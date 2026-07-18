# Ultra-Acceleration Architecture for TAOF
## Aligning Extreme Latency Optimization with the Existing TON Agent Orchestration Framework

**Date**: 2026-07-18  
**Status**: Design Document  
**Input**: ChatGPT conversation alignment + existing TAOF spec/plan/codebase

---

## Executive Summary

The existing TAOF already implements a Cold Path / Hot Path decoupling via:
- Cold Path: apps/agent/src/ai/brain.ts — LangChain ReAct agent with Claude/GPT-4o (500ms–2s)
- Hot Path: apps/agent/src/core/coordinator.ts + dex/router.ts + risk/guardrails.ts — native TypeScript execution (<50ms)

This document extends that architecture with four ultra-advanced acceleration techniques that push the framework to the theoretical limits of what is possible on TON's Catchain 2.0 infrastructure.

Critical Alignment: All acceleration techniques must preserve the Constitution's core principles:
- I. Deterministic Risk Core — LLM cannot bypass safety caps
- V. Fail Closed — any latency optimization failure resolves to NO TRADE

---

## 1. Cold Path / Hot Path Decoupling — Deepening the Split

### Current TAOF Architecture

[ LangChain Brain (ai/brain.ts) ]
    │  LLM calls MCP tools
    ▼
[ MCP Tools (mcp/tools.ts) ]
    │  validate + route
    ▼
[ Coordinator (core/coordinator.ts) ]
    │  gate checks
    ▼
[ DEX Router (dex/router.ts) ]
    │  execute
    ▼
[ TON RPC (http/tonapi.ts) ]

### Ultra-Accelerated Architecture

┌─────────────────────────────────────────────────────────────────────┐
│  COLD PATH (Intelligence) — Async, ~500ms-2s                       │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │ LangChain   │    │ Local SLM   │    │ Policy Matrix Store     │ │
│  │ Brain       │    │ (Unix Socket│    │ (Redis / SharedMemory)  │ │
│  │ (brain.ts)  │    │  / IPC)     │    │                         │ │
│  └──────┬──────┘    └──────┬──────┘    └───────────┬─────────────┘ │
│         │                  │                       │                │
│         └──────────────────┼───────────────────────┘                │
│                            │  PUSH: dynamic trading policies        │
└────────────────────────────┼───────────────────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────────────────┐
│  HOT PATH (Execution) — Sync, <1ms target                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  FastPath Engine (NEW: core/fastpath.ts)                     │   │
│  │  • Rust/Go FFI bridge OR pure-Node optimized loop            │   │
│  │  • Reads policy matrix from shared memory                    │   │
│  │  • Evaluates raw data feeds against active policy            │   │
│  │  • Executes orders via pre-built BOC buffer                  │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │                                      │
│  ┌──────────────────────────▼──────────────────────────────────┐   │
│  │  Direct ADNL Ingestion (NEW: infra/liteclient/)              │   │
│  │  • ton-lite-client over TCP/ADNL                             │   │
│  │  • Receives block updates <100ms from local full node        │   │
│  │  • Feeds raw market data to FastPath                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘

### Concrete Implementation Changes

#### New File: apps/agent/src/core/fastpath.ts

```typescript
/**
 * FastPath Engine — hot-path execution loop.
 *
 * This module runs as a separate high-priority worker thread or
 * child process. It NEVER calls LLM APIs. It reads:
 *   1. Policy matrix from shared memory (or Redis)
 *   2. Raw market data from ADNL lite client subscription
 *   3. Pre-built BOC templates from memory pool
 *
 * It writes:
 *   1. Signed transactions to ADNL lite client for broadcast
 *   2. Execution logs to SQLite (async, non-blocking)
 */

export interface TradingPolicy {
  maxPositionTon: number;        // e.g. 0.5
  minLiquidityUsd: number;       // e.g. 15000
  maxSlippageBps: number;        // e.g. 150 (1.5%)
  allowedDexes: Dex[];           // ['stonfi', 'dedust']
  blockedTokens: string[];       // honeypot blacklist
  updatedAt: number;             // policy version timestamp
}

export interface FastPathSignal {
  tokenAddress: string;
  poolAddress: string;
  side: 'buy' | 'sell';
  amountTon: number;
  confidence: number;            // 0-100, from radar scoring
  policyVersion: number;
}

export class FastPathEngine {
  private policy: TradingPolicy;
  private bocPool: Map<string, Buffer>;  // pre-built BOC templates
  private adnlClient: LiteClient;        // direct lite client
  
  /**
   * Evaluate a signal against the active policy.
   * Returns true if execution should proceed.
   * Target latency: <1ms for this function.
   */
  evaluateSignal(signal: FastPathSignal): { ok: boolean; reason?: string } {
    // 1. Policy version check (stale policy = reject)
    // 2. Position size check
    // 3. Slippage check (pre-calculated from pool reserves)
    // 4. DEX allowlist check
    // 5. Token blacklist check
    // All operations are pure TS, no I/O
  }
  
  /**
   * Execute a trade using pre-built BOC.
   * Overwrites only the dynamic fields (amount, min_out).
   * Target latency: <5ms for BOC mutation + ADNL send.
   */
  async executeTrade(signal: FastPathSignal): Promise<TxResult> {
    const bocTemplate = this.bocPool.get(signal.poolAddress);
    if (!bocTemplate) return { ok: false, error: 'NO_BOC_TEMPLATE' };
    
    // Mutate BOC in-place (byte offsets for amount + min_out)
    const boc = this.mutateBoc(bocTemplate, signal);
    
    // Send via ADNL lite client
    return await this.adnlClient.sendRawMessage(boc);
  }
}
```

#### Modified File: apps/agent/src/core/coordinator.ts

Add FastPath integration:

```typescript
// In TierCoordinator class:
private fastPath?: FastPathEngine;

async init(): Promise<void> {
  // ... existing tier init ...
  
  // Initialize FastPath if enabled
  if (CONFIG.fastPathEnabled) {
    this.fastPath = new FastPathEngine(/* ... */);
    await this.fastPath.start();
    log.ok('COORD', 'FastPath engine started (hot path active)');
  }
}

/**
 * New execution path: FastPath bypasses LLM for pre-approved signals.
 * Falls back to cold path if FastPath is disabled or signal is rejected.
 */
async executeSignal(signal: FastPathSignal): Promise<TxResult> {
  if (this.fastPath && CONFIG.fastPathEnabled) {
    const result = this.fastPath.evaluateSignal(signal);
    if (result.ok) {
      return await this.fastPath.executeTrade(signal);
    }
  }
  
  // Cold path fallback
  return await this.executeForTier(signal.tier, { ... });
}
```

---

## 2. Localized Edge SLMs over Unix Sockets

### Design

When the cold path must reason on hot-path data (e.g., parsing a new contract bytecode, analyzing a breaking news flash), use a local quantized SLM instead of cloud API.

[ FastPath / Coordinator ]
         │
         │ Unix Domain Socket (/tmp/vllm.sock)
         ▼
[ vLLM / TensorRT-LLM ]
    (local GPU/CPU, quantized 1B-3B model)

### New File: apps/agent/src/ai/local-slm.ts

```typescript
import { OpenAI } from 'openai';

/**
 * Local SLM client — connects to vLLM/TensorRT-LLM via Unix Domain Socket.
 * Falls back to cloud LLM if local model is unavailable.
 */
export class LocalSLMClient {
  private client: OpenAI;
  private socketPath: string;
  
  constructor(socketPath = '/tmp/vllm.sock') {
    this.socketPath = socketPath;
    this.client = new OpenAI({
      baseURL: `http://localhost:8000/v1`,  // vLLM OpenAI-compatible API
      // Or for UDS: use custom fetch with unix socket
    });
  }
  
  async reason(systemPrompt: string, userMessage: string): Promise<string> {
    try {
      const start = performance.now();
      const response = await this.client.chat.completions.create({
        model: 'fin-1b-q4',  // quantized financial SLM
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 256,  // keep short for latency
      });
      const latency = performance.now() - start;
      log.perf('SLM', `inference=${latency.toFixed(0)}ms`);
      return response.choices[0]?.message?.content ?? '';
    } catch (e) {
      log.warn('SLM', 'Local model unavailable, falling back to cloud');
      return this.fallbackToCloud(systemPrompt, userMessage);
    }
  }
}
```

### vLLM Docker Service (add to docker-compose.yml)

```yaml
services:
  agent:
    # ... existing agent service ...
    
  vllm:
    image: vllm/vllm-openai:latest
    command: >
      --model /models/fin-1b-q4
      --served-model-name fin-1b-q4
      --max-model-len 4096
      --gpu-memory-utilization 0.8
      --port 8000
      --host 127.0.0.1
    volumes:
      - ./models:/models:ro
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    networks:
      - agent-private
```

### Integration in brain.ts

```typescript
import { LocalSLMClient } from '../ai/local-slm';

const slm = new LocalSLMClient();

// Use SLM for time-critical reasoning inside the ReAct loop:
// "Analyze this bytecode for honeypot patterns — respond in <100 words"
```

---

## 3. TON Cryptographic & Shard Optimization

### 3A. Wallet Shard Mining

Concept: Before deploying the budgeting wallet contract, generate keypairs until the resulting address falls into the same shard as the target DEX router.

#### New File: apps/agent/src/wallet/shard-miner.ts

```typescript
import { KeyPair, keyPairFromSeed } from '@ton/crypto';
import { Address, beginCell, cell, hash, workchain } from '@ton/core';

export interface ShardMiningResult {
  keyPair: KeyPair;
  address: string;
  shardPrefix: number;
  targetShardPrefix: number;
  match: boolean;
}

/**
 * Mine a contract address that matches the target shard prefix.
 * TON shards are determined by the first bits of the account_id (SHA256 of StateInit).
 * For basechain (workchain 0), shard prefixes are 64-bit masks.
 */
export async function mineShardAddress(
  targetAddress: string,
  maxAttempts = 100000
): Promise<ShardMiningResult> {
  const target = Address.parse(targetAddress);
  const targetShard = extractShardPrefix(target);
  
  for (let i = 0; i < maxAttempts; i++) {
    const keyPair = await keyPairFromSeed(generateRandomSeed());
    const address = computeContractAddress(keyPair.publicKey);
    const shard = extractShardPrefix(address);
    
    if (shard === targetShard) {
      return { keyPair, address: address.toString(), shardPrefix: shard, targetShardPrefix: targetShard, match: true };
    }
  }
  
  throw new Error(`SHARD_MINE_FAILED — no match in ${maxAttempts} attempts`);
}

function extractShardPrefix(addr: Address): number {
  // For basechain, shard is derived from the first bits of account_id
  // after the workchain byte. Simplified: return high 16 bits.
  const buf = Buffer.from(addr.hash);  // 32 bytes
  return (buf[0] << 8) | buf[1];
}

function computeContractAddress(publicKey: Buffer): Address {
  // Simplified: in reality, this depends on the full StateInit (code + data)
  const stateInit = buildBudgetingStateInit(publicKey);
  const hash256 = hash(stateInit);
  return new Address(0, hash256);  // workchain 0
}
```

#### Integration in wallet/agentic-wallet.ts

```typescript
import { mineShardAddress } from './shard-miner';

export async function deployWithShardMining(
  targetRouterAddress: string,
  config: BudgetingConfig
): Promise<DeployResult> {
  log.info('WALLET', 'Starting shard mining for address proximity...');
  const result = await mineShardAddress(targetRouterAddress);
  
  if (result.match) {
    log.ok('WALLET', `Shard match! Agent wallet will live in same shard as router`);
  } else {
    log.warn('WALLET', 'No exact shard match, using closest available');
  }
  
  // Deploy with the mined keypair
  return deployBudgetingWallet(result.keyPair, config);
}
```

### 3B. Pre-Cached BOC Construction

Concept: Pre-build standard transaction BOC templates at startup. When executing, only overwrite the dynamic byte offsets.

#### New File: apps/agent/src/dex/boc-template.ts

```typescript
import { beginCell, Cell, Address, toNano } from '@ton/core';

export interface BocTemplate {
  name: string;
  template: Buffer;        // pre-serialized BOC
  offsets: {
    amount: number;         // byte offset for amount field
    minOut: number;         // byte offset for min_out field
    deadline: number;       // byte offset for deadline/lt
  };
}

export class BocTemplatePool {
  private templates = new Map<string, BocTemplate>();
  
  /**
   * Pre-build BOC templates for known pools at startup.
   * Call this during coordinator.init().
   */
  async prebuildForPools(pools: PoolAddress[]): Promise<void> {
    for (const pool of pools) {
      const template = this.buildSwapBoc(pool);
      this.templates.set(pool.address, template);
    }
    log.ok('BOC', `Pre-built ${this.templates.size} BOC templates`);
  }
  
  /**
   * Get a template for a pool, or fall back to dynamic build.
   */
  getTemplate(poolAddress: string): BocTemplate | undefined {
    return this.templates.get(poolAddress);
  }
  
  /**
   * Build a swap BOC template with fixed structure.
   * The dynamic fields (amount, min_out) are at known byte offsets.
   */
  private buildSwapBoc(pool: PoolAddress): BocTemplate {
    // Build the message body with placeholder values
    const body = beginCell()
      .storeUint(0x73625d3c, 32)       // opcode for Ston.fi swap
      .storeUint(0, 64)                // amount (placeholder)
      .storeUint(0, 64)                // min_out (placeholder)
      .storeUint(0, 64)                // deadline (placeholder)
      .storeAddress(pool.routerAddress)
      .storeCoins(toNano('0.05'))      // gas (fixed)
      .endCell();
    
    const boc = body.toBoc({ idx: false, crc32: false });
    
    // Calculate byte offsets for dynamic fields
    // This requires analyzing the serialized BOC structure
    const offsets = this.calculateOffsets(body);
    
    return {
      name: `stonfi-${pool.address.slice(0, 8)}`,
      template: boc,
      offsets,
    };
  }
  
  private calculateOffsets(cell: Cell): { amount: number; minOut: number; deadline: number } {
    // Analyze the serialized BOC to find exact byte offsets
    // This is a simplified version — in practice, use the BOC format spec
    return {
      amount: 4 + 8,      // after magic (4 bytes) + opcode (8 bytes)
      minOut: 4 + 8 + 8,  // after amount
      deadline: 4 + 8 + 8 + 8,  // after min_out
    };
  }
}

/**
 * Mutate a pre-built BOC template with actual trade values.
 * This is a raw memory operation — no cell rebuilding.
 */
export function mutateBoc(
  template: Buffer,
  amount: bigint,
  minOut: bigint,
  deadline: number
): Buffer {
  const boc = Buffer.from(template);  // copy
  
  // Write amount at offset
  boc.writeBigUInt64LE(amount, template.offsets.amount);
  
  // Write min_out at offset
  boc.writeBigUInt64LE(minOut, template.offsets.minOut);
  
  // Write deadline at offset
  boc.writeBigUInt64LE(BigInt(deadline), template.offsets.deadline);
  
  return boc;
}
```

---

## 4. Infrastructure Plumbing: High-Speed Lite Clients

### Design

Replace HTTP JSON-RPC (http/tonapi.ts) with direct ADNL Lite Client connections for sub-100ms block ingestion.

#### New Directory: apps/agent/src/infra/

#### New File: apps/agent/src/infra/liteclient.ts

```typescript
import { LiteClient, LiteSingleEngine, LiteRoundRobinEngine } from 'ton-lite-client';

export interface LiteClientConfig {
  servers: LiteServerConfig[];
  network: 'mainnet' | 'testnet';
}

export interface LiteServerConfig {
  host: string;
  port: number;
  publicKey: string;  // base64 Ed25519
}

/**
 * Direct ADNL Lite Client — bypasses HTTP RPC entirely.
 * Receives block updates the moment the local node processes them.
 */
export class DirectLiteClient {
  private client: LiteClient;
  private subscriptionHandle?: any;
  
  constructor(private config: LiteClientConfig) {
    const engines = config.servers.map(s => 
      new LiteSingleEngine({
        host: `tcp://${s.host}:${s.port}`,
        publicKey: Buffer.from(s.publicKey, 'base64'),
      })
    );
    const engine = new LiteRoundRobinEngine(engines);
    this.client = new LiteClient({ engine });
  }
  
  async connect(): Promise<void> {
    await this.client.getMasterchainInfo();
    log.ok('LITECLIENT', 'Connected via ADNL');
  }
  
  /**
   * Subscribe to new block updates.
   * Callback fires within milliseconds of block production.
   */
  subscribeToBlocks(callback: (block: BlockUpdate) => void): void {
    this.subscriptionHandle = setInterval(async () => {
      const info = await this.client.getMasterchainInfo();
      callback({
        seqno: info.last.seqno,
        shard: info.last.shard,
        timestamp: Date.now(),
      });
    }, 100);  // poll at 100ms — faster than any HTTP RPC indexer
  }
  
  /**
   * Get account state directly from lite server.
   * No HTTP overhead, no third-party indexer lag.
   */
  async getAccountState(address: string, block?: BlockId): Promise<AccountState> {
    const addr = Address.parse(address);
    const masterInfo = await this.client.getMasterchainInfo();
    return await this.client.getAccountState(addr, masterInfo.last);
  }
  
  /**
   * Send raw message directly to the network.
   */
  async sendRawMessage(boc: Buffer): Promise<TxHash> {
    // Use the lite client to send the message
    // This goes directly to the node, not through an HTTP API
    const result = await this.client.sendRawMessage(boc);
    return result;
  }
}
```

#### New File: apps/agent/src/infra/local-node.ts

```typescript
import { spawn, ChildProcess } from 'child_process';
import { DirectLiteClient } from './liteclient';

/**
 * Manages a local TON full node process for direct block ingestion.
 */
export class LocalNodeManager {
  private nodeProcess?: ChildProcess;
  
  async start(dataDir: string): Promise<void> {
    log.info('NODE', 'Starting local TON full node...');
    
    this.nodeProcess = spawn('ton-node', [
      '-C', `${dataDir}/config.json`,
      '-D', `${dataDir}/db`,
      '--liteserver',
      '--liteserver-port', '3031',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    this.nodeProcess.stdout?.on('data', (data) => {
      log.debug('NODE', data.toString());
    });
    
    this.nodeProcess.stderr?.on('data', (data) => {
      log.warn('NODE', data.toString());
    });
    
    // Wait for node to be ready
    await this.waitForNodeReady();
    log.ok('NODE', 'Local TON node is ready');
  }
  
  async stop(): Promise<void> {
    if (this.nodeProcess) {
      this.nodeProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  private async waitForNodeReady(): Promise<void> {
    // Poll the lite server port until it responds
    const maxRetries = 60;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const client = new DirectLiteClient({
          servers: [{ host: '127.0.0.1', port: 3031, publicKey: process.env.LITE_SERVER_PK! }],
          network: 'mainnet',
        });
        await client.connect();
        return;
      } catch (e) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    throw new Error('NODE_STARTUP_TIMEOUT');
  }
}
```

#### Modified File: apps/agent/src/index.ts

```typescript
import { LocalNodeManager } from './infra/local-node';
import { DirectLiteClient } from './infra/liteclient';

// In main():
async function main() {
  // ... existing init ...
  
  // Start local node if configured
  if (CONFIG.localNodeEnabled) {
    const nodeManager = new LocalNodeManager();
    await nodeManager.start(CONFIG.dataDir);
    
    const liteClient = new DirectLiteClient({
      servers: [{ host: '127.0.0.1', port: 3031, publicKey: CONFIG.liteServerPk }],
      network: CONFIG.network,
    });
    await liteClient.connect();
    
    // Replace HTTP-based tonapi with direct lite client
    global.liteClient = liteClient;
  }
}
```

---

## 5. Complete File Change Map

### New Files

| File | Purpose | Priority |
|------|---------|----------|
| apps/agent/src/core/fastpath.ts | Hot path execution engine with policy matrix | P0 |
| apps/agent/src/ai/local-slm.ts | Local SLM client over Unix socket | P1 |
| apps/agent/src/wallet/shard-miner.ts | Address shard mining for DEX proximity | P1 |
| apps/agent/src/dex/boc-template.ts | Pre-built BOC template pool | P0 |
| apps/agent/src/infra/liteclient.ts | Direct ADNL lite client wrapper | P0 |
| apps/agent/src/infra/local-node.ts | Local TON full node lifecycle manager | P0 |
| apps/agent/test/fastpath.test.ts | FastPath engine unit tests | P0 |
| apps/agent/test/shard-miner.test.ts | Shard mining logic tests | P1 |
| apps/agent/test/boc-template.test.ts | BOC template pre-build + mutate tests | P0 |
| apps/agent/test/local-slm.test.ts | Local SLM fallback tests | P1 |

### Modified Files

| File | Changes |
|------|---------|
| apps/agent/src/core/coordinator.ts | Add FastPath integration, policy matrix sync, lite client init |
| apps/agent/src/ai/brain.ts | Add LocalSLMClient for time-critical reasoning |
| apps/agent/src/wallet/agentic-wallet.ts | Add shard mining on deploy |
| apps/agent/src/dex/router.ts | Use BOC templates for swap execution |
| apps/agent/src/index.ts | Boot local node + lite client before coordinator |
| apps/agent/src/config.ts | Add fastPathEnabled, localNodeEnabled, liteServerPk, slmSocketPath |
| apps/agent/package.json | Add ton-lite-client dependency |
| docker-compose.yml | Add vLLM service for local SLM |
| Dockerfile | Add GPU support, local node binary |
| Acton.toml | No changes needed |

---

## 6. Performance Targets & Validation

### Target Latencies (Post-Optimization)

| Operation | Current | Target | Technique |
|-----------|---------|--------|-----------|
| LLM reasoning | 500ms-2s | 500ms-2s | Unchanged (cold path) |
| Local SLM inference | N/A | <80ms | vLLM + Unix socket |
| Risk gate evaluation | <50ms | <1ms | FastPath engine |
| BOC mutation | ~5ms | <1ms | Pre-built template + byte offset overwrite |
| Block ingestion | ~500ms (HTTP RPC) | <100ms | ADNL lite client |
| Shard-local TX routing | ~1-2s (cross-shard) | <500ms | Shard mining |
| End-to-end trade (cold path) | ~2-5s | ~1-2s | Combined optimizations |
| End-to-end trade (hot path) | N/A | <200ms | FastPath + local SLM |

### Validation Checklist

- [ ] FastPath engine evaluates signals in <1ms (unit test with mocked policy)
- [ ] BOC template mutate + serialize in <1ms (benchmark)
- [ ] ADNL lite client receives block update within 100ms of local node processing
- [ ] Shard mining finds matching address within 10,000 attempts (statistically guaranteed for reasonable targets)
- [ ] Local SLM fallback triggers within 500ms on unavailability
- [ ] Constitution gates still pass: all trades go through deterministic risk checks
- [ ] Kill-switch still trips within 30s grace window
- [ ] Circuit breaker still trips after 3 consecutive failures

---

## 7. Risk & Safety Analysis

### New Attack Surfaces

| Risk | Mitigation |
|------|-----------|
| FastPath bypasses LLM safety checks | FastPath only runs pre-approved policies pushed by cold path; policy updates still require LLM approval |
| Local SLM produces incorrect reasoning | Fallback to cloud LLM on confidence threshold; SLM outputs are advisory only |
| Shard mining wastes CPU | Cap at 10,000 attempts; log and fall back to random address |
| ADNL connection drops | Auto-reconnect with exponential backoff; fallback to HTTP RPC |
| BOC template corruption | CRC32 check on template; reject if mismatch |

### Constitution Gate Re-Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Risk Core | PASS | FastPath policy is set by cold path; risk checks remain deterministic |
| II. Least-Privilege Custody | PASS | Shard mining only affects address, not key security |
| III. Containment Over Filtering | PASS | FastPath tools are scoped to pre-approved policy |
| IV. HITL Scales With Capital | PASS | Unchanged |
| V. Fail Closed | PASS | FastPath defaults to reject on any error |

---

## 8. Implementation Wave Plan

### Wave 1 (Parallel — No Dependencies)

1. apps/agent/src/dex/boc-template.ts — BOC template pool
2. apps/agent/test/boc-template.test.ts — Tests for Wave 1 item 1
3. apps/agent/src/ai/local-slm.ts — Local SLM client
4. apps/agent/test/local-slm.test.ts — Tests for Wave 1 item 3
5. apps/agent/src/wallet/shard-miner.ts — Shard mining
6. apps/agent/test/shard-miner.test.ts — Tests for Wave 1 item 5

### Wave 2 (Depends on Wave 1)

1. apps/agent/src/core/fastpath.ts — FastPath engine (depends on BOC templates)
2. apps/agent/test/fastpath.test.ts — Tests for Wave 2 item 1
3. apps/agent/src/infra/liteclient.ts — ADNL lite client
4. apps/agent/src/infra/local-node.ts — Local node manager

### Wave 3 (Depends on Wave 2)

1. Modify apps/agent/src/core/coordinator.ts — FastPath integration
2. Modify apps/agent/src/ai/brain.ts — Local SLM integration
3. Modify apps/agent/src/wallet/agentic-wallet.ts — Shard mining on deploy
4. Modify apps/agent/src/dex/router.ts — BOC template usage
5. Modify apps/agent/src/index.ts — Boot local node
6. Modify docker-compose.yml — Add vLLM service
7. Modify Dockerfile — GPU + local node support

---

## 9. Open Questions

1. Rust FFI vs Pure TS for FastPath: Should we use Neon/rust FFI for the hot path, or can pure TS with worker_threads achieve <1ms?
2. vLLM Model Selection: Which quantized financial SLM to use? Options: Qwen2.5-1B-Instruct, Phi-3-mini-4k, or a custom fine-tuned model?
3. Shard Mining Feasibility: Is shard mining actually achievable for the budgeting wallet given StateInit constraints? Need to verify with TON docs on fixed_prefix_length.
4. Local Node Hardware: What are the minimum specs for running a TON full node + lite server + vLLM on the same machine?

---

## 10. References

- TON Catchain 2.0: https://www.bitrue.com/blog/ton-coin-catchain-2-upgrade-explained-mtonga-roadmap
- TON Sharding: https://docs.ton.org/foundations/shards
- TON Addresses: https://docs.ton.org/blockchain-basics/primitives/addresses/overview
- BOC Serialization: https://docs.ton.org/blockchain-basics/primitives/serialization/boc
- ADNL Protocol: https://eprint.iacr.org/2025/818.pdf
- ton-lite-client: https://github.com/ton-core/ton-lite-client
- vLLM Unix Socket: https://github.com/vllm-project/vllm/issues/13907
