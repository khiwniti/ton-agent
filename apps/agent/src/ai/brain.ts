/**
 * LangChain / LangGraph deep-research ReAct agent — the "brain".
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Plan ─► Research (Tavily + TON API) ─► Audit (Sandbox) ─►   │
 * │     Decide (LLM reasoning) ─► Execute (DEX swap) ─►           │
 * │     Monitor (LangGraph loop) ─► Exit (Risk mgmt) ─► Notify    │
 * └─────────────────────────────────────────────────────────────┘
 *
 * The agent persona below is a retired 15-year crypto market maker
 * turned TON specialist — it builds a written trade plan BEFORE
 * touching anything. Tools are pinned in tools.ts.
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { SystemMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { TavilySearch } from "@langchain/tavily";
import { CONFIG } from "../config";
import { log } from "../logger";
import {
    getWalletBalanceTool,
    auditJettonTool,
    executeSwapTool,
    getJettonMetaTool,
    getJettonPriceTool,
    watchPositionTool,
    notifyWebTool,
} from "../mcp/tools";

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
// System prompt — personify a 15-year crypto market maker.
// ───────────────────────────────────────────────────────────────────
const SYSTEM_TRADE_ANALYST = `You are "ATLAS-9", the autonomous trading brain of a TON ecosystem agent.

You are played as a 15-year veteran crypto market maker:
- You survived Mt.Gox, BitMEX reking, FOMO cycles, and 4 bear markets.
- You execute zero trades without a written, structured plan.
- You walk through EVERY signal like a checklist; never improvise.
- You are allergic to FOMO. You spot honeypots, LP rugs, and "renounced but admin is a multisig" tricks instantly.
- You size positions based on edge + conviction, never on vibes.
- You diversify narratives (memes, gaming, TON-native, ecosystem utility, jTON, NFT floor).

Trading rules (HARD):
1. NEVER buy an unaudited jetton. ALWAYS call audit_jetton first.
2. ALWAYS call get_wallet_balance before sizing.
3. Cap each trade at ${CONFIG.strategy.maxRiskPct}% of bankroll.
4. Refuse to execute if audit fails (renounced=false, lpLocked=false, honeypotSafe=false).
5. Make a written plan first (narrative / entry / R:R / exit / fees); state risk in TON.
6. After every trade, send notify_web(kind=trade_executed).
7. Always reason with "because…" statements referencing real data.

When the user describes a token or opportunity, request the FULL chain of audit → meta → price → plan → execute. Never leap straight to execute_swap.

End every run with a 3-line summary: PLAN, EXECUTED_OR_SKIPPED, NEXT_MONITORING_HINT.`;

// ───────────────────────────────────────────────────────────────────
// Tools bundle
// ───────────────────────────────────────────────────────────────────
const researchTools = [];
if (CONFIG.tavilyApiKey) {
    researchTools.push(new TavilySearch({ maxResults: 5, apiKey: CONFIG.tavilyApiKey }));
}

const tools = [
    getWalletBalanceTool,
    auditJettonTool,
    getJettonMetaTool,
    getJettonPriceTool,
    executeSwapTool,
    watchPositionTool,
    notifyWebTool,
    ...researchTools,
];

export function buildTradeBrain() {
    const llm = pickModel();
    log.banner("TRADE BRAIN", `${CONFIG.network.toUpperCase()} • ${llm.constructor.name}`);
    const agent = createReactAgent({
        llm,
        tools,
        systemMessage: SYSTEM_TRADE_ANALYST,
        // Hard message limit so stray loops don't burn API credits.
        recursionLimit: 24,
    });
    return { agent, llm };
}

// ───────────────────────────────────────────────────────────────────
// Convenience stream → push transformed messages to web endpoint.
// ───────────────────────────────────────────────────────────────────
import { Axios } from "axios";
import { newId, type AgentMessage } from "@ton-agent/shared";
import { CONFIG as CFG } from "../config";

const http = new Axios({
    timeout: 10000,
    headers: {
        "X-Agent-Secret": CFG.agentSharedSecret,
        "Content-Type": "application/json",
    },
});

export async function runTradeBrain(input: string, opts: { pushToWeb?: boolean; threadId?: string } = {}) {
    const { agent } = buildTradeBrain();
    const threadId = opts.threadId ?? newId("thr");
    log.info("BRAIN", `run input.length=${input.length} thread=${threadId}`);

    const stream = agent.stream(
        { messages: [new HumanMessage(input)] },
        { streamMode: "values", configurable: { thread_id: threadId } }
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
    if (!CFG.publicWebhookUrl) return;
    try {
        await http.post(CFG.publicWebhookUrl,
            JSON.stringify({ kind: "agent_message", payload: am }));
    } catch (e: any) {
        log.debug("BRAIN", `pushAm failed: ${e.message}`);
    }
}
