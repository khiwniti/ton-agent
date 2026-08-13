/**
 * Deterministic risk gate node — not an LLM step.
 * reject → discard; caution/pass continue (caution is advisory only).
 */
import type { GramTradeState } from "../state";

export function riskGateNode(state: GramTradeState): Partial<GramTradeState> {
  if (state.discarded) return {};

  const verdict = state.risk_assessment?.verdict;
  if (verdict === "reject") {
    return {
      discarded: true,
      discard_reason: "risk verdict reject — auto-discard",
    };
  }

  if (!state.proposed_ticket && state.candidate) {
    // Ensure downstream has a ticket shell if strategy already set one; else no-op.
    return {};
  }

  // Fold risk into ticket when present so SafetyCaps sees the verdict.
  if (state.proposed_ticket && state.risk_assessment) {
    return {
      proposed_ticket: {
        ...state.proposed_ticket,
        risk: state.risk_assessment,
      },
    };
  }

  return {};
}
