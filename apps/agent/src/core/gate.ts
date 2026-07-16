/**
 * Pure trade-gate evaluation for the tier coordinator.
 *
 * This module is INTENTIONALLY side-effect free — no DB, no network, no
 * logger, no environment reads beyond `import.meta` cycles. It exists so unit
 * tests in `test/coordinator-gate.test.ts` can import the rule set without
 * triggering the transitive dependency graph of `coordinator.ts`
 * (which boots a TonClient, opens SQLite, and pulls in the DEX router).
 *
 * Production callers go through `TierCoordinator.isTradeAllowed()` which
 * assembles the inputs (current daily PnL, kill-switch flag, tier bankroll)
 * and forwards them here.
 */
import type { TierRiskConfig } from "../risk/guardrails";

export type Tier = "low" | "mid" | "high";
export const ALL_TIERS: Tier[] = ["low", "mid", "high"];

export interface TierHandle {
  tier: Tier;
  /** Optional — callable without these for pure tests. */
  kp?: { pub: Buffer; sec: Buffer };
  address?: string;
  balanceTon: number;
  openPositions: number;
  closedTrades: number;
  config: TierRiskConfig;
  /** FALSE for HIGH until promotion criteria pass. LOW/MID are always TRUE. */
  unlocked: boolean;
  startedAt: number;
  totalPnlTon: number;
  dailyPnlTon: number;
}

export interface TradeGateInput {
  tier: Tier;
  requestedTon: number;
  killSwitchActive: boolean;
  killSwitchReason?: string;
  handle?: TierHandle;
  circuitBreakerOk: boolean;
  dailyPnl: number;
  /** When true, all trades are blocked. Set via OBSERVE_ONLY env var. */
  observeOnly?: boolean;
}

export interface TradeGateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Combined risk gate. The order matters — kill-switch first (so an operator
 * pull can short-circuit everything else), then HIGH-tier unlock (so we don't
 * leak the balance check on a locked tier), then circuit breaker (daily loss
 * limit), then tier caps (position size, bankroll, open-position count).
 */
export function evaluateTradeGate(input: TradeGateInput): TradeGateResult {
  const { tier, requestedTon, killSwitchActive, killSwitchReason, handle, circuitBreakerOk } = input;
  if (!handle) {
    return { allowed: false, reason: `tier ${tier} not initialized` };
  }
  if (input.observeOnly) {
    return { allowed: false, reason: "observe-only mode — all trades blocked" };
  }
  if (killSwitchActive) {
    return { allowed: false, reason: `kill-switch active: ${killSwitchReason ?? "n/a"}` };
  }
  if (tier === "high" && !handle.unlocked) {
    return { allowed: false, reason: "HIGH tier locked — promotion not satisfied" };
  }
  if (!circuitBreakerOk) {
    return { allowed: false, reason: "circuit breaker tripped (daily loss limit)" };
  }
  if (requestedTon > handle.config.maxPositionTon) {
    return {
      allowed: false,
      reason: `requested ${requestedTon} > tier cap ${handle.config.maxPositionTon}`,
    };
  }
  // 0.01 TON cushion for gas + slippage so a trade that fits balance at sign-time
  // doesn't fail mid-broadcast.
  if (handle.balanceTon < requestedTon + 0.01) {
    return {
      allowed: false,
      reason: `insufficient balance ${handle.balanceTon} < ${requestedTon + 0.3}`,
    };
  }
  if (handle.openPositions >= handle.config.maxOpen) {
    return {
      allowed: false,
      reason: `max open positions ${handle.openPositions}/${handle.config.maxOpen}`,
    };
  }
  return { allowed: true };
}
