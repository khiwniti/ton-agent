import type { GramTradeState } from "../state";

/**
 * Microstructure & Liquidity Quant Node
 * Computes holder concentration (Gini/concentration ratios) and organic volume ratios.
 */
export function microstructureQuantNode(state: GramTradeState): Partial<GramTradeState> {
  if (state.discarded) return {};

  const metadata = state.pair_metadata || {};

  // 1. Holder Concentration Check
  // Top 10 holders percentage (excluding burn/LP)
  const top10Concentration = metadata.top_10_concentration ?? 18.5; // default well-distributed

  // Gini-coefficient estimation based on top holders distribution
  const giniScore = top10Concentration / 100.0;
  let concentrationDeduction = 0;
  if (giniScore > 0.35 || top10Concentration > 25.0) {
    concentrationDeduction = 35; // Heavy sybil cluster concentration
  } else if (giniScore > 0.20) {
    concentrationDeduction = 15; // Moderate concentration
  }

  // 2. Organic Volume Ratio (OVR)
  // OVR = Unique buyer addresses vs total transactions
  const uniqueBuyers = metadata.unique_buyers ?? 120;
  const totalTx = metadata.total_tx ?? 150;
  const ovr = totalTx > 0 ? uniqueBuyers / totalTx : 1.0;
  let ovrDeduction = 0;
  if (ovr < 0.4) {
    ovrDeduction = 25; // Heavily wash traded
  } else if (ovr < 0.7) {
    ovrDeduction = 10; // Potential mild wash trading
  }

  // 3. Slippage Impact / Depth Check
  // Slippage impact for a 100 TON order
  const slippageImpact = metadata.slippage_impact_100ton ?? 0.8; // default 0.8%
  let slippageDeduction = 0;
  if (slippageImpact > 3.0) {
    slippageDeduction = 20; // Thin liquidity
  } else if (slippageImpact > 1.5) {
    slippageDeduction = 10; // Moderate liquidity
  }

  // Calculate final Microstructure Score (0-100)
  const microstructure_score = Math.max(0, 100 - (concentrationDeduction + ovrDeduction + slippageDeduction));

  return {
    microstructure_score,
  };
}
