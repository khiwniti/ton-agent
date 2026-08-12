import type { GramTradeState } from "../state";
import { getLLM } from "../../ai/llm";

/**
 * Social Sentiment & Alpha Momentum Node
 * Analyzes Telegram growth velocity, social trends, and smart money inflows.
 */
export async function socialSentimentNode(state: GramTradeState): Promise<Partial<GramTradeState>> {
  if (state.discarded) return {};

  const metadata = state.pair_metadata || {};

  // 1. Programmatic Smart Money Inflow (W_smart)
  // Number of tracked insider/deployer/sniper wallets accumulating
  const smartWalletsCount = metadata.smart_wallets_count ?? 3; // default 3 tracked whales
  const smartMoneyScore = Math.min(100, smartWalletsCount * 25); // max 100

  // 2. Local LLM Evaluation of Social Messages / Velocity (V_social)
  const mockMessages = metadata.scraped_messages || [
    "Uranus launch completing fast! Smart money buying in block 120",
    "Dev burned 100% LP on Ston.fi"
  ];

  const prompt = `Evaluate the viral potential and developer credibility from these community posts / telegram messages:
${JSON.stringify(mockMessages, null, 2)}
Output a single integer representing a social momentum velocity score from 0 to 100.
Respond ONLY with the raw integer score (e.g. 85). No other text or explanation.`;

  let socialVelocityScore = 65; // fallback
  try {
    const llm = getLLM();
    const res = await llm.invoke(prompt);
    const content = typeof res.content === "string" ? res.content.trim() : JSON.stringify(res.content);
    const parsed = parseInt(content.replace(/\D/g, ""), 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
      socialVelocityScore = parsed;
    }
  } catch {
    // Fail soft to default
  }

  // Final social_score is the weighted average of Smart Money and Social Velocity
  const social_score = Math.round((smartMoneyScore * 0.6) + (socialVelocityScore * 0.4));

  return {
    social_score,
  };
}
