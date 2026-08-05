/**
 * Confidence scoring engine - 100% baseline subtractive model.
 *
 * Computes a 0-100 confidence score starting from 100% and subtracting
 * for each risk factor. This better reflects risk accumulation:
 * "How much confidence do we lose?"
 *
 * Scoring formula:
 *   Start at 100% confidence
 *   Subtract for each risk factor:
 *   - Audit failures (critical): renounce (-25%), LP unlock (-30%), honeypot (-40%)
 *   - Weak distribution: <10 holders (-15%), <100 holders (-10%), <500 holders (-5%)
 *   - New token risk: <1hr (-15%), <12hr (-10%), <24hr (-5%)
 *   - Low liquidity: <10 TON (-10%), <100 TON (-5%)
 *   - Data unavailable: -20% per missing critical data point
 *
 * Minimum to trade: 70% confidence
 * Ideal trades: 85%+ confidence
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
  total: number;           // Final confidence percentage (0-100)
  auditDeduction: number;  // Deduction for audit failures
  holdersDeduction: number; // Deduction for weak distribution
  ageDeduction: number;    // Deduction for new token risk
  liquidityDeduction: number; // Deduction for low liquidity
  dataGapDeduction: number; // Deduction for missing data
  baseConfidence: number;  // Starting confidence before deductions
  
  // Backward compatibility - map old additive properties to new subtractive model
  audit: number;       // Legacy: 0-60 additive (now: 60 - auditDeduction)
  holders: number;     // Legacy: 0-15 additive (now: 15 - holdersDeduction) 
  age: number;         // Legacy: 0-15 additive (now: 15 - ageDeduction)
  liquidity: number;   // Legacy: 0-10 additive (now: 10 - liquidityDeduction)
  tierBonus: number;   // Legacy: 0-10 additive (now: 0 - no bonus in subtractive model)
}

/**
 * Compute a 0-100 confidence score using 100% baseline subtractive model.
 *
 * Returns the final confidence percentage and the deduction breakdown.
 */
export function computeConfidenceScore(input: ConfidenceInput): ScoreBreakdown {
  const baseConfidence = 100;
  let auditDeduction = 0;
  let holdersDeduction = 0;
  let ageDeduction = 0;
  let liquidityDeduction = 0;
  let dataGapDeduction = 0;

  // ── 1. Audit Deductions (Critical) ──
  if (!input.renounced) auditDeduction += 25;  // Non-renounced ownership
  if (!input.lpLocked) auditDeduction += 30;   // Unlocked liquidity pool
  if (!input.honeypotSafe) auditDeduction += 40; // Honeypot risk

  // ── 2. Holder Distribution Deductions ──
  if (input.holders < 10) holdersDeduction += 15;     // Very concentrated
  else if (input.holders < 100) holdersDeduction += 10; // Weak distribution
  else if (input.holders < 500) holdersDeduction += 5;  // Limited distribution

  // ── 3. Token Age Deductions ──
  if (input.ageHours === 0 || !Number.isFinite(input.ageHours)) {
    ageDeduction += 15; // Unknown/brand new - highest risk
  } else if (input.ageHours < 1) ageDeduction += 15;    // < 1 hour old
  else if (input.ageHours < 12) ageDeduction += 10;   // < 12 hours old
  else if (input.ageHours < 24) ageDeduction += 5;    // < 24 hours old

  // ── 4. Liquidity Deductions ──
  if (!input.poolAvailable || input.liquidityTon === null) {
    liquidityDeduction += 10; // No pool or unknown liquidity
  } else if (input.liquidityTon < 10) liquidityDeduction += 10;  // Very low liquidity
  else if (input.liquidityTon < 100) liquidityDeduction += 5;  // Low liquidity

  // ── 5. Data Gap Deductions ──
  if (!Number.isFinite(input.holders) || input.holders <= 0) dataGapDeduction += 20;
  if (!Number.isFinite(input.ageHours) || input.ageHours <= 0) dataGapDeduction += 20;

  // ── Calculate Final Confidence ──
  const totalDeduction = auditDeduction + holdersDeduction + ageDeduction + 
                         liquidityDeduction + dataGapDeduction;
  const total = Math.max(0, Math.min(100, baseConfidence - totalDeduction));

  // ── Backward Compatibility: Calculate legacy additive properties ──
  const audit = Math.max(0, 60 - auditDeduction);       // Map to 0-60 range
  const holders = Math.max(0, 15 - holdersDeduction);   // Map to 0-15 range
  const age = Math.max(0, 15 - ageDeduction);           // Map to 0-15 range
  const liquidity = Math.max(0, 10 - liquidityDeduction); // Map to 0-10 range
  const tierBonus = 0; // No tier bonus in subtractive model

  return { 
    total, 
    auditDeduction, 
    holdersDeduction, 
    ageDeduction, 
    liquidityDeduction, 
    dataGapDeduction,
    baseConfidence,
    // Backward compatibility
    audit,
    holders,
    age,
    liquidity,
    tierBonus
  };
}

export interface ExecutionConfidenceResult { 
  allowed: boolean; 
  reason?: string; 
  requiredScore: number; 
  score: ScoreBreakdown; 
}

const configuredNumber = (key: string, fallback: number) => { 
  const value = Number(process.env[key]); 
  return Number.isFinite(value) && value >= 0 ? value : fallback; 
};

/** Minimum confidence percentage to execute a trade (default: 70%) */
export const MIN_EXECUTION_CONFIDENCE_SCORE = Math.min(100, configuredNumber("MIN_EXECUTION_CONFIDENCE_SCORE", 70));

/** Minimum pool liquidity in TON to execute a trade (default: 50 TON) */
export const MIN_EXECUTABLE_POOL_LIQUIDITY_TON = configuredNumber("MIN_EXECUTABLE_POOL_LIQUIDITY_TON", 50);

/**
 * Evaluate execution confidence using the 100% baseline model.
 * 
 * Critical gates (hard failures):
 * - Honeypot unsafe (immediate rejection)
 * - LP not locked (immediate rejection)
 * - No executable pool (immediate rejection)
 * 
 * Advisory gates (reduce confidence but don't hard-fail):
 * - Non-renounced ownership (-25% deduction)
 * - Weak distribution (-5% to -15% deduction)
 * - New token (-5% to -15% deduction)
 * - Low liquidity (-5% to -10% deduction)
 */
export function evaluateExecutionConfidence(input: ConfidenceInput): ExecutionConfidenceResult {
  const score = computeConfidenceScore(input);
  const requiredScore = Math.max(input.minAiScore, MIN_EXECUTION_CONFIDENCE_SCORE);

  // Critical hard gates - these are immediate failures
  if (!input.honeypotSafe) {
    return { 
      allowed: false, 
      reason: "honeypot detection failed - critical security risk", 
      requiredScore, 
      score 
    };
  }

  if (!input.lpLocked) {
    return { 
      allowed: false, 
      reason: "liquidity pool not locked - rug pull risk", 
      requiredScore, 
      score 
    };
  }

  if (!input.poolAvailable) {
    return { 
      allowed: false, 
      reason: "no resolved executable pool", 
      requiredScore, 
      score 
    };
  }

  // Advisory gates - these reduce confidence but allow trading if score is high enough
  if (input.liquidityTon === null || !Number.isFinite(input.liquidityTon)) {
    return { 
      allowed: false, 
      reason: "pool liquidity is unavailable — fail closed", 
      requiredScore, 
      score 
    };
  }

  if (input.liquidityTon < MIN_EXECUTABLE_POOL_LIQUIDITY_TON) {
    return { 
      allowed: false, 
      reason: `pool liquidity ${input.liquidityTon} TON < minimum ${MIN_EXECUTABLE_POOL_LIQUIDITY_TON} TON`, 
      requiredScore, 
      score 
    };
  }

  // Check final confidence score
  if (score.total < requiredScore) {
    return { 
      allowed: false, 
      reason: `confidence ${score.total}% < required ${requiredScore}% (deductions: audit=${score.auditDeduction}%, holders=${score.holdersDeduction}%, age=${score.ageDeduction}%, liquidity=${score.liquidityDeduction}%, data=${score.dataGapDeduction}%)`, 
      requiredScore, 
      score 
    };
  }

  return { allowed: true, requiredScore, score };
}
