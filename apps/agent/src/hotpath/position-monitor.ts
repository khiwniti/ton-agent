/**
 * Hot-path Position Monitor — Phase 4 (spec 002 §8.5).
 *
 * Extracts the inline SL/TP/trailing arithmetic that used to live in
 * wallet/position-manager.ts and routes every tick through the pure
 * `evaluateExitPolicy` state machine in exit/policy-engine.ts.
 *
 * Non-negotiables (Constitution §6 hot path, §8.5, P6 fail-closed, SC-E):
 *   - NO LLM anywhere on this tick loop. The audit verdict arrives via a
 *     cached `fullAuditDetail()` result; price arrives via a DEX quote.
 *   - Journal FIRST: every cycle — fire OR skip — appends to decision_journal
 *     before any `executeSwap`. "If it is not journaled, it did not happen."
 *   - Fail closed: ambiguous price/audit skips the emergency trigger and the
 *     engine itself refuses non-finite pnl.
 *   - Same kill-switch skip as the legacy monitor (exits must still defer
 *     during a kill — no "fast lane" around the switch).
 *
 * ── 2026-08-08 post-mortem fixes ────────────────────────────────────────────
 * Production drained 3.3 TON of cost basis to a 0.000000 TON wallet while the
 * books showed only -0.188 TON. Four defects in this file were responsible:
 *
 *  1. GAS WAS NEVER BOOKED. `realizedPnl = (pnl / 100) * cost_basis_ton` omits
 *     the flat ~0.2 TON round-trip gas entirely, so every close under-reported
 *     its loss by more than the loss itself. `dailyPnlStore` fed the circuit
 *     breaker that fiction, so `DAILY_LOSS_LIMIT_TON=2.0` read -0.188 and never
 *     tripped. The breaker was blind BY CONSTRUCTION. Now every branch routes
 *     through `computeRealizedPnlTon` with an explicit per-leg gas charge.
 *
 *  2. THE MARK PRICE WAS SELF-POISONED. PnL came from quoting a dump of the
 *     ENTIRE position, so the reading included our own price impact: a larger
 *     position reads a worse price purely for being larger, and the stop fires
 *     on impact we caused. Now a small PROBE slice sets the mark used for
 *     trigger evaluation, and the full-size quote is fetched only on the tick
 *     an exit actually fires, to book accounting truth.
 *
 *  3. THE EXIT GATE WAS STRICTER THAN THE ENTRY GATE. `!auditVerdict.ok`
 *     required `renounced`, a STATIC property already accepted at entry, so 26
 *     positions were guillotined one tick after purchase at the DEX spread
 *     (~-0.6%, identical across nine unrelated pools). Emergency exits now
 *     require a measured DELTA via `exit/rug-detector.ts`.
 *
 *  4. UNQUOTABLE POSITIONS VANISHED. `if (pnl == null) continue` silently
 *     skipped any position whose quote failed — forever. A position that
 *     becomes untradeable (the real rug case) produced no log, no journal entry
 *     and no alert. Now tracked and escalated.
 *
 * FR-013 rollout: gated behind `EXIT_ENGINE_ENABLED`. When off, `runMonitor`
 * delegates to the legacy ticker.
 */
import { makeClient } from "../wallet/wallet";
import { log } from "../logger";
import { CONFIG } from "../config";
import { getJetton, fullAuditDetail } from "../security/audit";
import { getSwapQuote, readUserJettonBalance, type Dex } from "../dex/router";
import { resolvePool } from "../security/pool-resolver";
import { Address, fromNano, toNano } from "@ton/ton";
import {
  positionsStore,
  dailyPnlStore,
  decisionJournalStore,
  tradeTransactionStore,
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
import {
  detectRug,
  LiquidityTracker,
  type AuditSnapshot,
} from "../exit/rug-detector";
import {
  TrendTracker,
  type TrendSignal,
} from "../exit/trend-monitor";
import {
  atrClose,
  realizedVol,
  structureStopLevel,
  RegimeClassifier,
} from "../exit/volatility-regime";
import {
  computeRealizedPnlTon,
  effectiveStopLossPct,
  exitGasTon,
} from "../economics/trade-economics";
import { runMonitor as runLegacyMonitor } from "../wallet/position-manager";
import { SELL_GAS_FLOOR_TON } from "../dex/swap-gas-guard";
import { fetchHoldersTotal } from "../http/tonapi";
import { confirmedByFeeds, type ExitConfirmation } from "../sniper/filters";
import { fetchCoin, masterToAsset } from "../sniper/x1000-client";
import { fetchTradesWindow } from "../hotpath/dedust-trades";
import { poolMonitorService } from "../market";


/**
 * Push a position-shaped update to the web with the row id as the
 * idempotency key, so successive ticks updating the same position upsert
 * over the prior row instead of inserting duplicates.
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
 * Fraction of the position quoted to establish the MARK price.
 *
 * Quoting the full position measures its own liquidation impact, not the
 * market. A 10% probe scaled back up approximates the price a marginal seller
 * sees, which is the correct basis for a stop/take-profit decision. The
 * full-size quote is still used for accounting when an exit fires.
 */
const MARK_PROBE_FRACTION = (() => {
  const n = Number(process.env.MARK_PROBE_FRACTION || "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.1;
})();

/** Consecutive failed-quote ticks before a position is flagged as trapped. */
const TRAPPED_QUOTE_FAILURES = 3;

/**
 * Overlap guard — one tick at a time.
 *
 * Prod incident `eb09fbc5…` (2026-08-08): the `setInterval` callback fires
 * every 10s REGARDLESS of whether the previous invocation has finished. A
 * tick that takes >10s (audit RPC + probe quote + full quote + swap broadcast
 * + up to 45s seqno wait) overlaps the next tick, which then reads a STALE
 * `listOpen()` snapshot. On the NOTINU position this produced TWO concurrent
 * exits: TP1 sold half (218.5T) while the overlapped tick's stale snapshot
 * still held the full 437T, so its trailing-stop sell tried 437T — bounced
 * with exit 706 (insufficient balance) and, because the success check only
 * watched the wallet seqno, was booked as a phantom CONFIRMED close.
 *
 * With this flag a slow tick simply skips the next firing; the following
 * interval re-reads a FRESH `listOpen()` and never acts on stale state.
 */
let monitorTickInFlight = false;

/**
 * Per-jetton audit-verdict cache. `fullAuditDetail` does 3 sub-checks; running
 * it every 10s tick is too heavy for the hot path (SC-E). The cache is allowed
 * to go stale and is refreshed only when:
 *   (a) it has been ≥ AUDIT_TTL_MS since the last verdict, OR
 *   (b) the tick's pnl dropped sharply (≥ AUDIT_RECHECK_DROP_PCT in one tick).
 * A stale-or-absent cache yields `null` → the rug detector sees no fresh
 * measurement → no emergency (fail closed). The price is always fresh.
 */
const AUDIT_TTL_MS = 60_000; // 6 ticks at 10s cadence
const AUDIT_RECHECK_DROP_PCT = 20;
type CachedVerdict = { verdict: AuditVerdict; ts: number; lastPnlPct: number };
const auditCache = new Map<string, CachedVerdict>();

/**
 * First observed audit snapshot per jetton — the rug detector's baseline.
 *
 * A rug is a TRANSITION (safe → unsafe), so detection needs a "before". We
 * cannot read the entry-time audit (it was never persisted), so the first
 * successful observation while holding becomes the baseline. That is sound:
 * the entry gate already asserted the hard dimensions were good, and
 * `detectAuditDegradation` treats a missing baseline the same way.
 */
const auditBaselines = new Map<string, AuditSnapshot>();

/**
 * Exit-value high-water mark per position, the depth proxy for drain detection.
 *
 * NOTE ON WHY THIS IS NOT `resolvePool().liquidityTon`: that resolver caches
 * for 24 HOURS, so its liquidity figure is frozen for the entire life of a
 * position and a delta computed from it can never fire. The exit value we
 * already measure each tick is fresh, free, and a more direct statement of the
 * thing we actually care about — whether the pool can still honour our size.
 */
const exitValueTracker = new LiquidityTracker();

/** Consecutive quote failures per position id (trapped-position detection). */
const quoteFailures = new Map<string, number>();

// ── Pool subscription refcount (architecture research/01-architecture.md §3) ─
// The pool monitor polls only what is watched. We subscribe a pool the first
// time any open position resolves to it and unwatch when the last holder
// closes. Refcounted because two positions can share one pool.
const poolSubs = new Map<string, { refs: number; unsubscribe: () => void }>();

/** Subscribe a position's pool to the poller. Idempotent per pool. */
function watchPositionPool(poolAddress: string, dex: Dex): void {
  const existing = poolSubs.get(poolAddress);
  if (existing) {
    existing.refs += 1;
    return;
  }
  poolSubs.set(poolAddress, {
    refs: 1,
    unsubscribe: poolMonitorService.subscribeToPool(poolAddress, dex),
  });
}

/** Drop one holder's reference; unwatch when the last holder closes. */
function unwatchPositionPool(poolAddress: string): void {
  const existing = poolSubs.get(poolAddress);
  if (!existing) return;
  existing.refs -= 1;
  if (existing.refs <= 0) {
    poolSubs.delete(poolAddress);
    existing.unsubscribe();
  }
}

// Position id → the pool it is currently subscribed to. Enables both the
// refcount (one subscribe per position) and the reverse lookup in
// `forgetPosition` (a position's pool is not re-resolved at close time).
const positionPool = new Map<string, string>();

/**
 * Feed a polled pool price into the trend tracker for every open position
 * holding that pool. Called on every fresh `PriceTick` from the pool monitor
 * (architecture research/01-architecture.md §3): the confirmation counter
 * accumulates on real market data at ~3s cadence instead of waiting for the
 * next 10s probe-quote tick.
 *
 * Units note: the polled price is a reserve-derived per-token price. For
 * TON-quoted pools it is in the same TON/token units as the probe-quote
 * series, so the combined ring buffer is coherent. For quote-side pairs the
 * scale differs by the (slow-moving) quote rate — the trend gate reads
 * direction and crossings, not absolute scale, so this is acceptable for a
 * supplementary source; the probe-quote series remains authoritative.
 */
function observePolledTrend(tick: import("../market").PriceTick): void {
  if (!CONFIG.market.pollEnabled) return;
  if (!CONFIG.strategy.trendExitEnabled) return;
  // A tick that is already stale relative to the poll cadence would feed a
  // flat price into the ring buffer — drop it (same rule as BasePoolPriceSource).
  const age = Date.now() - tick.ts;
  if (age > CONFIG.market.staleAfterMs) return;

  // O(positions-on-pool): scan the open set for holders of this pool.
  const holders = positionsStore.listOpen().filter(
    (p) => positionPool.get(p.id) === tick.poolAddress,
  );
  for (const p of holders) {
    try {
      trendTracker.observe(p.id, tick.price, p.entry_price_ton);
    } catch {
      // Never let one bad observation kill the event bus.
    }
  }
}

/** TonClient handle lazily created on first audit refresh. */
let auditClient: ReturnType<typeof makeClient> | null = null;

/**
 * Per-position trend tracker (operator directive 2026-08-09). Winners ride the
 * trend with NO take-profit/trailing targets and close on a CONFIRMED
 * downtrend flip; the static stop-loss stays the hard loss floor.
 */
const trendTracker = new TrendTracker({
  fastEmaPeriod: CONFIG.strategy.trendExitFastEma,
  slowEmaPeriod: CONFIG.strategy.trendExitSlowEma,
  confirmTicks: CONFIG.strategy.trendExitConfirmTicks,
  historySize: CONFIG.strategy.trendExitHistory,
  minObservations: CONFIG.strategy.trendExitMinObservations,
});

/** Signal returned when trend exits are disabled — never fires. */
const trendDisabled: TrendSignal = {
  bearish: false,
  confirmations: 0,
  confirmed: false,
  observations: 0,
  fastEma: 0,
  slowEma: 0,
  macdHistogram: 0,
  reason: "",
};

/**
 * Per-position volatility regime classifiers (Phase 4.5). Each pool has its
 * own noise floor — SPIKED means "much noisier than THIS pool's recent
 * history" — so the classifier (and its EMA baseline) cannot be shared across
 * positions. Keyed by position id; dropped in `forgetPosition`.
 */
const regimeClassifiers = new Map<string, RegimeClassifier>();

/**
 * Consecutive closes below the structure-stop level, keyed by position id.
 * Close-confirmation SL (spec): the stop fires only after `stopConfirmTicks`
 * consecutive closes beyond the ATR band — never on a single wick/intrabar
 * excursion. Reset in `forgetPosition`.
 */
const structureBreakStreaks = new Map<string, number>();

/** Build the per-position regime classifier from CONFIG. */
function makeRegimeClassifier(): RegimeClassifier {
  return new RegimeClassifier({
    period: CONFIG.strategy.volatilityLookback,
    spikeThreshold: CONFIG.strategy.volatilitySpikeThreshold,
    calmRatio: CONFIG.strategy.volatilityCalmRatio,
    confirmTicks: CONFIG.strategy.volatilityConfirmTicks,
  });
}

/**
 * Baseline holder count captured on the first CONFIRMED trend tick, keyed by
 * position id. A later flip is checked against a shrinking holder count.
 */
const holdersBaseline = new Map<string, number>();

/** Drop all per-position state once a position reaches a terminal status. */
function forgetPosition(positionId: string, master: string): void {
  exitValueTracker.forget(positionId);
  quoteFailures.delete(positionId);
  trendTracker.forget(positionId);
  regimeClassifiers.delete(positionId);
  structureBreakStreaks.delete(positionId);
  holdersBaseline.delete(positionId);
  auditCache.delete(master);
  auditBaselines.delete(master);
  // Release the pool subscription refcount (polled-price event bus).
  const pool = positionPool.get(positionId);
  if (pool) {
    unwatchPositionPool(pool);
    positionPool.delete(positionId);
  }
}

/**
 * Return the audit verdict for a jetton, or `null` when no fresh verdict is
 * available. `null` means "nothing measured" — the rug detector will not fire.
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
    // `fullAuditDetail(client, master, pool?)` — pool is the DEX pool ADDRESS.
    // Passing `p.dex` (the literal string "dedust") made safeParseAddress
    // reject it, so lpLocked/honeypot always read false. The caller passes the
    // real resolved pool; undefined lets fullAuditDetail run its own resolver.
    const audit = await fullAuditDetail(auditClient, master, pool);
    // A data gap (pool unresolvable, RPC failure, sandbox failure) is
    // AMBIGUITY, not a measured rug. Returning a verdict here would let the
    // detector compare against garbage, so surface it as "no measurement".
    if (!audit.dataAvailable) {
      log.warn(
        "MGR",
        `audit data gap for ${master.slice(0, 8)}…: ${audit.dataUnavailableReason ?? "unknown"} — no verdict, no emergency exit`,
      );
      return null;
    }
    const verdict: AuditVerdict = {
      ok: audit.ok,
      honeypotSafe: audit.honeypotSafeDetail.passed,
      lpLocked: audit.lpLockedDetail.passed,
      // Raw tri-state preserved: "undetermined" must NOT read as "unlocked".
      // Collapsing it to a boolean turns a data gap into a measured rug.
      lpState: audit.lpLockedDetail.state,
      renounced: audit.renouncedDetail.passed,
    };
    auditCache.set(master, { verdict, ts: now, lastPnlPct: pnlPct });
    return verdict;
  } catch (e: any) {
    log.warn("MGR", `audit re-score failed for ${master.slice(0, 8)}: ${e.message}`);
    // A stale verdict could mask a fresh rug, so on refresh failure we
    // deliberately return null rather than a potentially-stale `ok:true`.
    if (cached) auditCache.delete(master);
    return null;
  }
}

/**
 * Journal a tick's outcome BEFORE any swap is submitted. Append-only by
 * construction via decisionJournalStore.append.
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

/** Quote a sell of `tokensNano` and return gross TON out, or null. */
async function quoteSellTon(
  client: ReturnType<typeof makeClient>,
  dex: Dex,
  poolAddress: string,
  tokensNano: string,
  master: string,
): Promise<number | null> {
  const q = await getSwapQuote(
    client,
    { dex, poolAddress },
    "sell",
    tokensNano,
    master,
  );
  if (!q || !q.available) return null;
  const out = Number(fromNano(q.expectedOutNano));
  return Number.isFinite(out) && out > 0 ? out : null;
}

/**
 * Record the sell leg into `trade_transactions`.
 *
 * This table had ZERO rows across the entire production drain, so there was no
 * execution forensics of any kind — no way to reconcile the books against the
 * chain, which is precisely how the gas leak stayed hidden.
 */
function recordSellTx(args: {
  txHash: string | undefined;
  walletAddress: string | undefined;
  master: string;
  tokensSoldNano: string;
  grossOutTon: number;
  gasTon: number;
}): void {
  try {
    tradeTransactionStore.insert({
      // A missing hash must not collide across positions, hence the synthetic key.
      tx_hash: args.txHash || `local_exit_${args.master.slice(0, 12)}_${Date.now()}`,
      wallet_address: args.walletAddress ?? null,
      source_token: args.master,
      target_token: "TON",
      input_amount: args.tokensSoldNano,
      output_amount: toNano(args.grossOutTon.toFixed(9)).toString(),
      status: "CONFIRMED",
      gas_fees: toNano(args.gasTon.toFixed(9)).toString(),
      timestamp: Date.now(),
    } as any);
  } catch (e: any) {
    // Observability must never break trading. Logged, not thrown.
    log.debug("MGR", `trade_transactions insert skipped: ${e.message}`);
  }
}

export async function runMonitor() {
  // FR-013: flag-off delegates to the proven legacy ticker. The legacy path
  // intentionally stays poll-free: it reads probe quotes only and never starts
  // the pool monitor, so a flag-off operator sees zero behavioural change.
  if (!CONFIG.exitEngineEnabled) {
    log.info(
      "MGR",
      "EXIT_ENGINE_ENABLED=false — running legacy position monitor",
    );
    return runLegacyMonitor();
  }

  log.info("MGR", "hot-path position monitor started (exit policy engine)");
  const client = makeClient();

  // ── Polled-price → trend event bus ────────────────────────────────────────
  // Start the REST pollers once at boot (idle until a position subscribes a
  // pool) and register the single global tick handler that fans polled pool
  // prices out to every open position holding that pool. `start()` is
  // idempotent; TimeSeriesStore.connect() swallows DB failures non-fatally.
  if (CONFIG.market.pollEnabled) {
    try {
      await poolMonitorService.start();
      poolMonitorService.onTick(observePolledTrend);
      log.ok("MGR", "pool monitor active — polled prices feed the trend exit bus");
    } catch (e: any) {
      log.err("MGR", `pool monitor failed to start: ${e.message}`);
    }
  } else {
    log.info("MGR", "MARKET_POLL_ENABLED=false — trend exit reads probe quotes only");
  }

  setInterval(async () => {
    // Overlap guard: if the previous tick is still running (slow RPC, audit,
    // swap seqno wait), skip this firing entirely rather than process a
    // STALE position snapshot. See the `monitorTickInFlight` doc — the
    // NOTINU double-sell that bounced (prod tx eb09fbc5…) was exactly this
    // race: an overlapped tick sold the full pre-TP1 amount from stale state.
    if (monitorTickInFlight) {
      log.debug("MGR", "previous tick still running — skipping firing (no overlap)");
      return;
    }
    monitorTickInFlight = true;
    try {
    // Kill-switch: same defer semantics as the legacy monitor. Positions
    // remain OPEN/TP1_HIT; next tick re-checks. No "fast lane".
    if (isCoordinatorStarted() && getCoordinator().isKillSwitchActive()) {
      log.debug("MGR", "kill-switch active — skipping exit evaluation cycle");
      return;
    }

    // Dry-wallet short-circuit: if the LOW-tier wallet cannot afford even a
    // single sell (gas floor), every per-position `executeSwap` below would be
    // refused by evaluateSellGasGuard anyway. Skip the whole tick.
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
            log.info(
              "MGR",
              `LOW balance=${dryBalTon.toFixed(3)} TON is tight against sell-gas floor ${SELL_GAS_FLOOR_TON} TON — top up soon`,
            );
          }
        }
      } catch (e: any) {
        log.debug("MGR", `dry-wallet check skipped (balance read failed): ${e.message}`);
      }
    }

    const openPositions = positionsStore.listOpen();
    for (const p of openPositions) {
      try {
        const tier = p.wallet_tier as Tier;
        const cfg = TIER_RISK_CONFIGS[tier];
        const totalTokens = BigInt(p.amount_tokens);

        // Cost basis of what we still hold. Fallback preserved from the legacy
        // path for rows written before cost_basis_ton was populated.
        const costBasis =
          p.cost_basis_ton > 0
            ? p.cost_basis_ton
            : (p.entry_price_ton * Number(totalTokens)) / 1e9;

        // ── Route on the DEX where the pool actually lives ────────────────
        // The recorded p.dex predates the dedust routing fix, and even for new
        // rows the venue can only be confirmed by resolvePool.
        const dex: Dex = (p.dex as any) || CONFIG.strategy.preferredDex;
        let execDex: Dex = dex;
        let poolAddress: string | null = null;

        try {
          const poolResolved = await resolvePool(
            client,
            Address.parse(p.jetton_master),
          );
          if (poolResolved.poolAddress) {
            poolAddress = poolResolved.poolAddress;
            if (poolResolved.source === "dedust" || poolResolved.source === "stonfi") {
              execDex = poolResolved.source;
            }
          }
        } catch {
          // Pool resolution failed — the USD fallback below still applies.
        }

        // ── Pool subscription for the polled-price event bus ──────────────
        // Idempotent per position: subscribe once when the pool first resolves
        // and keep the refcount steady for the life of the position. The
        // refcounted poolSubs map unwatches when the last holder closes.
        if (CONFIG.market.pollEnabled && poolAddress && !positionPool.has(p.id)) {
          watchPositionPool(poolAddress, execDex);
          positionPool.set(p.id, poolAddress);
        }

        // ── MARK price via a small PROBE, not a full-position dump ────────
        // Quoting the whole position prices in our own impact, so a bigger
        // position reads worse purely for being bigger and the stop fires on
        // damage we inflicted ourselves. The probe approximates the market.
        let markValueTon: number | null = null;
        if (poolAddress) {
          const probeTokens = (() => {
            const scaled =
              (totalTokens * BigInt(Math.round(MARK_PROBE_FRACTION * 10_000))) /
              10_000n;
            // Dust positions cannot be probed meaningfully — quote them whole.
            return scaled > 0n ? scaled : totalTokens;
          })();
          const probeOut = await quoteSellTon(
            client,
            execDex,
            poolAddress,
            probeTokens.toString(),
            p.jetton_master,
          );
          if (probeOut != null) {
            const scale = Number(totalTokens) / Number(probeTokens);
            markValueTon = probeOut * (Number.isFinite(scale) && scale > 0 ? scale : 1);
          }
        }

        let pnl: number | null =
          markValueTon != null && costBasis > 0
            ? ((markValueTon - costBasis) / costBasis) * 100
            : null;
        let curTon: number = markValueTon ?? p.current_price_ton ?? p.entry_price_ton;
        let curUsd: number | undefined;

        // ── USD fallback when the pool cannot be quoted ───────────────────
        if (pnl == null) {
          const meta = await getJetton(p.jetton_master);
          curUsd = meta?.market_data?.price;
          if (curUsd != null && p.entry_price_usd && p.entry_price_usd > 0) {
            pnl = ((curUsd - p.entry_price_usd) / p.entry_price_usd) * 100;
            curTon = (1 + pnl / 100) * p.entry_price_ton;
          }
        }

        if (pnl == null) {
          // A position we can neither quote nor price is TRAPPED. The old code
          // `continue`d silently, so an untradeable position produced no log,
          // no journal entry and no alert — forever. Escalate instead.
          const fails = (quoteFailures.get(p.id) ?? 0) + 1;
          quoteFailures.set(p.id, fails);
          if (fails === TRAPPED_QUOTE_FAILURES || fails % 30 === 0) {
            log.err(
              "MGR",
              `[${tier.toUpperCase()}] ${p.symbol ?? p.jetton_master.slice(0, 8)} UNQUOTABLE for ${fails} consecutive ticks — position may be trapped (pool=${poolAddress?.slice(0, 8) ?? "unresolved"}). Cannot price, cannot exit.`,
            );
            journalTick(p.id, "unquotable", {
              consecutive_failures: fails,
              pool: poolAddress,
              dex: execDex,
            });
          }
          continue;
        }
        quoteFailures.delete(p.id);

        // ── Trend monitoring (operator directive 2026-08-09) ─────────────
        // Winners ride the trend with no TP/trailing targets; a CONFIRMED
        // downtrend flip is the close signal. The series is derived from pnl
        // (per-token price) so it stays continuous across a legacy TP1
        // partial, which halves the position VALUE in one tick.
        const trend: TrendSignal = CONFIG.strategy.trendExitEnabled
          ? trendTracker.observe(
              p.id,
              p.entry_price_ton > 0 ? p.entry_price_ton * (1 + pnl / 100) : curTon,
              p.entry_price_ton,
            )
          : trendDisabled;

        // ── Volatility- & structure-adaptive facts (Phase 4.5) ─────────────
        // Computed on the SAME normalized price basis as the engine
        // (entry=1.0, mark = 1 + pnl/100), so the structure-stop level is
        // directly comparable to `currentPriceUsd`. The trend tracker's series
        // is `entry_price_ton * (1 + pnl/100)`, so dividing by the entry price
        // recovers the normalized mark exactly. Absent facts → engine behaves
        // exactly as pre-4.5. The per-position window is the tracker's ring
        // buffer (`closes()`), always ≥ slow-EMA warm-up in length — the exact
        // pool the ATR proxy is defined over.
        let volatilityCtx: ExitPolicyContext["volatility"] = null;
        let structureStopCtx: ExitPolicyContext["structureStop"] = null;
        let stopConfirmTicksCtx: number | undefined = undefined;
        if (CONFIG.strategy.volatilityRegimeEnabled && p.entry_price_ton > 0) {
          const closes = trendTracker.closes(p.id);
          const normCloses = closes.map((c) => c / p.entry_price_ton);
          const normHw =
            trendTracker.highWaterClose(p.id) != null
              ? (trendTracker.highWaterClose(p.id) as number) / p.entry_price_ton
              : null;
          const atr = atrClose(normCloses, CONFIG.strategy.volatilityLookback);
          let rc = regimeClassifiers.get(p.id);
          if (!rc) {
            rc = makeRegimeClassifier();
            regimeClassifiers.set(p.id, rc);
          }
          const regime = rc.observe(normCloses);
          volatilityCtx = {
            atrCloseTon: Number.isFinite(atr) ? atr : null,
            regime,
            realizedVol: Number.isFinite(atr) ? realizedVol(normCloses) : null,
          };
          if (normHw != null && Number.isFinite(atr) && atr > 0) {
            const level = structureStopLevel(
              normHw,
              1, // entry baseline on the normalized scale
              atr,
              CONFIG.strategy.stopAtrMult,
              cfg.stopLossPct, // clamp floor = the configured hard % line
            );
            if (level != null && Number.isFinite(level)) {
              const mark = 1 + pnl / 100;
              const streak = mark <= level ? (structureBreakStreaks.get(p.id) ?? 0) + 1 : 0;
              structureBreakStreaks.set(p.id, streak);
              structureStopCtx = { levelTon: level, confirmedTicks: streak };
            }
          } else {
            structureBreakStreaks.set(p.id, 0);
          }
          stopConfirmTicksCtx = CONFIG.strategy.stopConfirmTicks;
        }

        // ── Feed corroboration gate (operator directive 2026-08-09) ──────────
        // A CONFIRMED trend flip must be corroborated by live feeds before it
        // can close a position. Fail-closed: any feed error / missing data →
        // gate = false → hold. Gate is configurable via sniper.trendExitConfirmEnabled.
        let feedConfirmed = 0;
        let trendSignal: { bearish: boolean; confirmations?: number; reason?: string } | null = null;
        if (trend.confirmed && CONFIG.sniper?.trendExitConfirmEnabled) {
          // Capture holders baseline on first confirmed trend tick
          if (!holdersBaseline.has(p.id)) {
            const baseline = await fetchHoldersTotal(p.jetton_master);
            if (baseline != null && baseline > 0) {
              holdersBaseline.set(p.id, baseline);
            }
          }
          const baseline = holdersBaseline.get(p.id);
          const holdersNow = await fetchHoldersTotal(p.jetton_master);
          const holdersDeltaPct =
            baseline != null && holdersNow != null && baseline > 0
              ? ((holdersNow - baseline) / baseline) * 100
              : NaN;

          // Trader participation (DeDust only — STON.fi has no public trades feed)
          let sellTraders24h = 0;
          let buyTraders24h = 0;
          if (execDex === "dedust" && poolAddress) {
            const trades = await fetchTradesWindow(poolAddress);
            if (trades.ok) {
              sellTraders24h = trades.sellTraders24h;
              buyTraders24h = trades.buyTraders24h;
            }
          }

          const gate = confirmedByFeeds({
            sellTraders24h,
            buyTraders24h,
            holdersDeltaPct,
          });
          feedConfirmed = gate ? 1 : 0;
          if (gate) {
            trendSignal = {
              bearish: true,
              confirmations: trend.confirmations,
              reason: trend.reason,
            };
          }
        } else if (trend.confirmed) {
          // Gate disabled — trend flip alone is sufficient (operator override)
          trendSignal = {
            bearish: true,
            confirmations: trend.confirmations,
            reason: trend.reason,
          };
          feedConfirmed = 1;
        }

        log.debug(
          "MGR",
          `[${tier.toUpperCase()}] ${p.symbol ?? "?"} pnl=${pnl.toFixed(1)}% (mark)`,
        );

        // ── Push price/pnl update + UI ────────────────────────────────────
        const updatedPos = {
          ...p,
          current_price_ton: curTon,
          pnl_pct: pnl,
          trend_bearish: trend.bearish ? 1 : 0,
          trend_confirmations: trend.confirmations,
          trend_observations: trend.observations,
          trend_reason: trend.reason ?? null,
          trend_updated_at: Date.now(),
          feed_confirmed: feedConfirmed,
        };
        positionsStore.upsert(updatedPos);
        await pushWebhook("position_update", tier, {
          ...updatedPos,
          trend_bearish: updatedPos.trend_bearish,
          trend_confirmations: updatedPos.trend_confirmations,
          trend_reason: updatedPos.trend_reason,
          feed_confirmed: updatedPos.feed_confirmed,
        });

        // ── Audit verdict (cached) + rug detection by measured DELTA ──────
        const auditVerdict = await resolveAuditVerdict(
          p.jetton_master,
          poolAddress ?? undefined,
          pnl,
        );

        const currentSnapshot: AuditSnapshot | null = auditVerdict
          ? {
              honeypotSafe: auditVerdict.honeypotSafe,
              lpLocked: auditVerdict.lpLocked,
              lpState: auditVerdict.lpState,
              renounced: auditVerdict.renounced,
            }
          : null;
        if (currentSnapshot && !auditBaselines.has(p.jetton_master)) {
          auditBaselines.set(p.jetton_master, currentSnapshot);
        }

        const depth = exitValueTracker.observe(p.id, markValueTon);
        const rugSignal = detectRug({
          baselineAudit: auditBaselines.get(p.jetton_master) ?? null,
          currentAudit: currentSnapshot,
          peakLiquidityTon: depth.peakTon,
          currentLiquidityTon: depth.currentTon,
        });

        // ── Stop loss made reachable for THIS position's economics ────────
        // A stop tighter than the round-trip cost fires on the spread itself;
        // one far below it can never be honoured. Deriving it from the
        // position size keeps the threshold self-consistent at any size.
        const effCfg = {
          ...cfg,
          stopLossPct: effectiveStopLossPct({
            configuredStopPct: cfg.stopLossPct,
            positionTon: costBasis,
          }),
        };

        // ── Pure exit-policy evaluation ───────────────────────────────────
        // Normalised price basis of 1.0 so the ratio is exact regardless of
        // whether entry_price_usd was ever recorded. CLAMPED ABOVE ZERO: the
        // engine bails on `currentPriceUsd <= 0`, so a position at <= -100%
        // would otherwise never exit at all.
        const ctx: ExitPolicyContext = {
          now: Date.now(),
          currentPriceUsd: Math.max(1e-9, 1 + pnl / 100),
          entryPriceUsd: 1,
          tierCfg: effCfg,
          auditVerdict,
          rugSignal,
          trendSignal,
          maxHoldMs: p.max_hold_ms ?? null,
          // ── Phase 4.5 volatility facts (absent → engine = pre-4.5) ──────
          // The engine's SPIKED gate re-checks the tracker's live
          // `confirmations` counter against the raised threshold, so feeding
          // trendSignal only after `confirmed` is correct — the extra-cost
          // delay is applied at the engine, not the tracker.
          volatility: volatilityCtx,
          structureStop: structureStopCtx,
          stopConfirmTicks: stopConfirmTicksCtx,
          trendConfirmTicks: CONFIG.strategy.trendExitConfirmTicks,
          trendExitSpikedExtraTicks: CONFIG.strategy.trendExitSpikedExtraTicks,
        };
        const decision = evaluateExitPolicy(
          {
            status: p.status,
            entry_at: p.entry_at,
            entry_price_usd: 1,
            exit_by_ms: p.exit_by_ms ?? null,
          },
          ctx,
        );

        // ── Journal FIRST (before any swap) ───────────────────────────────
        journalTick(p.id, decision ? decision.trigger : "skip", {
          reason: decision?.reason ?? "no trigger",
          pnl,
          mark_value_ton: markValueTon,
          peak_value_ton: depth.peakTon,
          status: p.status,
          auditOk: auditVerdict?.ok ?? null,
          rugged: rugSignal.rugged,
          trend_bearish: trend.bearish,
          trend_confirmations: trend.confirmations,
          effective_stop_pct: effCfg.stopLossPct,
          // Phase 4.5: volatility/regime facts + structure-stop level
          atr_close_ton: volatilityCtx?.atrCloseTon ?? null,
          volatility_regime: volatilityCtx?.regime ?? null,
          realized_vol: volatilityCtx?.realizedVol ?? null,
          structure_stop_level_ton: structureStopCtx?.levelTon ?? null,
          structure_break_ticks: structureStopCtx?.confirmedTicks ?? 0,
          stop_confirm_ticks: stopConfirmTicksCtx ?? null,
          trend_confirm_ticks: CONFIG.strategy.trendExitConfirmTicks,
          spiked_extra_ticks: CONFIG.strategy.trendExitSpikedExtraTicks,
        });

        if (!decision) continue;

        log.trade(
          "MGR",
          `[${tier.toUpperCase()}] ${decision.trigger} for ${p.symbol} at ${pnl.toFixed(1)}% — ${decision.reason}`,
        );

        // ── Size the sell ─────────────────────────────────────────────────
        // 2026-08-09: every trigger is a FULL close — no TP1 partials remain.
        const sellTokens = p.amount_tokens;
        const costBasisPortion = costBasis;

        // ── PHANTOM-BALANCE GUARD ─────────────────────────────────────────
        // 2026-08-12: stale legacy rows can hold `amount_tokens` for jettons
        // the wallet no longer owns (sold/rugged/reconciled on-chain, DB not
        // updated). Selling requests a transfer of more than the real balance,
        // the DeDust child swap bounces (exit 706) and the monitor retries the
        // phantom sell every tick — a gas-burning retry storm. If the wallet
        // truly holds zero of the master, there is nothing to recover: close
        // the row STOPPED and stop retrying. A null read (RPC failure) is
        // treated as "keep trying" (fail closed — do not book a false close).
        const tierHandle = isCoordinatorStarted()
          ? getCoordinator().getTierHandle(tier)?.address
          : undefined;
        if (tierHandle) {
          let walletBalance: bigint | null = null;
          try {
            walletBalance = await readUserJettonBalance(
              client,
              Address.parse(p.jetton_master),
              Address.parse(tierHandle),
            );
          } catch (e: any) {
            log.warn("MGR", `[${tier.toUpperCase()}] balance read failed for ${p.id}: ${e.message}`);
          }
          if (walletBalance !== null && walletBalance <= 0n) {
            log.warn(
              "MGR",
              `[${tier.toUpperCase()}] ${decision.trigger} for ${p.symbol || p.jetton_master.slice(0, 8)}: wallet holds 0 ${p.symbol || "jettons"} on-chain — phantom position, closing STOPPED without sell`,
            );
            positionsStore.upsert({
              ...p,
              status: "STOPPED",
              close_at: Date.now(),
              close_tx: "reconcile_phantom_20260812",
              current_price_ton: curTon,
            });
            forgetPosition(p.id, p.jetton_master);
            continue;
          }
        }

        // ── ACCOUNTING quote: real full-size output for the sold portion ──
        // The mark is deliberately impact-free for DECIDING; realized PnL must
        // use what we will actually receive, impact included.
        const quotedOutTon = poolAddress
          ? await quoteSellTon(
              client,
              execDex,
              poolAddress,
              sellTokens,
              p.jetton_master,
            )
          : null;
        const grossOutTon =
          quotedOutTon ?? costBasisPortion * (1 + pnl / 100);

        const swapReq = {
          jettonMaster: p.jetton_master,
          amountTon: 0.1, // unused for sell
          side: "sell" as const,
          jettonAmountNano: sellTokens,
          minOutJettonNano: "0",
        };

        // ── LIVE EXIT: coordinator is the ONLY standard path ─────────────────
        // Plan §3.2: coordinator unavailability must return a blocked result,
        // journal exit_blocked_coordinator_unavailable, alert/log, and leave
        // the position OPEN for retry. Do NOT fall back to executeSwap directly.
        // A direct fallback bypasses all coordinator gates (serialization, wallet
        // exclusion, kill-switch re-check) and can race with sniper or concurrent
        // sends on the same wallet.
        //
        // If a future operator-gated emergency path is needed, it must use a
        // distinct wallet, fire an audit event, and have its own tests.
        if (!isCoordinatorStarted()) {
          const blockedReason = "coordinator not started — exit blocked; leaving OPEN for retry";
          log.err(
            "MGR",
            `[${tier.toUpperCase()}] EXIT BLOCKED: ${blockedReason} (position=${p.id})`,
          );
          journalTick(p.id, "exit_blocked_coordinator_unavailable", {
            reason: blockedReason,
            trigger: decision.trigger,
            pnl,
          });
          continue; // leave OPEN
        }

        const res = await getCoordinator().executeForTier(tier, swapReq, execDex, {
          isExit: true,
        });

        if (!res.ok) {
          // Swap failed — leave the position OPEN so a later tick can retry.
          // The journal already recorded the fire attempt.
          log.warn(
            "MGR",
            `${decision.trigger} sell failed for ${p.id}; leaving OPEN for retry`,
          );
          continue;
        }

        // ── Gas, charged once per leg and never double-booked ─────────────
        // Entry gas was never booked at buy time, so the FIRST exit absorbs
        // it. A position past TP1 has already paid it and owes only the sell.
        const entryGasAlreadyBooked =
          p.status === "TP1_HIT" || p.take_profit_t1_tx != null;
        const gasTon = exitGasTon({ entryGasAlreadyBooked });

        // THE FIX THAT MATTERS: gas is part of the result.
        const realizedPnl = computeRealizedPnlTon({
          grossOutTon,
          costBasisTon: costBasisPortion,
          gasTon,
        });
        // Report NET percent so the dashboard and the HIGH-tier promotion gate
        // see the same truth the wallet does. (apps/web recomputes realized as
        // pnl_pct/100 * cost_basis_ton, so this corrects the web view too.)
        const netPnlPct =
          costBasisPortion > 0 ? (realizedPnl / costBasisPortion) * 100 : pnl;

        log.info(
          "MGR",
          `[${tier.toUpperCase()}] ${decision.trigger} booked: gross=${grossOutTon.toFixed(4)} basis=${costBasisPortion.toFixed(4)} gas=${gasTon.toFixed(4)} → net=${realizedPnl.toFixed(4)} TON (${netPnlPct.toFixed(1)}%)`,
        );

        let row: any;

        if (decision.trigger === "emergency_exit") {
          // Rug exit: full sell, terminal RUG_EXIT, sticky rugged flags.
          row = {
            ...p,
            status: "RUG_EXIT",
            close_at: Date.now(),
            close_tx: res.txHash ?? null,
            pnl_pct: netPnlPct,
            current_price_ton: curTon,
            realized_pnl_ton: (p.realized_pnl_ton || 0) + realizedPnl,
            gas_ton: (p.gas_ton || 0) + gasTon,
            rugged: 1,
            rugged_at: Date.now(),
            emergency_exit: 1,
          };
        } else {
          // stop_loss + trend_exit + time_exit: full close.
          row = {
            ...p,
            status: decision.nextStatus, // "STOPPED" or "CLOSED"
            close_at: Date.now(),
            close_tx: res.txHash ?? null,
            pnl_pct: netPnlPct,
            current_price_ton: curTon,
            realized_pnl_ton: (p.realized_pnl_ton || 0) + realizedPnl,
            gas_ton: (p.gas_ton || 0) + gasTon,
          };
        }

        positionsStore.upsert(row);
        dailyPnlStore.addPnl(realizedPnl);
        await pushWebhook("position_update", tier, row);

        recordSellTx({
          txHash: res.txHash,
          walletAddress: isCoordinatorStarted()
            ? getCoordinator().getTierHandle(tier)?.address
            : undefined,
          master: p.jetton_master,
          tokensSoldNano: sellTokens,
          grossOutTon,
          gasTon,
        });

        // Every exit is terminal now (no TP1_HIT partials remain) — drop
        // per-position trend/rug/audit state so a re-entry starts fresh.
        forgetPosition(p.id, p.jetton_master);
      } catch (e: any) {
        // One bad position never kills the loop.
        log.err(
          "MGR",
          `Monitor error for ${p.symbol || p.jetton_master.slice(0, 8)}: ${e.message}`,
        );
      }
    }
    } finally {
      // Release the overlap guard no matter how the tick ended.
      monitorTickInFlight = false;
    }
  }, CONFIG.strategy.monitorIntervalMs);
}
