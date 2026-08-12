# Current State: Exit Monitoring + Real-Time Data (2026-08-10)

## Exit signal chain (LIVE, operator directive 2026-08-09)

- **Policy**: no TP, no trailing stop. Winners ride the trend; close on CONFIRMED
  significant downtrend flip (`trend_exit`). Static stop-loss is the hard loss floor.
- **Signal** (`exit/trend-monitor.ts`): fast EMA(7) < slow EMA(25) AND MACD hist < 0,
  requiring `confirmTicks`=3 CONSECUTIVE bearish ticks. `minObservations`=6 real prices
  required (2026-08-09 PAWZ fix — seed-baseline flips fired with almost no evidence).
- **Wiring** (`hotpath/position-monitor.ts:535-546`): per-position `TrendTracker.observe()`
  fed with pnl-derived per-token price, on the ~10-20s tick loop.
- **Corroboration gate** (`position-monitor.ts:548+`): confirmed flip must ALSO pass
  live-feeds gate — holder delta (TONAPI `/v2/jettons/{id}/holders`) + DeDust
  buy/sell-trade window (STON.fi has no public trades feed). Fail-closed.
- **Engine** (`exit/policy-engine.ts`): pure. Priority: emergency(rug) → trend → time →
  stop-loss. `evaluateExitPolicy()` returns `ExitDecision | null`.

## Real-time data layer (`src/market/`) — SCAFFOLDED, UNVERIFIED

New files (untracked in git), **not wired into the exit path**, typecheck clean:
- `websocket-client.ts` — generic WS reconnecting client (no reconnection logic — logs only)
- `stonfi-websocket.ts` — **assumes `wss://api.ston.fi/ws`** → DIRECT PROBE 2026-08-10: **404 Not Found**
- `dedust-websocket.ts` — **assumes `wss://api.dedust.io/ws`** → DIRECT PROBE 2026-08-10: **404 Not Found**
- `pool-monitor.ts` — PoolMonitorService (subscription service)
- `time-series-store.ts` — ring-buffer series store
- `data-cache.ts` — PoolStateCache / TradeCache, exported singletons
- `data-validator.ts` — sanity checks

Wired into: `core/coordinator.ts` (poolMonitorService), `core/fastpath-engine.ts`
(poolStateCache). **NOT** wired into hotpath/position-monitor.ts exit path.

## Verified facts

| Fact | Source |
|---|---|
| Ston.fi REST: `api.ston.fi/` → 307 (exists) | direct probe |
| Ston.fi WS `/ws` → 404 (does NOT exist) | direct probe 2026-08-10 |
| DeDust WS `/ws` → 404 (does NOT exist) | direct probe 2026-08-10 |
| Exit loop cadence ~10-20s, TON shard blocks ~1s | code + domain |
| market/ scaffold typechecks clean | `tsc --noEmit` |
| Repo-wide typecheck RED (pre-existing): brain.ts, fastpath-engine.ts, ml/, line.ts, read-api.ts | `tsc --noEmit` |

## Open questions → research agents

1. Do REAL public WS/stream endpoints exist for Ston.fi / DeDust / TON?
2. What is the fastest honest feed for exit monitoring (block ~1-5s)?
3. Is EMA-cross+MACD the right reversal signal for high-swing memecoins?
4. What corroborations are documented for trend-flip exits?
