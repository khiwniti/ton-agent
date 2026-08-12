import type { GramTradeState } from "../state";

/**
 * Risk & Execution Director Node
 * Computes composite Pair Opportunity Score using the exact formula:
 * S_pair = R_circuit * (w1 * S_sec + w2 * M_liq + w3 * W_smart + w4 * V_social)
 */
export function riskExecutionNode(state: GramTradeState): Partial<GramTradeState> {
  if (state.discarded) {
    return {
      decision: "REJECT",
      execution_payload: { reason: "Discarded in previous nodes." },
    };
  }

  const metadata = state.pair_metadata || {};
  const securityPassed = state.security_passed ?? false;

  // 1. Circuit Breaker (R_circuit)
  const rCircuit = securityPassed ? 1.0 : 0.0;

  // 2. Score Components
  const sSec = securityPassed ? 100.0 : 0.0;
  const mLiq = state.microstructure_score ?? 0.0;

  const smartWalletsCount = metadata.smart_wallets_count ?? 3;
  const wSmart = Math.min(100, smartWalletsCount * 25);

  const vSocial = state.social_score ?? 65.0;

  // 3. Quantitative Weights
  const w1 = 0.35;
  const w2 = 0.25;
  const w3 = 0.25;
  const w4 = 0.15;

  // S_pair Formula
  const compositeScore = rCircuit * (
    (w1 * sSec) +
    (w2 * mLiq) +
    (w3 * wSmart) +
    (w4 * vSocial)
  );

  const roundedScore = Math.round(compositeScore * 10) / 10;

  // Execution rule: S_pair >= 78.0 and R_circuit === 1
  let decision: "EXECUTE_BUY" | "REJECT" | "HOLD" = "HOLD";
  let payload: Record<string, any> = {};

  let proposed_ticket = null;
  let discarded = false;
  let discard_reason = undefined;

  if (rCircuit === 1 && roundedScore >= 78.0) {
    decision = "EXECUTE_BUY";
    payload = {
      target: state.candidate?.jetton_master,
      action: "SWAP_NATIVE_TO_JETTON",
      slippage_bps: 250,
      composite_score: roundedScore,
      sSec,
      mLiq,
      wSmart,
      vSocial,
    };
    proposed_ticket = {
      cycle_id: state.cycle_id,
      tier: state.tier,
      side: "buy" as const,
      jetton_master: state.candidate?.jetton_master || "",
      amount_ton: 0.5, // low tier default snipe size
      ai_score: roundedScore,
    };
  } else {
    decision = "REJECT";
    discarded = true;
    discard_reason = `Score (${roundedScore}) below threshold (78.0) or security circuit-breaker tripped.`;
    payload = {
      reason: discard_reason,
      composite_score: roundedScore,
    };
  }

  return {
    composite_score: roundedScore,
    decision,
    execution_payload: payload,
    proposed_ticket,
    discarded,
    discard_reason,
  };
}
