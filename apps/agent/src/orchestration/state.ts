/**
 * GramTradeState — LangGraph-compatible cycle state for GRAM orchestration.
 * TradeTicket is a proposal; CapCheckResult is the only authorization.
 */
import type {
  CapCheckResult,
  HitlStatus,
  RiskAssessment,
  Tier,
  TradeTicket,
} from "../safetycaps";

export type { CapCheckResult, HitlStatus, RiskAssessment, Tier, TradeTicket };

export interface JettonCandidate {
  jetton_master: string;
  symbol?: string;
  pool_address?: string;
  pool_tvl_ton?: number;
  volume_24h_ton?: number;
}

export interface ExecutionResult {
  ok: boolean;
  error?: string;
  txHash?: string;
  amountTokens?: string;
  dex?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

export interface GramTradeState {
  cycle_id: string;
  tier: Tier;
  candidate: JettonCandidate | null;
  risk_assessment: RiskAssessment | null;
  proposed_ticket: TradeTicket | null;
  cap_check_result: CapCheckResult | null;
  hitl_status: HitlStatus;
  execution_result: ExecutionResult | null;
  /** When true, cycle must stop without execution. */
  discarded: boolean;
  discard_reason?: string;
  todo_plan: TodoItem[];
  journal_ref?: string;

  // Multi-Agent states
  pair_metadata?: Record<string, any> | null;
  security_passed?: boolean;
  security_report?: string;
  microstructure_score?: number;
  social_score?: number;
  composite_score?: number;
  decision?: "EXECUTE_BUY" | "REJECT" | "HOLD";
  execution_payload?: Record<string, any> | null;
}

export function emptyGramState(
  partial: Partial<GramTradeState> & Pick<GramTradeState, "cycle_id" | "tier">,
): GramTradeState {
  return {
    candidate: null,
    risk_assessment: null,
    proposed_ticket: null,
    cap_check_result: null,
    hitl_status: "not_required",
    execution_result: null,
    discarded: false,
    todo_plan: [],
    pair_metadata: null,
    security_passed: false,
    security_report: "",
    microstructure_score: 0,
    social_score: 0,
    composite_score: 0,
    decision: "HOLD",
    execution_payload: null,
    ...partial,
  };
}
