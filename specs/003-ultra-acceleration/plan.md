# Implementation Plan: Ultra-Acceleration Architecture (Spec 003)

**Status**: Planning Complete — Ready for `/gsd:execute-phase`  
**Generated**: 2026-08-11  
**Spec**: `specs/003-ultra-acceleration/spec.md`  
**Constitution**: `.specify/memory/constitution.md` (Principles I–V)

---

## Executive Summary

This plan decomposes the Ultra-Acceleration Architecture specification into 5 phases with 14 executable plans. Each plan targets ~50% context consumption (2-3 tasks) and preserves Constitution Principles I–V:

| Principle | Preservation Mechanism |
|-----------|------------------------|
| **I. Deterministic Risk Core** | FastPath only evaluates pre-approved policies; all gates remain pure TS functions |
| **II. Least-Privilege Custody** | Shard mining only affects address derivation; signing keys unchanged |
| **III. Containment Over Filtering** | FastPath tools scoped to pre-approved policy matrix |
| **IV. HITL Scales With Capital** | Unchanged — SLM is advisory only |
| **V. Fail Closed** | All new paths default to reject on error/timeout |

---

## Phase 0: Foundation & Research (Week 0)

### 0.1 — Policy Matrix Transport & Versioning
**Dependencies**: None | **Wave**: 1 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 00-01-policy-matrix-transport

### Objective
Establish the policy matrix shared-memory transport between Cold Path (brain/coordinator) and Hot Path (FastPath). Policy versioning enables stale-policy rejection per FR-001/FR-002.

### Context
@specs/003-ultra-acceleration/spec.md (FR-001, FR-002, FR-013, FR-020)
@apps/agent/src/core/policy-types.ts (TradingPolicy, FastPathSignal)
@apps/agent/src/core/policy-manager.ts (PolicyManager)
@apps/agent/src/config.ts (fastPathEnabled flag)

### Tasks
1. **Create PolicyTransport interface + SharedMemory implementation**
   - Files: `src/core/policy-transport.ts`, `src/core/policy-transport.test.ts`
   - Action: Define `PolicyTransport` interface with `push(policy: TradingPolicy)`, `subscribe(cb)`, `getVersion()`. Implement `SharedMemoryPolicyTransport` using `Buffer` + version counter. No external deps. Target: <0.1ms read latency.
   - Verify: `npx tsx --test test/policy-transport.test.ts` passes
   - Done: Interface + impl + tests; version increments on push; subscribers notified

2. **Wire PolicyManager → PolicyTransport**
   - Files: `src/core/policy-manager.ts`, `src/core/coordinator.ts`
   - Action: On policy update (cold path), `PolicyManager.updatePolicy()` calls `transport.push(newPolicy)`. Coordinator reads latest via transport on init. Feature-flagged by `fastPathEnabled`.
   - Verify: Integration test — policy change propagates to subscribers within 1 tick
   - Done: Policy updates flow to transport; coordinator receives latest version
```

### 0.2 — BOC Template Pool (FR-018 Resolution)
**Dependencies**: 0.1 | **Wave**: 2 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 00-02-boc-template-pool

### Objective
Implement pre-built BOC template pool for Ston.fi and DeDust swap messages. Uses exact @ton/core Cell API pattern from router.ts:257-297 (resolved FR-018). Only leaf cell carrying amount/min_out/deadline is mutated at execution.

### Context
@specs/003-ultra-acceleration/spec.md (FR-018, FR-001, FR-020)
@apps/agent/src/dex/router.ts:257-297 (Ston.fi BOC build)
@apps/agent/src/dex/router.ts:919-929 (DeDust BOC build)
@apps/agent/src/core/policy-types.ts (FastPathSignal.poolAddress)

### Tasks
1. **Create BocTemplatePool with Ston.fi + DeDust templates**
   - Files: `src/dex/boc-template.ts`, `src/dex/boc-template.test.ts`
   - Action: Pre-build BOC templates at startup for known pools. Store: template Buffer + byte offsets for dynamic fields (amount, min_out, deadline, query_id). Use `beginCell().storeUint(opcode,32).storeUint(0,64)...endCell()` pattern from router.ts. Compute offsets by serializing once with placeholders, then finding byte positions. Export `mutateBoc(template, amount, minOut, deadline, queryId)` — pure Buffer overwrite.
   - Verify: Unit test — mutate produces valid BOC; `Cell.fromBoc()` parses; opcode/amount/min_out match
   - Done: Pool builds templates for both DEXes; mutate is <0.5ms; serialized BOC validates

2. **Add pool registry + prebuild hook in coordinator**
   - Files: `src/core/coordinator.ts`, `src/dex/router.ts` (exports pool addresses)
   - Action: `Coordinator.init()` calls `bocPool.prebuild(router.getKnownPools())` when `fastPathEnabled`. Pool list sourced from router's known DEX pools.
   - Verify: Coordinator boot logs "Pre-built N BOC templates" when flag enabled
   - Done: Templates ready before FastPath starts; no runtime BOC builds on hot path
```

---

## Phase 1: FastPath Hot Execution Path (P1 — Highest Priority)

### 1.1 — FastPath Engine Core
**Dependencies**: 0.1, 0.2 | **Wave**: 3 | **Tasks**: 3 | **Type**: tdd

```markdown
## Plan: 01-01-fastpath-engine-core

### Objective
Implement FastPathEngine — synchronous, zero-I/O signal evaluation against active policy. Target: <1ms evaluateSignal(). Implements FR-001, FR-002, FR-011, FR-012, FR-017, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-001, FR-002, FR-011, FR-012, FR-013, FR-017, FR-020)
@apps/agent/src/core/fastpath-engine.ts (existing — evaluates via evaluateTradeGate)
@apps/agent/src/core/gate.ts (evaluateTradeGate — pure gate logic)
@apps/agent/src/core/policy-transport.ts (PolicyTransport)
@apps/agent/src/dex/boc-template.ts (BocTemplatePool)
@apps/agent/src/core/policy-types.ts (TradingPolicy, FastPathSignal)

### TDD Feature
- **Name**: FastPathEngine
- **Files**: `src/core/fastpath-engine.ts`, `src/core/fastpath-engine.test.ts`
- **Behavior**:
  - `evaluateSignal(signal)` returns `{ok:boolean, reason?:string}` in <1ms
  - Rejects if signal.policyVersion !== transport.currentVersion (stale policy)
  - Rejects if signal.side==="buy" && signal.amountTon > policy.maxPositionTon
  - Rejects if signal.confidence < 0.8 (configurable threshold)
  - Rejects if signal.tokenAddress in policy.blockedTokens
  - Rejects if signal.producer==="radar" but pool not in allowedDexes
  - Accepts valid pre-approved LLM signals (producer==="llm-preapproved")
  - Returns `{ok:false, reason:"STALE_POLICY"}` etc. for audit trail
- **Implementation**: Pure TS, no I/O. Reads policy from PolicyTransport. Uses BocTemplatePool for template existence check.

### Tasks
1. **RED: Write failing tests for evaluateSignal**
   - Action: Create test file with cases for each rejection reason + happy path. Use synthetic policy + signal fixtures.
   - Verify: `npx tsx --test test/fastpath-engine.test.ts` fails (RED)

2. **GREEN: Implement FastPathEngine.evaluateSignal**
   - Files: `src/core/fastpath-engine.ts`
   - Action: Implement evaluation logic per behavior spec. Inject PolicyTransport + BocTemplatePool. No async.
   - Verify: Tests pass (GREEN); benchmark shows <1ms per evaluation

3. **REFACTOR: Add metrics + config injection**
   - Action: Export `FastPathMetrics` (evaluations, rejectionsByReason). Accept `FastPathConfig` (confidenceThreshold, etc.) from CONFIG.
   - Verify: Tests pass; metrics increment correctly; config drives thresholds
```

### 1.2 — FastPath Trade Execution (BOC Mutate + Send)
**Dependencies**: 1.1 | **Wave**: 4 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 01-02-fastpath-execution

### Objective
Implement `executeTrade(signal)` — mutates pre-built BOC template, signs, sends via ADNL. Target: <5ms end-to-end. Implements FR-003, FR-014, FR-018, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-003, FR-014, FR-018, FR-020)
@apps/agent/src/dex/boc-template.ts (mutateBoc, BocTemplatePool)
@apps/agent/src/core/direct-lite-client.ts (DirectLiteClient — placeholder)
@apps/agent/src/wallet/wallet.ts (signing)
@apps/agent/src/http/tonapi.ts (fallback HTTP send)

### Tasks
1. **Implement executeTrade with BOC mutate + dual send path**
   - Files: `src/core/fastpath-engine.ts` (add method), `src/core/fastpath-engine.test.ts`
   - Action: `executeTrade(signal)`:
     1. Get template from BocTemplatePool via signal.poolAddress
     2. Compute minOut from pool reserves (read via PolicyTransport cached state or direct query)
     3. `mutateBoc(template, amount, minOut, deadline, queryId)`
     4. Sign with tier wallet keypair (injected at init)
     5. Send via `directLiteClient.sendRawMessage(boc)` if connected, else fallback to `tonapi.sendRawMessage(boc)`
     6. Return `{ok:boolean, txHash?:string, error?:string, latencyMs:number}`
   - Verify: Integration test with mocked lite client + tonapi; mutate+sign+send <5ms; valid BOC produced

2. **Add execution metrics + circuit breaker**
   - Action: Track executionLatencyMs, sendPath (adnl|http), failureCount. After 3 consecutive failures, set `circuitBreakerOpen=true` — FastPath rejects all signals until manual reset or cooldown.
   - Verify: Circuit opens after 3 mock failures; metric recorded; cooldown resets
```

### 1.3 — Coordinator Integration & Feature Flags
**Dependencies**: 1.1, 1.2 | **Wave**: 5 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 01-03-coordinator-integration

### Objective
Wire FastPath into TierCoordinator as new execution path. Cold path fallback preserved. All flags default false (FR-013). Implements FR-001, FR-013, FR-019, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-001, FR-013, FR-019, FR-020)
@apps/agent/src/core/coordinator.ts (TierCoordinator.executeSignal)
@apps/agent/src/core/fastpath-engine.ts (FastPathEngine)
@apps/agent/src/config.ts (fastPathEnabled, directLiteEnabled)

### Tasks
1. **Add FastPathEngine to Coordinator + executeSignal fast path**
   - Files: `src/core/coordinator.ts`, `src/core/coordinator.test.ts`
   - Action: In `Coordinator.init()`: if `CONFIG.fastPathEnabled`, construct FastPathEngine with PolicyTransport, BocTemplatePool, DirectLiteClient (if `directLiteEnabled`), tier keypair. New `executeSignal(signal)`:
     - If fastPathEnabled && fastPath.evaluateSignal(signal).ok → return fastPath.executeTrade(signal)
     - Else → existing cold path `executeForTier()`
   - Verify: Integration test — fast path taken when enabled+valid; cold path fallback when disabled/rejected

2. **Add policy version sync + health checks**
   - Action: Coordinator subscribes to PolicyTransport updates; on version change, logs "FastPath policy updated to v{N}". Health endpoint `/health/fastpath` returns `{enabled, policyVersion, circuitBreakerOpen, lastEvaluationMs}`.
   - Verify: Health endpoint returns correct state; policy version increments on update
```

### 1.4 — FastPath Radar Producer Integration
**Dependencies**: 1.3 | **Wave**: 6 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 01-04-radar-producer

### Objective
Connect Radar scanner to FastPath as signal producer. Radar emits `FastPathSignal` with producer="radar" for deterministic candidates. Implements FR-015, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-015, FR-020)
@apps/agent/src/radar/scanner.ts (Radar scanner loop)
@apps/agent/src/core/policy-types.ts (FastPathSignal)
@apps/agent/src/core/coordinator.ts (Coordinator.executeSignal)

### Tasks
1. **Add FastPathSignal emission to Radar**
   - Files: `src/radar/scanner.ts`, `src/radar/scanner.test.ts`
   - Action: When radar finds qualifying candidate (passes audit + confidence >= threshold), construct `FastPathSignal` with producer="radar", policyVersion from PolicyTransport.currentVersion. Call `coordinator.executeSignal(signal)`.
   - Verify: Radar emits signal with correct structure; coordinator receives; FastPath evaluates

2. **Add radar→FastPath metrics + tuning**
   - Action: Track `radarSignalsEmitted`, `radarSignalsAccepted`, `radarSignalsRejected`. Expose radar confidence threshold as `CONFIG.radarFastPathConfidenceThreshold` (default 0.85).
   - Verify: Metrics increment; threshold config drives acceptance rate
```

---

## Phase 2: Local SLM for Time-Critical Reasoning (P2)

### 2.1 — Local SLM Client (vLLM over Unix Socket)
**Dependencies**: 0.1 | **Wave**: 3 (parallel with 1.1) | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 02-01-local-slm-client

### Objective
Implement LocalSLMClient connecting to vLLM/TensorRT-LLM via Unix Domain Socket (or localhost:8000). Fallback to cloud LLM on failure. Implements FR-004, FR-005, FR-013, FR-014, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-004, FR-005, FR-013, FR-014, FR-020)
@apps/agent/src/ai/brain.ts (LangChain brain — cold path)
@apps/agent/src/ml/types.ts (PredictionService interface)
@apps/agent/src/config.ts (localSlmEnabled, slmSocketPath)

### Tasks
1. **Create LocalSLMClient with UDS + HTTP fallback**
   - Files: `src/ai/local-slm.ts`, `src/ai/local-slm.test.ts`
   - Action: 
     - `LocalSLMClient` constructor: `socketPath` (default `/tmp/vllm.sock`), `fallbackClient` (OpenAI-compatible cloud)
     - `reason(systemPrompt, userMessage)`: try UDS via custom fetch (or HTTP to localhost:8000/v1). Timeout 200ms. On success, return content. On failure/timeout, log warning, call `fallbackClient.reason()`.
     - Implement `PredictionService` interface for compatibility with ML module.
   - Verify: Unit test with mocked UDS success + failure → fallback; latency <50ms local, <2s fallback

2. **Add vLLM model config + health check**
   - Action: Config: `slmModel` (default "fin-1b-q4"), `slmMaxTokens` (256), `slmTemperature` (0.2). Health endpoint `/health/slm` returns `{available:boolean, model:string, lastLatencyMs:number, fallbackUsed:boolean}`.
   - Verify: Health endpoint reflects availability; model config respected
```

### 2.2 — Brain Integration: SLM for Time-Critical Reasoning
**Dependencies**: 2.1 | **Wave**: 4 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 02-02-brain-slm-integration

### Objective
Integrate LocalSLMClient into LangChain brain for time-critical reasoning tasks (bytecode analysis, news flash parsing). SLM is advisory only — brain makes final decision. Implements FR-004, FR-005, FR-013, FR-014, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-004, FR-005, FR-013, FR-014, FR-020)
@apps/agent/src/ai/brain.ts (ReAct agent)
@apps/agent/src/ai/local-slm.ts (LocalSLMClient)
@apps/agent/src/config.ts (localSlmEnabled, brainEnabled)

### Tasks
1. **Add SLM tool to brain's MCP toolset**
   - Files: `src/ai/brain.ts`, `src/mcp/tools.ts`
   - Action: New MCP tool `analyze_with_slm(input: {prompt:string, context:string})` → calls LocalSLMClient.reason(). Brain uses this for: "Analyze this bytecode for honeypot patterns in <100 words", "Summarize this news for trading impact". Tool only available when `localSlmEnabled && brainEnabled`.
   - Verify: Brain invokes SLM tool; response parsed; fallback to cloud logged

2. **Add SLM confidence gating + audit trail**
   - Action: SLM response includes `confidence` (0-1). Brain only acts on SLM output if confidence >= 0.7. All SLM interactions journaled to DecisionJournal with `source="slm"`, `confidence`, `latencyMs`.
   - Verify: Journal entries created; low-confidence SLM output ignored; audit trail complete
```

---

## Phase 3: ADNL Direct Lite Client Ingestion (P3)

### 3.1 — DirectLiteClient: Full ADNL Implementation
**Dependencies**: 0.1 | **Wave**: 3 (parallel) | **Tasks**: 3 | **Type**: execute

```markdown
## Plan: 03-01-direct-lite-client

### Objective
Replace placeholder DirectLiteClient with full `ton-lite-client` implementation. Connects to local TON full node lite server. Receives block updates <100ms. Implements FR-006, FR-007, FR-013, FR-014, FR-016, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-006, FR-007, FR-013, FR-014, FR-016, FR-020)
@apps/agent/src/core/direct-lite-client.ts (placeholder)
@apps/agent/.worktrees/live-monitor/apps/agent/src/core/direct-lite-client.test.ts (test patterns)
@apps/agent/package.json (add ton-lite-client dependency)
@apps/agent/src/config.ts (liteClientEnabled, directLiteEnabled, liteServerPk)

### Tasks
1. **Add ton-lite-client dependency + implement DirectLiteClient**
   - Files: `src/core/direct-lite-client.ts`, `src/core/direct-lite-client.test.ts`, `package.json`
   - Action: 
     - Add `ton-lite-client` to package.json
     - Implement `DirectLiteClient` using `LiteClient`, `LiteRoundRobinEngine`, `LiteSingleEngine` from ton-lite-client
     - Methods: `connect()`, `subscribeToBlocks(cb)`, `getAccountState(address)`, `sendRawMessage(boc)`, `getMasterchainInfo()`
     - Auto-reconnect with exponential backoff (100ms, 200ms, 500ms, 1s, 2s max)
     - Fallback to HTTP RPC (tonapi) on sustained ADNL failure (>10s)
   - Verify: Unit test with mocked lite server; connect/subscribe/send work; reconnection logic tested

2. **Add LocalNodeManager for embedded TON full node**
   - Files: `src/infra/local-node.ts`, `src/infra/local-node.test.ts`
   - Action: Manage `ton-node` process lifecycle. Config: `dataDir`, `liteServerPort` (default 3031), `liteServerPk` (from env). `start()` spawns node, waits for lite server ready. `stop()` SIGTERM + 5s grace.
   - Verify: Integration test (optional — requires ton-node binary); start/stop works; port binds

3. **Wire into Coordinator + config flags**
   - Files: `src/core/coordinator.ts`, `src/index.ts`, `src/config.ts`
   - Action: In `index.ts` main(): if `CONFIG.localNodeEnabled`, start LocalNodeManager. If `CONFIG.directLiteEnabled`, create DirectLiteClient with local node endpoint (or remote servers from `CONFIG.liteServers[]`). Pass to Coordinator. Coordinator uses for `getAccountState` (pool reserves) and `sendRawMessage` (FastPath).
   - Verify: Coordinator boots with lite client; health endpoint shows ADNL status
```

### 3.2 — Block Ingestion → FastPath Feed
**Dependencies**: 3.1, 1.1 | **Wave**: 5 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 03-02-block-ingestion-feed

### Objective
Subscribe DirectLiteClient to block updates; parse new pool reserves/state; push to FastPath for immediate evaluation. Implements FR-006, FR-007, FR-016, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-006, FR-007, FR-016, FR-020)
@apps/agent/src/core/direct-lite-client.ts (DirectLiteClient.subscribeToBlocks)
@apps/agent/src/core/fastpath-engine.ts (FastPathEngine)
@apps/agent/src/dex/router.ts (pool state parsing)

### Tasks
1. **Implement block handler → pool state extraction**
   - Files: `src/core/block-ingestion.ts`, `src/core/block-ingestion.test.ts`
   - Action: `BlockIngestion` class subscribes to DirectLiteClient. On new block: fetch affected pool account states (known pool addresses from router). Parse reserves, prices. Push `MarketUpdate {poolAddress, reserves, timestamp, blockSeqno}` to FastPathEngine via callback.
   - Verify: Mock block → pool state extracted; update pushed to FastPath callback

2. **FastPath consumes market updates for signal generation**
   - Files: `src/core/fastpath-engine.ts` (add `onMarketUpdate`), `src/core/fastpath-engine.test.ts`
   - Action: FastPathEngine registers callback with BlockIngestion. On `MarketUpdate`: recompute slippage for tracked pools, update internal cache. If radar signal pending for this pool, re-evaluate with fresh reserves.
   - Verify: Market update reduces slippage calc latency; re-evaluation uses fresh data
```

---

## Phase 4: TON Shard Proximity for Budgeting Wallet (P4)

### 4.1 — Shard Mining Library
**Dependencies**: 0.1 | **Wave**: 3 (parallel) | **Tasks**: 2 | **Type**: tdd

```markdown
## Plan: 04-01-shard-miner

### Objective
Implement address shard mining — generate keypairs until contract address falls in same shard as target DEX router. Implements FR-008, FR-009, FR-010, FR-013, FR-014, FR-017, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-008, FR-009, FR-010, FR-013, FR-014, FR-017, FR-020)
@apps/agent/src/wallet/agentic-wallet.ts (budgeting wallet deploy)
@apps/agent/src/wallet/wallet.ts (keypair generation)
@specs/001-ton-agent-orchestration/ultra-acceleration.md (§3A — shard-miner.ts reference)

### TDD Feature
- **Name**: ShardMiner
- **Files**: `src/wallet/shard-miner.ts`, `src/wallet/shard-miner.test.ts`
- **Behavior**:
  - `mineShardAddress(targetRouterAddress, maxAttempts=100000)` returns `{keyPair, address, shardPrefix, match:boolean}`
  - Shard prefix = high 16 bits of address hash (basechain workchain 0)
  - Match = generated address shardPrefix === target shardPrefix
  - Cap at maxAttempts; throw `SHARD_MINE_FAILED` if no match
  - Uses `@ton/crypto` keyPairFromSeed + `@ton/core` Address/contractAddress
- **Implementation**: Pure TS, no I/O. Deterministic given seed.

### Tasks
1. **RED: Write failing tests for mineShardAddress**
   - Action: Test cases: match found, no match within cap, target address parsing, shard prefix extraction correctness.
   - Verify: Tests fail (RED)

2. **GREEN+REFACTOR: Implement ShardMiner**
   - Action: Implement per behavior. Add `extractShardPrefix(address)`, `computeBudgetingAddress(publicKey, config)`. Config includes budgeting wallet code hash + init data.
   - Verify: Tests pass; finds match in <10000 attempts for typical targets; <500ms runtime
```

### 4.2 — Budgeting Wallet Deploy with Shard Mining
**Dependencies**: 4.1 | **Wave**: 4 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 04-02-wallet-shard-deploy

### Objective
Integrate shard mining into budgeting wallet deployment. Feature-flagged (SHARD_MINING_ENABLED). Implements FR-008, FR-009, FR-010, FR-013, FR-014, FR-017, FR-020.

### Context
@specs/003-ultra-acceleration/spec.md (FR-008, FR-009, FR-010, FR-013, FR-014, FR-017, FR-020)
@apps/agent/src/wallet/agentic-wallet.ts (deployBudgetingWallet)
@apps/agent/src/wallet/shard-miner.ts (ShardMiner)
@apps/agent/src/config.ts (shardMiningEnabled)

### Tasks
1. **Modify deployBudgetingWallet to mine shard address**
   - Files: `src/wallet/agentic-wallet.ts`, `src/wallet/agentic-wallet.test.ts`
   - Action: If `CONFIG.shardMiningEnabled`:
     - Get target router address from `CONFIG.shardTargetRouter` (default: Ston.fi mainnet router)
     - Call `mineShardAddress(targetRouter, 100000)`
     - If match: deploy with mined keypair; log "Shard match: wallet in same shard as router"
     - If no match: log warning; deploy with random keypair (fail-open)
   - Verify: Deploy uses mined key when enabled+match; random key when disabled/no-match

2. **Add shard proximity metrics + config**
   - Action: Track `shardMiningAttempts`, `shardMatchSuccess`, `shardMatchLatencyMs`. Config: `shardMiningMaxAttempts` (100000), `shardTargetRouter` (env).
   - Verify: Metrics recorded; config drives behavior; deploy works both paths
```

---

## Phase 5: Integration, Hardening & Acceptance Testing

### 5.1 — End-to-End Integration Test Suite
**Dependencies**: 1.3, 2.2, 3.2, 4.2 | **Wave**: 6 | **Tasks**: 3 | **Type**: execute

```markdown
## Plan: 05-01-integration-tests

### Objective
Validate all four acceleration pillars work together. Map to Success Criteria SC-001 through SC-006.

### Context
@specs/003-ultra-acceleration/spec.md (SC-001 through SC-006)
@apps/agent/test/**/*.test.ts (existing test patterns)

### Acceptance Criteria Mapping
| SC | Description | Test Approach |
|----|-------------|---------------|
| SC-001 | FastPath gate-pass rate ≥ 95% for pre-approved signals | Load test: 1000 valid signals → count accepts |
| SC-002 | FastPath evaluation ≤ 1ms p99 | Benchmark: 10000 evaluations → percentile |
| SC-003 | ADNL block ingestion ≤ 100ms from local node | Instrument: block.timestamp vs ingestion.timestamp |
| SC-004 | SLM inference ≤ 80ms p99 (local) | Benchmark: 100 local calls → percentile |
| SC-005 | Shard mining success ≥ 95% within 10k attempts | Statistical: 100 runs → success rate |
| SC-006 | Constitution gates pass: all trades through deterministic risk | Integration: kill-switch, circuit-breaker, policy-drift tests |

### Tasks
1. **Create integration test harness**
   - Files: `test/integration/ultra-acceleration.test.ts`, `test/integration/fixtures.ts`
   - Action: Spin up test coordinator with all flags enabled. Mock: ADNL client, SLM, tonapi. Inject synthetic market data + radar signals. Run full pipeline.
   - Verify: Test runs without external deps; all 4 pillars exercised

2. **Implement SC-001 through SC-006 test cases**
   - Action: One test per SC. Use `performance.now()` for latency. Use statistical assertions for rates.
   - Verify: All 6 tests pass; thresholds met

3. **Add Constitution gate regression tests**
   - Action: Test: FastPath rejects when kill-switch active; circuit breaker trips after 3 failures; stale policy rejected; HITL gate unchanged; Fail-closed on any error.
   - Verify: All Constitution principles validated in integration
```

### 5.2 — Performance Benchmarks & Observability
**Dependencies**: 5.1 | **Wave**: 7 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 05-02-benchmarks-observability

### Objective
Produce benchmark results for all latency targets. Add production observability (metrics, logging, health endpoints).

### Context
@specs/003-ultra-acceleration/spec.md (Performance Targets table)
@apps/agent/src/logger.ts (structured logging)
@apps/agent/src/metrics/ (if exists) or new metrics module

### Tasks
1. **Add metrics + structured logging for all hot paths**
   - Files: `src/metrics/ultra.ts`, `src/core/fastpath-engine.ts`, `src/ai/local-slm.ts`, `src/core/direct-lite-client.ts`, `src/wallet/shard-miner.ts`
   - Action: Export `UltraMetrics` with counters/histograms for: `fastpath.eval.latency`, `fastpath.exec.latency`, `adnl.block.ingestion.latency`, `slm.inference.latency`, `shard.mining.latency`, `shard.mining.attempts`. Log at INFO: policy version changes, circuit breaker state, shard match result.
   - Verify: Metrics exported; logs structured; dashboard-ready

2. **Run benchmarks + document results**
   - Files: `benchmarks/ultra-acceleration.md` (output)
   - Action: Script `npm run bench:ultra` runs 10k iterations per hot path. Records p50/p95/p99. Compares against targets table. Outputs markdown table.
   - Verify: Benchmarks run; results documented; all targets met or gaps identified
```

### 5.3 — Documentation & Rollout Guide
**Dependencies**: 5.2 | **Wave**: 8 | **Tasks**: 2 | **Type**: execute

```markdown
## Plan: 05-03-docs-rollout

### Objective
Operator-facing documentation: feature flag guide, rollout checklist, troubleshooting.

### Context
@specs/003-ultra-acceleration/spec.md (FR-013 flags default false)
@apps/agent/src/config.ts (all ultra flags)
@apps/agent/README.md (if exists)

### Tasks
1. **Create ULTRA_ACCELERATION.md operator guide**
   - Files: `docs/ULTRA_ACCELERATION.md`
   - Action: Document each flag (FAST_PATH_ENABLED, LOCAL_SLM_ENABLED, LITE_CLIENT_ENABLED, DIRECT_LITE_ENABLED, SHARD_MINING_ENABLED). Prerequisites per flag (local node, vLLM, GPU). Rollout sequence: 1) FastPath only, 2) +SLM, 3) +ADNL, 4) +Shard. Troubleshooting: circuit breaker, stale policy, ADNL reconnection, shard mining timeout.
   - Verify: Guide complete; all flags documented; prerequisites clear

2. **Add feature flag validation at startup**
   - Files: `src/index.ts`, `src/config.ts`
   - Action: On boot, validate flag combinations: `DIRECT_LITE_ENABLED` requires `LITE_CLIENT_ENABLED`; `SHARD_MINING_ENABLED` requires `FAST_PATH_ENABLED` (for router address). Warn on invalid combos.
   - Verify: Startup logs flag validation; invalid combos warned
```

---

## Dependency Graph & Wave Structure

```
Wave 1 (Parallel — Foundation):
  00-01-policy-matrix-transport     ← no deps
  02-01-local-slm-client            ← 0.1 (config only)
  03-01-direct-lite-client          ← 0.1 (config only)
  04-01-shard-miner                 ← 0.1 (config only)

Wave 2:
  00-02-boc-template-pool           ← 0.1

Wave 3 (Parallel — Core Engines):
  01-01-fastpath-engine-core (TDD)  ← 0.1, 0.2
  02-01-local-slm-client (done)
  03-01-direct-lite-client (done)
  04-01-shard-miner (TDD, done)

Wave 4 (Parallel — Execution + Integration):
  01-02-fastpath-execution          ← 1.1
  02-02-brain-slm-integration       ← 2.1
  03-02-block-ingestion-feed        ← 3.1, 1.1
  04-02-wallet-shard-deploy         ← 4.1

Wave 5:
  01-03-coordinator-integration     ← 1.1, 1.2
  01-04-radar-producer              ← 1.3

Wave 6:
  05-01-integration-tests           ← 1.3, 2.2, 3.2, 4.2

Wave 7:
  05-02-benchmarks-observability    ← 5.1

Wave 8:
  05-03-docs-rollout                ← 5.2
```

**Parallelization Notes**:
- Wave 1: 4 plans, zero file overlap → full parallel
- Wave 3: 1.1 (TDD) + 2.1/3.1/4.1 (done in Wave 1) → 1.1 runs alone
- Wave 4: 4 plans, distinct file sets → full parallel
- Waves 5-8: Sequential due to integration dependencies

---

## Must-Haves (Goal-Backward Verification)

### Truths (Observable Outcomes)
1. **FastPath evaluates pre-approved signals in <1ms** — operator sees trade executed before cold path would respond
2. **BOC mutation + send completes in <5ms** — no full cell rebuild on hot path
3. **ADNL block updates received <100ms from local node** — no HTTP RPC polling lag
4. **Local SLM responds in <80ms p99** — time-critical reasoning doesn't block cold path
5. **Shard mining finds same-shard address in >95% of runs** — wallet deploys near target router
6. **All Constitution gates pass** — kill-switch, circuit-breaker, policy-drift, HITL, fail-closed all functional

### Artifacts (Files That Must Exist)
| Path | Provides | Min Lines |
|------|----------|-----------|
| `src/core/policy-transport.ts` | Policy matrix shared memory + versioning | 80 |
| `src/dex/boc-template.ts` | Pre-built BOC templates + mutate | 150 |
| `src/core/fastpath-engine.ts` | FastPath evaluation + execution | 200 |
| `src/ai/local-slm.ts` | Local SLM client + fallback | 120 |
| `src/core/direct-lite-client.ts` | ADNL lite client wrapper | 180 |
| `src/infra/local-node.ts` | Local TON node lifecycle | 100 |
| `src/core/block-ingestion.ts` | Block → market update pipeline | 100 |
| `src/wallet/shard-miner.ts` | Address shard mining | 120 |
| `src/wallet/agentic-wallet.ts` | Shard-aware deploy (modified) | +50 |
| `src/core/coordinator.ts` | FastPath integration (modified) | +80 |
| `src/radar/scanner.ts` | Radar → FastPath producer (modified) | +40 |
| `src/ai/brain.ts` | SLM tool integration (modified) | +40 |

### Key Links (Critical Connections)
| From | To | Via | Pattern |
|------|-----|-----|---------|
| `policy-transport.ts` | `fastpath-engine.ts` | `PolicyTransport.subscribe()` | `transport\.subscribe\(` |
| `boc-template.ts` | `fastpath-engine.ts` | `BocTemplatePool.getTemplate()` | `bocPool\.getTemplate\(` |
| `direct-lite-client.ts` | `fastpath-engine.ts` | `DirectLiteClient.sendRawMessage()` | `liteClient\.sendRawMessage\(` |
| `block-ingestion.ts` | `fastpath-engine.ts` | `BlockIngestion.onMarketUpdate()` | `ingestion\.onMarketUpdate\(` |
| `shard-miner.ts` | `agentic-wallet.ts` | `mineShardAddress()` | `mineShardAddress\(` |
| `local-slm.ts` | `brain.ts` | `LocalSLMClient.reason()` | `slm\.reason\(` |
| `radar/scanner.ts` | `coordinator.ts` | `coordinator.executeSignal()` | `coordinator\.executeSignal\(` |

---

## Threat Model (STRIDE)

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-003-01 | Spoofing | FastPath signal injection | Mitigate | Policy version check; only pre-approved producers |
| T-003-02 | Tampering | BOC template corruption | Mitigate | CRC32 on template; reject on mismatch |
| T-003-03 | Repudiation | SLM advisory output | Accept | SLM output journaled; not authoritative |
| T-003-04 | Info Disclosure | Shard mining target address | Accept | Public router address; no secret leaked |
| T-003-05 | DoS | ADNL connection flood | Mitigate | Rate-limit subscribe; backoff on errors |
| T-003-06 | Elevation | FastPath bypasses risk gates | Mitigate | FastPath ONLY reads policy; gates in evaluateSignal |
| T-003-SC | Supply Chain | `ton-lite-client` npm install | Mitigate | Package legitimacy audit in RESEARCH.md; human checkpoint for [ASSUMED] |

---

## Package Legitimacy Audit Required

Before Wave 1 execution (plan 03-01 adds `ton-lite-client`):

```markdown
## Package Legitimacy Audit (RESEARCH.md)

| Package | Version | Source | Disposition | Verification |
|---------|---------|--------|-------------|--------------|
| ton-lite-client | latest | npm | [ASSUMED] | Check: npmjs.com/package/ton-lite-client → maintainer @ton-core, weekly downloads >1k, no malware flags |
```

**Human checkpoint required** before `npm install ton-lite-client` — verify package legitimacy.

---

## User Setup Required

```yaml
user_setup:
  - service: vLLM
    why: Local SLM inference for time-critical reasoning
    env_vars:
      - name: SLM_SOCKET_PATH
        default: "/tmp/vllm.sock"
      - name: SLM_MODEL
        default: "fin-1b-q4"
    dashboard_config:
      - task: "Deploy vLLM with quantized financial model"
        location: "Docker Compose: services.vllm"
      - task: "Mount model weights volume"
        location: "docker-compose.yml volumes"
  
  - service: TON Full Node
    why: ADNL lite server for direct block ingestion
    env_vars:
      - name: LITE_SERVER_PK
        source: "Local node config: lite-server public key (base64)"
      - name: LITE_SERVER_PORT
        default: "3031"
    dashboard_config:
      - task: "Run ton-node with --liteserver flag"
        location: "LocalNodeManager.start()"
      - task: "Configure lite server port + key"
        location: "ton-node config.json"
```

---

## Success Criteria Verification

| SC | Target | Verification Method | Plan |
|----|--------|---------------------|------|
| SC-001 | FastPath gate-pass ≥ 95% | Integration test: 1000 valid signals | 05-01 |
| SC-002 | FastPath eval ≤ 1ms p99 | Benchmark: 10000 evaluations | 05-02 |
| SC-003 | ADNL ingestion ≤ 100ms | Instrumented block.timestamp diff | 05-02 |
| SC-004 | SLM inference ≤ 80ms p99 | Benchmark: 100 local calls | 05-02 |
| SC-005 | Shard mining ≥ 95% success | Statistical: 100 runs | 05-01 |
| SC-006 | Constitution gates pass | Regression test suite | 05-01 |

---

## Execution Order Summary

```bash
# Phase 0: Foundation
/gsd:execute-phase 00-01-policy-matrix-transport
/gsd:execute-phase 00-02-boc-template-pool

# Phase 1: FastPath (P1)
/gsd:execute-phase 01-01-fastpath-engine-core      # TDD
/gsd:execute-phase 01-02-fastpath-execution
/gsd:execute-phase 01-03-coordinator-integration
/gsd:execute-phase 01-04-radar-producer

# Phase 2: Local SLM (P2) — can run parallel with Phase 1 Wave 3-4
/gsd:execute-phase 02-01-local-slm-client
/gsd:execute-phase 02-02-brain-slm-integration

# Phase 3: ADNL (P3) — can run parallel with Phase 1 Wave 3-4
/gsd:execute-phase 03-01-direct-lite-client
/gsd:execute-phase 03-02-block-ingestion-feed

# Phase 4: Shard Mining (P4) — can run parallel with Phase 1 Wave 3-4
/gsd:execute-phase 04-01-shard-miner               # TDD
/gsd:execute-phase 04-02-wallet-shard-deploy

# Phase 5: Integration & Rollout
/gsd:execute-phase 05-01-integration-tests
/gsd:execute-phase 05-02-benchmarks-observability
/gsd:execute-phase 05-03-docs-rollout
```

---

## Output

Each plan creates `.planning/phases/03-ultra-acceleration/{plan-id}-SUMMARY.md` on completion.

**Next**: Run `/gsd:execute-phase 00-01-policy-matrix-transport` to begin.