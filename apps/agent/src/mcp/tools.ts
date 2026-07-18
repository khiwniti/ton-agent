/**
 * LangChain tools exposed to the ReAct agent.
 *
 * Each tool is a thin wrapper over the agent runtime modules
 * (wallet, security, dex, tonapi, tavily). The ReAct loop calls
 * them via the LangChain tool-calling protocol with strict Zod
 * schemas so the LLM cannot improvise arguments.
 *
 * Keep this file the *only* coupling point between the LLM and
 * the agent's internal state.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { CONFIG } from "../config";
import { log } from "../logger";
import { makeClient } from "../wallet/wallet";
import { tonapiGet } from "../http/tonapi";
import { postEnvelope } from "../webhook";
import * as audit from "../security/audit";
import { getCoordinator, isCoordinatorStarted, ALL_TIERS, type Tier } from "../core/coordinator";
import { positionsStore } from "../storage/store";
import { newId } from "@ton-agent/shared";
import { TIER_RISK_CONFIGS } from "../risk/guardrails";

/**
 * Phase 4 — per-tier TimeExit deadline (ms) read at position-entry time.
 *
 * Honours FR-013: the default is 0 (disabled), so an unsuspecting operator
 * sees zero behavioural change. Setting e.g. `LOW_MAX_HOLD_MS=1800000`
 * limits LOW-tier positions to 30 minutes; the monitor then flips them to
 * CLOSED on the first tick past the deadline (spec 002 §8.5 TimeExit).
 */
const tierMaxHoldMs = (tier: Tier): number => {
    const envKey = `${tier.toUpperCase()}_MAX_HOLD_MS`;
    const v = parseFloat(process.env[envKey] || "");
    return Number.isFinite(v) && v > 0 ? v : 0;
};

// ─────────────────────────────── 1. WALLET BALANCE ───────────────────────────────
export const getWalletBalanceTool = tool(
    async ({}: Record<string, never>, _opts?: any) => {
        const client = makeClient();
        const walletMod = await import("../wallet/wallet");
        const w = await walletMod.openWallet(client, await walletMod.loadKeyPair());
        const bal = await w.getBalance();
        return {
            address: w.address.toString(),
            balanceTon: Number((Number(bal) / 1e9).toFixed(4)),
            chain: CONFIG.network,
        };
    },
    {
        name: "get_wallet_balance",
        description: "Get the agent's hot-wallet address and current TON balance. Call this whenever you need to check available capital before sizing a trade.",
        schema: z.object({}),
    }
);

// ─────────────────────────────── 2. SECURITY AUDIT ───────────────────────────────
export const auditJettonTool = tool(
    async ({ jettonMaster, poolAddress }: { jettonMaster: string; poolAddress?: string }) => {
        const client = makeClient();
        return await audit.fullAudit(client, jettonMaster, poolAddress);
    },
    {
        name: "audit_jetton",
        description: "Run a full security audit on a TON jetton (renounce + LP lock + honeypot sandbox). Use this BEFORE any BUY decision. Returns booleans and the holders count.",
        schema: z.object({
            jettonMaster: z.string().describe("EQ... TON jetton master address"),
            poolAddress: z.string().optional().describe("EQ... pool address for honeypot sandbox. Omit to skip simulation."),
        }),
    }
);

// ─────────────────────────────── 3. SWAP EXECUTE ───────────────────────────────
export const executeSwapTool = tool(
    async ({
        jettonMaster,
        amountTon,
        dex: dexName,
        side,
        tier,
        cycleId,
        ticketHash,
        riskVerdict,
        poolTvlTon,
        slippagePct,
        aiScore,
    }) => {
        log.banner("EXECUTE", `tier=${tier ?? "low"} side=${side} amount=${amountTon} TON jetton=${jettonMaster}`);

        // Resolve tier (default 'low' for backward compat).
        const resolvedTier = (tier ?? "low") as Tier;

        // Route through the coordinator so SafetyCaps + kill-switch / bankroll fire.
        // Bypassing the coordinator is NOT allowed — it would lose risk protection.
        if (!isCoordinatorStarted()) {
            return { ok: false, error: "TierCoordinator not started — boot the agent first" };
        }
        const coord = getCoordinator();

        const risk =
            riskVerdict
                ? {
                      score: riskVerdict === "pass" ? 80 : riskVerdict === "caution" ? 50 : 0,
                      verdict: riskVerdict as "pass" | "caution" | "reject",
                  }
                : null;

        const r = await coord.executeForTier(
            resolvedTier,
            {
                jettonMaster,
                amountTon,
                side,
            },
            dexName,
            {
                cycleId,
                ticketHash,
                risk,
                poolTvlTon,
                slippagePct,
                aiScore,
            },
        );
        return {
            ...r,
            tier: resolvedTier,
            // Surface cap outcome so the model cannot ignore a denial.
            cap_ok: r.cap?.ok,
            ticket_hash: r.cap?.ticket_hash ?? r.cycle_id,
            hitl_required: r.cap?.hitl_required,
        };
    },
    {
        name: "execute_swap",
        description:
            "Execute a real signed BUY or SELL on Ston.fi or DeDust through the tier coordinator. " +
            "Every call runs deterministic SafetyCaps (kill-switch, circuit breaker, tier caps, allocation, optional depth/slippage/risk verdict) before signing. " +
            "Optional ticketHash must match a previously issued SafetyCaps authorization for the same ticket. " +
            "riskVerdict=reject always denies; caution requires HITL (not auto-executable until Telegram approval lands). " +
            "Losses can be 100% of amountTon — verify size thrice.",
        schema: z.object({
            jettonMaster: z.string(),
            amountTon: z.number().positive().max(50, "cap to 50 TON until risk profile grows"),
            dex: z.enum(["stonfi", "dedust"]).default(CONFIG.strategy.preferredDex),
            side: z.enum(["buy", "sell"]).default("buy"),
            tier: z.enum(["low", "mid", "high"]).default("low")
                .describe("Risk tier wallet to route the swap through. 'high' is promotion-gated."),
            cycleId: z.string().optional()
                .describe("Optional cycle id for the decision journal; auto-minted if omitted."),
            ticketHash: z.string().optional()
                .describe("Optional SafetyCaps ticket_hash from a prior authorize step; must match live ticket."),
            riskVerdict: z.enum(["pass", "caution", "reject"]).optional()
                .describe("Advisory risk verdict from audit/risk step. reject blocks; caution forces HITL."),
            poolTvlTon: z.number().positive().optional()
                .describe("Pool TVL in TON for liquidity-depth gate."),
            slippagePct: z.number().nonnegative().optional()
                .describe("Quoted slippage percent for the slippage cap."),
            aiScore: z.number().min(0).max(100).optional()
                .describe("Optional AI confidence score vs tier minAiScore."),
        }),
    }
);

// ─────────────────────────────── 4. JETTON META ───────────────────────────────
export const getJettonMetaTool = tool(
    async ({ jettonMaster }: { jettonMaster: string }) => {
        const data = await audit.getJetton(jettonMaster);
        return data || { error: `no meta for ${jettonMaster}` };
    },
    {
        name: "get_jetton_meta",
        description: "Fetch TONAPI metadata for a jetton (name, symbol, holders, supply, market stats). Use this to confirm a token identity and spot scam duplicates.",
        schema: z.object({ jettonMaster: z.string() }),
    }
);

// ─────────────────────────────── 5. JETTON PRICE (TONAPI retry-aware) ───────────────────────────────
export const getJettonPriceTool = tool(
    async ({ jettonMaster }: { jettonMaster: string }) => {
        try {
            const r = await tonapiGet(`/jettons/${jettonMaster}`, { timeoutMs: 8000 });
            const priceUsd = r.data?.market_data?.price;
            const priceBtc = r.data?.market_data?.price_btc;
            const capUsd = r.data?.market_data?.market_cap;
            return { priceUsd, priceBtc, marketCapUsd: capUsd, source: "tonapi" };
        } catch (e: any) {
            return { error: e.message };
        }
    },
    {
        name: "get_jetton_price",
        description: "Get the current USD price and market cap of a TON jetton via TONAPI. Call this before sizing positions, computing targets, or comparing token candidates.",
        schema: z.object({ jettonMaster: z.string() }),
    }
);

// ─────────────────────────────── 6. WATCH JETTON (for monitoring) ───────────────────────────────
export const watchPositionTool = tool(
    async ({ jettonMaster }: { jettonMaster: string }) => {
        const data = await audit.getJetton(jettonMaster);
        const priceUsd = data?.market_data?.price ?? null;
        const holders = data?.holders_count ?? 0;
        return { jettonMaster, priceUsd, holders };
    },
    {
        name: "watch_position",
        description: "Spot-check a jetton you currently hold; returns its latest price and holder count. Call periodically after a buy to drive exit decisions.",
        schema: z.object({ jettonMaster: z.string() }),
    }
);

// ─────────────────────────────── 7. PUSH EVENT TO WEB (idempotent envelope) ───────────────────────────────
export const notifyWebTool = tool(
    async ({ kind, payload }: { kind: string; payload: Record<string, any> }) => {
        // Reuse payload.id if present so retries with same payload dedupe on
        // the web side. Otherwise mint a fresh id.
        const stableId = typeof payload?.id === "string" ? payload.id : undefined;
        return await postEnvelope({
            kind,
          walletTier: typeof payload?.walletTier === "string" ? (payload.walletTier as Tier) : undefined,
          payload,
          stableId,
        });
    },
    {
        name: "notify_web",
        description: "Push an event (radar hit, trade executed, audit complete, message) to the owned web app at PUBLIC_WEBHOOK_URL. Use this for the human-readable trail on every important decision.",
        schema: z.object({
            kind: z.enum(["radar_hit", "trade_executed", "audit", "agent_message", "status", "position_update"]),
            payload: z.record(z.any()),
        }),
    }
);

// ─────────────────────────────── 8. CHECK RISK STATUS ───────────────────────────────
// Read-only view of the kill-switch, circuit breaker, per-tier bankroll, and
// the high-tier promotion gate. The agent should consult this BEFORE sizing
// any new buy and after any sell.
export const checkRiskStatusTool = tool(
    async ({ tier }: { tier?: Tier }) => {
        if (!isCoordinatorStarted()) {
            return { ok: false, error: "TierCoordinator not started yet" };
        }
        const coord = getCoordinator();
        const snap = coord.getSnapshot();
        const result: any = {
            ok: true,
            killSwitch: snap.killSwitch,
            circuitBreaker: snap.circuitBreaker,
            highTierUnlocked: snap.highUnlocked,
            uptimeSec: snap.uptimeSec,
            tiers: snap.tiers,
        };
        if (tier) {
            const handle = coord.getTierHandle(tier);
            if (!handle) {
                return { ok: false, error: `tier "${tier}" not initialized` };
            }
            // Reuse the same gate logic so the agent sees what execute_swap will check.
            const requestedTon = CONFIG.strategy.defaultSnipeTon;
            const gate = coord.isTradeAllowed(tier, requestedTon);
            result.gate = gate;
            result.tierDetail = {
                tier,
                balanceTon: handle.balanceTon,
                openPositions: handle.openPositions,
                closedTrades: handle.closedTrades,
                dailyPnlTon: handle.dailyPnlTon,
                maxPositionTon: handle.config.maxPositionTon,
                maxOpen: handle.config.maxOpen,
                stopLossPct: handle.config.stopLossPct,
                takeProfitPct: handle.config.takeProfitPct,
                minAiScore: handle.config.minAiScore,
            };
        }
        return result;
    },
    {
        name: "check_risk_status",
        description: "Inspect risk posture: kill-switch state, circuit breaker (daily PnL), per-tier bankroll, open-position counts, and whether HIGH tier is unlocked. Pass a tier name to also see whether a default-sized buy is currently allowed for that tier. Call this BEFORE execute_swap and after any sell to confirm trading is still permitted.",
        schema: z.object({
            tier: z.enum(["low", "mid", "high"]).optional()
                .describe("Optional tier to probe — returns gate verdict + risk params for that tier."),
        }),
    }
);

// ─────────────────────────────── 9. RECORD POSITION ───────────────────────────────
// Persists an open position to SQLite so the position monitor can later apply
// stop-loss / take-profit. Called by the agent IMMEDIATELY after execute_swap
// succeeds on a buy. Sells should record a separate close via stop-loss/take-profit
// status transitions handled by the position monitor.
export const recordPositionTool = tool(
    async ({
        walletTier,
        jettonMaster,
        symbol,
        dex: dexName,
        entryTxHash,
        entryPriceTon,
        entryPriceUsd,
        amountTokens,
        costBasisTon,
        confidenceScore,
    }: {
        walletTier: Tier;
        jettonMaster: string;
        symbol?: string;
        dex?: string;
        entryTxHash: string;
        entryPriceTon: number;
        entryPriceUsd?: number;
        amountTokens: string;
        costBasisTon: number;
        confidenceScore?: number;
    }) => {
        if (!isCoordinatorStarted()) {
            return { ok: false, error: "TierCoordinator not started yet" };
        }
        if (!ALL_TIERS.includes(walletTier)) {
            return { ok: false, error: `unknown tier "${walletTier}"` };
        }
        // Soft gate: refuse to record a buy into a tier that is currently blocked.
        const coord = getCoordinator();
        const gate = coord.isTradeAllowed(walletTier, costBasisTon);
        if (!gate.allowed) {
            log.warn("MCP", `record_position denied for ${walletTier.toUpperCase()}: ${gate.reason}`);
            return { ok: false, error: gate.reason };
        }

        const id = newId("pos");
        const now = Date.now();
        const dbPos = {
            id,
            wallet_tier: walletTier,
            jetton_master: jettonMaster,
            symbol: symbol ?? null,
            dex: dexName ?? CONFIG.strategy.preferredDex,
            entry_tx_hash: entryTxHash,
            entry_price_ton: entryPriceTon,
            entry_price_usd: entryPriceUsd ?? null,
            entry_at: now,
            amount_tokens: amountTokens,
            cost_basis_ton: costBasisTon,
            confidence_score: confidenceScore ?? 0,
            status: "OPEN",
            // Phase 4 hot-path exit state — populate at entry so TimeExit can fire.
            // max_hold_ms comes from a per-tier env default (0/unset = disabled),
            // keeping TimeExit opt-in and behaviour-neutral for existing positions.
            // exit_by_ms is the denormalised deadline (= entry_at + max_hold_ms)
            // the monitor reads on every tick without recomputing.
            max_hold_ms: tierMaxHoldMs(walletTier),
            exit_by_ms: (() => {
                const m = tierMaxHoldMs(walletTier);
                return m && m > 0 ? now + m : null;
            })(),
        } as any;

        try {
            positionsStore.upsert(dbPos);
            log.ok("MCP", `[${walletTier.toUpperCase()}] recorded OPEN position ${id} ${symbol ?? "?"} cost=${costBasisTon}TON`);
            return { ok: true, id, position: dbPos };
        } catch (e: any) {
            log.err("MCP", `record_position failed: ${e.message}`);
            return { ok: false, error: e.message };
        }
    },
    {
        name: "record_position",
        description: "Persist a freshly executed BUY to the agent's position database so the position monitor can apply stop-loss, take-profit, and trailing exits. Call this immediately after execute_swap returns ok=true (side='buy'). The position monitor handles sells automatically.",
        schema: z.object({
            walletTier: z.enum(["low", "mid", "high"])
                .describe("The risk tier wallet that holds this position — must match the tier passed to execute_swap."),
            jettonMaster: z.string().describe("EQ... master address of the jetton bought."),
            symbol: z.string().optional().describe("Optional display symbol (e.g. 'jTON')."),
            dex: z.enum(["stonfi", "dedust"]).optional(),
            entryTxHash: z.string().describe("Transaction hash returned by the DEX after the buy settled."),
            entryPriceTon: z.number().positive().describe("TON price of the token at entry, used for PnL math."),
            entryPriceUsd: z.number().positive().optional().describe("Optional USD price at entry (from TONAPI)."),
            amountTokens: z.string().describe("Jetton amount in nano-jetton units as a string (BigInt-safe)."),
            costBasisTon: z.number().positive().describe("TON actually spent on the buy, including gas."),
            confidenceScore: z.number().int().min(0).max(100).optional()
                .describe("0-100 confidence score computed from audit, holders, age, liquidity, and tier alignment. Higher = more conviction."),
        }),
    }
);
