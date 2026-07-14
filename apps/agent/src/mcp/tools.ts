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
import * as audit from "../security/audit";
import * as dex from "../dex/router";
import axios from "axios";

// ─────────────────────────────── 1. WALLET BALANCE ───────────────────────────────
export const getWalletBalanceTool = tool(
    async ({}: Record<string, never>, opts: any) => {
        const client = makeClient();
        const w = await (await import("../wallet/wallet")).openWallet(client, await (await import("../wallet/wallet")).loadKeyPair());
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
    async ({ jettonMaster, amountTon, dex: dexName, side }) => {
        log.banner("EXECUTE", `side=${side} amount=${amountTon} TON jetton=${jettonMaster}`);
        const client = makeClient();
        const r = await dex.executeSwap(client, {
            jettonMaster,
            amountTon,
            side,
        }, dexName);
        return r;
    },
    {
        name: "execute_swap",
        description: "Execute a real signed BUY or SELL on Ston.fi or DeDust with the hot wallet. Use ONLY after audit_jetton passes and the strategy rules are satisfied. Losses can be 100% of amountTon — verify size thrice.",
        schema: z.object({
            jettonMaster: z.string(),
            amountTon: z.number().positive().max(50, "cap to 50 TON until risk profile grows"),
            dex: z.enum(["stonfi", "dedust"]).default(CONFIG.strategy.preferredDex),
            side: z.enum(["buy", "sell"]).default("buy"),
        }),
    }
);

// ─────────────────────────────── 4. JETTON META ───────────────────────────────
export const getJettonMetaTool = tool(
    async ({ jettonMaster }) => {
        const data = await audit.getJetton(jettonMaster);
        return data || { error: `no meta for ${jettonMaster}` };
    },
    {
        name: "get_jetton_meta",
        description: "Fetch TONAPI metadata for a jetton (name, symbol, holders, supply, market stats). Use this to confirm a token identity and spot scam duplicates.",
        schema: z.object({ jettonMaster: z.string() }),
    }
);

// ─────────────────────────────── 5. JETTON PRICE ───────────────────────────────
export const getJettonPriceTool = tool(
    async ({ jettonMaster }) => {
        try {
            const r = await axios.get(
                `${CONFIG.tonapiBase}/jettons/${jettonMaster}`,
                { headers: { Authorization: `Bearer ${CONFIG.tonApiKey}`, "Content-Type": "application/json" }, timeout: 8000 }
            );
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
    async ({ jettonMaster }) => {
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

// ─────────────────────────────── 7. PUSH EVENT TO WEB ───────────────────────────────
export const notifyWebTool = tool(
    async ({ kind, payload }) => {
        const url = CONFIG.publicWebhookUrl;
        if (!url) return { sent: false, reason: "PUBLIC_WEBHOOK_URL not set" };
        try {
            await axios.post(url, { kind, payload }, {
                headers: {
                    "Content-Type": "application/json",
                    "X-Agent-Secret": CONFIG.agentSharedSecret,
                },
                timeout: 10000,
            });
            return { sent: true };
        } catch (e: any) {
            log.warn("notifyWeb", `failed ${e.message}`);
            return { sent: false, error: e.message };
        }
    },
    {
        name: "notify_web",
        description: "Push an event (radar hit, trade executed, audit complete, message) to the owned web app at PUBLIC_WEBHOOK_URL. Use this for the human-readable trail on every important decision.",
        schema: z.object({
            kind: z.enum(["radar_hit", "trade_executed", "audit", "agent_message", "status"]),
            payload: z.record(z.any()),
        }),
    }
);
