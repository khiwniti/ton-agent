/**
 * Strategy Agent — sizing & exit planning specialist.
 *
 * Tools: sizing calculators, exit-policy config READ ONLY.
 * Proposes TradeTicket — NEVER authorizes.
 * Model: frontier (reasoning on risk/reward).
 */
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { CONFIG } from "../../config";
import { log } from "../../logger";
import type { TradeTicket, Tier, RiskAssessment } from "../../safetycaps";
import { checkPortfolioAllocation, TIER_RISK_CONFIGS } from "../../risk/guardrails";

export interface StrategyInput {
  cycle_id: string;
  tier: Tier;
  candidate: {
    jetton_master: string;
    symbol?: string;
    pool_tvl_ton?: number;
    liquidity_ton?: number;
    volume_24h_ton?: number;
    price_ton?: number;
    price_change_24h_pct?: number;
    holders?: number;
    age_hours?: number;
    bonding_curve_pct?: number;
  };
  risk_assessment: RiskAssessment;
  /** Current tier state for sizing */
  tier_state: {
    balance_ton: number;
    open_positions: number;
    max_position_ton: number;
    max_open: number;
  };
}

export interface StrategyOutput {
  cycle_id: string;
  ticket: TradeTicket | null;
  /** Reasoning for journal */
  rationale: string;
}

/**
 * Deterministic sizing calculator — no LLM.
 * Returns max allowed size respecting ALL caps.
 */
export function calculateMaxSize(input: StrategyInput): number {
  const { tier, candidate, tier_state, risk_assessment } = input;
  const cfg = TIER_RISK_CONFIGS[tier];

  // 1. Tier absolute cap
  let maxSize = cfg.maxPositionTon;

  // 2. Portfolio allocation cap (5% default)
  const allocCheck = checkPortfolioAllocation(maxSize, tier_state.balance_ton);
  if (!allocCheck.allowed && allocCheck.maxAllowedTon !== undefined) {
    maxSize = Math.min(maxSize, allocCheck.maxAllowedTon);
  }

  // 3. Liquidity depth cap (5% of pool TVL default)
  if (candidate.pool_tvl_ton && candidate.pool_tvl_ton > 0) {
    const depthCap = candidate.pool_tvl_ton * 0.05; // 5% default
    maxSize = Math.min(maxSize, depthCap);
  }

  // 4. Risk-adjusted: caution verdict reduces size by 50%
  if (risk_assessment.verdict === "caution") {
    maxSize *= 0.5;
  }

  // 5. Min viable size (dust filter)
  const minSize = 0.05; // 0.05 TON minimum
  if (maxSize < minSize) return 0;

  return Math.floor(maxSize * 1000) / 1000; // Round to 3 decimals
}

/**
 * LLM-based strategy reasoning — entry/exit plan, R:R, position sizing rationale.
 * Receives deterministic max size, proposes final ticket.
 * NO transact tools — only READ tools for config.
 */
export function makeStrategyAgent() {
  const llm = new ChatOpenAI({
    apiKey: CONFIG.nvidiaApiKey,
    model: CONFIG.nvidiaModel,
    temperature: 0.2,
    configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
  });

  const systemPrompt = `You are a quantitative strategist for TON jetton swing trades (1h–24h hold).
You receive: candidate data, risk assessment, deterministic max size, tier config.
You propose a TradeTicket with: size, slippage estimate, pool TVL, AI confidence.

RULES:
- NEVER exceed deterministic max_size_ton.
- Size must be >= 0.05 TON (dust filter).
- Slippage_pct: estimate from pool depth (vol/TVL ratio). Cap at tier ceiling (1.5% default).
- ai_score: map risk_assessment.score (0-100) to tier minAiScore baseline.
- Exit policy is FIXED by tier config (TP/SL/trailing/time) — do NOT invent custom exits.
- Rationale must be specific: "Size 0.42 TON = min(tier cap 1, alloc 0.45, depth 0.8, caution 50%)"

Return ONLY JSON:
{
  "ticket": {
    "cycle_id": "...",
    "tier": "low",
    "side": "buy",
    "jetton_master": "...",
    "amount_ton": 0.42,
    "slippage_pct": 1.2,
    "pool_tvl_ton": 45.3,
    "ai_score": 78
  },
  "rationale": "Size 0.42 TON = min(tier cap 1, alloc 0.45, depth 0.8, caution 50%). R:R 1:3 at TP1. Trail activates at +35%."
}`;

  const agent = createReactAgent({
    llm,
    tools: [], // NO tools — pure reasoning on provided context
    prompt: systemPrompt,
  });

  return agent;
}

/**
 * Main entry for supervisor: deterministic sizing + optional LLM refinement.
 */
export async function strategyNode(
  input: StrategyInput,
): Promise<StrategyOutput> {
  const { cycle_id, tier, candidate, risk_assessment, tier_state } = input;

  // Deterministic max size
  const maxSize = calculateMaxSize(input);

  if (maxSize <= 0) {
    return {
      cycle_id,
      ticket: null,
      rationale: `Sizing resulted in 0 — maxSize=${maxSize} (tier cap=${TIER_RISK_CONFIGS[tier].maxPositionTon}, balance=${tier_state.balance_ton})`,
    };
  }

  // Deterministic slippage estimate from pool depth
  let slippagePct = 0.5; // default optimistic
  if (candidate.pool_tvl_ton && candidate.volume_24h_ton) {
    const depthRatio = candidate.volume_24h_ton / candidate.pool_tvl_ton;
    slippagePct = Math.min(1.5, Math.max(0.3, depthRatio * 2)); // heuristic
  }

  // AI score from risk assessment
  const aiScore = risk_assessment.score;

  // Build ticket (deterministic baseline)
  const ticket: TradeTicket = {
    cycle_id,
    tier,
    side: "buy",
    jetton_master: candidate.jetton_master,
    amount_ton: maxSize,
    slippage_pct: slippagePct,
    pool_tvl_ton: candidate.pool_tvl_ton,
    ai_score: aiScore,
    risk: risk_assessment,
  };

  const rationale = `Size ${maxSize} TON = min(tier cap ${TIER_RISK_CONFIGS[tier].maxPositionTon}, alloc ${(tier_state.balance_ton * 0.05).toFixed(3)}, depth ${candidate.pool_tvl_ton ? (candidate.pool_tvl_ton * 0.05).toFixed(3) : "N/A"}${risk_assessment.verdict === "caution" ? ", caution 50%" : ""}). Slippage est ${slippagePct.toFixed(1)}%. AI score ${aiScore}.`;

  return { cycle_id, ticket, rationale };
}