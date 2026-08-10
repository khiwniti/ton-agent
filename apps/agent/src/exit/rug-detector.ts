/**
 * Rug detection by MEASURED DELTA, not by static flags.
 *
 * Why this module exists — the production evidence is damning in both directions:
 *
 *   FALSE POSITIVES: 26 of 28 closed positions were `RUG_EXIT` at ~-0.6%, all
 *   within 0.0005% of each other across nine unrelated pools. That is not a
 *   rug and not even a price move — it is the DEX fee, booked because the
 *   audit re-score on the exit path returned `ok=false`. With
 *   `AUDIT_REQUIRE_RENOUNCE=true`, `audit.ok` demands
 *   `honeypotSafe && lpLocked && renounced`, and trending memecoins are
 *   essentially never renounced. So a token that PASSED the entry gate got
 *   guillotined one tick later by a STRICTER exit gate, realizing the flat gas
 *   cost with zero chance of upside.
 *
 *   FALSE NEGATIVES: the 2 genuine rugs (-85.7%, sell quote collapsed ~7x) were
 *   recorded with `rugged=0, emergency_exit=0`. The audit said "fine" while the
 *   pool emptied.
 *
 * The static-flag signal was therefore anti-correlated with actual rugs. The
 * conclusions encoded here:
 *
 *   1. A STATIC property cannot be a rug SIGNAL. `renounced` was true-or-false
 *      before we ever bought and was accepted by the entry gate. Re-checking it
 *      on the exit path cannot discover anything new, so it is excluded
 *      unconditionally. An exit gate must never be stricter than the entry gate
 *      that admitted the position.
 *   2. A rug is a TRANSITION: something that was safe became unsafe.
 *   3. The most reliable rug signal is LIQUIDITY DRAIN, because it is a direct
 *      measurement of the thing that actually harms us, and it is what the
 *      static flags missed.
 *
 * Pure functions + one small in-memory tracker, so all of it is unit-testable.
 */

/** The dimensions we can observe about a jetton's safety. */
export interface AuditSnapshot {
  honeypotSafe: boolean;
  /** Legacy boolean. `lpState` is preferred when available (see below). */
  lpLocked: boolean;
  /**
   * Raw LP state string straight from the audit dimension.
   *
   * Tri-state matters: mapping `state === "locked"` onto a boolean collapses
   * "undetermined" into "unlocked", turning a DATA GAP into a measured rug.
   * Only the exact literal `"unlocked"` counts as degradation; every other
   * value (including whatever the undetermined literal happens to be) is
   * treated as unknown and never triggers an exit.
   */
  lpState?: string;
  /** Recorded for observability only — deliberately NOT a rug trigger. */
  renounced: boolean;
}

export interface RugSignal {
  rugged: boolean;
  reason: string;
}

/**
 * Liquidity drop (percent, from the observed high-water mark) that counts as a
 * drain. 50% means the pool lost half its TON depth since we entered.
 */
export const RUG_LIQUIDITY_DROP_PCT = (() => {
  const raw =
    typeof process !== "undefined" ? process.env?.RUG_LIQUIDITY_DROP_PCT : undefined;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 50;
})();

/** Minimum absolute TON depth worth measuring a drop against (avoids dust noise). */
export const RUG_LIQUIDITY_MIN_BASE_TON = (() => {
  const raw =
    typeof process !== "undefined"
      ? process.env?.RUG_LIQUIDITY_MIN_BASE_TON
      : undefined;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();

/**
 * True only when LP is EXPLICITLY unlocked.
 *
 * Prefers the raw tri-state string. Falls back to the legacy boolean when no
 * state was supplied, so callers (and existing tests) that only provide
 * `lpLocked` keep their original meaning.
 */
function isLpExplicitlyUnlocked(snap: AuditSnapshot): boolean {
  if (snap.lpState !== undefined) return snap.lpState === "unlocked";
  return snap.lpLocked === false;
}

/**
 * Detect a safety dimension that DEGRADED since entry. Returns a reason string,
 * or `null` when nothing got worse.
 *
 * A missing baseline is treated as "hard dimensions were good at entry" — that
 * is what the entry gate asserted before it allowed the buy. So a genuine
 * honeypot or an explicit LP unlock still fires after a process restart, while
 * `renounced` is excluded regardless of baseline.
 */
export function detectAuditDegradation(
  baseline: AuditSnapshot | null,
  current: AuditSnapshot | null,
): string | null {
  // No fresh measurement => nothing measured => no rug. Fail closed on the
  // emergency trigger; monitoring continues and other triggers still apply.
  if (!current) return null;

  const wasHoneypotSafe = baseline ? baseline.honeypotSafe : true;
  if (wasHoneypotSafe && !current.honeypotSafe) {
    return "honeypot detected (was safe at entry)";
  }

  const wasLpUnlocked = baseline ? isLpExplicitlyUnlocked(baseline) : false;
  if (!wasLpUnlocked && isLpExplicitlyUnlocked(current)) {
    return "LP unlocked (was locked at entry)";
  }

  // `renounced` is intentionally absent. It is a static property that the entry
  // gate already ruled on; re-litigating it here is what produced 26 false
  // RUG_EXITs at the spread.
  return null;
}

/**
 * Detect a liquidity drain against the high-water mark. This is the signal that
 * actually catches rugs — the two real ones in production had clean audits.
 */
export function detectLiquidityDrain(
  peakTon: number | null,
  currentTon: number | null,
  dropPct: number = RUG_LIQUIDITY_DROP_PCT,
): string | null {
  if (peakTon == null || currentTon == null) return null;
  if (!Number.isFinite(peakTon) || !Number.isFinite(currentTon)) return null;
  // Too shallow to distinguish a drain from measurement noise.
  if (peakTon < RUG_LIQUIDITY_MIN_BASE_TON) return null;

  const threshold = peakTon * (1 - dropPct / 100);
  if (currentTon < threshold) {
    const lostPct = ((peakTon - currentTon) / peakTon) * 100;
    return `liquidity drained ${lostPct.toFixed(1)}% (peak=${peakTon.toFixed(3)} now=${currentTon.toFixed(3)} TON, limit ${dropPct}%)`;
  }
  return null;
}

/**
 * Combined rug verdict. Liquidity drain is checked FIRST because it is a direct
 * measurement of harm, whereas audit dimensions are inferences.
 */
export function detectRug(args: {
  baselineAudit: AuditSnapshot | null;
  currentAudit: AuditSnapshot | null;
  peakLiquidityTon: number | null;
  currentLiquidityTon: number | null;
  liquidityDropPct?: number;
}): RugSignal {
  const drain = detectLiquidityDrain(
    args.peakLiquidityTon,
    args.currentLiquidityTon,
    args.liquidityDropPct,
  );
  if (drain) return { rugged: true, reason: drain };

  const degraded = detectAuditDegradation(args.baselineAudit, args.currentAudit);
  if (degraded) return { rugged: true, reason: degraded };

  return { rugged: false, reason: "" };
}

/**
 * Per-jetton liquidity high-water tracker.
 *
 * Deliberately in-memory: a restart simply re-seeds the baseline from the next
 * observation, which is fail-SAFE for this signal (it can only miss a drain
 * that happened while we were down, never invent one). Persisting it would add
 * a migration for no safety gain.
 */
export class LiquidityTracker {
  private peaks = new Map<string, number>();

  /** Record an observation and return the peak/current pair for detection. */
  observe(
    key: string,
    liquidityTon: number | null,
  ): { peakTon: number | null; currentTon: number | null } {
    if (liquidityTon == null || !Number.isFinite(liquidityTon)) {
      return { peakTon: this.peaks.get(key) ?? null, currentTon: null };
    }
    const prior = this.peaks.get(key);
    const peak = prior == null ? liquidityTon : Math.max(prior, liquidityTon);
    this.peaks.set(key, peak);
    return { peakTon: peak, currentTon: liquidityTon };
  }

  peak(key: string): number | null {
    return this.peaks.get(key) ?? null;
  }

  /** Drop state once a position is closed so a later re-entry starts fresh. */
  forget(key: string): void {
    this.peaks.delete(key);
  }
}
