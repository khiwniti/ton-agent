# Architecture: Event-Driven Trend-Exit Monitor (2026-08-10)

Synthesis of `00-current-state.md` + `ton-realtime-data.md` +
`trend-flip-detection.md`. Goal (operator directive 2026-08-09): **no TP, no
trailing stop; close only on a SIGNIFICANT up→down trend reversal**, with
near-real-time data.

## 1. The core insight

There is no public push feed (verified: STON.fi `/ws` 404, DeDust `/ws` 404,
TONAPI SSE auth-gated, Omniston RFQ-only). So "real-time" must mean:

> **REST poll → derive → event bus → exit hot path.**

TON shard blocks land ~1s; both DEX REST APIs reflect a swap within a block or
two. A 1-5s poll per held pool captures essentially every trade that moves the
price the exit logic reads. This replaces the fabricated WS scaffold entirely.

## 2. Data source layer (replaces `src/market/` WS files)

Delete: `stonfi-websocket.ts`, `dedust-websocket.ts`, `websocket-client.ts`
(their endpoints 404). Keep `data-cache.ts`, `time-series-store.ts`,
`data-validator.ts` (harmless, useful). Add two REST pollers:

```
interface PoolPriceSource {
  start(onPrice: (ev: PriceTick) => void): void;
  stop(): void;
  pollNow(): Promise<void>;
}
interface PriceTick {
  poolAddress: string;
  dex: 'stonfi' | 'dedust';
  price: number;          // reserve1/reserve0, normalized per pool
  reserve0: string; reserve1: string;
  volume24h?: number;
  ts: number;
}
```

- `StonFiPoolSource` — `GET /v1/pools/{addr}` per held pool; price =
  reserve ratio; independent cross-check via `/v1/assets` `dex_usd_price`
  (catches single-pool reserve skew from routing/LP moves).
- `DeDustPoolSource` — `GET /v2/pools` once, filter client-side to held pools
  (`/v2/pools/{addr}` 404s), read `lastPrice` + reserves + stats.
- Shared scheduler: interval (default 3s, config `marketPollIntervalMs`),
  backoff on 429/5xx (double up to 15s, jitter), one in-flight guard per pool.
- Batch API notes: STON.fi `/v1/pools/query` and single `/v2/pools` fetch let us
  amortize 10 held pools into 1-2 requests/tick.

## 3. Event bus → exit hot path wiring

The exit path already owns price + trend state (`position-monitor.ts:535-546`):
`trendTracker.observe(p.id, price, seedPrice)`. The monitor currently derives
price from **pnl** (mark value from a quote probe). The polled reserve price is
a *supplementary, faster, impact-free* source. Wiring:

```
position-monitor tick (10-20s, exit engine)  ← existing, unchanged
        │
        └─ trend price now comes from BOTH:
             (a) polled reserve price (fresh, ~3s)   → observe() FIRST, every
                 sub-tick between monitor intervals
             (b) probe-quote pnl price (existing)     → observe() on tick

TrendTracker.observe() is keyed per position and idempotent across sources:
the ring buffer just appends prices. Feed (a) between ticks so the
confirmTicks counter accumulates on real market data even when the exit
engine's 10s tick is between cycles.
```

Concretely: the poller emits `PriceTick`; the position monitor registers a
per-open-position handler that calls `trendTracker.observe(posId, tick.price,
entryPrice)` and (only when `trend.confirmed`) re-runs the **feed
corroboration gate** (`confirmedByFeeds` at `position-monitor.ts:580`) —
holder delta + DeDust sell/buy trader window. A confirmed+corroborated flip
sets the same `trendSignal` the exit engine already reads, so `evaluateExitPolicy`
needs **zero changes** (priority: emergency → trend → time → stop-loss).

Fail-closed invariants (from existing code, preserved):
- No poll data → fall back to pnl-derived price (current behavior). Never a gap.
- Poll data non-finite / stale (>2× interval) → discard, don't reset streaks
  (`trend-monitor.ts:172-179` treats a gap as not-a-recovery).
- Corroboration gate error → gate=false → hold (`position-monitor.ts:580+`).

## 4. New file map

| File | Action |
|---|---|
| `src/market/websocket-client.ts` | DELETE (fabricated) |
| `src/market/stonfi-websocket.ts` | DELETE (fabricated) |
| `src/market/dedust-websocket.ts` | DELETE (fabricated) |
| `src/market/price-source.ts` | NEW: `PriceTick` + `PoolPriceSource` interface |
| `src/market/stonfi-pool-source.ts` | NEW: REST poller for STON.fi pools + assets cross-check |
| `src/market/dedust-pool-source.ts` | NEW: REST poller for DeDust `/v2/pools` |
| `src/market/pool-monitor.ts` | REWORK: drop WS, drive from pollers, keep `getPoolState`/`getTradeHistory` API surface (used by `mcp/tools`) |
| `src/market/index.ts` | Update exports (no WS exports) |
| `src/hotpath/position-monitor.ts` | Add poller subscription feeding `trendTracker.observe()` between ticks (guarded by `CONFIG.market?.pollEnabled`) |
| `src/core/coordinator.ts` / `fastpath-engine.ts` | Re-point to new source API (they already use `poolStateCache`) |
| `config.ts` | Add `market.pollIntervalMs`, `market.pollEnabled`, `market.maxBackoffMs` |

## 5. Latency budget (poll cadence vs signal)

- `confirmTicks=3` @ 10s monitor = ~30s confirmation delay today.
- Poll at 3s: the counter accumulates ~3-4x more ticks in the same wall-clock
  window → **effective confirmation latency drops to ~10-15s** without changing
  the (load-bearing) whipsaw filter semantics — same number of consecutive
  bearish *market observations*, just on real data faster.
- Keep `historySize=60`; at 3s that is 3min of prices (EMA(7)/(25) settle fine).
- Caveat to record: faster confirmation also means **noisier** flips. The
  `minObservations` lock and the corroboration gate stay as the safety net; if
  field data shows early exits, raise `confirmTicks` to 4-5 (not lower cadence).

## 6. What is explicitly OUT of scope for v1

- No TONAPI SSE (auth + wallet-tx semantics, not pool price) — revisit later
  for exit-landed corroboration.
- No reserve-flow lead indicator (research §3.2) — v1.1 only, if field data
  shows trend_exits are materially late.
- No change to the pure `evaluateExitPolicy` — the engine is already correct.
- No TimescaleDB persistence changes (keep, it's cheap and useful for postmortem).

## 7. Acceptance criteria

1. Poller runs at configured cadence; every held pool updates `poolStateCache`.
2. `trendTracker.observe()` receives polled reserve prices between monitor
   ticks; `trend_observations` grows between ticks in logs/DB.
3. A simulated flip (reserve-driven price decline) confirms on real data and
   the corroboration gate runs unchanged.
4. Poller failure (RPC 5xx, network) degrades to pnl-derived price — no
   spurious closes, no missing exits, journal shows the fallback.
5. Typecheck clean; no WS code remains.
