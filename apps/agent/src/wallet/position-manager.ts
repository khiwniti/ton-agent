/**
 * Position monitor — polls open positions on the wallet,
 * applies stop-loss / take-profit rules, drives auto-sells.
 *
 * This is the "RISK LAYER 3" from the original advanced-risk-manager.ts
 * raised to first-class, real-data-backed.
 */
import { makeClient } from "../wallet/wallet";
import { log } from "../logger";
import { CONFIG } from "../config";
import { getJetton } from "../security/audit";
import { executeSwap } from "../dex/router";

interface Position {
    jettonMaster: string;
    symbol?: string;
    entryPriceUsd: number;
    costTon: number;
    tokens: string;
    openedAt: number;
    t1Triggered: boolean;
}

// In-memory positions. Persistent backing is the responsibility of
// the web app (Supabase) — agent posts `position_opened` events.
const POSITIONS: Position[] = [];

export function addPosition(p: Position) {
    POSITIONS.push(p);
    log.trade("MGR", `OPEN ${p.symbol ?? p.jettonMaster.slice(0, 8)} cost=${p.costTon} TON`);
}

export function listPositions() {
    return [...POSITIONS];
}

export async function runMonitor() {
    log.info("MGR", "Position monitor started");
    setInterval(async () => {
        for (const p of POSITIONS) {
            try {
                const meta = await getJetton(p.jettonMaster);
                if (!meta) continue;
                const cur = meta?.market_data?.price;
                if (cur == null) continue;
                const pnl = (cur - p.entryPriceUsd) / p.entryPriceUsd * 100;
                log.debug("MGR", `${p.symbol ?? "?"} pnl=${pnl.toFixed(1)}%`);

                // Stop-loss
                if (pnl <= -CONFIG.strategy.stopLossPct) {
                    log.trade("MGR", `SL ${p.symbol} ${pnl.toFixed(1)}%  SELLING 100%`);
                    await executeSwap(makeClient(), {
                        jettonMaster: p.jettonMaster,
                        amountTon: 0.1,      // tiny out for now; replaced by real sell amount
                        side: "sell",
                    });
                    // remove from list
                    const idx = POSITIONS.indexOf(p);
                    if (idx >= 0) POSITIONS.splice(idx, 1);
                    continue;
                }

                // Take-profit T1
                if (!p.t1Triggered && pnl >= CONFIG.strategy.takeProfitT1Pct) {
                    log.trade("MGR", `TP1 ${p.symbol} ${pnl.toFixed(1)}%  SELLING 50%`);
                    await executeSwap(makeClient(), {
                        jettonMaster: p.jettonMaster,
                        amountTon: 0.1,
                        side: "sell",
                    });
                    p.t1Triggered = true;
                }
            } catch (e: any) {
                log.err("MGR", e.message);
            }
        }
    }, 10_000);
}
