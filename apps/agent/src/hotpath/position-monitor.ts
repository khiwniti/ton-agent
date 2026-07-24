/**
 * Hot-path Position Monitor — Phase 4 (spec 002 §8.5).
 *
 * Extracts the inline SL/TP/trailing arithmetic that used to live in
 * wallet/position-manager.ts and routes every tick through the pure
 * `evaluateExitPolicy` state machine in exit/policy-engine.ts.
 *
 * Non-negotiables (Constitution §6 hot path, §8.5, P6 fail-closed, SC-E):
 *   - NO LLM anywhere on this tick loop. The audit verdict arrives via a
 *     cached `fullAudit()` SecurityReport (the verdict maps 1:1 onto
 *     AuditVerdict); price arrives via the cheap `getJetton()` call.
 *   - Journal FIRST: every cycle — fire OR skip — appends to decision_journal
 *     before any `executeSwap`. "If it is not journaled, it did not happen."
 *   - Fail closed: ambiguous price/audit (verdict === null) skips the
 *     emergency trigger and the engine itself refuses non-finite pnl.
 *   - Same kill-switch skip as the legacy monitor (exits must still defer
 *     during a kill — no "fast lane" around the switch).
 *
 * FR-013 rollout: gated behind `EXIT_ENGINE_ENABLED` (default false). When
 * off, `runMonitor` delegates to the legacy ticker — behaviour-preserving
 * for operators who haven't flipped the flag.
 */
import { makeClient } from "../wallet/wallet";
import { log } from "../logger";
import { CONFIG } from "../config";
import { getJetton, fullAudit } from "../security/audit";
import { executeSwap, getSwapQuote, type Dex } from "../dex/router";
import { resolvePool } from "../security/pool-resolver";
import { Address, fromNano } from "@ton/ton";
import {
  positionsStore,
  dailyPnlStore,
  decisionJournalStore,
} from "../storage/store";
import { TIER_RISK_CONFIGS } from "../risk/guardrails";
import {
  getCoordinator,
  isCoordinatorStarted,
  type Tier,
} from "../core/coordinator";
import { postEnvelope } from "../webhook";
import {
  evaluateExitPolicy,
  type AuditVerdict,
  type ExitPolicyContext,
} from "../exit/policy-engine";
import { runMonitor as runLegacyMonitor } from "../wallet/position-manager";
import { SELL_GAS_FLOOR_TON } from "../dex/swap-gas-guard";

/**
 * Push a position-shaped update to the web with the row id as the
 * idempotency key, so successive ticks updating the same position upsert
 * over the prior row instead of inserting duplicates. (Carried over
 * verbatim from the legacy monitor.)
 */
async function pushWebhook(
  kind: string,
  tier: Tier,
  payload: any,
): Promise<void> {
  await postEnvelope({
    kind,
    walletTier: tier,
    payload,
    stableId: typeof payload?.id === "string" ? payload.id : undefined,
  });
}

/**
 * Per-jetton audit-verdict cache. `fullAudit` does 3 sub-checks; running it
 * every 10s tick is too heavy for the hot path (SC-E). The cache is allowed
 * to go stale and is refreshed only when:
 *   (a) it has been ≥ AUDIT_TTL_MS since the last verdict, OR
 *   (b) the tick's pnl dropped sharply (≥ AUDIT_RECHECK_DROP_PCT in one tick),
 *       which is the most reliable cheap signal that the pool may be rugged.
 * A stale-or-absent cache yields `auditVerdict: null` to the engine → fail
 * closed (emergency does not fire). The price is always fresh via getJetton.
 */
const AUDIT_TTL_MS = 60_000; // 6 ticks at 10s cadence
const AUDIT_RECHECK_DROP_PCT = 20;
type CachedVerdict = { verdict: AuditVerdict; ts: number; lastPnlPct: number };
const auditCache = new Map<string, CachedVerdict>();

/** TonClient handle lazily created on first audit refresh. */
let auditClient: ReturnType<typeof makeClient> | null = null;

/**
 * Return the audit verdict for a jetton, or `null` when no fresh verdict is
 * available and the engine must fail closed on the emergency trigger.
 */
async function resolveAuditVerdict(
  master: string,
  pool: string | undefined,
  pnlPct: number,
): Promise<AuditVerdict | null> {
  const cached = auditCache.get(master);
  const now = Date.now();
  const stale = !cached || now - cached.ts >= AUDIT_TTL_MS;
  const sharpDrop =
    cached && pnlPct < cached.lastPnlPct - AUDIT_RECHECK_DROP_PCT;

  if (cached && !stale && !sharpDrop) {
    return cached.verdict;
  }

  // Refresh. On any failure (TONAPI down, invalid address, etc.) we leave
  // the cache as-is and return null — fail closed, never escalate to LLM.
  try {
    if (!auditClient) auditClient = makeClient();
    // fullAudit takes `(client, master, pool?)`. The pool is the DEX pool
    // address; before we had it plumbed we pass undefined and fullAudit
    // degrades gracefully (lpLocked=false → ok=false → still a verdict).
    const report = await fullAudit(auditClient, master, pool);
    const verdict: AuditVerdict = {
      ok: report.ok,
      honeypotSafe: report.honeypotSafe,
      lpLocked: report.lpLocked,
      renounced: report.renounced,
    };
    auditCache.set(master, { verdict, ts: now, lastPnlPct: pnlPct });
    return verdict;
  } catch (e: any) {
    log.warn("MGR", `audit re-score failed for ${master.slice(0, 8)}: ${e.message}`);
    // If we have a stale verdict, using it could mask a fresh rug — so on a
    // refresh failure we deliberately return null (fail closed on emergency)
    // rather than a potentially-stale `ok:true`.
    if (cached) auditCache.delete(master);
    return null;
  }
}

/**
 * Journal a tick's outcome BEFORE any swap is submitted. Append-only by
 * construction via decisionJournalStore.append. `final_action` is the
 * trigger name when an exit fires, or `"skip"` when nothing fired.
 */
function journalTick(
  positionId: string,
  action: string,
  detail: Record<string, unknown>,
): void {
  decisionJournalStore.append({
    cycle_id: `tick_${positionId}_${Date.now()}`,
    agent: "position-monitor",
    final_action: action,
    output: detail,
  });
}

export async function runMonitor() {
  // FR-013: flag-off delegates to the proven legacy ticker. Keeps the tree
  // green while the new engine is exercised only by its own tests.
  if (!CONFIG.exitEngineEnabled) {
    log.info(
      "MGR",
      "EXIT_ENGINE_ENABLED=false — running legacy position monitor",
    );
    return runLegacyMonitor();
  }

  log.info("MGR", "hot-path position monitor started (exit policy engine)");
  const client = makeClient();

  setInterval(async () => {
    // Kill-switch: same defer semantics as the legacy monitor. Positions
    // remain OPEN/TP1_HIT; next tick re-checks. No "fast lane".
    if (
      isCoordinatorStarted() &&
      getCoordinator().isKillSwitchActive()
    ) {
      log.debug("MGR", "kill-switch active — skipping exit evaluation cycle");
      return;
    }

    // Dry-wallet short-circuit: if the LOW-tier wallet cannot afford even
    // a single sell (gas floor), every per-position `executeSwap` below
    // would be refused by dex/swap-gas-guard's evaluateSellGasGuard anyway.
    // Skip the whole tick to avoid burning getJetton/SwapQuote/journal
    // cycles on stuck positions. The next tick re-checks on top-up.
    //
    // We only short-circuit when the coordinator is up (e.g. ≥1 tier
    // handle initialized). Otherwise the legacy path handles it.
    if (isCoordinatorStarted()) {
      try {
        const lowHandle = getCoordinator().getTierHandle("low");
        if (lowHandle?.address) {
          const dryBal = await client.getBalance(Address.parse(lowHandle.address));
          const dryBalTon = Number(fromNano(dryBal));
          if (dryBalTon < SELL_GAS_FLOOR_TON) {
            log.warn(
              "MGR",
              `dry-wallet short-circuit: LOW balance=${dryBalTon.toFixed(3)} TON < SELL_GAS_FLOOR=${SELL_GAS_FLOOR_TON} TON — skipping entire tick until topped up`,
            );
            return;
          }
          if (dryBalTon < SELL_GAS_FLOOR_TON * 2) {
            // Above floor but tight — log info so operators can see the
            // gap before it crosses the floor. Still processes positions.
            log.info(
              "MGR",
              `LOW balance=${dryBalTon.toFixed(3)} TON is tight against sell-gas floor ${SELL_GAS_FLOOR_TON} TON — top up soon`,
            );
          }
        }
      } catch (e: any) {
        // Balance check is best-effort; failing here just falls through to
        // the per-position logic, where each executeSwap will refuse cleanly.
        log.debug("MGR", `dry-wallet check skipped (balance read failed): ${e.message}`);
      }
    }

    const openPositions = positionsStore.listOpen();
    for (const p of openPositions) {
      try {
        const tier = p.wallet_tier as Tier;
        const cfg = TIER_RISK_CONFIGS[tier];

        // ── Price (TON pool quote first, fallback to USD if quote unavailable) ──────
        const dex: Dex = (p.dex as any) || CONFIG.strategy.preferredDex;
        let pnl: number | null = null;
        let curTon: number = p.current_price_ton ?? p.entry_price_ton;
        let curUsd: number | undefined;

        try {
          const poolResolved = await resolvePool(client, Address.parse(p.jetton_master));
          if (poolResolved.poolAddress) {
            const quote = await getSwapQuote(
              client,
              { dex, poolAddress: poolResolved.poolAddress },
              "sell",
              p.amount_tokens,
              p.jetton_master,
            );
            if (quote && quote.available) {
              curTon = Number(fromNano(quote.expectedOutNano));
              const costBasis = p.cost_basis_ton > 0 ? p.cost_basis_ton : (p.entry_price_ton * Number(BigInt(p.amount_tokens)) / 1e9);
              if (costBasis > 0) {
                pnl = ((curTon - costBasis) / costBasis) * 100;
              }
            }
          }
        } catch {
          // Quote fetch failed — fall back to USD price
        }

        const entryUsd = p.entry_price_usd ?? 1;
        if (pnl == null) {
          const meta = await getJetton(p.jetton_master);
          curUsd = meta?.market_data?.price;
          if (curUsd != null && p.entry_price_usd && p.entry_price_usd > 0) {
            pnl = ((curUsd - p.entry_price_usd) / p.entry_price_usd) * 100;
            curTon = (1 + pnl / 100) * p.entry_price_ton;
          }
        }

        if (pnl == null) continue; // Fail closed if neither quote nor USD is available

        log.debug(
          "MGR",
          `[${tier.toUpperCase()}] ${p.symbol ?? "?"} pnl=${pnl.toFixed(1)}%`,
        );

        // ── Push price/pnl update + UI (matches legacy) ───────────────────
        const updatedPos = {
          ...p,
          current_price_ton: curTon,
          pnl_pct: pnl,
        };
        positionsStore.upsert(updatedPos);
        await pushWebhook("position_update", tier, updatedPos);

        // ── Audit verdict (cached; null → engine fail-closed) ────────────
        const auditVerdict = await resolveAuditVerdict(
          p.jetton_master,
          p.dex,
          pnl,
        );

        // ── Pure exit-policy evaluation ───────────────────────────────────
        const ctx: ExitPolicyContext = {
          now: Date.now(),
          currentPriceUsd: curUsd ?? entryUsd * (1 + pnl / 100),
          entryPriceUsd: entryUsd,
          tierCfg: cfg,
          auditVerdict,
          maxHoldMs: p.max_hold_ms ?? null,
        };
        const decision = evaluateExitPolicy(
          {
            status: p.status,
            entry_at: p.entry_at,
            entry_price_usd: entryUsd,
            exit_by_ms: p.exit_by_ms ?? null,
          },
          ctx,
        );

        // ── Journal FIRST (before any swap) ───────────────────────────────
        journalTick(p.id, decision ? decision.trigger : "skip", {
          reason: decision?.reason ?? "no trigger",
          pnl,
          status: p.status,
          auditOk: auditVerdict?.ok ?? null,
        });

        if (!decision) continue;

        log.trade(
          "MGR",
          `[${tier.toUpperCase()}] ${decision.trigger} for ${p.symbol} at ${pnl.toFixed(1)}% — ${decision.reason}`,
        );

        // ── Size the sell (full vs TP1 half) ──────────────────────────────
        const isFull = decision.sellFraction >= 1.0;
        const sellTokens = isFull
          ? p.amount_tokens
          : (BigInt(p.amount_tokens) / 2n).toString();

        const swapReq = {
          jettonMaster: p.jetton_master,
          amountTon: 0.1, // unused for sell
          side: "sell" as const,
          jettonAmountNano: sellTokens,
          minOutJettonNano: "0",
        };

        const res = isCoordinatorStarted()
          ? await getCoordinator().executeForTier(
              tier,
              swapReq,
              dex,
              { isExit: true }
            )
          : await executeSwap(
              client,
              swapReq,
              tier,
              dex,
            );

        if (!res.ok) {
          // Swap failed — leave the position OPEN so a later tick can retry,
          // exactly as the legacy monitor did on a failed sell. The journal
          // already recorded the fire attempt; no extra recovery state.
          log.warn(
            "MGR",
            `${decision.trigger} sell failed for ${p.id}; leaving OPEN for retry`,
          );
          continue;
        }

        // ── Persist the post-sell row (mirrors legacy arithmetic per trigger) ──
        let realizedPnl: number;
        let row: any;

        if (decision.trigger === "take_profit") {
          // TP1: half the position; PnL realised on the sold half.
          realizedPnl = (pnl / 100) * (p.cost_basis_ton / 2);
          const halfTokens = BigInt(p.amount_tokens) / 2n;
          row = {
            ...p,
            status: "TP1_HIT",
            pnl_pct: pnl,
            current_price_ton: curTon,
            take_profit_t1_tx: "executed",
            realized_pnl_ton: realizedPnl,
            amount_tokens: (BigInt(p.amount_tokens) - halfTokens).toString(),
            cost_basis_ton: p.cost_basis_ton / 2,
          };
        } else if (decision.trigger === "trailing" || decision.trigger === "tp2") {
          // Final leaf of the TP1_HIT branch: accumulate onto prior realised.
          // (Legacy closedPos combined trailing + tp2 with realised_pnl_ton += .)
          realizedPnl = (pnl / 100) * p.cost_basis_ton;
          row = {
            ...p,
            status: decision.nextStatus, // "CLOSED"
            close_at: Date.now(),
            pnl_pct: pnl,
            current_price_ton: curTon,
            realized_pnl_ton: (p.realized_pnl_ton || 0) + realizedPnl,
          };
        } else if (decision.trigger === "emergency_exit") {
          // Rug exit: full sell, terminal RUG_EXIT, sticky rugged flags.
          realizedPnl = (pnl / 100) * p.cost_basis_ton;
          row = {
            ...p,
            status: "RUG_EXIT",
            close_at: Date.now(),
            pnl_pct: pnl,
            current_price_ton: curTon,
            realized_pnl_ton: (p.realized_pnl_ton || 0) + realizedPnl,
            rugged: 1,
            rugged_at: Date.now(),
            emergency_exit: 1,
          };
        } else {
          // stop_loss + time_exit: full sell.
          realizedPnl = (pnl / 100) * p.cost_basis_ton;
          row = {
            ...p,
            status: decision.nextStatus, // "STOPPED" or "CLOSED"
            close_at: Date.now(),
            pnl_pct: pnl,
            current_price_ton: curTon,
            realized_pnl_ton: realizedPnl,
          };
        }

        positionsStore.upsert(row);
        dailyPnlStore.addPnl(realizedPnl);
        await pushWebhook("position_update", tier, row);
      } catch (e: any) {
        // Exact legacy error handling — one bad position never kills the loop.
        log.err(
          "MGR",
          `Monitor error for ${p.symbol || p.jetton_master.slice(0, 8)}: ${e.message}`,
        );
      }
    }
  }, 10_000);
}
