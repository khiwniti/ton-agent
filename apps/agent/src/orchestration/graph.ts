/**
 * Minimal GRAM supervisor graph skeleton (Phase 2).
 *
 * Topology (stub): START → risk_gate → (discard? END : safety_caps) → END
 * Full specialist subgraphs land later. ai/brain.ts remains production entry until cutover.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { CapCheckContext } from "../safetycaps";
import { riskGateNode } from "./nodes/risk-gate";
import { makeSafetyCapsNode, type CapContextFactory } from "./nodes/safety-caps";
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
  candidate: Annotation<JettonCandidate | null>,
  risk_assessment: Annotation<RiskAssessment | null>,
  proposed_ticket: Annotation<TradeTicket | null>,
  cap_check_result: Annotation<CapCheckResult | null>,
  hitl_status: Annotation<HitlStatus>,
  execution_result: Annotation<ExecutionResult | null>,
  discarded: Annotation<boolean>,
  discard_reason: Annotation<string | undefined>,
  todo_plan: Annotation<TodoItem[]>,
  journal_ref: Annotation<string | undefined>,
});

export type CompiledGramGraph = ReturnType<typeof buildGramRiskGraph>;

/**
 * Compile risk-only graph. Inject CapCheckContext via factory so tests stay pure.
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
      {
        end: END,
        safety_caps: "safety_caps",
      },
    )
    .addEdge("safety_caps", END)
    .compile();
}

/** Helper for tests: run risk pipeline on a GramTradeState. */
export async function runRiskPipeline(
  input: GramTradeState,
  ctx: CapCheckContext,
): Promise<GramTradeState> {
  const graph = buildGramRiskGraph(() => ctx);
  const out = await graph.invoke(input);
  return out as GramTradeState;
}
