/**
 * TradingPolicy defines the parameters that govern trading decisions.
 * This is the shared state between the cold path (LLM/reasoning) and hot path (FastPath).
 */
export interface TradingPolicy {
  /** Version number for detecting stale policies in FastPath */
  version: number;
  /** Maximum position size in TON */
  maxPositionTon: number;
  /** Minimum liquidity in USD for a pool to be considered */
  minLiquidityUsd: number;
  /** Maximum allowed slippage in basis points (e.g., 50 = 0.5%) */
  maxSlippageBps: number;
  /** List of allowed DEXes ("stonfi" | "dedust") */
  allowedDexes: Array<"stonfi" | "dedust">;
  /** List of blocked jetton master addresses */
  blockedTokens: string[];
  /** Timestamp of the last update */
  updatedAt: number;
}

/**
 * FastPathSignal represents a trading signal that can be processed by the FastPath engine.
 * Signals can come from the radar scanner (deterministic) or from an LLM decision marked as pre-approved.
 */
export interface FastPathSignal {
  /** The jetton master address to trade */
  tokenAddress: string;
  /** The pool address to trade in (optional for some DEXes) */
  poolAddress?: string;
  /** Side of the trade: "buy" or "sell" */
  side: "buy" | "sell";
  /** Amount in TON to trade */
  amountTon: number;
  /** Confidence level of the signal (0-1) */
  confidence: number;
  /** Version of the policy this signal was generated under */
  policyVersion: number;
  /** Source of the signal: "radar" (deterministic) or "llm-preapproved" (LLM-approved) */
  producer: "radar" | "llm-preapproved";
}