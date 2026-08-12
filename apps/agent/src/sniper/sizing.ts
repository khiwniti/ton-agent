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

/**
 * %-of-pool-depth cap (spec §4, 2026-08-12): cap the lot at `maxSharePct`
 * of the pool's collected depth so a buy cannot move price more than ~that
 * against itself on a thin memepad curve. null when depth is unknown — the
 * legacy coins don't report it, and refusing them would strand the feature.
 */
export function poolDepthCapTon(
  poolDepthNano: string | null | undefined,
  maxSharePct: number,
): number | null {
  if (poolDepthNano == null) return null;
  const depthTon = Number(poolDepthNano) / 1e9;
  if (!Number.isFinite(depthTon) || depthTon <= 0) return null;
  return depthTon * (maxSharePct / 100);
}

/**
 * Slippage probe (spec §4, 2026-08-12): before executing, request the real
 * quote and refuse a fill that deviates beyond tolerance from the model's
 * pool-price assumption. Prevents buying a fill worse than the model thinks.
 */
export function slippageProbeOk(
  quote: { swap_is_possible?: boolean; price_impact?: number },
  maxImpactPct: number,
): { ok: boolean; reason?: string } {
  if (quote.swap_is_possible === false) {
    return { ok: false, reason: "router reports the swap is not possible" };
  }
  const impact = quote.price_impact;
  if (impact == null || !Number.isFinite(impact)) {
    return { ok: true }; // legacy quote without impact data → no probe signal
  }
  if (impact > maxImpactPct) {
    return { ok: false, reason: `price impact ${impact.toFixed(1)}% > tolerance ${maxImpactPct}%` };
  }
  return { ok: true };
}