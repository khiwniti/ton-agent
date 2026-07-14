/**
 * MemPool radar — continuous scanner.
 *
 * Pattern:
 *  1. Poll TONAPI for recent jetton creations (or DEX pool adds).
 *  2. For each candidate, trigger the ReAct brain for audit + plan.
 *  3. Brain emits trade or skip. We post the radar event to the web.
 *
 * NOTE: TONAPI's free endpoints throttle hard; in production wire
 * a TON validator connection or a paid TONAPI stream.
 */
import axios from "axios";
import { CONFIG } from "../config";
import { log } from "../logger";
import { newId, type RadarEvent } from "@ton-agent/shared";
import { fullAudit } from "../security/audit";
import { makeClient } from "../wallet/wallet";
import { runTradeBrain } from "../ai/brain";

const http = axios.create({
    timeout: 10000,
    headers: { "X-Agent-Secret": CONFIG.agentSharedSecret, "Content-Type": "application/json" },
});

async function pushRadarEvent(e: RadarEvent) {
    if (!CONFIG.publicWebhookUrl) return;
    try { await http.post(CONFIG.publicWebhookUrl, { kind: "radar_hit", payload: e }); }
    catch (e2: any) { log.debug("RADAR", `push ${e2.message}`); }
}

// Polling primitives -------------------------------------------------
async function getRecentJettonMasters(limit = 50): Promise<{ master: string; pool?: string; symbol?: string; liquidityTon?: number }[]> {
    try {
        const r = await axios.get(`${CONFIG.tonapiBase}/jettons`, {
            params: { limit, verified: false, sort: "created" },
            headers: { "Content-Type": "application/json", ...(CONFIG.tonApiKey ? { Authorization: `Bearer ${CONFIG.tonApiKey}` } : {}) },
            timeout: 8000,
        });
        const items = r.data?.jettons ?? [];
        return items.map((x: any) => ({
            master: x.address,
            pool: x.pool?.pool_address,
            symbol: x.metadata?.symbol,
            liquidityTon: x.pool?.liquidity?.jetton_reserves_in_ton,
        }));
    } catch (e: any) {
        log.err("RADAR", `getRecentJettonMasters ${e.message}`);
        return [];
    }
}

// Main scan loop ----------------------------------------------------
const SEEN = new Set<string>();

export async function startRadar(printOnly = false) {
    log.banner("RADAR", `${CONFIG.network.toUpperCase()} • TONAPI`);
    const client = makeClient();
    let tick = 0;

    const tickFn = async () => {
        tick++;
        log.info("RADAR", `tick=${tick} ${CONFIG.network} seen=${SEEN.size}`);

        // Pull watchlist + recent jettons stream
        const recent = await getRecentJettonMasters(30);
        const candidates = [
            ...CONFIG.watchlist.map(m => ({ master: m })),
            ...recent,
        ].filter(c => !SEEN.has(c.master));

        for (const c of candidates) {
            SEEN.add(c.master);
            try {
                const audit = await fullAudit(client, c.master, c.pool);
                if (!audit.ok) {
                    log.warn("RADAR", `skip ${c.master.slice(0, 8)}… audit failed`);
                    continue;
                }

                // Kick the brain for plan. (Live ai run only when keys present.)
                const prompt = `Candidate jetton ${c.master}\n` +
                    `Symbol: ${c.symbol ?? "?"}\n` +
                    `Liquidity Ton: ${c.liquidityTon ?? "unknown"}\n` +
                    `Audit: renounced=${audit.renounced}, lpLocked=${audit.lpLocked}, honeypotSafe=${audit.honeypotSafe}, holders=${audit.holders}\n` +
                    `Build a written trade plan, choose entry size using max 15% of bankroll cap, then either BUY or SKIP. If you BUY, immediately call notify_web(kind=trade_executed).`;

                const result = await runTradeBrain(prompt, { pushToWeb: true });

                const e: RadarEvent = {
                    id: newId("rad"),
                    detectedAt: Date.now(),
                    jettonMaster: c.master,
                    symbol: c.symbol,
                    poolAddress: c.pool,
                    initialLiquidityTon: c.liquidityTon ?? null,
                    tokenAgeHours: audit.ageHours || 0,
                    renounced: audit.renounced,
                    lpLocked: audit.lpLocked,
                    honeypotSafe: audit.honeypotSafe,
                    aiScore: 0,
                    action: "HOLD", // refined post-LLM; weak default
                    confidence: 0,
                    reasoning: "scan completed",
                };
                await pushRadarEvent(e);
            } catch (err: any) {
                log.err("RADAR", `${err.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Cap memory spent on seen list
        if (SEEN.size > 2000) {
            for (const v of [...SEEN].slice(0, 1700)) SEEN.delete(v);
        }
    };

    await tickFn();
    setInterval(tickFn, 60_000); // every 60 s; configurable later
}
