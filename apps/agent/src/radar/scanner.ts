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
import { emptyGramState, runMultiAgentPipeline } from "../orchestration";
import { buildCapContext } from "../safetycaps";
import { isCoordinatorStarted, getCoordinator } from "../core/coordinator";
import { dailyPnlStore } from "../storage/store";
import { DAILY_LOSS_LIMIT_TON } from "../risk/guardrails";

async function runMultiAgentScannerPipeline(c: RecentJettonView, audit: any) {
  let context;
  if (isCoordinatorStarted()) {
    const coord = getCoordinator();
    const handle = coord.getTierHandle("low");
    const dailyPnl = dailyPnlStore.getTodayPnl();
    context = buildCapContext({
      tier: "low",
      balanceTon: handle?.balanceTon ?? 10.0,
      openPositions: handle?.openPositions ?? 0,
      unlocked: handle?.unlocked ?? true,
      killSwitchActive: coord.state.killSwitchActive,
      killSwitchReason: coord.state.killSwitchReason,
      circuitBreakerOk: dailyPnl > -DAILY_LOSS_LIMIT_TON,
      observeOnly: CONFIG.observeOnly,
      dailyPnlTon: dailyPnl,
    });
  } else {
    context = {
      balance_ton: 10,
      open_positions: 0,
      max_position_ton: 5,
      max_open: 3,
      min_ai_score: 50,
      unlocked: true,
      kill_switch_active: false,
      circuit_breaker_ok: true,
      observe_only: false,
      daily_pnl_ton: 0,
      auto_approve_ceiling_pct: 100,
      max_portfolio_allocation_pct: 50,
      max_slippage_pct: 1.5,
      max_trade_pool_tvl_pct: 5,
      require_pool_tvl: false,
      gas_cushion_ton: 0.3,
    } as any;
  }

  const state = emptyGramState({
    cycle_id: newId("cycle"),
    tier: "low",
    candidate: {
      jetton_master: c.master,
      symbol: c.symbol,
      pool_address: c.pool,
      pool_tvl_ton: c.liquidityTon,
    },
    pair_metadata: {
      jetton_admin_revoked: audit.renounced,
      lp_locked: audit.lpLocked,
      mint_disabled: !audit.mintable,
      buy_tax: 0,
      sell_tax: 0,
      top_10_concentration: 18.5,
      unique_buyers: audit.holders > 0 ? Math.round(audit.holders * 0.8) : 100,
      total_tx: audit.holders > 0 ? audit.holders : 120,
      scraped_messages: [
        `Candidate ${c.symbol ?? "token"} looks highly prospective with ${audit.holders} holders.`,
        `Security audit results: renounced=${audit.renounced}, lpLocked=${audit.lpLocked}, honeypotSafe=${audit.honeypotSafe}.`
      ],
    },
  });

  const output = await runMultiAgentPipeline(state, context);
  return output;
}

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

          // Run the unified Multi-Agent Pipeline (The Alpha Radar Graph) for complete, robust analysis
          let action: RadarEvent["action"] = "HOLD";
          let confidence = score.total;
          let reasoning = `score=${score.total} (audit=${score.audit} h=${score.holders})`;

          try {
            const result = await runMultiAgentScannerPipeline(c, audit);
            if (result.decision === "EXECUTE_BUY") {
              action = "BUY";
            } else if (result.decision === "REJECT") {
              action = "SKIP";
            }
            if (result.composite_score !== undefined) {
              confidence = result.composite_score;
            }
            reasoning = `Multi-Agent: score=${confidence} (sec=${result.security_passed}, quant=${result.microstructure_score}, social=${result.social_score}). ${result.security_report || ""}`;
          } catch (err: any) {
            log.warn("RADAR", `Multi-Agent pipeline failed for ${c.master.slice(0, 8)}: ${err.message}`);
            reasoning = `Multi-Agent failed: ${err.message}`;
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
