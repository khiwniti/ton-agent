/**
 * MCP server — exposes the agent's tools and read-only resources over stdio
 * so any MCP client (Claude Code, Zed, Cursor, IDE plugins) can drive the
 * agent runtime as a peer.
 *
 *   Tools → 9 existing LangChain tools in `mcp/tools.ts`, wrapped here.
 *            Wrapped lazily so a tool that throws a runtime error still
 *            surfaces a proper MCP error result instead of crashing the
 *            JSON-RPC loop.
 *
 *   Resources (read-only, agent-authoritative):
 *     agent://tiers/status    — full snapshot of LOW/MID/HIGH handles
 *     agent://positions/open  — list of currently open positions per tier
 *     agent://risk/circuit-breaker — circuit breaker + kill-switch state
 *     agent://pnl/today       — today's PnL log
 *
 * Stdio-only in this iteration; SSE/HTTP can be added behind a flag later.
 *
 * v2 fixes:
 *   - Hand-encodes the 9 tool JSON schemas instead of `zod-to-json-schema`,
 *     which is not in `apps/agent` deps and whose lazy import always fell
 *     through to an empty schema shape (MCP clients would have listed 9
 *     tools with no parameter declarations).
 *   - Boots the TierCoordinator on demand so the resource readers work
 *     even when the standalone daemon is started WITHOUT coordinator state.
 *
 * Concurrently safe: shutting the server down should not leak the stdio
 * stream. `server.close()` is awaited on shutdown so stdio closes cleanly.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    type Tool,
    type Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../logger";
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
} from "./tools";
import {
    getCoordinator,
    isCoordinatorStarted,
    startCoordinator,
} from "../core/coordinator";
import { positionsStore, dailyPnlStore } from "../storage/store";

// ───────────────────────────────────────────────────────────────────
// Hand-encoded JSON Schemas for the 9 MCP tools.
//
// These mirror the Zod shapes declared in `tools.ts` one-to-one. Keeping
// them inline avoids adding `zod-to-json-schema` as a runtime dep and
// guarantees deterministic schema delivery regardless of zod version.
// ───────────────────────────────────────────────────────────────────
const TOOL_SCHEMAS: Record<string, Tool["inputSchema"]> = {
    get_wallet_balance: { type: "object", properties: {}, additionalProperties: false },
    audit_jetton: {
        type: "object",
        properties: {
            jettonMaster: { type: "string", description: "EQ... TON jetton master address" },
            poolAddress: { type: "string", description: "Optional EQ... pool address for honeypot sandbox." },
        },
        required: ["jettonMaster"],
        additionalProperties: false,
    },
    get_jetton_meta: {
        type: "object",
        properties: { jettonMaster: { type: "string" } },
        required: ["jettonMaster"],
        additionalProperties: false,
    },
    get_jetton_price: {
        type: "object",
        properties: { jettonMaster: { type: "string" } },
        required: ["jettonMaster"],
        additionalProperties: false,
    },
    execute_swap: {
        type: "object",
        properties: {
            jettonMaster: { type: "string" },
            amountTon: { type: "number", minimum: 0, maximum: 50, description: "Cap to 50 TON until risk profile grows." },
            dex: { type: "string", enum: ["stonfi", "dedust"] },
            side: { type: "string", enum: ["buy", "sell"] },
            tier: { type: "string", enum: ["low", "mid", "high"], description: "Risk tier wallet; HIGH is promotion-gated." },
            cycleId: { type: "string", description: "Optional decision-journal cycle id." },
            ticketHash: { type: "string", description: "Optional SafetyCaps ticket_hash from a prior authorize step." },
            riskVerdict: { type: "string", enum: ["pass", "caution", "reject"], description: "Advisory risk verdict; reject blocks; caution forces HITL." },
            poolTvlTon: { type: "number", minimum: 0, description: "Pool TVL in TON for liquidity-depth gate." },
            slippagePct: { type: "number", minimum: 0, description: "Quoted slippage percent." },
            aiScore: { type: "number", minimum: 0, maximum: 100, description: "Optional AI confidence vs tier minAiScore." },
        },
        required: ["jettonMaster", "amountTon"],
        additionalProperties: false,
    },
    watch_position: {
        type: "object",
        properties: { jettonMaster: { type: "string" } },
        required: ["jettonMaster"],
        additionalProperties: false,
    },
    notify_web: {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["radar_hit", "trade_executed", "audit", "agent_message", "status", "position_update"] },
            payload: { type: "object", additionalProperties: true },
        },
        required: ["kind", "payload"],
        additionalProperties: false,
    },
    check_risk_status: {
        type: "object",
        properties: { tier: { type: "string", enum: ["low", "mid", "high"] } },
        additionalProperties: false,
    },
    record_position: {
        type: "object",
        properties: {
            walletTier: { type: "string", enum: ["low", "mid", "high"] },
            jettonMaster: { type: "string" },
            symbol: { type: "string" },
            dex: { type: "string", enum: ["stonfi", "dedust"] },
            entryTxHash: { type: "string" },
            entryPriceTon: { type: "number", minimum: 0 },
            entryPriceUsd: { type: "number", minimum: 0, description: "Optional USD price at entry." },
            amountTokens: { type: "string", description: "Jetton amount in nano-jetton units (BigInt-safe string)." },
            costBasisTon: { type: "number", minimum: 0 },
        },
        required: ["walletTier", "jettonMaster", "entryTxHash", "entryPriceTon", "amountTokens", "costBasisTon"],
        additionalProperties: false,
    },
};

// ───────────────────────────────────────────────────────────────────
// Tool registry — one entry per LangChain tool with its MCP schema.
// Descriptions come from the LangChain tool definitions (already written
// for the ReAct brain), so operators see the same prose in MCP clients.
// ───────────────────────────────────────────────────────────────────
interface LangChainTool {
    name: string;
    description: string;
    schema: any;
    invoke: (input: any) => Promise<any>;
}

const RAW_TOOLS: LangChainTool[] = [
    getWalletBalanceTool,
    auditJettonTool,
    getJettonMetaTool,
    getJettonPriceTool,
    executeSwapTool,
    watchPositionTool,
    notifyWebTool,
    checkRiskStatusTool,
    recordPositionTool,
];

async function buildMcpToolList(): Promise<Tool[]> {
    return RAW_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: TOOL_SCHEMAS[t.name] ?? { type: "object", properties: {}, additionalProperties: false },
    }));
}

// ───────────────────────────────────────────────────────────────────
// Resource readers — boot coordinator lazily so MCP-only usage works.
// ───────────────────────────────────────────────────────────────────
async function ensureCoordinator(): Promise<void> {
    if (isCoordinatorStarted()) return;
    try {
        await startCoordinator();
    } catch (e: any) {
        log.warn("MCP-SRV", `ensureCoordinator: bootstrap failed (${e.message}); resource readers that depend on it will return an error envelope.`);
    }
}

async function readTierStatus(): Promise<string> {
    await ensureCoordinator();
    if (!isCoordinatorStarted()) return JSON.stringify({ error: "coordinator not started" });
    return JSON.stringify(getCoordinator().getSnapshot(), null, 2);
}

async function readOpenPositions(): Promise<string> {
    return JSON.stringify(positionsStore.listOpen(), null, 2);
}

async function readRiskState(): Promise<string> {
    await ensureCoordinator();
    if (!isCoordinatorStarted()) return JSON.stringify({ error: "coordinator not started" });
    const coord = getCoordinator();
    return JSON.stringify({
        killSwitch: coord.getKillSwitchState(),
        circuitBreakerTodayPnl: dailyPnlStore.getTodayPnl(),
        startedAt: coord.getSnapshot().startedAt,
    }, null, 2);
}

async function readTodayPnl(): Promise<string> {
    return JSON.stringify({ todayPnlTon: dailyPnlStore.getTodayPnl() }, null, 2);
}

const RESOURCE_READERS: Record<string, () => Promise<string>> = {
    "agent://tiers/status": readTierStatus,
    "agent://positions/open": readOpenPositions,
    "agent://risk/circuit-breaker": readRiskState,
    "agent://pnl/today": readTodayPnl,
};

const RESOURCES: Resource[] = Object.keys(RESOURCE_READERS).map((uri) => ({
    uri,
    name: uri.replace(/^agent:\/\//, "").replace(/\//g, " "),
    mimeType: "application/json",
}));

// ───────────────────────────────────────────────────────────────────
// Lifecycle
// ───────────────────────────────────────────────────────────────────
export async function startMcpServer(): Promise<Server> {
    const server = new Server(
        {
            name: "ton-agent-mcp",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
                resources: {},
            },
        },
    );

    const toolsList = await buildMcpToolList();

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: toolsList,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const target = RAW_TOOLS.find((t) => t.name === req.params.name);
        if (!target) {
            return {
                isError: true,
                content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
            };
        }
        try {
            const result = await target.invoke(req.params.arguments ?? {});
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        } catch (e: any) {
            log.err("MCP-SRV", `${req.params.name} threw: ${e.message}`);
            return {
                isError: true,
                content: [{ type: "text", text: `tool ${req.params.name} failed: ${e.message}` }],
            };
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: RESOURCES,
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const reader = RESOURCE_READERS[req.params.uri];
        if (!reader) {
            return { isError: true, contents: [] };
        }
        try {
            const body = await reader();
            return {
                contents: [{ uri: req.params.uri, mimeType: "application/json", text: body }],
            };
        } catch (e: any) {
            log.err("MCP-SRV", `resource ${req.params.uri} threw: ${e.message}`);
            return { isError: true, contents: [] };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("MCP-SRV", `MCP server connected on stdio — ${toolsList.length} tools, ${RESOURCES.length} resources`);
    return server;
}

/**
 * Gracefully tear down an MCP server. Safe to call multiple times.
 */
export async function stopMcpServer(server: Server | null): Promise<void> {
    if (!server) return;
    try {
        await server.close();
    } catch (e: any) {
        log.warn("MCP-SRV", `server.close failed: ${e.message}`);
    }
}
