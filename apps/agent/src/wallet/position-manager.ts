/**
 * Position monitor — polls open positions in SQLite,
 * applies stop-loss / take-profit rules, and drives auto-sells.
 *
 * Sells (SL/TP/trailing) route through the TierCoordinator so the
 * kill-switch is enforced globally. Buys do NOT happen here — those
 * are driven by the brain via the MCP execute_swap tool, which uses
 * the coordinator's gated `executeForTier()` method.
 */
import { makeClient } from "./wallet";
import { log } from "../logger";
import { CONFIG } from "../config";
import { getJetton } from "../security/audit";
import { executeSwap } from "../dex/router";
import { positionsStore, dailyPnlStore } from "../storage/store";
import { TIER_RISK_CONFIGS } from "../risk/guardrails";
import { getCoordinator, isCoordinatorStarted, type Tier } from "../core/coordinator";
import { postEnvelope } from "../webhook";

/**
 * Push a position-shaped update to the web with the row id as the
 * idempotency key, so successive ticks updating the same position
 * upsert over the prior row instead of inserting duplicates.
 */
async function pushWebhook(kind: string, tier: Tier, payload: any): Promise<void> {
  await postEnvelope({
    kind,
    walletTier: tier,
    payload,
    stableId: typeof payload?.id === "string" ? payload.id : undefined,
  });
}

export async function runMonitor() {
  log.info("MGR", "Position monitor started");
  const client = makeClient();

  setInterval(async () => {
    // If kill-switch is flipped globally, the brain should have stopped issuing buys long ago.
    // The monitor respects it too: any pending SL/TP closes get deferred (positions remain
    // OPEN in DB; next tick will re-check). This prevents a forced exit DURING a kill.
    if (isCoordinatorStarted() && getCoordinator().isKillSwitchActive()) {
      log.debug("MGR", "kill-switch active — skipping SL/TP evaluation cycle");
      return;
    }

    const openPositions = positionsStore.listOpen();
    for (const p of openPositions) {
      try {
        const tier = p.wallet_tier as Tier;
        const cfg = TIER_RISK_CONFIGS[tier];

        const meta = await getJetton(p.jetton_master);
        if (!meta) continue;

        const curUsd = meta?.market_data?.price;
        if (curUsd == null) continue;

        // Calculate PnL based on USD price
        const pnl = ((curUsd - p.entry_price_usd!) / p.entry_price_usd!) * 100;
        const curTon = (1 + pnl / 100) * p.entry_price_ton;

        log.debug("MGR", `[${tier.toUpperCase()}] ${p.symbol ?? "?"} pnl=${pnl.toFixed(1)}%`);

        // Update current price & PnL in database + UI
        const updatedPos = {
          ...p,
          current_price_ton: curTon,
          pnl_pct: pnl,
        };
        positionsStore.upsert(updatedPos);
        await pushWebhook("position_update", tier, updatedPos);

        // 1. Stop-Loss (SL) — legacy full-close only (no TP1/trailing, 2026-08-09 aligned)
        if (p.status === "OPEN" && pnl <= -cfg.stopLossPct) {
          log.trade("MGR", `[${tier.toUpperCase()}] SL triggered for ${p.symbol} at ${pnl.toFixed(1)}% (Limit: -${cfg.stopLossPct}%)`);

          const res = await executeSwap(
            client,
            {
              jettonMaster: p.jetton_master,
              amountTon: 0.1, // Not used for sell
              side: "sell",
              jettonAmountNano: p.amount_tokens,
            },
            tier,
            (p.dex as any) || CONFIG.strategy.preferredDex
          );

          if (res.ok) {
            const realizedPnl = (pnl / 100) * p.cost_basis_ton;
            const closedPos = {
              ...p,
              status: "STOPPED",
              close_at: Date.now(),
              pnl_pct: pnl,
              current_price_ton: curTon,
              realized_pnl_ton: realizedPnl,
            };
            positionsStore.upsert(closedPos);
            dailyPnlStore.addPnl(realizedPnl);
            await pushWebhook("position_update", tier, closedPos);
          }
          continue;
        }

        // 2. Take-Profit — legacy full-close only (no partials, no trailing, 2026-08-09 aligned)
        if (p.status === "OPEN" && pnl >= cfg.takeProfitPct) {
          log.trade("MGR", `[${tier.toUpperCase()}] TP triggered for ${p.symbol} at ${pnl.toFixed(1)}% (Target: ${cfg.takeProfitPct}%)`);

          const res = await executeSwap(
            client,
            {
              jettonMaster: p.jetton_master,
              amountTon: 0.1,
              side: "sell",
              jettonAmountNano: p.amount_tokens,
            },
            tier,
            (p.dex as any) || CONFIG.strategy.preferredDex
          );

          if (res.ok) {
            const realizedPnl = (pnl / 100) * p.cost_basis_ton;
            const closedPos = {
              ...p,
              status: "CLOSED",
              close_at: Date.now(),
              pnl_pct: pnl,
              current_price_ton: curTon,
              realized_pnl_ton: realizedPnl,
            };
            positionsStore.upsert(closedPos);
            dailyPnlStore.addPnl(realizedPnl);
            await pushWebhook("position_update", tier, closedPos);
          }
        }
      } catch (e: any) {
        log.err("MGR", `Monitor error for ${p.symbol || p.jetton_master.slice(0, 8)}: ${e.message}`);
      }
    }
  }, 10_000);
}
