/**
 * Supervisor Agent — plans, delegates to specialists, manages todo_plan.
 *
 * Tools: Specialist sub-agents AS TOOLS (MarketScanner, RiskAnalyst, Strategy, etc.)
 * Model: frontier (planning, delegation, synthesis).
 * NO direct transact tools — only delegates to Execution via graph edges.
 */
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { CONFIG } from "../../config";
import { log } from "../../logger";
import type { GramTradeState, TodoItem, JettonCandidate } from "../state";
import { emptyGramState } from "../state";
import { marketScannerNode, makeMarketScannerAgent, type MarketScannerInput } from "./market-scanner";
import { riskAnalystNode, makeRiskAnalystAgent, type RiskAnalystInput } from "./risk-analyst";
import { strategyNode, makeStrategyAgent, type StrategyInput } from "./strategy";
import { postmortemNode, type PostmortemInput } from "./postmortem";

export interface SupervisorInput {
  cycle_id: string;
  tier: "low" | "mid" | "high";
  /** Optional: seed from scheduler / Telegram */
  seed_jetton_master?: string;
  /** Optional: resume from HITL */
  hitl_resume?: { approval_id: string; action: "approve" | "deny" };
}

export interface SupervisorOutput {
  /** Updated state for graph continuation */
  state: Partial<GramTradeState>;
  /** Next node hint for conditional routing */
  next: "market_scanner" | "risk_analyst" | "risk_gate" | "strategy" | "safety_caps" | "hitl" | "execution" | "postmortem" | "end";
  /** Human-readable plan step */
  plan_step: string;
}

/**
 * Build todo plan for the cycle.
 */
function buildInitialPlan(cycleId: string, seedJetton?: string): TodoItem[] {
  return [
    { id: `${cycleId}-1`, content: "Scan market for candidates", status: "pending" },
    { id: `${cycleId}-2`, content: "Risk analysis (audit + microstructure)", status: "pending" },
    { id: `${cycleId}-3`, content: "Risk gate (deterministic)", status: "pending" },
    { id: `${cycleId}-4`, content: "Strategy & sizing", status: "pending" },
    { id: `${cycleId}-5`, content: "SafetyCaps authorization", status: "pending" },
    { id: `${cycleId}-6`, content: "HITL approval (if required)", status: "pending" },
    { id: `${cycleId}-7`, content: "Execute swap", status: "pending" },
    { id: `${cycleId}-8`, content: "Postmortem journal", status: "pending" },
  ];
}

function updatePlanItem(plan: TodoItem[], id: string, status: TodoItem["status"]): TodoItem[] {
  return plan.map((item) => (item.id === id ? { ...item, status } : item));
}

/**
 * LLM-based supervisor — plans cycle, delegates to specialists, synthesizes.
 * Tools = specialist agents (invoked via tool calling).
 */
export function makeSupervisorAgent() {
  const llm = new ChatOpenAI({
    apiKey: CONFIG.nvidiaApiKey,
    model: CONFIG.nvidiaModel,
    temperature: 0.2,
    configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
  });

  const systemPrompt = `You are the SUPERVISOR of a TON trading agent orchestra.
You manage a trading cycle from scan → execute → postmortem.
You DELEGATE to specialists by invoking their tools — you do NOT call raw tools yourself.

SPECIALISTS (invoke as tools):
1. market_scanner — read-only market data, returns ranked candidates
2. risk_analyst — read-only security audit, returns RiskAssessment (pass/caution/reject)
3. strategy — sizing + exit plan, returns TradeTicket proposal
4. safety_caps — deterministic authorization (graph node, not a tool)
5. hitl — Telegram approval interrupt (graph node)
6. execution — mechanical swap execution (graph node)
6. postmortem — journal summary (graph node)

YOUR JOB:
- Accept cycle_id + tier + optional seed_jetton_master
- Build todo_plan
- Invoke specialists IN ORDER, updating todo_plan as each completes
- Synthesize outputs into GramTradeState updates
- Return { state: Partial<GramTradeState>, next: "node_name", plan_step: "..." }

DECISION RULES:
- If market_scanner returns 0 candidates → next="end", discarded=true
- If risk_analyst verdict="reject" → next="end", discarded=true
- If risk_gate (deterministic) discards → next="end"
- If strategy returns no ticket (size=0) → next="end", discarded=true
- If safety_caps hitl_required → next="hitl" (graph pauses)
- If safety_caps ok + no HITL → next="execution"
- After execution → next="postmortem"
- After postmortem → next="end"

Return ONLY JSON:
{
  "state": { ...GramTradeState updates... },
  "next": "market_scanner",
  "plan_step": "Scanning market for top candidates..."
}`;

  const agent = createReactAgent({
    llm,
    tools: [
      // Specialist agents exposed as tools
      {
        name: "market_scanner",
        description: "Scan market for trade candidates. Returns ranked JettonCandidate list.",
        schema: {
          type: "object",
          properties: {
            cycle_id: { type: "string" },
            seed_jetton_master: { type: "string" },
          },
          required: ["cycle_id"],
        },
        func: async (args: MarketScannerInput) => marketScannerNode(args),
      },
      {
        name: "risk_analyst",
        description: "Analyze jetton security risk. Returns RiskAssessment with verdict.",
        schema: {
          type: "object",
          properties: {
            cycle_id: { type: "string" },
            jetton_master: { type: "string" },
            candidate: { type: "object" },
          },
          required: ["cycle_id", "jetton_master"],
        },
        func: async (args: RiskAnalystInput) => riskAnalystNode(args),
      },
      {
        name: "strategy",
        description: "Propose TradeTicket with sizing. Returns ticket + rationale.",
        schema: {
          type: "object",
          properties: {
            cycle_id: { type: "string" },
            tier: { type: "string", enum: ["low", "mid", "high"] },
            candidate: { type: "object" },
            risk_assessment: { type: "object" },
            tier_state: { type: "object" },
          },
          required: ["cycle_id", "tier", "candidate", "risk_assessment", "tier_state"],
        },
        func: async (args: StrategyInput) => strategyNode(args),
      },
      {
        name: "postmortem",
        description: "Generate postmortem summary from journal.",
        schema: {
          type: "object",
          properties: {
            cycle_id: { type: "string" },
          },
          required: ["cycle_id"],
        },
        func: async (args: PostmortemInput) => postmortemNode(args),
      },
    ],
    prompt: systemPrompt,
  });

  return agent;
}

/**
 * Deterministic supervisor step — runs one phase of the cycle.
 * This is the graph node version (no LLM) for production use.
 * LLM version above is for complex planning / recovery scenarios.
 */
export async function supervisorNode(
  state: GramTradeState,
  getTierState: (tier: string) => Promise<{ balance_ton: number; open_positions: number }>,
): Promise<SupervisorOutput> {
  const { cycle_id, tier, discarded, candidate, risk_assessment, proposed_ticket, cap_check_result, hitl_status, execution_result, todo_plan } = state;

  if (discarded) {
    return { state: {}, next: "end", plan_step: "Cycle discarded — ending" };
  }

  const plan = todo_plan ?? buildInitialPlan(cycle_id);

  // Phase 1: Market Scanner
  if (!candidate && plan[0].status !== "done") {
    const scannerIn: MarketScannerInput = { cycle_id, seed_jetton_master: state.seed_jetton_master };
    const scannerOut = await marketScannerNode(scannerIn);

    if (scannerOut.candidates.length === 0) {
      return {
        state: {
          discarded: true,
          discard_reason: "no candidates found",
          todo_plan: updatePlanItem(plan, `${cycle_id}-1`, "done"),
        },
        next: "end",
        plan_step: "No candidates — discarding cycle",
      };
    }

    const winner = scannerOut.winner ?? scannerOut.candidates[0];
    return {
      state: {
        candidate: winner,
        todo_plan: updatePlanItem(plan, `${cycle_id}-1`, "done"),
      },
      next: "risk_analyst",
      plan_step: `Selected ${winner.symbol ?? winner.jetton_master.slice(0, 8)}… — running risk analysis`,
    };
  }

  // Phase 2: Risk Analyst
  if (candidate && !risk_assessment && plan[1].status !== "done") {
    const riskIn: RiskAnalystInput = { cycle_id, jetton_master: candidate.jetton_master, candidate };
    const riskOut = await riskAnalystNode(riskIn);

    if (riskOut.assessment.verdict === "reject") {
      return {
        state: {
          risk_assessment: riskOut.assessment,
          discarded: true,
          discard_reason: `risk verdict: ${riskOut.assessment.rationale_for_journal}`,
          todo_plan: updatePlanItem(plan, `${cycle_id}-2`, "done"),
        },
        next: "end",
        plan_step: `Risk REJECT: ${riskOut.assessment.rationale_for_journal}`,
      };
    }

    return {
      state: {
        risk_assessment: riskOut.assessment,
        todo_plan: updatePlanItem(plan, `${cycle_id}-2`, "done"),
      },
      next: "risk_gate",
      plan_step: `Risk ${riskOut.assessment.verdict.toUpperCase()} (score ${riskOut.assessment.score}) — proceeding to risk gate`,
    };
  }

  // Phase 3: Strategy (after risk_gate passes)
  if (risk_assessment && !proposed_ticket && plan[3].status !== "done") {
    const tierState = await getTierState(tier);
    const strategyIn: StrategyInput = {
      cycle_id,
      tier: tier as "low" | "mid" | "high",
      candidate,
      risk_assessment,
      tier_state: {
        balance_ton: tierState.balance_ton,
        open_positions: tierState.open_positions,
        max_position_ton: 5, // Will be overridden by SafetyCaps context
        max_open: 3,
      },
    };
    const strategyOut = await strategyNode(strategyIn);

    if (!strategyOut.ticket) {
      return {
        state: {
          discarded: true,
          discard_reason: strategyOut.rationale,
          todo_plan: updatePlanItem(plan, `${cycle_id}-4`, "done"),
        },
        next: "end",
        plan_step: `Sizing failed: ${strategyOut.rationale}`,
      };
    }

    return {
      state: {
        proposed_ticket: strategyOut.ticket,
        todo_plan: updatePlanItem(plan, `${cycle_id}-4`, "done"),
        journal_ref: strategyOut.rationale,
      },
      next: "safety_caps",
      plan_step: `Proposed ticket: ${strategyOut.ticket.amount_ton} TON — requesting SafetyCaps authorization`,
    };
  }

  // Phase 4: After SafetyCaps (handled by graph edges)
  // This node doesn't handle SafetyCaps/HITL/Execution directly — those are separate graph nodes

  // Phase 5: Postmortem (after execution)
  if (execution_result && plan[7].status !== "done") {
    const postOut = await postmortemNode({ cycle_id });
    return {
      state: {
        journal_ref: postOut.summary,
        todo_plan: updatePlanItem(plan, `${cycle_id}-8`, "done"),
      },
      next: "end",
      plan_step: `Postmortem complete: ${postOut.summary}`,
    };
  }

  // Default: continue to next phase based on state
  if (!candidate) return { state: {}, next: "market_scanner", plan_step: "Starting market scan" };
  if (!risk_assessment) return { state: {}, next: "risk_analyst", plan_step: "Running risk analysis" };
  if (!proposed_ticket) return { state: {}, next: "strategy", plan_step: "Planning strategy" };
  if (!cap_check_result) return { state: {}, next: "safety_caps", plan_step: "Requesting SafetyCaps authorization" };
  if (cap_check_result && cap_check_result.hitl_required && hitl_status === "pending") return { state: {}, next: "hitl", plan_step: "Awaiting HITL approval" };
  if (cap_check_result && cap_check_result.ok && !cap_check_result.hitl_required && !execution_result) return { state: {}, next: "execution", plan_step: "Executing swap" };
  if (execution_result && !plan[7].status) return { state: {}, next: "postmortem", plan_step: "Generating postmortem" };

  return { state: {}, next: "end", plan_step: "Cycle complete" };
}