/**
 * Sizing guards for the aligned TP/SL (spec 2026-08-12).
 *
 * Pure functions, unit-tested in test/sizing-guard.test.ts.
 */

/**
 * Worst-case SL economics (§2 "Sizing guard", 2026-08-12).
 *
 * Vol-widening raises the effective stop distance (worst case
 * `slVolWidenMaxPct` instead of the base), so the lot must still clear the
 * economic floor at THAT distance: `perTradeTon × (1 − slVolWidenMaxPct/100)`
 * is what survives a worst-case SL fill, and it must be ≥ the min-viable
 * floor or gas eats the position before it can ever be a winner.
 */
export function worstCaseSlLossOk(args: {
  perTradeTon: number;
  slVolWidenMaxPct: number;
  minViablePositionTon: number;
}): boolean {
  const survive = args.perTradeTon * (1 - args.slVolWidenMaxPct / 100);
  return survive >= args.minViablePositionTon;
}