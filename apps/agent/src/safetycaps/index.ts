/**
 * SafetyCaps façade — deterministic risk authorization for GRAM / TAOF.
 *
 * LLM agents may propose TradeTickets; only this module greenlights execution.
 */
export { CAPS_VERSION, checkTicket, hashTradeTicket, verifyCapBinding } from "./check";
export {
  issueAuthorization,
  consumeAuthorization,
  peekAuthorization,
  clearAuthorizationRegistry,
  authorizationRegistrySize,
} from "./registry";
export type {
  AuthorizedExecution,
  CapCheckContext,
  CapCheckFailure,
  CapCheckResult,
  RiskAssessment,
  RiskVerdict,
  Tier,
  TradeSide,
  TradeTicket,
} from "./types";

import {
  MAX_PORTFOLIO_ALLOCATION_PCT,
  MAX_SLIPPAGE_PCT,
  TIER_RISK_CONFIGS,
} from "../risk/guardrails";
import { GAS_CUSHION_TON } from "../core/gate";
import type { CapCheckContext, CapCheckResult, Tier, TradeTicket } from "./types";
import { checkTicket } from "./check";
import { issueAuthorization } from "./registry";

/** Max trade as % of pool TVL when pool_tvl_ton is known. */
export const MAX_TRADE_POOL_TVL_PCT = parseFloat(
  process.env.MAX_TRADE_POOL_TVL_PCT || "5",
);

/** Fail closed on missing pool TVL for buys when true. */
export const REQUIRE_POOL_TVL =
  (process.env.REQUIRE_POOL_TVL || "false").toLowerCase() === "true";

export interface BuildCapContextInput {
  tier: Tier;
  balanceTon: number;
  openPositions: number;
  unlocked: boolean;
  killSwitchActive: boolean;
  killSwitchReason?: string;
  circuitBreakerOk: boolean;
  observeOnly: boolean;
  dailyPnlTon: number;
  maxPortfolioAllocationPct?: number;
  maxSlippagePct?: number;
  maxTradePoolTvlPct?: number;
  requirePoolTvl?: boolean;
  gasCushionTon?: number;
}

/**
 * Build CapCheckContext from live coordinator/tier state + env defaults.
 */
export function buildCapContext(input: BuildCapContextInput): CapCheckContext {
  const cfg = TIER_RISK_CONFIGS[input.tier];
  return {
    balance_ton: input.balanceTon,
    open_positions: input.openPositions,
    max_position_ton: cfg.maxPositionTon,
    max_open: cfg.maxOpen,
    min_ai_score: cfg.minAiScore,
    unlocked: input.unlocked,
    kill_switch_active: input.killSwitchActive,
    kill_switch_reason: input.killSwitchReason,
    circuit_breaker_ok: input.circuitBreakerOk,
    observe_only: input.observeOnly,
    daily_pnl_ton: input.dailyPnlTon,
    max_portfolio_allocation_pct:
      input.maxPortfolioAllocationPct ?? MAX_PORTFOLIO_ALLOCATION_PCT,
    max_slippage_pct: input.maxSlippagePct ?? MAX_SLIPPAGE_PCT,
    max_trade_pool_tvl_pct: input.maxTradePoolTvlPct ?? MAX_TRADE_POOL_TVL_PCT,
    require_pool_tvl: input.requirePoolTvl ?? REQUIRE_POOL_TVL,
    gas_cushion_ton: input.gasCushionTon ?? GAS_CUSHION_TON,
  };
}

/**
 * Evaluate ticket and, if ok, register authorization for later execute.
 */
export function authorizeTicket(
  ticket: TradeTicket,
  ctx: CapCheckContext,
): CapCheckResult {
  const result = checkTicket(ticket, ctx);
  return issueAuthorization(result);
}
