/**
 * token-scout executor v2.
 *
 * Wraps the live radar pipeline so the brain can invoke it as a single
 * composable skill, and operator CLIs can trigger a one-shot scan.
 *
 * v2 fix: uses the SHARED `seenStore` from `storage/store.ts` (already
 * wired to a SQLite table) instead of a module-level Set. The radar loop
 * uses the same store, so dedup state survives across processes.
 */
import { CONFIG } from "../../config";
import { log } from "../../logger";
import { tonapiGet } from "../../http/tonapi";
import { fullAudit } from "../../security/audit";
import { makeClient } from "../../wallet/wallet";
import { seenStore } from "../../storage/store";
import { newId, type RadarEvent } from "@ton-agent/shared";
import { postEnvelope } from "../../webhook";
import type { SkillHandler, SkillContext } from "../runtime";
import { manifest } from "./manifest";

type Input = { limit?: number; onlyFresh?: boolean; includeWatchlist?: boolean };
type Output = {
    scanned: number;
    audited: number;
    hits: Array<{
        master: string;
        symbol?: string;
        renounced: boolean;
        lpLocked: boolean;
        honeypotSafe: boolean;
    }>;
};

const execute: SkillHandler<Input, Output>["execute"] = async (input, _ctx: SkillContext) => {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const onlyFresh = input.onlyFresh !== false;
    const includeWatchlist = input.includeWatchlist !== false;

    const client = makeClient();

    // 1. Pull recent jettons (or skip if the user wants watchlist-only)
    let recent: Array<{ master: string; pool?: string; symbol?: string; liquidityTon?: number }> = [];
    if (!onlyFresh || includeWatchlist) {
        try {
            const r = await tonapiGet("/jettons", {
                params: { limit, verified: false, sort: "created" },
                timeoutMs: 8000,
            });
            const items = (r.data?.jettons ?? []) as Array<any>;
            recent = items.map((x) => ({
                master: x.address,
                pool: x.pool?.pool_address,
                symbol: x.metadata?.symbol,
                liquidityTon: x.pool?.liquidity?.jetton_reserves_in_ton,
            }));
        } catch (e: any) {
            log.warn("SCOUT", `TONAPI fetch failed: ${e.message}`);
        }
    }

    // Watchlist is strings only — coerce to the same shape as recent items
    // so the union type below is unambiguous.
    const watchlistItems: Array<{ master: string; pool?: undefined; symbol?: undefined; liquidityTon?: undefined }> =
        (includeWatchlist ? CONFIG.watchlist.map((m) => ({ master: m })) : []);

    const candidates = [...watchlistItems, ...recent].filter(
        (c) => !seenStore.has(c.master),
    );

    const hits: Output["hits"] = [];
    for (const c of candidates) {
        try {
            seenStore.add(c.master);
        } catch (e: any) {
            log.warn("SCOUT", `seenStore.add failed: ${e.message}`);
        }
        try {
            const audit = await fullAudit(client, c.master, c.pool);
            if (!audit.ok) continue;
            hits.push({
                master: c.master,
                symbol: c.symbol,
                renounced: audit.renounced,
                lpLocked: audit.lpLocked,
                honeypotSafe: audit.honeypotSafe,
            });
            // Push radar event for every passing candidate.
            const e: RadarEvent = {
                id: newId("rad"),
                detectedAt: Date.now(),
                walletTier: "low",
                jettonMaster: c.master,
                symbol: c.symbol,
                poolAddress: c.pool,
                dex: undefined,
                initialLiquidityTon: c.liquidityTon ?? null,
                tokenAgeHours: audit.ageHours || 0,
                renounced: audit.renounced,
                lpLocked: audit.lpLocked,
                honeypotSafe: audit.honeypotSafe,
                aiScore: 0,
                action: "HOLD",
                confidence: 0,
                reasoning: "token-scout skill — passed audit gates",
            };
            await postEnvelope({
                kind: "radar_hit",
                walletTier: "low",
                payload: e as unknown as Record<string, any>,
                stableId: e.id,
            });
        } catch (e: any) {
            log.warn("SCOUT", `audit failed for ${c.master.slice(0, 8)}…: ${e.message}`);
        }
    }

    try { seenStore.clearOld(); } catch { /* ignore */ }
    return { scanned: candidates.length, audited: candidates.length, hits };
};

export const handler: SkillHandler<Input, Output> = {
    manifest,
    execute,
};

import { registerSkill } from "../runtime";
registerSkill(handler);
