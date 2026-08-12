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
  /** Optional seed from scheduler or Telegram command */
  seed_jetton_master?: string;
  candidate: JettonCandidate | null;
  risk_assessment: RiskAssessment | null;
  proposed_ticket: TradeTicket | null;
  cap_check_result: CapCheckResult | null;
  hitl_status: HitlStatus;
  execution_result: ExecutionResult | null;
  /** Current open positions for context */
  open_positions: number;
  /** When true, cycle must stop without execution. */
  discarded: boolean;
  discard_reason?: string;
  todo_plan: TodoItem[];
  journal_ref?: string;
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
    open_positions: 0,
    discarded: false,
    todo_plan: [],
    ...partial,
  };
}
