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

  // Multi-Agent annotations
  pair_metadata: Annotation<Record<string, any> | null>,
  security_passed: Annotation<boolean>,
  security_report: Annotation<string>,
  microstructure_score: Annotation<number>,
  social_score: Annotation<number>,
  composite_score: Annotation<number>,
  decision: Annotation<string>,
  execution_payload: Annotation<Record<string, any> | null>,
});

export type CompiledGramGraph = ReturnType<typeof buildGramRiskGraph>;

import { sentinelNode } from "./nodes/sentinel";
import { securityAuditorNode } from "./nodes/security-auditor";
import { microstructureQuantNode } from "./nodes/microstructure-quant";
import { socialSentimentNode } from "./nodes/social-sentiment";
import { riskExecutionNode } from "./nodes/risk-execution";

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

/**
 * Compile the complete Multi-Agent Crypto Trading Brain (The Alpha Radar Graph).
 */
export function buildMultiAgentGraph(getContext: CapContextFactory) {
  const safetyCaps = makeSafetyCapsNode(getContext);

  return new StateGraph(GramAnnotation)
    .addNode("sentinel", (s) => sentinelNode(s as GramTradeState))
    .addNode("security_auditor", (s) => securityAuditorNode(s as GramTradeState))
    .addNode("microstructure_quant", (s) => microstructureQuantNode(s as GramTradeState))
    .addNode("social_sentiment", (s) => socialSentimentNode(s as GramTradeState))
    .addNode("risk_execution", (s) => riskExecutionNode(s as GramTradeState))
    .addNode("safety_caps", (s) => safetyCaps(s as GramTradeState))

    .addEdge(START, "sentinel")
    .addEdge("sentinel", "security_auditor")

    // If security fails, router goes directly to safety_caps/end (fail fast)
    .addConditionalEdges(
      "security_auditor",
      (s) => (s.discarded ? "safety_caps" : "microstructure_quant"),
      {
        safety_caps: "safety_caps",
        microstructure_quant: "microstructure_quant",
      }
    )
    .addEdge("microstructure_quant", "social_sentiment")
    .addEdge("social_sentiment", "risk_execution")
    .addEdge("risk_execution", "safety_caps")
    .addEdge("safety_caps", END)
    .compile();
}

/** Run the multi-agent pipeline on a GramTradeState. */
export async function runMultiAgentPipeline(
  input: GramTradeState,
  ctx: CapCheckContext,
): Promise<GramTradeState> {
  const graph = buildMultiAgentGraph(() => ctx);
  const out = await graph.invoke(input);
  return out as GramTradeState;
}
