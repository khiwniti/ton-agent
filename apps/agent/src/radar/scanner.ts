/**
 * MemPool radar — continuous scanner.
 *
 *  1. Poll TONAPI for recent jetton creations (or DEX pool adds).
 *  2. For each candidate, audit + (rate-limited) ReAct brain plan.
 *  3. Push the radar event to the web via `postEnvelope` with stable id.
 *
 * Throttling:
 *  - One console log per tick.
 *  - LLM-driven plan is gated by `tryConsumeLlmCall()` (hourly + per-tick).
 *  - TONAPI calls route through `tonapiGet` so 429/5xx retries on the radar.
 *  - Audits stay uncapped; only the LLM call is throttled.
 *
 * NOTE: TONAPI's free endpoints throttle hard; in production wire
 * a TON validator connection or a paid TONAPI stream.
 */
import { CONFIG } from "../config";
import { log } from "../logger";
import { newId, type RiskTier, type RadarEvent } from "@ton-agent/shared";
import { fullAudit } from "../security/audit";
import { computeConfidenceScore } from "../risk/scoring";
import { makeClient } from "../wallet/wallet";
import { runTradeBrain } from "../ai/brain";
import { tonapiGet } from "../http/tonapi";
import { postEnvelope } from "../webhook";
import { tryConsumeLlmCall } from "./llm-budget";

// Actual TONAPI /jettons response shape (as of 2026-07).
// Top-level fields: mintable, total_supply, metadata, preview, verification,
// holders_count, code_hash, data_hash, interfaces. Address lives in metadata,
// pool info is NOT included — the radar discovers pools via audit.
interface TonapiJetton {
  mintable: boolean;
  total_supply: string;
  metadata: {
    address: string;
    name?: string;
    symbol?: string;
    decimals?: string;
  };
  verification: string;
  holders_count: number;
}

async function pushRadarEvent(
  e: RadarEvent,
  walletTier?: RiskTier
): Promise<void> {
  await postEnvelope({
    kind: "radar_hit",
    walletTier,
    payload: e as unknown as Record<string, any>,
    stableId: e.id,
  });
}

interface RecentJettonView {
  master: string;
  pool?: string;
  symbol?: string;
  liquidityTon?: number;
}

/**
 * Recent jettons via TONAPI. Refresh-on-429 is handled by `tonapiGet`.
 */
async function getRecentJettonMasters(
  limit = 50
): Promise<RecentJettonView[]> {
  try {
    const r = await tonapiGet("/jettons", {
      params: { limit, verified: "false", sort: "created" },
      timeoutMs: 8000,
    });
    // Defensive: ensure jettons is actually an array (TONAPI testnet may return
    // a different shape or empty response). Non-array values produce [] safely.
    const raw = r.data?.jettons;
    const items: TonapiJetton[] = Array.isArray(raw) ? raw : [];
    return items
      .filter((x): x is TonapiJetton => x != null && !!x.metadata?.address)
      .map((x) => ({
        master: x.metadata.address,
        pool: undefined,  // TONAPI /jettons does not include pool info
        symbol: x.metadata?.symbol,
        liquidityTon: undefined,  // pool liquidity not available at this level
      }));
  } catch (e: any) {
    const stack = (e as Error)?.stack?.split('\n').slice(0, 4).join(' | ') ?? '';
    log.err("RADAR", `getRecentJettonMasters ${e.message} ${stack}`);
    return [];
  }
}

const SEEN = new Set<string>();

export async function startRadar(_printOnly = false) {
  log.banner("RADAR", `${CONFIG.network.toUpperCase()} • TONAPI`);
  const client = makeClient();
  let tick = 0;

  const tickFn = async () => {
    try {
      tick++;
      log.info("RADAR", `tick=${tick} ${CONFIG.network} seen=${SEEN.size}`);

      const recent = await getRecentJettonMasters(30);
      const candidates: RecentJettonView[] = [
        ...CONFIG.watchlist.map((m) => ({ master: m })),
        ...recent,
      ].filter((c) => !SEEN.has(c.master));

      for (const c of candidates) {
        SEEN.add(c.master);
        try {
          const audit = await fullAudit(client, c.master, c.pool);
          if (!audit.ok) {
            log.warn("RADAR", `skip ${c.master.slice(0, 8)}… audit failed`);
            continue;
          }

          // Compute confidence score from audit data + pool metadata.
          // This runs BEFORE the LLM is called so the event always has a score.
          const score = computeConfidenceScore({
            renounced: audit.renounced,
            lpLocked: audit.lpLocked,
            honeypotSafe: audit.honeypotSafe,
            holders: audit.holders,
            ageHours: audit.ageHours || 0,
            liquidityTon: c.liquidityTon ?? null,
            poolAvailable: !!c.pool,
            tier: "low",
            minAiScore: 50, // radar uses a generous threshold — any passable audit qualifies
          });

          // Gate the LLM-driven plan behind the budget. When over budget we
          // still push the event (with HOLD action, conservative defaults) so
          // the operator sees the audit result on the web UI.
          const budget = tryConsumeLlmCall(`radar:${c.master.slice(0, 8)}`);
          let action: RadarEvent["action"] = "HOLD";
          let confidence = score.total;
          let reasoning = budget.allowed ? `score=${score.total} (audit=${score.audit} h=${score.holders} a=${score.age} l=${score.liquidity})` : `LLM budget exhausted (${budget.reason ?? "n/a"}) — audit only`;

          if (budget.allowed) {
            const prompt = `Candidate jetton ${c.master}\n` +
              `Symbol: ${c.symbol ?? "?"}\n` +
              `Liquidity Ton: ${c.liquidityTon ?? "unknown"}\n` +
              `Audit: renounced=${audit.renounced}, lpLocked=${audit.lpLocked}, honeypotSafe=${audit.honeypotSafe}, holders=${audit.holders}\n` +
              `Build a written trade plan, choose entry size using max 15% of bankroll cap, then either BUY or SKIP. If you BUY, immediately call notify_web(kind=trade_executed).`;

            try {
              const result = await runTradeBrain(prompt, { pushToWeb: true });
              // The brain's emitted action is in metadata; we keep a conservative
              // default until the agent surfaces one explicitly via notify_web.
              if (result?.threadId) reasoning = `brain thread=${result.threadId}`;
            } catch (err: any) {
              log.warn("RADAR", `brain failed ${err.message}; marking SKIP`);
              action = "SKIP";
              reasoning = `brain failed: ${err.message}`;
            }
          }

          const e: RadarEvent = {
            id: newId("rad"),
            detectedAt: Date.now(),
            walletTier: "low",
            jettonMaster: c.master,
            symbol: c.symbol,
            poolAddress: c.pool,
            initialLiquidityTon: c.liquidityTon ?? null,
            tokenAgeHours: audit.ageHours || 0,
            renounced: audit.renounced,
            lpLocked: audit.lpLocked,
            honeypotSafe: audit.honeypotSafe,
            aiScore: 0,
            action,
            confidence,
            reasoning,
          };
          await pushRadarEvent(e, "low");
        } catch (err: any) {
          const stack = (err as Error)?.stack?.split('\n').slice(0, 4).join(' | ') ?? '';
          log.err("RADAR", `candidate ${c.master?.slice(0, 12) ?? '?'}: ${err.message} ${stack}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // Cap memory spent on seen list
      if (SEEN.size > 2000) {
        const arr = [...SEEN];
        for (let i = 0; i < 1700 && i < arr.length; i++) SEEN.delete(arr[i]);
      }
    } catch (tickErr: any) {
      const stack = (tickErr as Error)?.stack?.split('\n').slice(0, 4).join(' | ') ?? '';
      log.err("RADAR", `tickFn fatal: ${tickErr.message} ${stack}`);
    }
  };

  await tickFn();
  setInterval(tickFn, 60_000); // every 60 s; configurable later
}
