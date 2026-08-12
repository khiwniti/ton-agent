# TON Real-Time Data Infrastructure (2026-08-10)

All facts below were verified FIRST-HAND via live probes (curl / raw Node TLS
probe / SDK source mining) on 2026-08-10. No endpoint in this doc is an
assumption — fabricated endpoints from the `src/market/` scaffold are flagged
explicitly as **FABRICATED**.

## 1. Ground truth: there is NO public WebSocket for DEX pools

The scaffolded `src/market/` WS clients point at endpoints that DO NOT EXIST:

| Client file | Endpoint | Probe result |
|---|---|---|
| `stonfi-websocket.ts` | `wss://api.ston.fi/ws` | **404 Not Found** |
| `dedust-websocket.ts` | `wss://api.dedust.io/ws` | **404 Not Found** |

Both 404s were confirmed by a raw Node `tls.connect` probe sending a
`GET <path> HTTP/1.1` + `Upgrade: websocket` handshake and reading the HTTP
status line. **The WS layer must be removed or reworked — it will never connect.**

## 2. What actually exists (verified)

### 2.1 STON.fi REST (`api.ston.fi`)
- `/v1/pools/{poolAddress}` → 200. Returns full pool state including
  `reserve0`, `reserve1`, `volume24HUsd`, `lpTotalSupplyUsd`.
  Verified live with real pool `EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4`.
- `/v1/pools?limit=N` → 200 (list; payload can be ~9 MB, avoid parsing whole body).
- `/v1/assets` → 200. Includes `dex_usd_price` per asset — a cross-check price
  source independent of any one pool.
- `/v1/assets/{assetAddress}`, `/v1/assets/query`, `/v1/markets`,
  `/v1/routers`, `/v1/routers/{routerAddress}`, `/v1/swap/simulate`,
  `/v1/reverse_swap/simulate`, `/v1/swap/status`, `/v1/transactions/query`,
  `/v1/wallets/{walletAddress}/*`, `/v1/stats/*` — route strings mined from
  `node_modules/@ston-fi/api/dist/esm/index.d.ts` (v2.7.0).
- **`/v1/swaps` → 404.** STON.fi has **NO public trade/swap feed.** The
  `queryTransactions` method is for **wallet** transactions (`{walletAddress,
  queryId}` or `{extMsgHash}`), NOT pool trades.
- **Implication:** the only real-time price primitive on STON.fi is **polling
  pool reserves** and deriving price = `reserve1/reserve0` (quote/base). Reserve
  changes are also a direct buy/sell flow signal (net reserve movement over a
  window ≈ net flow).

### 2.2 DeDust REST (`api.dedust.io`)
- `/v2/pools` → 200. Returns list with `reserve0`, `reserve1`, `lastPrice`,
  `stats` (volume/liquidity). No auth. Verified live.
- `/v2/pools/{addr}` → 404 (no single-pool detail route found). Filtering must
  be done client-side or via query params (`asset0_address`/`asset1_address`).
- DeDust ops: buy `0xea06185d`, sell `0x0f8a7ea5` (team memory — verified
  previously against TONAPI transaction payloads).
- **Implication:** same as STON.fi — poll `/v2/pools`, filter to the held pool,
  derive price + flow from reserves.

### 2.3 TONAPI streaming (`tonapi.io`)
- `/v2/sse/accounts/transactions` → **401** (exists, requires API key).
- `/v2/sse/blockchain/blocks` → **404**.
- **Implication:** an authenticated SSE stream of a wallet's transactions IS
  possible (401 = auth-gated, not missing). This is the ONE push channel in the
  ecosystem that exists, but it tracks **wallet transactions**, not pool prices —
  usable for exit confirmation (own sell landed) and for detecting whale/monitor
  wallets, not for price.
- Docs URLs (`docs.ton.org/v3/apis/tonapi-http/sse`) → 404; undocumented or
  moved.

### 2.4 Omniston (`wss://omni-ws.ston.fi`)
- **RFQ/quote channel for swap EXECUTION**, not a monitoring feed. Lifecycle:
  RFQ → Quote → Order → Execution (v1beta8). Source: STON.fi docs corpus
  `llms-full.txt`, Python ws example at lines 2757-2796.
- **Not usable for trend monitoring.**

## 3. The honest architecture: poll-to-event, not push

There is no push feed. The real-time layer must be built as **REST poll →
in-memory event bus**, tuned to the exit cadence:

```
timer (~1-5s) → GET /v1/pools/{addr} (or /v2/pools for DeDust)
             → parse reserves → derive price, reserve flow deltas
             → push { price, flow, ts } onto an in-process event bus
             → trend-monitor's TrendTracker.observe(price) consumes it
```

- TON shard blocks land ~1s. Reserve state on the REST APIs updates within a
  block or two of a swap landing — a 1-5s poll captures essentially every swap.
- `dex_usd_price` (STON.fi `/v1/assets`) is a cheap cross-check that catches
  single-pool reserve skew (routing, LP-only moves, rebalancing).
- Rate limits: keep poll interval ≥ 1s per pool; batch multiple pools into one
  request where the API allows (`/v1/pools/query`).

## 4. What the scaffold needs (rework plan)

1. **Delete** `dedust-websocket.ts`, `stonfi-websocket.ts`, `websocket-client.ts`
   — fabricated endpoints, will never connect.
2. **Replace** with `RESTPollingSource` abstraction:
   - `StonFiPoolSource` — `GET /v1/pools/{addr}` + `/v1/assets` cross-check.
   - `DeDustPoolSource` — `GET /v2/pools` + client-side filter.
   - Shared: interval scheduler, backoff on 429/5xx, in-memory event emitter.
3. **Feed the exit hot path** (`hotpath/position-monitor.ts` TrendTracker.observe)
   directly from the poll loop — the scaffold currently wires only into
   coordinator/fastpath-engine, NOT the exit path.
4. Optional later: TONAPI SSE (`/v2/sse/accounts/transactions`) with API key for
   wallet-transaction corroboration (exit landed / whale activity).

## 5. Rate budget (rough)

- 1 held pool × 3s poll = 20 req/min — trivial for both APIs.
- 10 held pools × 3s poll = 200 req/min — still fine, but batch via
  `/v1/pools/query` / single `/v2/pools` fetch + local filter.
- Backoff: on 429/5xx, double interval up to 15s, jitter.

## Key decisions to record

- **D1:** Poll-to-event is the only honest real-time layer (no public WS).
- **D2:** Price = reserve ratio per pool; `dex_usd_price` as independent cross-check.
- **D3:** Net reserve movement over a window = buy/sell flow signal (DeDust
  ops buy `0xea06185d` / sell `0x0f8a7ea5` can corroborate per-tx).
