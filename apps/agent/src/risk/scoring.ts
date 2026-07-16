/**
 * Confidence scoring engine.
 *
 * Computes a 0-100 score for each trade opportunity based on:
 *   • Security audit results  (renounced, lpLocked, honeypotSafe)
 *   • Holder count            (distribution breadth)
 *   • Token age               (time since creation)
 *   • Pool liquidity          (available depth)
 *   • Pool availability       (can we trade it?)
 *   • Tier minimum threshold  (does the score meet the tier's minAiScore?)
 *
 * The score is purely informational — it does NOT gate execution (the audit
 * booleans + risk gate do that). It IS stored alongside every position so
 * operators can sort/filter by quality and the dashboard can show a badge.
 */

export interface ConfidenceInput {
  /** Security audit pass/fail booleans */
  renounced: boolean;
  lpLocked: boolean;
  honeypotSafe: boolean;
  /** Number of holders (from TONAPI) */
  holders: number;
  /** Token age in hours (0 = unknown / brand new) */
  ageHours: number;
  /** Available pool liquidity in TON (null = unknown) */
  liquidityTon: number | null;
  /** Whether a DEX pool address was provided */
  poolAvailable: boolean;
  /** Risk tier this trade is targeting */
  tier: "low" | "mid" | "high";
  /** Minimum AI score required for this tier (from TierRiskConfig.minAiScore) */
  minAiScore: number;
}

/**
 * Score components breakdown — useful for logging and dashboard display.
 */
export interface ScoreBreakdown {
  total: number;
  audit: number;       // 0-60
  holders: number;     // 0-15
  age: number;         // 0-15
  liquidity: number;   // 0-10
  tierBonus: number;   // 0-10
}

/**
 * Compute a 0-100 confidence score for a trade opportunity.
 *
 * Scoring formula:
 *   audit    (0-60)  — 20 pts each for renounced / LP locked / honeypot-safe
 *   holders  (0-15)  — logarithmic tiers based on distribution breadth
 *   age      (0-15)  — older tokens get more points (established)
 *   liquidity(0-10)  — deeper pools are safer
 *   tierBonus(0-10)  — extra points when the base score already meets the
 *                       tier's minAiScore threshold (alignment bonus)
 *
 * Returns the raw total (0-100) and the component breakdown.
 */
export function computeConfidenceScore(input: ConfidenceInput): ScoreBreakdown {
  // ── 1. Audit (0-60) — each of the three hard gates contributes 20 pts ──
  let audit = 0;
  if (input.renounced) audit += 20;
  if (input.lpLocked) audit += 20;
  if (input.honeypotSafe) audit += 20;

  // ── 2. Holders (0-15) — logarithmic breadth distribution ──
  let holders = 0;
  if (input.holders >= 10_000) holders = 15;
  else if (input.holders >= 5_000) holders = 13;
  else if (input.holders >= 1_000) holders = 11;
  else if (input.holders >= 500) holders = 9;
  else if (input.holders >= 100) holders = 7;
  else if (input.holders >= 50) holders = 5;
  else if (input.holders >= 10) holders = 3;
  else if (input.holders > 0) holders = 1;

  // ── 3. Token age (0-15) — older = more established ──
  let age = 0;
  if (input.ageHours >= 720) age = 15;     // 30+ days
  else if (input.ageHours >= 336) age = 13; // 14+ days
  else if (input.ageHours >= 168) age = 10; // 7+ days
  else if (input.ageHours >= 72) age = 8;   // 3+ days
  else if (input.ageHours >= 48) age = 6;   // 2+ days
  else if (input.ageHours >= 24) age = 5;   // 1+ day
  else if (input.ageHours >= 12) age = 3;   // 12+ hours
  else if (input.ageHours >= 6) age = 2;    // 6+ hours
  else if (input.ageHours >= 1) age = 1;
  // ageHours === 0 → no data, keep age=0

  // ── 4. Liquidity (0-10) — pool depth ──
  let liquidity = 0;
  if (input.poolAvailable && input.liquidityTon != null) {
    if (input.liquidityTon >= 500_000) liquidity = 10;
    else if (input.liquidityTon >= 100_000) liquidity = 9;
    else if (input.liquidityTon >= 50_000) liquidity = 8;
    else if (input.liquidityTon >= 10_000) liquidity = 7;
    else if (input.liquidityTon >= 5_000) liquidity = 6;
    else if (input.liquidityTon >= 1_000) liquidity = 5;
    else if (input.liquidityTon >= 500) liquidity = 4;
    else if (input.liquidityTon >= 100) liquidity = 3;
    else if (input.liquidityTon >= 10) liquidity = 2;
    else liquidity = 1;
  }
  // If pool is available but liquidity is unknown, give a small base point
  if (input.poolAvailable && liquidity === 0) liquidity = 1;

  // ── 5. Tier alignment bonus (0-10) ──
  const baseScore = audit + holders + age + liquidity;
  let tierBonus = 0;
  if (baseScore >= input.minAiScore) {
    // Score already meets threshold — bonus for alignment
    if (baseScore >= 90) tierBonus = 10;
    else if (baseScore >= 80) tierBonus = 8;
    else if (baseScore >= 70) tierBonus = 6;
    else if (baseScore >= 60) tierBonus = 4;
    else tierBonus = 2;
  }

  // ── Clamp to 0-100 ──
  const total = Math.min(100, Math.max(0, baseScore + tierBonus));

  return { total, audit, holders, age, liquidity, tierBonus };
}
