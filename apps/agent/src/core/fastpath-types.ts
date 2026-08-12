import type { TradingPolicy, FastPathSignal } from "./policy-types";
import type { SwapExecutionStatus, Dex } from "../dex/router";

// Re-export FastPathSignal from policy-types for convenience
export type { FastPathSignal } from "./policy-types";

/**
 * FastPath-specific types extending the base policy types.
 * These types support the ultra-low-latency hot path execution.
 */

import type { Cell, Address, Dictionary, Transaction, Slice, Builder } from "@ton/core";

/**
 * Pre-compiled BOC template for a swap transaction.
 * Only the leaf cell (amount/address/slippage) needs rebuilding at execution time.
 * The template encodes the static structure: wallet, DEX router, jetton wallet, etc.
 */
export interface BocTemplate {
  /** Serialized BOC of the template cell (without the dynamic leaf) */
  templateBoc: Buffer;
  /** The hash of the template for quick equality checks */
  templateHash: Buffer;
  /** DEX this template is for */
  dex: "stonfi" | "dedust";
  /** Pool address this template targets */
  poolAddress: string;
  /** Token address this template trades */
  tokenAddress: string;
  /** Whether this is a buy or sell template */
  side: "buy" | "sell";
  /** Estimated gas for this template (nanoTON) */
  estimatedGasNanoTon: number;
  /** Unix timestamp when template was compiled */
  compiledAt: number;
  /** Policy version this template was compiled under */
  policyVersion: number;
}

/**
 * BOC Template metadata for cache management.
 */
export interface BocTemplateMeta {
  template: BocTemplate;
  /** Number of times this template has been used */
  useCount: number;
  /** Last time this template was used */
  lastUsedAt: number;
}

/**
 * FastPath execution context — all data needed to execute a swap in hot path.
 * Pre-fetched/pre-computed during cold path to minimize hot path latency.
 */
export interface FastPathContext {
  /** The signal triggering this execution */
  signal: FastPathSignal;
  /** The policy version this execution runs under */
  policyVersion: number;
  /** The pre-compiled BOC template to use (if available) */
  bocTemplate?: BocTemplate;
  /** The selected DEX */
  dex: "stonfi" | "dedust";
  /** Pool state at decision time (for reference/slippage calc) */
  poolState: PoolSnapshot;
  /** Wallet address for this tier */
  walletAddress: string;
  /** Wallet public key for signing */
  walletPublicKey: Buffer;
  /** Tier config for reserve checks */
  tierConfig: TierConfig;
}

/**
 * Pool snapshot for fast slippage calculations without RPC calls.
 */
export interface PoolSnapshot {
  /** Pool address */
  address: string;
  /** Reserve 0 (TON or jetton) in nano units */
  reserve0: bigint;
  /** Reserve 1 (TON or jetton) in nano units */
  reserve1: bigint;
  /** Token 0 address */
  token0: string;
  /** Token 1 address */
  token1: string;
  /** DEX identifier */
  dex: "stonfi" | "dedust";
  /** Snapshot timestamp */
  timestamp: number;
  /** Fee basis points */
  feeBps: number;
}

/**
 * Tier configuration needed in hot path.
 */
export interface TierConfig {
  tier: "low" | "mid" | "high";
  maxPositionTon: number;
  maxOpen: number;
  reserveTon: number;
}

/**
 * FastPath execution result with detailed timing.
 */
export interface FastPathResult {
  /** Whether execution was attempted via FastPath */
  executedViaFastPath: boolean;
  /** The swap transaction if executed */
  transaction?: Transaction;
  /** The swap result if executed (from dex router) */
  swapResult?: {
    ok: boolean;
    dex: "stonfi" | "dedust";
    status?: SwapExecutionStatus;
    error?: string;
    txHash?: string;
    jettonAmountNano?: string;
  };
  /** BOC of the executed transaction */
  boc?: Buffer;
  /** Time spent in hot path (microseconds) */
  hotPathDurationUs: number;
  /** Time spent rebuilding leaf cell (microseconds) */
  leafRebuildDurationUs: number;
  /** Time spent serializing BOC (microseconds) */
  bocSerializeDurationUs: number;
  /** Time spent broadcasting (microseconds) */
  broadcastDurationUs: number;
  /** Error if execution failed */
  error?: string;
  /** Fallback reason if not executed via FastPath */
  fallbackReason?: string;
  /** Policy version used */
  policyVersion: number;
}

/**
 * FastPath metrics for observability.
 */
export interface FastPathMetrics {
  /** Total signals received */
  signalsReceived: number;
  /** Signals executed via FastPath */
  fastPathExecutions: number;
  /** Signals falling back to cold path */
  coldPathFallbacks: number;
  /** FastPath execution successes */
  fastPathSuccesses: number;
  /** FastPath execution failures */
  fastPathFailures: number;
  /** Average hot path latency (microseconds) */
  avgHotPathLatencyUs: number;
  /** P99 hot path latency (microseconds) */
  p99HotPathLatencyUs: number;
  /** Average leaf rebuild latency (microseconds) */
  avgLeafRebuildLatencyUs: number;
  /** Cache hit rate for BOC templates */
  bocTemplateHitRate: number;
  /** Current policy version */
  currentPolicyVersion: number;
  /** Last update timestamp */
  lastUpdatedAt: number;
}

/**
 * FastPath configuration.
 */
export interface FastPathConfig {
  /** Enable FastPath execution */
  enabled: boolean;
  /** Maximum hot path latency budget (microseconds) */
  maxHotPathLatencyUs: number;
  /** BOC template cache size */
  bocTemplateCacheSize: number;
  /** BOC template TTL (ms) */
  bocTemplateTtlMs: number;
  /** Minimum pool liquidity for template compilation (USD) */
  minLiquidityForTemplateUsd: number;
  /** Pre-compile templates for top N pools by volume */
  preCompileTopPools: number;
}

/**
 * Cell rebuild primitives — the exact @ton/core Builder API methods
 * used for the leaf cell rebuild pattern (FR-018).
 *
 * Pattern:
 * 1. Parse template BOC → Cell
 * 2. Navigate to leaf position using Slice operations
 * 3. Rebuild leaf using Builder: beginCell().storeUint().storeAddress().storeCoins().storeBit().endCell()
 * 4. Reassemble parent cells using storeRef()
 * 5. Serialize fresh BOC
 *
 * These are the ONLY Builder methods used in hot path.
 */
export interface LeafCellData {
  /** Query ID for replay protection */
  queryId: number;
  /** Amount in nano units */
  amount: bigint;
  /** Recipient address */
  recipient: Address;
  /** Response destination */
  responseDestination: Address;
  /** Forward payload (optional) */
  forwardPayload: Cell | null;
  /** Forward amount (nanoTON) */
  forwardTonAmount: bigint;
}

/**
 * Rebuild a leaf cell from template using @ton/core Builder API.
 * This is the hot-path critical function — must be <50μs.
 *
 * @param templateBoc - The pre-compiled template BOC
 * @param leafData - Dynamic data for the leaf cell
 * @returns Fresh BOC bytes ready for broadcast
 */
export declare function rebuildLeafCell(
  templateBoc: Buffer,
  leafData: LeafCellData
): Buffer;

/**
 * Extract leaf position from template for fast rebuild.
 * Returns the path (array of child indices) to the leaf cell.
 */
export declare function findLeafPath(template: Cell, side: "buy" | "sell"): number[];

/**
 * Compile a BOC template from a swap transaction pattern.
 * Called in cold path during pool discovery/pre-compilation.
 */
export declare function compileBocTemplate(
  dex: "stonfi" | "dedust",
  poolAddress: string,
  tokenAddress: string,
  side: "buy" | "sell",
  walletAddress: string,
  walletPublicKey: Buffer,
  estimatedGasNanoTon: number,
  policyVersion: number
): BocTemplate;

/**
 * Validate a BOC template is still usable (pool hasn't migrated, etc).
 */
export declare function validateBocTemplate(
  template: BocTemplate,
  currentPoolState: PoolSnapshot
): boolean;