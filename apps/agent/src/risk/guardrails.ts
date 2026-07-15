import { db, dailyPnlStore } from "../storage/store";
import { log } from "../logger";

// Standard risk configuration per tier.
// Mirrors the frontend settings (RiskParams.tsx).
export interface TierRiskConfig {
  maxPositionTon: number;
  maxOpen: number;
  takeProfitPct: number;
  stopLossPct: number;
  minAiScore: number;
}

export const TIER_RISK_CONFIGS: Record<"low" | "mid" | "high", TierRiskConfig> = {
  low: {
    maxPositionTon: 1.0,
    maxOpen: 2,
    takeProfitPct: 25,
    stopLossPct: 15,
    minAiScore: 80,
  },
  mid: {
    maxPositionTon: 3.0,
    maxOpen: 3,
    takeProfitPct: 60,
    stopLossPct: 25,
    minAiScore: 65,
  },
  high: {
    maxPositionTon: 5.0,
    maxOpen: 4,
    takeProfitPct: 150,
    stopLossPct: 40,
    minAiScore: 50,
  },
};

export const DAILY_LOSS_LIMIT_TON = parseFloat(process.env.DAILY_LOSS_LIMIT_TON || "2.0");

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
