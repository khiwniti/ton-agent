# Feature Specification: Ultra-Acceleration Architecture for TON Agent

**Feature Branch**: `003-ultra-acceleration`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Extend the TON Agent Orchestration Framework (TAOF) with four ultra-acceleration techniques — Cold/Hot path decoupling with shared policy matrix, localized edge SLMs over Unix Domain Sockets, TON cryptographic and shard optimization, and high-speed ADNL direct lite clients — while preserving all five Constitution principles (Deterministic Risk Core, Least-Privilege Custody, Containment Over Filtering, HITL Scales With Capital, Fail Closed). This spec supersedes and corrects the design notes in `specs/001-ton-agent-orchestration/ultra-acceleration.md`, which contained invalid BOC mutation, shard-mining, and gate-bypass proposals."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - FastPath Hot Execution Path (Priority: P1)

As a trading operator, I want pre-approved trade signals to execute in under 50 milliseconds through a FastPath engine that bypasses the LLM reasoning loop but still calls every deterministic risk gate, so that I can capture sub-second market opportunities on TON's Catchain 2.0 (~400ms block time, ~1s finality) without compromising any safety invariant.

**Why this priority**: FastPath is the single highest-leverage acceleration technique. It removes the 500ms–2s LLM round-trip from trades the operator has *already* approved policy for, while leaving the deterministic SafetyCaps core untouched. Constitution Principle I (Deterministic Risk Core) and Principle V (Fail Closed) are non-negotiable: FastPath MUST route every candidate through the same `evaluateTradeGate()` used by the cold path, and MUST reject on any ambiguity. No acceleration is acceptable if it weakens a Constitution principle.

**Independent Test**: Inject a pre-approved `FastPathSignal` (carrying a `policyVersion` that matches the active TradingPolicy) directly into `FastPathEngine.evaluateSignal`. Verify end-to-end execution (gate → BOC rebuild → sign → broadcast) completes in under 50ms with all gate checks passing, and that the execution journal entry is written before the broadcast returns success.

**Acceptance Scenarios**:

1. **Given** a `FastPathSignal` whose `policyVersion` matches the active TradingPolicy and whose amount, slippage, DEX, and token fields are all within policy bounds, **When** `FastPathEngine.evaluateSignal` is invoked, **Then** `evaluateTradeGate` from `core/gate.ts` is called and all checks (kill-switch, circuit breaker, bankroll, position size, slippage, allowlist, blacklist) pass, and the trade is executed via a rebuilt `@ton/core` Cell — never via raw byte-offset mutation of a serialized BOC buffer.
2. **Given** a `FastPathSignal` that exceeds any policy bound (position too large, slippage too high, DEX not allowlisted, token blocklisted, or stale `policyVersion`), **When** `evaluateSignal` is invoked, **Then** FastPath rejects the signal with an explicit reason code, journals the rejection, and the coordinator falls back to the cold LLM path for that signal — no partial execution occurs.
3. **Given** the FastPath worker thread crashes, the BOC template pool is missing the pool address, or an ADNL broadcast fails, **When** the coordinator detects FastPath absence or a FastPath-returned error, **Then** all subsequent trades route through the cold path automatically until the operator confirms FastPath is healthy again, and the incident is journaled as a `fail-closed` event.

---

### User Story 2 - Local SLM for Time-Critical Reasoning (Priority: P2)

As the trading agent's reasoning core, I want a local quantized Small Language Model accessible via Unix Domain Socket so that time-critical reasoning tasks — novel bytecode honeypot-pattern analysis, breaking-news-flash parsing, and rug-score nuance fits — complete in under 200ms instead of the 500ms–2s of round-tripping a cloud API. The local SLM is advisory-only; every output still passes through the deterministic SafetyCaps core before any trade.

**Why this priority**: Local SLM accelerates *reasoning* (cold path), not execution (hot path). It is the second-highest leverage because a meaningful fraction of cold-path latency is the LLM call itself, and many cold-path calls are low-stakes time-critical analyses where a 1B–3B quantized model is adequate. It degrades gracefully: any SLM failure or low-confidence output escalates to the cloud LLM with no downtime.

**Independent Test**: Start a vLLM service listening on `/tmp/vllm.sock`, send a bytecode-analysis prompt (≤256 output tokens) through `LocalSLMClient.reason()`, and verify a structured response returns in under 200ms. Kill the vLLM process, send the same prompt, and verify fallback to the cloud LLM completes within 500ms with a logged warning.

**Acceptance Scenarios**:

1. **Given** a vLLM service running on the Unix Domain Socket `/tmp/vllm.sock` with a quantized 1B–3B model loaded, **When** `LocalSLMClient.reason()` is called with a ≤256-token-output prompt, **Then** a response returns in under 200ms with logged latency, structured for downstream parsing.
2. **Given** the local SLM is unavailable (socket closed, GPU OOM, or process down), **When** `reason()` is called, **Then** the client falls back to the cloud LLM within 500ms, logs a warning, and the calling reasoning loop continues without throwing.
3. **Given** the local SLM returns a response whose confidence is below the configured threshold or whose structure cannot be parsed, **When** `brain.ts` receives the response, **Then** brain escalates that single decision to the cloud LLM (the SLM is advisory-only and never the last step before a signature).

---

### User Story 3 - ADNL Direct Lite Client Ingestion (Priority: P3)

As the agent runtime, I want to connect directly to a TON lite server via the ADNL protocol over TCP, so that I receive block updates and account-state reads within 100ms of the local node processing them — replacing the 500ms HTTP JSON-RPC indexer indirection — with transparent fallback to HTTP TonClient on any ADNL failure.

**Why this priority**: ADNL direct ingestion accelerates *data freshness*, which benefits both paths but is not on the critical signing path. It is third because the cold path can tolerate 500ms indexer lag, and FastPath correctness does not depend on sub-100ms blocks (it depends on the gate). It is independent of the other three stories and can be developed and deployed standalone.

**Independent Test**: Start `DirectLiteClient` against a known lite server, subscribe to block updates, and compare the timestamp of each update arrival against the same block seen via the HTTP Tonapi client for 10 consecutive blocks. Verify the ADNL client leads on ≥9 of 10.

**Acceptance Scenarios**:

1. **Given** `DirectLiteClient` is connected to a healthy lite server via ADNL TCP, **When** a new masterchain block is produced, **Then** the client receives the update within 100ms of the local node processing it.
2. **Given** the ADNL connection drops (lite server unreachable or rotated key), **When** three consecutive reconnect attempts fail, **Then** the client transparently falls back to HTTP TonClient with zero missed cycles, logs the fallback, and periodically retries ADNL in the background.
3. **Given** `DirectLiteClient` is active, **When** `getAccountState` is called for the same block the HTTP client would read, **Then** the ADNL response arrives faster than the HTTP equivalent (no indexer re-indexing lag) for that block.

---

### User Story 4 - TON Shard Proximity for Budgeting Wallet (Priority: P4)

As the operator, I want the budgeting wallet contract deployed to the same shard as the target DEX router at deployment time, so that the majority of trades avoid the 1–2s cross-shard hypercube routing latency and execute within a single ~400ms block. Shard mining affects only the deployment address; the contract logic and keys are untouched.

**Why this priority**: Shard proximity is the lowest-priority acceleration because it is a one-time deployment optimization that only helps if the wallet's shard and the router's shard happen to align *post-deployment*. Shards split and merge dynamically; a wallet that is co-located today may be one shard away tomorrow, and wallets are immovable. It is still valuable for the long-tail of trades and is fully independent of the other stories.

**Independent Test**: Run shard mining against a Ston.fi or DeDust router address against the live masterchain shard config. Verify the miner either returns a keypair whose address matches the target shard prefix within 10,000 attempts, or falls back to a random keypair with a logged warning — never throws an unrecoverable error.

**Acceptance Scenarios**:

1. **Given** a target router address and the current masterchain shard configuration, **When** `mineShardAddress` runs, **Then** it computes the wallet address via `contractAddress()` from `@ton/core` (with proper `StateInit` serialization, not a hand-rolled hash) and returns a keypair whose address matches the target shard prefix, OR falls back to a random address after 10,000 attempts with a logged warning — never throws `SHARD_MINE_FAILED`.
2. **Given** a mined wallet keypair, **When** the budgeting wallet is deployed using the existing `agentic-wallet.tolk` contract and that keypair, **Then** the deployed wallet lives in the same shard as the target router at deployment time.
3. **Given** the shard configuration later changes (split or merge) and the wallet and router are no longer in the same shard, **When** the agent detects the divergence, **Then** it logs an informational note but does NOT re-deploy — wallet shard membership is fixed at deployment and wallets are immovable.

---

### Edge Cases

- **TON shard split/merge during active trading**: The budgeting wallet's shard is fixed at deployment (account_id is immutable). The target router's shard can move when the network splits or merges shards. The agent MUST detect wallet/router shard divergence on each cycle and log it; it MUST NOT attempt to re-deploy or migrate the wallet. Trades that would now cross shards simply incur the 1–2s hypercube latency and proceed normally via the cold path; FastPath MAY downgrade such signals to cold-path routing.
- **ADNL lite server key rotation**: Lite server public keys are published in the global masterchain config and rotate periodically. `DirectLiteClient` MUST periodically re-read the live config and rotate its peer key set; if a connection fails with a key-mismatch error and the new key cannot be fetched, the client MUST fall back to HTTP TonClient rather than pinning a stale key.
- **BOC template pool missing pool address**: If `FastPathEngine` receives a signal for a pool with no pre-built template, it MUST NOT attempt to byte-mutate an unrelated template. It MUST either fall back to a dynamic `@ton/core` Cell build (cold path speeds) or reject the signal — never fabricate a transaction. This is a Fail-Closed event and is journaled.
- **Local SLM output malformed or unparseable**: If the local SLM returns content that fails structured parsing or is scored below the confidence threshold, `brain.ts` MUST treat it as advisory-zero and escalate that single decision to the cloud LLM. The SLM is never the last step before a signature (Principle I).
- **Policy matrix version mismatch between cold and hot path**: If a `FastPathSignal` arrives carrying a `policyVersion` older than the active `TradingPolicy.version`, FastPath MUST reject the signal as `STALE_POLICY` and route to the cold path. If the signal's version is *newer* than the active policy, FastPath MUST also reject (`POLICY_AHEAD`) — the hot path never leads policy.
- **FastPath worker thread crash**: The coordinator MUST health-check the FastPath worker at a bounded interval. On detected absence (missed heartbeat or worker exit), the coordinator MUST mark FastPath as unavailable, journal a `fail-closed` event, and route all subsequent signals through the cold path until the operator confirms recovery. No retry storm.
- **vLLM GPU OOM or model load failure**: `LocalSLMClient` MUST detect GPU-OOM and model-unavailable conditions, evict any cached inference state, and fall back to cloud LLM. If CPU-only inference is configured as a secondary, it MAY be tried before cloud fallback. Every fallback is journaled.
- **Signing key isolation breach attempt**: If any FastPath code path attempts to access a signing key directly (rather than routing through the coordinator's existing `sendTransferLocked` mechanism), the coordinator MUST abort the cycle, journal a `CONTAINMENT_VIOLATION` event, and disable FastPath until the operator reviews. FastPath MUST NOT hold signing keys (Principle II).
- **Kill-switch trip during FastPath cycle**: If the kill-switch endpoint returns active (or is unreachable for 3 consecutive polls) during a FastPath cycle, every in-flight and queued FastPath signal MUST resolve to reject, and the circuit breaker enters its safe-halted state identically to the cold path. FastPath does not get a "fast lane" around the kill-switch (Principle V).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `FastPathEngine` MUST call `evaluateTradeGate()` from `core/gate.ts` before any execution step, including kill-switch poll, circuit-breaker check, bankroll check, position-size check, slippage check, DEX allowlist check, and token blacklist check. No FastPath code path may bypass the gate.
- **FR-002**: `FastPathEngine` MUST fail closed to "reject" on any error — missing BOC template, stale or ahead policy version, ADNL send failure, BOC rebuild exception, or any unhandled exception within the worker. A rejected signal MUST fall back to the cold LLM path; no partial or speculative execution is permitted.
- **FR-003**: The BOC template pool MUST use the `@ton/core` Cell API to rebuild cells with new values (amount, min_out, deadline) at execution time. Raw byte-offset mutation of serialized BOC buffers is PROHIBITED — serialized BOCs are DAGs of cells with child-cell hash references, and overwriting a byte invalidates the hash DAG.
- **FR-004**: `LocalSLMClient` MUST connect via Unix Domain Socket when available, fall back to HTTP localhost, then to the cloud LLM. The fallback chain is deterministic and journal-recorded at each transition.
- **FR-005**: `LocalSLMClient` MUST complete inference in under 200ms for ≤256-token responses on 1B–3B quantized models when the local GPU is healthy; if the response exceeds 300ms at the 95th percentile, the client SHOULD be reclassified as degraded and the calling loop SHOULD escalate to cloud for time-critical requests.
- **FR-006**: `DirectLiteClient` MUST receive block updates within 100ms of the local node processing them via ADNL TCP, when the lite server is healthy and on the same local network.
- **FR-007**: `DirectLiteClient` MUST fall back to HTTP TonClient on ADNL failure (connection drop, key rotation mismatch, or 3 consecutive reconnect failures) with zero downtime — the fallback MUST complete before the next block cycle begins and MUST be transparent to the coordinator.
- **FR-008**: Shard mining MUST use `contractAddress()` from `@ton/core` with a properly serialized `StateInit` (code + data cells). Hand-rolled hash computation is PROHIBITED — the account_id depends on the full `StateInit`, and any shortcut risks deploying to the wrong address.
- **FR-009**: Shard mining MUST query the current shard configuration from the masterchain before mining. Hardcoded shard prefixes are PROHIBITED — shards split and merge and the active configuration is the only source of truth.
- **FR-010**: Shard mining MUST cap at 10,000 attempts. If no matching keypair is found within the cap, the miner MUST fall back to a random keypair, log a warning, and return — it MUST NOT throw an unrecoverable error or block deployment indefinitely.
- **FR-011**: Policy matrix updates from the cold path to FastPath MUST use an in-process `EventTarget` when FastPath runs in-process, or a `SharedArrayBuffer`-backed ring buffer when FastPath runs in a Node `worker_thread`. A `version` field on `TradingPolicy` MUST accompany every update, and FastPath MUST reject any signal whose `policyVersion` does not exactly match the active version.
- **FR-012**: FastPath MUST NOT hold signing keys directly. All signing MUST route through the coordinator's existing `sendTransferLocked` mechanism, which performs its own state-lock and bankroll checks before signing. This preserves Principle II (Least-Privilege Custody) — a compromised FastPath worker cannot sign anything on its own.
- **FR-013**: All new acceleration modules MUST be feature-flagged: `FAST_PATH_ENABLED`, `LOCAL_SLM_ENABLED`, `LITE_CLIENT_ENABLED`, `SHARD_MINING_ENABLED`. All flags MUST default to `false` to preserve current cold-path-only behavior for backward compatibility. Setting any flag to `true` MUST be an explicit operator action.
- **FR-014**: All execution paths — cold, hot, rejected, and failed — MUST journal to the decision log (the existing `trade_transactions` SQLite stream) before the next step in the cycle proceeds. If the journal write fails, the cycle MUST abort and enter the safe-halted state (Principle: "if it is not journaled, it did not happen").
- **FR-015**: The signal producer for FastPath MUST be explicitly identified: signals originate from either the radar scanner (deterministic scoring of pool/token state) or an LLM decision tagged as pre-approved. Anonymous signals (no producer, no `policyVersion`) MUST be rejected.
- **FR-016**: `DirectLiteClient` MUST periodically re-read the live masterchain config to detect lite server key rotations and update its peer set. Stale key pinning is PROHIBITED.
- **FR-017**: If the wallet and target router are detected to be in different shards at trade time (post split/merge), the agent MUST log the divergence AND downgrade FastPath handling of that signal to cold-path routing (incurring the 1–2s hypercube latency). The agent MUST NOT attempt to re-deploy the wallet.
- **FR-018**: BOC template CELL rebuild — when a pre-built template exists, FastPath MUST rebuild only the changed `Cell` (the leaf carrying amount/min_out/deadline), reference it from the parent `Cell`, and re-serialize the BOC fresh. The resulting BOC's internal cell-hash DAG MUST be consistent; this is the only permitted "template" usage.
- **FR-019**: HITL scaling (Principle IV) MUST NOT be weakened by FastPath. Any trade whose notional exceeds the auto-approve ceiling MUST still require an explicit operator approval (e.g., a Telegram tap), regardless of whether it originated from a pre-approved FastPath signal. FastPath is an execution accelerator, not a cap elevator.
- **FR-020**: A promotion-gate test suite (unit, integration, contract-simulator, and adversarial red-team) MUST exist for every new acceleration module before it is enabled on mainnet-live-capped, per the constitution's Test-First standard and Promotion Path.

*[NEEDS CLARIFICATION: FR-018 — exact cell-rebuild primitive set permitted (e.g., is `beginCell()`/`storeRef()` the only allowed API, or are shallow-copy optimisations on `Cell` references acceptable?) — this affects whether the "template" concept survives as a rebuild hint or collapses to a fully dynamic build]*

### Key Entities *(include if feature involves data)*

- **TradingPolicy**: The active policy matrix pushed from the cold path (LLM-reasoned, operator-capped) to FastPath via the in-process `EventTarget` or `SharedArrayBuffer` ring. Attributes: `maxPositionTon`, `minLiquidityUsd`, `maxSlippageBps`, `allowedDexes`, `blockedTokens`, `updatedAt`, `version`. The `version` is monotonic and is the field FastPath compares against any incoming signal's `policyVersion`. Raising any cap above its current value requires operator approval — never an agent proposal (Principle IV).
- **FastPathSignal**: The unit of work FastPath evaluates. Produced by the radar scanner (deterministic) or by an LLM decision tagged pre-approved. Attributes: `tokenAddress`, `poolAddress`, `side`, `amountTon`, `confidence`, `policyVersion`, `producer` (`radar` | `llm-preapproved`). Signals lacking `policyVersion` or `producer` MUST be rejected (FR-015).
- **BocCellTemplate**: A pre-built `@ton/core` `Cell` tree (parent + leaf references) for a known pool's swap-message body, with placeholders for the dynamic fields. At execution time, FastPath rebuilds only the changed leaf `Cell`, re-references it from the parent, and re-serializes — it does NOT mutate serialized BOC bytes (FR-003, FR-018). Conceptually this is a *rebuild blueprint*, not a byte buffer to patch.
- **LiteClientConnection**: The connection abstraction that backs the data-ingestion interface. Wraps a direct ADNL `LiteClient` (primary) with transparent fallback to the existing HTTP `TonClient` (secondary). Holds no signing keys and performs no transaction signing. Handles peer-set rotation (FR-016) and connection health independently of any FastPath cycle.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of FastPath-executed trades pass the same deterministic `evaluateTradeGate()` checks as cold-path trades — zero bypass. Measured by journal post-mortem comparing each FastPath execution to the gate's recorded check results.
- **SC-002**: Pre-approved signals, when all acceleration infrastructure is healthy (FastPath up, BOC template present, ADNL or HTTP transport reachable), execute end-to-end (gate → cell rebuild → sign via `sendTransferLocked` → broadcast) in under 50 milliseconds, measured from `evaluateSignal` entry to broadcast-acknowledged.
- **SC-003**: The local SLM responds to time-critical reasoning prompts (≤256 output tokens) in under 200ms median, with the 95th percentile under 300ms, when the local GPU is healthy. Cloud fallback latency is excluded from this metric but logged separately.
- **SC-004**: The ADNL direct lite client receives block updates within 100ms of the local node processing them at least 95% of the time, when the lite server is on the same local network and healthy. Dropouts during key rotation or network blips do not count against this metric (they are covered by SC-005).
- **SC-005**: 100% of acceleration infrastructure failures — FastPath crash, SLM unavailable, ADNL drop, BOC template missing, GPU OOM — resolve to cold-path execution with zero missed opportunities logged as "infrastructure failure." Every such resolution is journaled with the failure mode and the recovered execution path.
- **SC-006**: 100% of execution paths (cold trade, hot trade, rejection, kill-switch trip, circuit-breaker trip, policy-stale rejection) write a journal entry to the decision log before the next step in the cycle proceeds. No cycle may complete — successful or not — without a reconstructable journal trail.

## Assumptions

- **A-001**: The operator has access to hardware capable of running a local TON lite server (8+ cores, 32GB RAM, 500GB SSD) OR is willing to use a trusted public lite server for ADNL ingestion. Local full-node features are optional given a stable public lite server.
- **A-002**: For the local SLM, the operator has a GPU with at least 8GB VRAM (RTX 3090/4090 or A100) OR accepts CPU-only inference with higher latency (which will struggle to meet SC-003 and should default `LOCAL_SLM_ENABLED=false`).
- **A-003**: The existing budgeting-wallet contract (`contracts/budgeting-wallet.tolk` from spec 001) remains unchanged. Shard mining only affects the *initial deployment address* (via the mined keypair that determines `account_id`), never the contract logic. The contract's daily-spend limit, signature validation, and bounce handling are untouched.
- **A-004**: Catchain 2.0 is active on TON mainnet, with ~400ms block time and ~1s finality (confirmed activated April 2026). Latency targets in this spec are calibrated to that block cadence; if Catchain parameters change, SC-002 and SC-004 should be re-baselined.
- **A-005**: A maintained `ton-lite-client` npm package (or an equivalent fork providing ADNL `LiteClient`, `LiteSingleEngine`, and `LiteRoundRobinEngine`) is available at build time.
- **A-006**: A vLLM release with Unix Domain Socket support (PR #18097 merged August 2025) is available to the operator, OR an equivalent TensorRT-LLM deployment exposing an OpenAI-compatible API over a Unix socket is substituted. The SLM model itself (1B–3B quantized) is supplied by the operator — model selection is out of scope for this spec.
- **A-007**: The operator explicitly enables acceleration features via environment flags (`FAST_PATH_ENABLED`, `LOCAL_SLM_ENABLED`, `LITE_CLIENT_ENABLED`, `SHARD_MINING_ENABLED`). The default for every flag is `OFF`, so an unsuspecting operator running current code sees zero behavioral change (FR-013).
- **A-008**: Cross-shard hypercube routing latency is 1–2s per the TON documentation; same-shard routing resolves within a single ~400ms block. This delta is the entire economic motivation for shard proximity (User Story 4) and for SC-002's tight budget on the same-shard fast path.
