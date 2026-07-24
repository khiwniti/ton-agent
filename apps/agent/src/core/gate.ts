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
import {
  BANKROLL_FLOOR_TON,
  effectiveBuyReserveTon,
} from "../dex/swap-gas-guard";

export type Tier = "low" | "mid" | "high";
export const ALL_TIERS: Tier[] = ["low", "mid", "high"];

/**
 * TON headroom reserved on every buy for gas + forward fees + slippage so a
 * trade that just fits the balance at sign-time doesn't fail mid-broadcast.
 * A jetton buy on Ston.fi/DeDust forwards ~0.2–0.25 TON; 0.3 is the safe floor.
 */
export const GAS_CUSHION_TON = 0.3;

/**
 * Effective per-trade reserve that the bankroll floor policy mandates stay
 * untouched after any successful buy. Defaults from
 * `effectiveBuyReserveTon()` (= max of EXIT_RESERVE_TON / BANKROLL_FLOOR_TON).
 * Kept here as a named constant so the gate's reasoning reads consistently
 * with the router-side pre-flight in dex/swap-gas-guard.ts.
 */
export const TRADE_RESERVE_TON = effectiveBuyReserveTon();

/** Re-export of the operator-configurable bankroll floor for downstream gates. */
export { BANKROLL_FLOOR_TON };

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
  // Reserve GAS_CUSHION_TON on top of the position so the buy doesn't fail
  // mid-broadcast on gas/forward fees, AND TRADE_RESERVE_TON so the wallet
  // never drops below the operator's bankroll floor. The reason string
  // reports the exact threshold the code checks — previously it only
  // checked requestedTon+0.3 and silently let the buy drain the wallet
  // past the floor (the user's "lost all orders" worst case).
  const needTon = requestedTon + GAS_CUSHION_TON + TRADE_RESERVE_TON;
  if (handle.balanceTon < needTon) {
    return {
      allowed: false,
      reason:
        `insufficient balance ${handle.balanceTon} < ${needTon} ` +
        `(requested=${requestedTon} + gas-cushion=${GAS_CUSHION_TON} + trade-reserve=${TRADE_RESERVE_TON})`,
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
