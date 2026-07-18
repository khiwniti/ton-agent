/**
 * Pure exit-policy engine — no DB, no network, no LLM.
 *
 * Implements the per-position state machine from spec 002 §8.5:
 *   Monitoring → TakeProfit | StopLoss | Trailing | TimeExit | EmergencyExit → Exited
 *
 * Mirrors the structure of `safetycaps/check.ts`: a single pure function that
 * takes the position + a context of deterministic facts and returns either a
 * decision (when an exit trigger fires) or `null` (continue monitoring).
 *
 * Hostile-environment rules (spec §6 hot path, §8.5, P6 fail-closed, SC-E):
 *   - No LLM is ever called here. The audit verdict arrives pre-computed in the
 *     context; if it is `null` (price/audit fetch failed), the engine MUST NOT
 *     guess — it skips the emergency trigger and fails closed on the rest.
 *   - Non-finite price/pnl → `null` (no action, never a guess).
 *   - Priority order is fixed (first match wins): emergency → time → SL →
 *     TP1 → trailing/TP2. A rug verdict outranks everything because a rugged
 *     pool may report any price (the price is a lie once liquidity is gone).
 */

import type { TierRiskConfig } from "../risk/guardrails";

/** The five exit triggers of the §8.5 state machine. */
export type ExitTrigger =
  | "emergency_exit"
  | "time_exit"
  | "stop_loss"
  | "take_profit"
  | "trailing"
  | "tp2";

/**
 * Deterministic audit verdict, re-scored on the hot path via
 * `security/audit.ts getJetton()`. `null` = the re-score was unavailable
 * (TONAPI down, parse failed) → fail closed.
 */
export interface AuditVerdict {
  /** honeypotSafe && lpLocked && renounced, per `getJetton()`. */
  ok: boolean;
  honeypotSafe: boolean;
  lpLocked: boolean;
  renounced: boolean;
}

/**
 * Inputs the monitor computes *outside* the engine, then injects.
 * Everything here is a deterministic fact — the engine never fetches.
 */
export interface ExitPolicyContext {
  /** `Date.now()`, injected so unit tests are deterministic. */
  now: number;
  currentPriceUsd: number;
  entryPriceUsd: number;
  /** Per-tier thresholds from `TIER_RISK_CONFIGS[tier]`. */
  tierCfg: TierRiskConfig;
  /**
   * Re-scored audit verdict, or `null` if unavailable. `ok === false`
   * triggers EmergencyExit; `null` does NOT (fail closed).
   */
  auditVerdict: AuditVerdict | null;
  /**
   * Per-position time limit in ms (the `max_hold_ms` column).
   * `0`/`null`/`undefined` → TimeExit disabled.
   */
  maxHoldMs?: number | null;
}

/**
 * Minimal position shape the engine reads. Kept narrow so the engine does not
 * couple to the full `DbPosition` type or the storage layer.
 */
export interface ExitPolicyPosition {
  status: string; // "OPEN" | "TP1_HIT" | …
  entry_at: number; // unix ms
  entry_price_usd: number;
  /** Computed deadline (= entry_at + max_hold_ms), or null if no limit. */
  exit_by_ms?: number | null;
}

/** What the monitor should do when an exit fires. */
export interface ExitDecision {
  trigger: ExitTrigger;
  /** Fraction of remaining tokens to sell. 1.0 = full exit, 0.5 = TP1 half. */
  sellFraction: number;
  /** DB status to write after the sell lands.
   * "RUG_EXIT" is a Phase-4 terminal status for emergency exits. */
  nextStatus: "OPEN" | "TP1_HIT" | "STOPPED" | "CLOSED" | "RUG_EXIT";
  /** Cost-basis scale applied to the position after a partial sell (TP1 = 0.5). */
  costBasisScale: number;
  /** Human-readable reason, journaled verbatim (not trusted for auth). */
  reason: string;
}

/**
 * Evaluate the exit state machine. Returns `null` when nothing fires.
 *
 * @param position  the open position (OPEN or TP1_HIT)
 * @param ctx       deterministic facts for this tick
 */
export function evaluateExitPolicy(
  position: ExitPolicyPosition,
  ctx: ExitPolicyContext,
): ExitDecision | null {
  const { now, currentPriceUsd, entryPriceUsd, tierCfg, auditVerdict } = ctx;

  // ── Fail closed on bad price ───────────────────────────────────────────
  if (!Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) return null;
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;

  const pnl = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
  if (!Number.isFinite(pnl)) return null;

  const status = position.status;

  // ── 1. EmergencyExit — rug verdict outranks everything ─────────────────
  // A pool that just rugged may report any price; act on the audit, not pnl.
  // `auditVerdict === null` means the re-score was unavailable → fail closed.
  if (auditVerdict !== null && !auditVerdict.ok) {
    return {
      trigger: "emergency_exit",
      sellFraction: 1.0,
      nextStatus: "RUG_EXIT",
      costBasisScale: 1.0,
      reason: `emergency exit: audit verdict !ok (honeypot=${auditVerdict.honeypotSafe} lp=${auditVerdict.lpLocked} renounced=${auditVerdict.renounced})`,
    };
  }

  // ── 2. TimeExit — hard deadline, OPEN only ─────────────────────────────
  const maxHoldMs = ctx.maxHoldMs ?? 0;
  if (status === "OPEN" && maxHoldMs > 0 && position.exit_by_ms != null) {
    if (now >= position.exit_by_ms) {
      return {
        trigger: "time_exit",
        sellFraction: 1.0,
        nextStatus: "CLOSED",
        costBasisScale: 1.0,
        reason: `time exit: now=${now} >= exit_by_ms=${position.exit_by_ms}`,
      };
    }
  }

  // ── 3. StopLoss — OPEN only ─────────────────────────────────────────────
  if (status === "OPEN" && pnl <= -tierCfg.stopLossPct) {
    return {
      trigger: "stop_loss",
      sellFraction: 1.0,
      nextStatus: "STOPPED",
      costBasisScale: 1.0,
      reason: `stop loss: pnl=${pnl.toFixed(2)}% <= -${tierCfg.stopLossPct}%`,
    };
  }

  // ── 4. TakeProfit1 — OPEN only, sells half ────────────────────────────
  if (status === "OPEN" && pnl >= tierCfg.takeProfitPct) {
    return {
      trigger: "take_profit",
      sellFraction: 0.5,
      nextStatus: "TP1_HIT",
      costBasisScale: 0.5,
      reason: `take-profit 1: pnl=${pnl.toFixed(2)}% >= ${tierCfg.takeProfitPct}%`,
    };
  }

  // ── 5. Trailing / TP2 — TP1_HIT only ───────────────────────────────────
  // Trail to entry once pnl gives back to ≤0; or take the second target at 2×.
  if (status === "TP1_HIT") {
    if (pnl <= 0) {
      return {
        trigger: "trailing",
        sellFraction: 1.0,
        nextStatus: "CLOSED",
        costBasisScale: 1.0,
        reason: `trailing stop: pnl=${pnl.toFixed(2)}% <= 0 (trail to entry)`,
      };
    }
    if (pnl >= tierCfg.takeProfitPct * 2) {
      return {
        trigger: "tp2",
        sellFraction: 1.0,
        nextStatus: "CLOSED",
        costBasisScale: 1.0,
        reason: `tp2: pnl=${pnl.toFixed(2)}% >= ${tierCfg.takeProfitPct * 2}%`,
      };
    }
  }

  return null;
}
