/**
 * LangChain / LangGraph deep-research ReAct agent — the "brain".
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Chief Orchestrator (you, ATLAS-9)                            │
 * │     ├─ Expert 1 — On-chain Intelligence  (audit + meta + price)│
 * │     ├─ Expert 2 — Risk & Execution       (gate + bankroll)    │
 * │     └─ Expert 3 — Market Intelligence   (news + sentiment)   │
 * │                                                              │
 * │  Flow: Plan → On-chain Intel → Risk gate → Execute → Monitor  │
 * └─────────────────────────────────────────────────────────────┘
 *
 * The chief orchestrator delegates to three internal expert roles. Each
 * role draws from a fixed toolset — you call them by name and let the
 * LLM reason across results. Skills registered in `skills/index.ts`
 * appear in the system prompt so the LLM knows what composable behavior
 * packs it can invoke.
 *
 * The persona below is a retired 15-year crypto market maker turned TON
 * specialist — it builds a written plan BEFORE touching anything.
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { TavilySearch } from "@langchain/tavily";
import { newId, type AgentMessage } from "@ton-agent/shared";
import { CONFIG } from "../config";
import { log } from "../logger";
import { postEnvelope } from "../webhook";
import {
    getWalletBalanceTool,
    auditJettonTool,
    executeSwapTool,
    getJettonMetaTool,
    getJettonPriceTool,
    watchPositionTool,
    notifyWebTool,
    checkRiskStatusTool,
    recordPositionTool,
} from "../mcp/tools";
// Side-effect import: registers all skills + exposes availableSkillsSection().
import { availableSkillsSection } from "../skills";

// ───────────────────────────────────────────────────────────────────
// Model selection — pick the strongest bootable.
// ───────────────────────────────────────────────────────────────────
function pickModel() {
    if (CONFIG.anthropicApiKey) {
        // Claude-3.5-Sonnet is best-in-class for finance reasoning.
        return new ChatAnthropic({
            apiKey: CONFIG.anthropicApiKey,
            model: "claude-3-5-sonnet-20241022",
            temperature: 0.2,
        });
    }
    if (CONFIG.openaiApiKey) {
        return new ChatOpenAI({
            apiKey: CONFIG.openaiApiKey,
            model: "gpt-4o-2024-11-20",
            temperature: 0.2,
        });
    }
    if (CONFIG.nvidiaApiKey) {
        // NVIDIA NIM offers OpenAI-compatible endpoint.
        return new ChatOpenAI({
            apiKey: CONFIG.nvidiaApiKey,
            model: CONFIG.nvidiaModel,
            temperature: 0.2,
            configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
        });
    }
    throw new Error("NO_LLM_KEY — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or NVIDIA_API_KEY.");
}

// ───────────────────────────────────────────────────────────────────
// System prompt — chief orchestrator delegating to three expert roles.
// ───────────────────────────────────────────────────────────────────
const SYSTEM_TRADE_ANALYST = `You are "ATLAS-9", the chief trading orchestrator of a TON ecosystem agent. You are played as a 15-year veteran crypto market maker who survived Mt.Gox, BitMEX rektings, 4 bear markets, and 6 TON halvings.

== ORG STRUCTURE ==

You delegate to three internal experts. Pick the right expert per decision; never call tools outside your expert's mandate.

Expert 1 — On-chain Intelligence.
  Tools at your disposal: audit_jetton, get_jetton_meta, get_jetton_price.
  Mission: verify renounce / LP lock / honeypot before any buy. Surface identity (symbol, holders, supply) and price/market-cap context. NEVER approve a buy without this expert's clean report.

Expert 2 — Risk & Execution.
  Tools at your disposal: get_wallet_balance, check_risk_status, execute_swap, record_position.
  Mission: enforce size caps (default tier='low'), respect the kill-switch + circuit breaker, ensure HIGH tier is unlocked before considering it, and post-buy persistence for the position monitor. This expert NEVER executes without an Expert 1 PASS.

Expert 3 — Market Intelligence.
  Tools at your disposal: tavily_search (research), watch_position, notify_web.
  Mission: gather news, narrative, sentiment, and live price ticks. Surface the "why now" and the "exit signal." Also owns outbound human-readable notifications.

The Chief will:
  1. Demand Expert 1 PASS before unlocking Expert 2 execution.
  2. Demand Expert 2 risk-gate verdict before signing.
  3. Loop Expert 3 in AFTER execution for ongoing watch.
  4. Reject any path that skips an expert.

== TRADING RULES (HARD) ==
1. NEVER buy an unaudited jetton. ALWAYS call audit_jetton first.
2. ALWAYS call get_wallet_balance AND check_risk_status before sizing.
3. Cap each trade at ${CONFIG.strategy.maxRiskPct}% of bankroll per tier cap.
4. Refuse expert 2 if Expert 1 says audit failed (renounced=false, lpLocked=false, honeypotSafe=false).
5. Make a written plan first (narrative / entry / R:R / exit / fees); state risk in TON.
6. After every trade, send notify_web(kind=trade_executed).
7. ALWAYS pick a risk tier ('low' default; 'mid' after a few winners; 'high' only when check_risk_status reports highTierUnlocked=true).
8. ALWAYS check_risk_status(tier=<chosen>) before execute_swap.
9. ALWAYS call record_position immediately after a successful BUY so the position monitor can apply stops and take-profits. If the swap succeeded but the router returns no jetton amount, emit verdict="UNRECORDED" + loud warning — do NOT record a zero-amount row.
10. ALWAYS reason with "because…" statements referencing real data (audit result, balance, price).

== COMPOSABLE SKILLS ==
The agent ships with skill packs that compose Expert 1 → 2 → 3 into one call:

${availableSkillsSection()}

Skills are invoked by name through the same tool-calling protocol. Prefer invoking a skill over manually chaining its underlying tools when the skill matches your intent.

== REQUIRED FLOW ==
When the user describes a token or opportunity, request the FULL chain:
  Expert 1 (audit + meta + price) → Expert 2 (risk gate → execute → record) → Expert 3 (notify).

Never leap straight to execute_swap. Never skip the audit. Never skip the risk gate.

End every run with a 3-line summary: PLAN, EXECUTED_OR_SKIPPED, NEXT_MONITORING_HINT.`;

// ───────────────────────────────────────────────────────────────────
// Tools bundle
// ───────────────────────────────────────────────────────────────────
const researchTools: any[] = [];
if (CONFIG.tavilyApiKey) {
    // @langchain/tavily v0.1+ field is `tavilyApiKey` (camelCase), not `apiKey`.
    // Falls back to TAVILY_API_KEY env if the param is omitted. We cast `as any`
    // because the installed .d.ts uses TavilySearchAPIRetrieverFields which only
    // declares `apiWrapper`/`apiBaseUrl` — the underlying TavilySearch class
    // accepts the camelCase form at runtime.
    researchTools.push(new TavilySearch({ maxResults: 5, tavilyApiKey: CONFIG.tavilyApiKey } as any));
}

const tools = [
    getWalletBalanceTool,
    auditJettonTool,
    getJettonMetaTool,
    getJettonPriceTool,
    executeSwapTool,
    watchPositionTool,
    notifyWebTool,
    checkRiskStatusTool,
    recordPositionTool,
    ...researchTools,
];

export function buildTradeBrain() {
    const llm = pickModel();
    log.banner("TRADE BRAIN", `${CONFIG.network.toUpperCase()} • ${llm.constructor.name}`);
    // @langchain/langgraph v1+: createReactAgent accepts `prompt` (was `systemMessage`
    // in older versions). `recursionLimit` moves to the stream/invoke config.
    const agent = createReactAgent({
        llm,
        tools,
        prompt: SYSTEM_TRADE_ANALYST,
    });
    return { agent, llm };
}

// ───────────────────────────────────────────────────────────────────
// Convenience stream → push transformed messages to web endpoint.
// ───────────────────────────────────────────────────────────────────
export async function runTradeBrain(input: string, opts: { pushToWeb?: boolean; threadId?: string } = {}) {
    const { agent } = buildTradeBrain();
    const threadId = opts.threadId ?? newId("thr");
    log.info("BRAIN", `run input.length=${input.length} thread=${threadId}`);

    // @langchain/langgraph v1+: agent.stream returns a Promise<AsyncIterable>.
    const stream = await agent.stream(
        { messages: [new HumanMessage(input)] },
        {
            streamMode: "values",
            recursionLimit: 24, // message-iteration cap to bound API spend
            configurable: { thread_id: threadId },
        }
    );

    const allMsgs: BaseMessage[] = [];
    for await (const chunk of stream) {
        const msgs = (chunk as any).messages ?? [];
        allMsgs.push(...msgs);
        if (opts.pushToWeb) {
            for (const m of msgs) {
                const am: AgentMessage = {
                    id: newId("msg"),
                    threadId,
                    at: Date.now(),
                    role: roleOf(m),
                    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
                    toolName: (m as any).name ?? undefined,
                    meta: { model: m.constructor.name },
                };
                await pushAm(am);
            }
        }
    }
    return { threadId, messages: allMsgs };
}

function roleOf(m: BaseMessage): AgentMessage["role"] {
    const t = (m as any)._getType?.() ?? "";
    return t === "human" ? "user" :
           t === "ai"    ? "assistant" :
           t === "tool"  ? "tool" : "system";
}

async function pushAm(am: AgentMessage) {
    // Stable envelope id = am.id, dedupe retries at the web ingest layer.
    await postEnvelope({
        kind: "agent_message",
        payload: am as unknown as Record<string, any>,
        stableId: am.id,
    });
}
