/**
 * GRAM Supervisor Graph — LangGraph Deep Agents topology (Phase 2).
 *
 * Topology:
 * START → Supervisor → Market Scanner → Risk Analyst → Risk Gate → Strategy → SafetyCaps → HITL (conditional) → Execution → Postmortem → END
 *
 * Risk Gate and SafetyCaps are pure TS graph nodes (not LLM tools).
 * HITL interrupt only before Execution when size ≥ auto-approve ceiling OR risk verdict = caution.
 * Specialist sub-agents as tools with appropriately scoped tool sets.
 * Cold path (LLM) vs Hot path (native TS) separation.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { CapCheckContext } from "../safetycaps";
import { riskGateNode } from "./nodes/risk-gate";
import { makeSafetyCapsNode, type CapContextFactory } from "./nodes/safety-caps";
import { supervisorNode } from "./nodes/supervisor";
import { marketScannerNode } from "./nodes/market-scanner";
import { riskAnalystNode } from "./nodes/risk-analyst";
import { strategyNode } from "./nodes/strategy";
import { hitlNode, resolveHitl } from "./nodes/hitl";
import { executionNode, makeAuthorizedExecution } from "./nodes/execution";
import { postmortemNode } from "./nodes/postmortem";
import type {
  CapCheckResult,
  ExecutionResult,
  GramTradeState,
  HitlStatus,
  JettonCandidate,
  RiskAssessment,
  Tier,
  TodoItem,
  TradeTicket,
} from "./state";

const GramAnnotation = Annotation.Root({
  cycle_id: Annotation<string>,
  tier: Annotation<Tier>,
  seed_jetton_master: Annotation<string | undefined>,
  candidate: Annotation<JettonCandidate | null>,
  risk_assessment: Annotation<RiskAssessment | null>,
  proposed_ticket: Annotation<TradeTicket | null>,
  cap_check_result: Annotation<CapCheckResult | null>,
  hitl_status: Annotation<HitlStatus>,
  execution_result: Annotation<ExecutionResult | null>,
  open_positions: Annotation<number>,
  discarded: Annotation<boolean>,
  discard_reason: Annotation<string | undefined>,
  todo_plan: Annotation<TodoItem[]>,
  journal_ref: Annotation<string | undefined>,
});

export type CompiledGramGraph = ReturnType<typeof buildGramSupervisorGraph>;

/**
 * Build the complete supervisor graph with all specialist nodes.
 * Inject CapCheckContext via factory so tests stay pure.
 */
export function buildGramSupervisorGraph(
  getContext: CapContextFactory,
  checkpointer?: BaseCheckpointSaver,
) {
  const safetyCaps = makeSafetyCapsNode(getContext);

  const graph = new StateGraph(GramAnnotation)
    // Supervisor plans and delegates
    .addNode("supervisor", async (state: GramTradeState) => {
      // getTierState fetches live balance + open positions for the tier
      const getTierState = async (tier: string) => {
        // In production, this reads from coordinator tier handle
        // For graph execution, we'll need to pass this via config
        return { balance_ton: 10, open_positions: 0 };
      };
      return supervisorNode(state, getTierState);
    })
    // Market Scanner — read-only market data
    .addNode("market_scanner", async (state: GramTradeState) => {
      const out = await marketScannerNode({
        cycle_id: state.cycle_id,
        seed_jetton_master: state.seed_jetton_master,
      });
      return {
        candidate: out.winner ?? out.candidates[0] ?? null,
        // Store all candidates in journal_ref for reference
        journal_ref: JSON.stringify(out.candidates.map((c) => c.jetton_master)),
      };
    })
    // Risk Analyst — read-only security audit
    .addNode("risk_analyst", async (state: GramTradeState) => {
      if (!state.candidate) return {};
      const out = await riskAnalystNode({
        cycle_id: state.cycle_id,
        jetton_master: state.candidate.jetton_master,
        candidate: state.candidate,
      });
      return { risk_assessment: out.assessment };
    })
    // Risk Gate — deterministic: reject if verdict=reject
    .addNode("risk_gate", (s: GramTradeState) => riskGateNode(s))
    // Strategy — sizing & exit plan, proposes TradeTicket
    .addNode("strategy", async (state: GramTradeState) => {
      if (!state.candidate || !state.risk_assessment) return {};
      // Tier state would come from coordinator in production
      const tierState = { balance_ton: 10, open_positions: state.open_positions, max_position_ton: 5, max_open: 3 };
      const out = await strategyNode({
        cycle_id: state.cycle_id,
        tier: state.tier,
        candidate: state.candidate,
        risk_assessment: state.risk_assessment,
        tier_state: tierState,
      });
      return {
        proposed_ticket: out.ticket,
        journal_ref: out.rationale,
      };
    })
    // SafetyCaps — deterministic authorization
    .addNode("safety_caps", (s: GramTradeState) => safetyCaps(s))
    // HITL — Telegram approval interrupt (pauses graph)
    .addNode("hitl", async (state: GramTradeState) => {
      if (!state.proposed_ticket || !state.cap_check_result) return {};
      const out = await hitlNode({
        cycle_id: state.cycle_id,
        ticket: state.proposed_ticket,
        cap: state.cap_check_result,
      });
      return {
        hitl_status: out.hitl_status,
        cap_check_result: out.cap,
        discarded: !out.proceed && out.hitl_status !== "pending", // Discard if denied/timeout
        discard_reason: out.hitl_status === "denied" ? "HITL denied" : out.hitl_status === "timeout" ? "HITL timeout" : undefined,
      };
    })
    // Execution — mechanical swap (only after SafetyCaps + HITL)
    .addNode("execution", async (state: GramTradeState) => {
      if (!state.proposed_ticket || !state.cap_check_result) return {};
      if (state.cap_check_result.hitl_required && state.hitl_status !== "approved") {
        return { discarded: true, discard_reason: "HITL not approved" };
      }
      const authorized = makeAuthorizedExecution(
        state.proposed_ticket,
        state.cap_check_result,
        state.hitl_status,
      );
      const out = await executionNode({ cycle_id: state.cycle_id, authorized });
      return {
        execution_result: out.ok
          ? { ok: true, txHash: out.result?.txHash, amountTokens: out.result?.amountTokens, dex: out.result?.dex }
          : { ok: false, error: out.error },
        discarded: !out.ok,
        discard_reason: out.error,
      };
    })
    // Postmortem — journal summary
    .addNode("postmortem", async (state: GramTradeState) => {
      const out = await postmortemNode({ cycle_id: state.cycle_id });
      return { journal_ref: out.summary };
    })
    // Edges
    .addEdge(START, "supervisor")
    // Supervisor conditional routing based on next hint
    .addConditionalEdges(
      "supervisor",
      (s) => s.discarded ? "end" : (s as any)._next ?? "market_scanner",
      {
        market_scanner: "market_scanner",
        risk_analyst: "risk_analyst",
        risk_gate: "risk_gate",
        strategy: "strategy",
        safety_caps: "safety_caps",
        hitl: "hitl",
        execution: "execution",
        postmortem: "postmortem",
        end: END,
      },
    )
    .addEdge("market_scanner", "supervisor")
    .addEdge("risk_analyst", "supervisor")
    .addConditionalEdges(
      "risk_gate",
      (s) => s.discarded ? "end" : "supervisor",
      { end: END, supervisor: "supervisor" },
    )
    .addEdge("strategy", "supervisor")
    .addConditionalEdges(
      "safety_caps",
      (s) => {
        if (s.discarded) return "end";
        if (s.cap_check_result?.hitl_required && s.hitl_status === "pending") return "hitl";
        if (s.cap_check_result?.ok) return "execution";
        return "end";
      },
      { end: END, hitl: "hitl", execution: "execution" },
    )
    .addConditionalEdges(
      "hitl",
      (s) => {
        if (s.discarded) return "end";
        if (s.hitl_status === "approved") return "execution";
        return "end"; // denied or timeout
      },
      { end: END, execution: "execution" },
    )
    .addEdge("execution", "supervisor")
    .addEdge("postmortem", END);

  return checkpointer ? graph.compile({ checkpointer }) : graph.compile();
}

/**
 * Build the risk-only graph (Phase 1 compatibility).
 * START → risk_gate → safety_caps → END
 */
export function buildGramRiskGraph(getContext: CapContextFactory) {
  const safetyCaps = makeSafetyCapsNode(getContext);

  return new StateGraph(GramAnnotation)
    .addNode("risk_gate", (s) => riskGateNode(s as GramTradeState))
    .addNode("safety_caps", (s) => safetyCaps(s as GramTradeState))
    .addEdge(START, "risk_gate")
    .addConditionalEdges(
      "risk_gate",
      (s) => (s.discarded ? "end" : "safety_caps"),
      { end: END, safety_caps: "safety_caps" },
    )
    .addEdge("safety_caps", END)
    .compile();
}

/**
 * Helper to run the risk pipeline (used by tests).
 */
export async function runRiskPipeline(
  state: GramTradeState,
  ctx: CapCheckContext,
): Promise<GramTradeState> {
  const graph = buildGramRiskGraph(() => ctx);
  const result = await graph.invoke(state);
  return result as GramTradeState;
}