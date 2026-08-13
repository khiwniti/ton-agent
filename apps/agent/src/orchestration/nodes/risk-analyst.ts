/**
 * Rug / Risk Analyst — read-only security specialist.
 *
 * Tools: audit_jetton, chain read, scoring helpers.
 * NO transact tools — containment layer.
 * Model: frontier (nuanced judgment on rug/honeypot).
 */
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { CONFIG } from "../../config";
import { log } from "../../logger";
import type { RiskAssessment, RiskVerdict } from "../../safetycaps";
import { auditJettonTool } from "../../mcp/tools";
import { computeConfidenceScore } from "../../risk/scoring";
import type { SecurityReport } from "../../security/audit";

export interface RiskAnalystInput {
  cycle_id: string;
  jetton_master: string;
  /** Pre-enriched candidate from market scanner */
  candidate?: {
    pool_tvl_ton?: number;
    liquidity_ton?: number;
    holders?: number;
    age_hours?: number;
    bonding_curve_pct?: number;
  };
}

export interface RiskAnalystOutput {
  cycle_id: string;
  assessment: RiskAssessment;
}

/**
 * Deterministic hard gates — fast fail before LLM.
 * Mirrors security/audit.ts logic but returns structured RiskAssessment.
 */
export async function runDeterministicChecks(
  jettonMaster: string,
): Promise<{
  passed: boolean;
  checks: RiskAssessment["checks"];
  reason?: string;
  report?: SecurityReport;
}> {
  try {
    const auditResult = await auditJettonTool.invoke({ jettonMaster });

    // Also fetch meta for symbol/mintable/verified
    const { getJettonMetaTool } = await import("../../mcp/tools");
    const meta = await getJettonMetaTool.invoke({ jettonMaster });

    // Map from auditJettonTool output + meta to SecurityReport-like structure
    // auditResult: { renounced, lpLocked, honeypotSafe, holders, ageHours, ok, dataAvailable, dataUnavailableReason, lpLockedDetail, honeypotSafeDetail, renouncedDetail }
    // meta: { name, symbol, description, image, holders, mintable, verification }
    const checks: RiskAssessment["checks"] = {
      lpLock: auditResult.lpLocked,
      holderConcentrationOk: (auditResult.holders ?? meta?.holders ?? 0) > 50,
      mintBlacklistOk: !meta?.mintable,
      verified: !!meta?.verification,
      sellSimOk: auditResult.honeypotSafe,
      creatorHistoryOk: true, // Would need deployer history check
      gramTickerCollisionOk: !meta?.symbol?.toUpperCase().includes("GRAM"),
    };

    const hardFail = !checks.lpLock || !checks.mintBlacklistOk || !checks.sellSimOk || !checks.gramTickerCollisionOk;

    return {
      passed: !hardFail,
      checks,
      reason: hardFail
        ? Object.entries(checks)
            .filter(([, v]) => !v)
            .map(([k]) => k)
            .join(", ")
        : undefined,
    };
  } catch (e: any) {
    log.debug("RISK_ANALYST", `deterministic check failed: ${e.message}`);
    return {
      passed: false,
      checks: {
        lpLock: false,
        holderConcentrationOk: false,
        mintBlacklistOk: false,
        verified: false,
        sellSimOk: false,
        creatorHistoryOk: false,
        gramTickerCollisionOk: true,
      },
      reason: `audit error: ${e.message}`,
    };
  }
}

/**
 * LLM-based nuanced risk analysis.
 * Receives deterministic checks + candidate context, outputs RiskAssessment.
 * NO tool calls — pure reasoning on provided data.
 */
export function makeRiskAnalystAgent() {
  const llm = new ChatOpenAI({
    apiKey: CONFIG.nvidiaApiKey,
    model: CONFIG.nvidiaModel,
    temperature: 0.0,
    configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
  });

  const systemPrompt = `You are a senior smart-contract auditor specializing in TON Jetton (TEP-74) and DEX pool risk.
You receive deterministic audit results (lpLock, mintBlacklistOk, sellSimOk, etc.) and market context.
Your job: assign a final RiskVerdict and rationale for the journal.

VERDICT RULES:
- "reject": ANY hard fail (lpLock=false, mintBlacklistOk=false, sellSimOk=false, gramTickerCollisionOk=false)
- "caution": All hard passes BUT soft concerns (low holders < 100, thin TVL < 20 TON, age < 6h, bonding curve 80-95%, holder concentration > 25%)
- "pass": All hard passes AND no material soft concerns

SOFT CONCERN WEIGHTS:
- holders < 50: -15 pts
- TVL 10-20 TON: -10 pts
- age < 6h: -10 pts
- bonding curve 80-95%: -5 pts (pre-graduation momentum but sniper risk)
- top10 concentration > 25%: -15 pts
- creator has rugged before: -20 pts (if known)

SCORE = 100 - sum(soft penalties). Minimum 0.
Verdict mapping: score >= 70 → "pass", 40-69 → "caution", <40 → "reject" (but hard fails already forced reject).

Return ONLY JSON:
{
  "score": 85,
  "verdict": "pass",
  "checks": { ...echo deterministic checks... },
  "rationale_for_journal": "Clean audit. TVL 45 TON, 200+ holders, 12h age. No soft concerns."
}`;

  const agent = createReactAgent({
    llm,
    tools: [], // NO tools — pure reasoning on provided context
    prompt: systemPrompt,
  });

  return agent;
}

/**
 * Main entry for supervisor: deterministic checks + optional LLM analysis.
 */
export async function riskAnalystNode(
  input: RiskAnalystInput,
): Promise<RiskAnalystOutput> {
  const { cycle_id, jetton_master, candidate } = input;

  // Step 1: Deterministic hard gates (fast, no LLM)
  const det = await runDeterministicChecks(jetton_master);

  if (!det.passed) {
    return {
      cycle_id,
      assessment: {
        score: 0,
        verdict: "reject",
        checks: det.checks,
        rationale_for_journal: `HARD FAIL: ${det.reason}`,
      },
    };
  }

  // Step 2: Compute confidence score from existing risk/scoring.ts
  const confidence = computeConfidenceScore({
    renounced: det.checks.lpLock, // lpLock ≈ renounced for LP
    lpLocked: det.checks.lpLock,
    honeypotSafe: det.checks.sellSimOk,
    holders: candidate?.holders ?? 0,
    ageHours: candidate?.age_hours ?? 0,
    liquidityTon: candidate?.liquidity_ton ?? null,
    poolAvailable: true,
    tier: "low",
    minAiScore: 50,
  });

  // Step 3: Optional LLM nuance (supervisor decides whether to invoke)
  // For deterministic pipeline, fold confidence into assessment
  const softPenalties = [];
  let score = confidence.total;

  if (candidate) {
    if ((candidate.holders ?? 0) < 50) {
      score -= 15;
      softPenalties.push("holders < 50");
    }
    if ((candidate.pool_tvl_ton ?? 0) < 20) {
      score -= 10;
      softPenalties.push("TVL < 20 TON");
    }
    if ((candidate.age_hours ?? 0) < 6) {
      score -= 10;
      softPenalties.push("age < 6h");
    }
    if ((candidate.bonding_curve_pct ?? 0) >= 80 && (candidate.bonding_curve_pct ?? 0) < 95) {
      score -= 5;
      softPenalties.push("bonding curve 80-95%");
    }
  }

  score = Math.max(0, score);

  let verdict: RiskVerdict;
  if (score >= 70) verdict = "pass";
  else if (score >= 40) verdict = "caution";
  else verdict = "reject";

  return {
    cycle_id,
    assessment: {
      score,
      verdict,
      checks: det.checks,
      rationale_for_journal:
        softPenalties.length > 0
          ? `Confidence ${confidence.total}. Soft penalties: ${softPenalties.join(", ")}.`
          : `Confidence ${confidence.total}. No soft concerns.`,
    },
  };
}