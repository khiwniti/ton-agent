import { db, dailyPnlStore, positionsStore } from "../storage/store";
import { log } from "../logger";
export { computeConfidenceScore } from "./scoring";
export type { ConfidenceInput, ScoreBreakdown } from "./scoring";

// Standard risk configuration per tier.
// Mirrors the frontend settings (RiskParams.tsx).
export interface TierRiskConfig {
  maxPositionTon: number;
  maxOpen: number;
  takeProfitPct: number;
  stopLossPct: number;
  minAiScore: number;
}

/**
 * Per-tier absolute position caps (in TON), env-overridable.
 *
 * IMPORTANT: a cap MUST exceed `GAS_CUSHION_TON` (see gate.ts) or no trade in
 * that tier can ever clear the bankroll check — a self-locking contradiction.
 * The prior dust defaults (0.02/0.05/0.1) did exactly that. Defaults below
 * follow the tiered-proven model: LOW builds the port with small size, MID
 * scales, HIGH accelerates once promotion unlocks.
 */
const capTon = (k: string, fb: number) => {
  const v = parseFloat(process.env[k] || "");
  return Number.isFinite(v) && v > 0 ? v : fb;
};

export const TIER_RISK_CONFIGS: Record<"low" | "mid" | "high", TierRiskConfig> = {
  low: {
    maxPositionTon: capTon("LOW_MAX_POSITION_TON", 1.0),
    maxOpen: 2,
    takeProfitPct: 25,
    stopLossPct: 15,
    minAiScore: 80,
  },
  mid: {
    maxPositionTon: capTon("MID_MAX_POSITION_TON", 3.0),
    maxOpen: 3,
    takeProfitPct: 60,
    stopLossPct: 25,
    minAiScore: 65,
  },
  high: {
    maxPositionTon: capTon("HIGH_MAX_POSITION_TON", 5.0),
    maxOpen: 4,
    takeProfitPct: 150,
    stopLossPct: 40,
    minAiScore: 50,
  },
};

export const DAILY_LOSS_LIMIT_TON = parseFloat(process.env.DAILY_LOSS_LIMIT_TON || "2.0");

/** Max portfolio allocation per trade (5% of available balance) */
export const MAX_PORTFOLIO_ALLOCATION_PCT = parseFloat(process.env.MAX_PORTFOLIO_ALLOCATION_PCT || "5");

/** Max slippage tolerance (1.5%) */
export const MAX_SLIPPAGE_PCT = parseFloat(process.env.MAX_SLIPPAGE_PCT || "1.5");

/**
 * 1. Circuit Breaker
 * Returns true if today's PnL is safe, false if loss limit is breached.
 */
export function checkCircuitBreaker(): boolean {
  const todayPnl = dailyPnlStore.getTodayPnl();
  if (todayPnl <= -DAILY_LOSS_LIMIT_TON) {
    log.err("RISK", `Circuit Breaker TRIPPED! Daily PnL (${todayPnl.toFixed(3)} TON) <= Limit (-${DAILY_LOSS_LIMIT_TON} TON)`);
    return false;
  }
  return true;
}

/**
 * 1b. Portfolio Allocation Check
 * Ensures trade size does not exceed MAX_PORTFOLIO_ALLOCATION_PCT of
 * the wallet's available balance.
 */
export function checkPortfolioAllocation(
  requestedTon: number,
  balanceTon: number,
  openPositionsCostBasisTon: number = 0,
): { allowed: boolean; reason?: string; maxAllowedTon?: number } {
  // Available capital = current balance (open positions already deducted)
  // Max allocation = available balance * allocation_pct / 100
  const available = balanceTon;
  const maxAllowed = available * (MAX_PORTFOLIO_ALLOCATION_PCT / 100);

  if (requestedTon > maxAllowed) {
    return {
      allowed: false,
      reason: `trade ${requestedTon}TON exceeds ${MAX_PORTFOLIO_ALLOCATION_PCT}% allocation (max ${maxAllowed.toFixed(4)}TON)`,
      maxAllowedTon: maxAllowed,
    };
  }

  return { allowed: true, maxAllowedTon: maxAllowed };
}

/**
 * 1c. Slippage Validation
 * Checks that simulated slippage does not exceed MAX_SLIPPAGE_PCT.
 *
 * @param expectedOutput The expected output amount (in nano-jetton units)
 * @param minOutput The minimum output amount acceptable (after slippage)
 * @returns Whether the slippage is within tolerance
 */
export function checkSlippage(
  expectedOutput: bigint,
  minOutput: bigint,
): { allowed: boolean; reason?: string; slippagePct?: number } {
  if (expectedOutput <= 0n) {
    return { allowed: false, reason: "expected output must be positive" };
  }
  if (minOutput <= 0n) {
    return { allowed: false, reason: "min output must be positive" };
  }

  // Actual slippage: how much worse minOutput is vs. expectedOutput
  // slippage% = ((expected - min) / expected) * 100
  const diff = expectedOutput - minOutput;
  const slippagePct = Number((diff * 10000n) / expectedOutput) / 100;

  if (slippagePct > MAX_SLIPPAGE_PCT) {
    return {
      allowed: false,
      reason: `slippage ${slippagePct.toFixed(2)}% exceeds max ${MAX_SLIPPAGE_PCT}%`,
      slippagePct,
    };
  }

  return { allowed: true, slippagePct };
}

/**
 * 2. High Tier Promotion Logic
 * Returns true if HIGH tier is unlocked.
 * Unlock criteria: LOW + MID closed >= 5 trades with cumulative PnL > 0.
 */
export function isHighTierUnlocked(): boolean {
  try {
    const res = db.prepare(`
      SELECT 
        COUNT(*) as count,
        SUM(realized_pnl_ton) as total_pnl
      FROM positions 
      WHERE status IN ('CLOSED', 'STOPPED') 
        AND wallet_tier IN ('low', 'mid')
    `).get() as { count: number; total_pnl: number | null };

    const count = res?.count || 0;
    const totalPnl = res?.total_pnl || 0;

    const unlocked = count >= 5 && totalPnl > 0;
    if (unlocked) {
      log.ok("RISK", `HIGH tier unlocked! Closed low/mid trades = ${count}, cumulative PnL = ${totalPnl.toFixed(3)} TON`);
    } else {
      log.info("RISK", `HIGH tier locked. Closed low/mid trades = ${count}/5, cumulative PnL = ${totalPnl.toFixed(3)}/0 TON`);
    }
    return unlocked;
  } catch (e: any) {
    log.err("RISK", `Failed to evaluate promotion: ${e.message}`);
    return false;
  }
}
