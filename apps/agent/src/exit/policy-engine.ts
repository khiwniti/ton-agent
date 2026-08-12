/**
 * Pure exit-policy engine — no DB, no network, no LLM.
 *
 * Implements the per-position exit decision from spec 002 §8.5:
 *   Monitoring → TrendExit | StopLoss | TimeExit | EmergencyExit → Exited
 *
 * Mirrors the structure of `safetycaps/check.ts`: a single pure function that
 * takes the position + a context of deterministic facts and returns either a
 * decision (when an exit trigger fires) or `null` (continue monitoring).
 *
 * ── 2026-08-09 OPERATOR DIRECTIVE ─────────────────────────────────────────
 * The take-profit ladder (TP1 half-sell → trailing/TP2) and the trailing stop
 * are GONE. Winners ride the trend with no fixed profit target and close only
 * when the trend SIGNIFICANTLY flips to downtrend (`trend_exit`, fed by
 * exit/trend-monitor.ts). The static stop-loss remains the hard loss floor for
 * the losing side. Rationale: the fixed ladder either banked tiny amounts while
 * a runner collapsed to the stop (GULYA closed at -80.5% despite a -35% stop on
 * an illiquid curve), or trapped winners with no protection at all.
 *
 * Hostile-environment rules (spec §6 hot path, §8.5, P6 fail-closed, SC-E):
 *   - No LLM is ever called here. The audit verdict arrives pre-computed in the
 *     context; if it is `null` (price/audit fetch failed), the engine MUST NOT
 *     guess — it skips the emergency trigger and fails closed on the rest.
 *   - Non-finite price/pnl → `null` (no action, never a guess).
 *   - Priority order is fixed (first match wins): emergency → trend → time →
 *     stop-loss. A rug verdict outranks everything because a rugged pool may
 *     report any price (the price is a lie once liquidity is gone).
 *
 * 2026-08-08 — the emergency trigger no longer fires on `!auditVerdict.ok`.
 * That rule closed 26 positions at the DEX spread (~-0.6%) because `ok` demands
 * `renounced`, a STATIC property the entry gate had already accepted. An exit
 * gate must never be stricter than the entry gate that admitted the position.
 * Emergencies now require a measured DELTA (`rugSignal`, see exit/rug-detector.ts):
 * liquidity drain, or a safety dimension that went good → bad.
 *
 * ── Phase 4.5: volatility- & structure-adaptive exits ─────────────────────
 * The trend and stop paths consume optional `volatility`/`structureStop` facts
 * computed in the hot path from SMOOTHED closes (EMA/ATR window in
 * exit/volatility-regime.ts). Absent facts = exactly the pre-4.5 behavior, so
 * callers that do not inject them (e.g. the sniper engine) are untouched.
 *
 * FLASH-CRASH SEPARATION: the smoothing layer deliberately sits ONLY on the
 * trend/stop path. The flash-crash circuit breaker (`rugSignal` → emergency_exit,
 * exit/rug-detector.ts) measures liquidity drain / safety deltas on RAW ticks
 * and is NOT routed through these smoothed facts — a genuine liquidity drain
 * must trip instantly, not after N smoothed closes.
 */

import type { TierRiskConfig } from "../risk/guardrails";
import type { RugSignal } from "./rug-detector";
import type { VolatilityRegime } from "./volatility-regime";

/** The exit triggers of the §8.5 state machine (as of 2026-08-09). */
export type ExitTrigger =
  | "emergency_exit"
  | "trend_exit"
  | "time_exit"
  | "stop_loss";

/**
 * Deterministic audit verdict, re-scored on the hot path via
 * `security/audit.ts getJetton()`. `null` = the re-score was unavailable
 * (TONAPI down, parse failed) → fail closed.
 */
export interface AuditVerdict {
  /**
   * honeypotSafe && lpLocked && renounced, per `getJetton()`.
   *
   * Retained for observability/journaling ONLY. It is deliberately NOT an exit
   * trigger: it folds the static `renounced` dimension and undetermined data
   * gaps into the same `false` as a genuine honeypot.
   */
  ok: boolean;
  honeypotSafe: boolean;
  lpLocked: boolean;
  /**
   * Raw LP tri-state string. Only the exact literal `"unlocked"` is a
   * degradation; anything else (notably "undetermined") is a data gap, not a
   * rug. Optional so existing callers/tests that supply only `lpLocked` keep
   * their original semantics.
   */
  lpState?: string;
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
   * Re-scored audit verdict, or `null` if unavailable. Journaled for
   * observability; no longer an exit trigger on its own (see `rugSignal`).
   */
  auditVerdict: AuditVerdict | null;
  /**
   * Measured rug verdict from `exit/rug-detector.ts` — liquidity drain or a
   * good → bad transition on a hard safety dimension. This is the ONLY input
   * that fires EmergencyExit. `null`/not-rugged means keep monitoring.
   */
  rugSignal?: RugSignal | null;
  /**
   * CONFIRMED significant downtrend flip from `exit/trend-monitor.ts` — the
   * operator's 2026-08-09 close rule. `bearish: true` fires a full `trend_exit`.
   * The confirmation filter (consecutive ticks) lives in the tracker, so a
   * signal present here has already survived the whipsaw check.
   *
   * `confirmations` (consecutive bearish ticks so far) is carried so the
   * engine can apply regime-adaptive confirmation cost in a SPIKED market
   * without coupling to TrendConfig.
   */
  trendSignal?: {
    bearish: boolean;
    confirmations?: number;
    reason?: string;
  } | null;
  /**
   * Volatility- & structure-adaptive exit facts (Phase 4.5). Absent → the
   * engine behaves exactly as before: fixed-distance stop + plain trend exit.
   */
  volatility?: {
    /** Close-only ATR proxy, in price units (per-position window). */
    atrCloseTon: number | null;
    /** CALM/NORMAL/SPIKED classification ("unknown" before the lookback fills). */
    regime: VolatilityRegime;
    /** Rolling realized vol (per-tick σ of log returns), or null pre-warm-up. */
    realizedVol: number | null;
  } | null;
  /**
   * Structure stop: high-water close − mult×ATR, clamped to never sit below
   * the static % floor. `confirmedTicks` counts consecutive closes beyond the
   * level — the stop fires only when the mark has been UNDER the level for
   * `stopConfirmTicks` closes, never on a single wick/intrabar excursion.
   */
  structureStop?: {
    levelTon: number | null;
    confirmedTicks: number;
  } | null;
  /**
   * Consecutive closes beyond the structure level required before the
   * structure stop fires (close-confirmation SL). Absent/0 → the structure
   * stop is inert and the static % floor is the only loss stop (backward
   * compatible with pre-Phase-4.5 callers).
   */
  stopConfirmTicks?: number;
  /**
   * Base consecutive bearish ticks that count as a confirmed flip in NORMAL
   * markets (the tracker's `confirmTicks`). Combined with
   * `trendExitSpikedExtraTicks`, the engine re-gates `trend_exit` in a SPIKED
   * regime: `confirmations >= trendConfirmTicks + trendExitSpikedExtraTicks`.
   * Absent → the SPIKED extra-cost gate is skipped (plain `bearish` fires).
   */
  trendConfirmTicks?: number;
  /**
   * Extra consecutive bearish ticks required before `trend_exit` fires while
   * `volatility.regime === "spiked"`. Absent/0 → SPIKED adds nothing to the
   * configured confirmation cost.
   */
  trendExitSpikedExtraTicks?: number;
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
  /** Fraction of remaining tokens to sell. Always 1.0 — no partials remain. */
  sellFraction: number;
  /** DB status to write after the sell lands.
   * "RUG_EXIT" is the terminal status for emergency exits. */
  nextStatus: "STOPPED" | "CLOSED" | "RUG_EXIT";
  /** Cost-basis scale applied after the sell (always 1.0 — no partials). */
  costBasisScale: number;
  /** Human-readable reason, journaled verbatim (not trusted for auth). */
  reason: string;
}

/**
 * Evaluate the exit state machine. Returns `null` when nothing fires.
 *
 * @param position  the open position (OPEN or legacy TP1_HIT)
 * @param ctx       deterministic facts for this tick
 */
export function evaluateExitPolicy(
  position: ExitPolicyPosition,
  ctx: ExitPolicyContext,
): ExitDecision | null {
  const { now, currentPriceUsd, entryPriceUsd, tierCfg } = ctx;

  // ── Fail closed on bad price ───────────────────────────────────────────
  if (!Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) return null;
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;

  const pnl = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
  if (!Number.isFinite(pnl)) return null;

  const status = position.status;

  // ── 1. EmergencyExit — measured rug outranks everything ────────────────
  // A pool that just rugged may report any price; act on the measurement, not
  // pnl. Only a DELTA counts (see rug-detector): liquidity drain, or a hard
  // dimension that went good → bad. A static `renounced=false` or an
  // undetermined dimension is NOT a rug — treating one as such closed 26
  // positions at the spread for nothing.
  if (ctx.rugSignal?.rugged) {
    return {
      trigger: "emergency_exit",
      sellFraction: 1.0,
      nextStatus: "RUG_EXIT",
      costBasisScale: 1.0,
      reason: `emergency exit: ${ctx.rugSignal.reason}`,
    };
  }

  // ── 2. TrendExit — significant downtrend flip, any open status ─────────
  // Operator directive 2026-08-09: no TP/trailing targets. Winners ride the
  // trend; a CONFIRMED downtrend flip is the close signal (the consecutive-tick
  // whipsaw filter ran in exit/trend-monitor.ts before this was set).
  //
  // Phase 4.5 regime filter: in a SPIKED market single-tick noise passes a
  // fixed confirmation counter faster — a raw bearish flag that already cleared
  // `confirmTicks` on a normal day can be < 1s of noise on a volatile one. When
  // the regime is SPIKED and the engine knows both the base tick count and the
  // extra cost, it requires `confirmations >= trendConfirmTicks +
  // trendExitSpikedExtraTicks` before letting the flip through. CALM/NORMAL
  // keeps the configured cost exactly. Absent facts → plain `bearish` fires.
  const spiked =
    ctx.volatility?.regime === "spiked" &&
    ctx.trendConfirmTicks != null &&
    ctx.trendExitSpikedExtraTicks != null &&
    ctx.trendExitSpikedExtraTicks > 0;
  const confirmations = ctx.trendSignal?.confirmations ?? 0;
  const spikedGatePassed =
    !spiked || confirmations >= ctx.trendConfirmTicks! + ctx.trendExitSpikedExtraTicks!;
  if (ctx.trendSignal?.bearish && spikedGatePassed) {
    return {
      trigger: "trend_exit",
      sellFraction: 1.0,
      nextStatus: "CLOSED",
      costBasisScale: 1.0,
      reason: spiked
        ? `trend exit: ${ctx.trendSignal.reason ?? "significant downtrend flip"} ` +
          `(SPIKED vol, ${confirmations} >= ${ctx.trendConfirmTicks! + ctx.trendExitSpikedExtraTicks!} confirms)`
        : `trend exit: ${ctx.trendSignal.reason ?? "significant downtrend flip"}`,
    };
  }

  // ── 3. TimeExit — hard deadline, OPEN only ─────────────────────────────
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

  // ── 4. StopLoss — the hard loss floor, any open status ─────────────────
  // Not OPEN-only: a legacy TP1_HIT runner must not be allowed to sink past
  // the floor either. Every exit here is a full close.
  if (pnl <= -tierCfg.stopLossPct) {
    return {
      trigger: "stop_loss",
      sellFraction: 1.0,
      nextStatus: "STOPPED",
      costBasisScale: 1.0,
      reason: `stop loss: pnl=${pnl.toFixed(2)}% <= -${tierCfg.stopLossPct}%`,
    };
  }

  // ── 5. Structure stop — close-confirmed break of the ATR band ──────────
  // Phase 4.5: level = high-water close − mult×ATR, clamped to never sit below
  // the static % floor (which fired above, so anything reaching here is a
  // structure level ABOVE the hard line — a shallower, earlier stop). Fires
  // only after `stopConfirmTicks` CONSECUTIVE closes under the level — a single
  // wick or intrabar excursion past the level does NOT stop the position out.
  // Absent `structureStop`/`levelTon` → behavior unchanged (static line only).
  const structLevel = ctx.structureStop?.levelTon;
  const structTicks = ctx.structureStop?.confirmedTicks ?? 0;
  const stopConfirmTicks = ctx.stopConfirmTicks ?? 0;
  if (
    structLevel != null &&
    Number.isFinite(structLevel) &&
    structLevel > 0 &&
    currentPriceUsd <= structLevel &&
    stopConfirmTicks > 0 &&
    structTicks >= stopConfirmTicks
  ) {
    return {
      trigger: "stop_loss",
      sellFraction: 1.0,
      nextStatus: "STOPPED",
      costBasisScale: 1.0,
      reason: `stop loss: structure break price=${currentPriceUsd.toFixed(6)} <= ` +
        `level=${structLevel.toFixed(6)} for ${structTicks} consecutive closes ` +
        `(>= ${stopConfirmTicks})`,
    };
  }

  return null;
}
