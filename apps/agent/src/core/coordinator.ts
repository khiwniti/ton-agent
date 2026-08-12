/**
 * Tier Coordinator — central orchestrator managing all 3 wallet tiers (LOW/MID/HIGH).
 *
 * Responsibilities:
 *  • Initialize a derived hot-wallet for each enabled tier (LOW + MID always,
 *    HIGH only when promotion criteria are satisfied).
 *  • Push per-tier status rows to the SQLite tier_status table.
 *  • Poll the kill-switch endpoint (configurable URL) every KILL_SWITCH_INTERVAL_MS.
 *  • Poll per-tier metrics for the dashboard.
 *  • Expose a `isTradeAllowed(tier)` gate that combines: kill-switch state,
 *    circuit breaker (daily loss limit), and bankroll sufficiency.
 *  • Expose `executeForTier()` helper used by the brain to route a swap through
 *    the correct tier wallet. HIGH tier requires unlocked status.
 *
 * Long-lived process. Booted once from index.ts and shares its lifecycle.
 */
import axios from "axios";
import { fromNano, toNano, TonClient, Address } from "@ton/ton";
import { CONFIG, isTestnet } from "../config";
import { log } from "../logger";
import { resolvePool, type PoolResolutionResult } from "../security/pool-resolver";
import {
  loadKeyPair,
  loadKeyPairForTier,
  makeClient,
  openWallet,
  type KeyPair,
} from "../wallet/wallet";
import { executeSwap, getSwapQuote, type Dex, type SwapRequest, type SwapResult } from "../dex/router";
import {
  positionsStore,
  statusStore,
  dailyPnlStore,
  tradeTransactionStore,
  decisionJournalStore,
  DbTradeTransaction,
} from "../storage/store";
import {
  checkCircuitBreaker,
  isHighTierUnlocked,
  TIER_RISK_CONFIGS,
  DAILY_LOSS_LIMIT_TON,
  checkPortfolioAllocation,
  getTierSlippageCeilingBps,
} from "../risk/guardrails";
import { computeMinOut } from "../dex/router";
import {
  authorizeTicket,
  buildCapContext,
  consumeAuthorization,
  hashTradeTicket,
  verifyCapBinding,
  type CapCheckResult,
  type RiskAssessment,
  type TradeTicket,
} from "../safetycaps";
import { postEnvelope } from "../webhook";
import { newId } from "@ton-agent/shared";

// Pure-types + gate evaluator live in `gate.ts` (no side effects).
// The live coordinator carries runtime-only fields (kp/address) on top
// of the pure `TierHandle`. Avoid re-exporting `TierHandle` from `gate.ts`
// and then redeclaring it in the same module — TS2484.
import {
  evaluateTradeGate,
  ALL_TIERS,
  type Tier as PureTier,
  type TierHandle as PureTierHandle,
  type TradeGateInput,
} from "./gate";


import { FastPathSignal, TradingPolicy } from "./policy-types";
import { policyManager } from "./policy-manager";
import { fastPathEngine } from "./fastpath-engine";
import { DirectLiteClient } from "./direct-lite-client";
// Re-export the pure enum/identifier + gate evaluator with stable names.
export type Tier = PureTier;
export { ALL_TIERS, evaluateTradeGate };
export type { TradeGateInput };

// Market data imports
import { poolMonitorService } from "../market";
import { type PoolState } from "../market/data-cache";
// ML imports
import { PredictionService } from "../ml/prediction-service";
import { FeatureEngine } from "../ml/features";
import { RetrainingScheduler } from "../ml/retraining-scheduler";
import { ModelTrainer } from "../ml/training";

// Extended TierHandle used by the live coordinator (carries kp/address).
export interface TierHandle extends PureTierHandle {
  kp: KeyPair;
  address: string;
}

const KILL_SWITCH_INTERVAL_MS = Number(process.env.KILL_SWITCH_INTERVAL_MS || 30_000);
const STATUS_REPORT_INTERVAL_MS = Number(process.env.TIER_STATUS_INTERVAL_MS || 15_000);
const PROMOTION_CHECK_INTERVAL_MS = Number(process.env.PROMOTION_CHECK_INTERVAL_MS || 30_000);
// Grace window: keep trading through transient kill-switch poll failures, but if
// the endpoint stays unreachable for this many CONSECUTIVE polls, fail SAFE by
// auto-activating the kill-switch. Prevents an attacker (or an outage) from
// silently defeating the emergency brake by simply blocking the endpoint.
const KILL_SWITCH_MAX_MISSES = Number(process.env.KILL_SWITCH_MAX_MISSES || 3);

interface CoordinatorState {
  killSwitchActive: boolean;
  killSwitchReason?: string;
  /** Whether the current active state was self-imposed by the grace window
   *  (as opposed to reported by the remote endpoint). Lets us auto-lift it
   *  the moment the endpoint becomes reachable again. */
  killSwitchAutoTripped: boolean;
  /** Consecutive failed kill-switch polls since the last successful one. */
  killSwitchMisses: number;
  startedAt: number;
  lastPromotionCheck: number;
  highUnlockedSnapshot: boolean;
    mlServicesInitialized: boolean;
}

class TierCoordinator {
  private client: TonClient;
  private tiers: Record<Tier, TierHandle> = {} as any;
  public state: CoordinatorState = {
    killSwitchActive: false,
    killSwitchAutoTripped: false,
    killSwitchMisses: 0,
    startedAt: Date.now(),
    lastPromotionCheck: 0,
    highUnlockedSnapshot: false,
    mlServicesInitialized: false,
  };
  public directLiteClient: DirectLiteClient | null = null;
  public poolMonitor: typeof poolMonitorService = poolMonitorService;
  public predictionService: PredictionService | null = null;
  public featureEngine: FeatureEngine | null = null;
  public retrainingScheduler: RetrainingScheduler | null = null;

  constructor(client: TonClient) {
    this.client = client;
   
    // Initialize DirectLiteClient for data ingestion if feature flag is enabled
    if (CONFIG.liteClientEnabled) {
      this.directLiteClient = new DirectLiteClient(
        process.env.DIRECT_LITE_ADNL_ENDPOINT || "toncenter.com",
        process.env.DIRECT_LITE_HTTP_ENDPOINT || "https://toncenter.com/api/v2/jsonRPC",
        Number(process.env.DIRECT_LITE_TIMEOUT_MS) || 1000,
        Number(process.env.DIRECT_LITE_MAX_RETRIES) || 3
      );
      log.info("COORD", "DirectLiteClient initialized for data ingestion");
    } else {
      this.directLiteClient = null;
    }
    // Initialize market data services
    this.initializeMarketData();
    // Initialize ML services if enabled
    this.initializeMLServices();
  }


  // Initialize market data services
  private initializeMarketData(): void {
    this.poolMonitor = poolMonitorService;
    log.info("COORD", "Market data services initialized");
  }

  // Initialize ML services
  private initializeMLServices(): void {
    if (!CONFIG.mlEnabled) {
      log.info("COORD", "ML services disabled via configuration");
      this.state.mlServicesInitialized = false;
      return;
    }

    try {
      this.predictionService = new PredictionService(
        CONFIG.mlConfidenceThreshold,
        CONFIG.mlCacheTTLSeconds
      );
      this.featureEngine = new FeatureEngine(100); // Keep 100 candles for feature calculation
      const modelTrainer = new ModelTrainer();
      this.retrainingScheduler = new RetrainingScheduler(
        modelTrainer,
        this.predictionService,
        CONFIG.mlRetrainingIntervalHours
      );

      // Start the retraining scheduler
      this.retrainingScheduler.start();

      log.info("COORD", "ML services initialized successfully");
      this.state.mlServicesInitialized = true;
    } catch (error) {
      log.warn("COORD", `Failed to initialize ML services: ${error instanceof Error ? error.message : String(error)}`);
      this.predictionService = null;
      this.featureEngine = null;
      this.retrainingScheduler = null;
    this.state.mlServicesInitialized = false;
    }
  }
  // ─────────────────────────────────────────────────────────────────
  // 1. INIT — derive keys + wallets for all tiers
  // ─────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    const enabledTiers = ALL_TIERS.filter((t) => CONFIG.tierEnabled[t]);
    const disabledTiers = ALL_TIERS.filter((t) => !CONFIG.tierEnabled[t]);
    log.banner("TIER COORDINATOR", `bootstrap tiers=${enabledTiers.map((t) => t.toUpperCase()).join("/")} disabled=${disabledTiers.map((t) => t.toUpperCase()).join("/") || "none"} network=${CONFIG.network}`);

    // HIGH: only enabled if promotion criteria are met, but we always initialize
    // it so a single boot has the wallet hot for prompt promotion.
    const highUnlocked = isHighTierUnlocked();
    this.state.highUnlockedSnapshot = highUnlocked;

    for (const tier of enabledTiers) {
      try {
        // LOW tier uses the legacy (non-HD) mnemonic path — same as Tonkeeper/MyTonWallet.
        // MID/HIGH use HD derivation with per-tier indices (2, 3) for sub-wallets.
        const kp = tier === "low" ? await loadKeyPair() : await loadKeyPairForTier(tier);
        const wallet = openWallet(this.client, kp);
        const balanceNano = await wallet.getBalance();
        const balanceTon = Number(fromNano(balanceNano));
        const address = wallet.address.toString({ bounceable: false });

        const handle: TierHandle = {
          tier,
          kp,
          address,
          balanceTon,
          config: TIER_RISK_CONFIGS[tier],
          unlocked: tier === "high" ? highUnlocked : true,
          startedAt: Date.now(),
          openPositions: positionsStore.listOpenByTier(tier).length,
          closedTrades: positionsStore.countClosedForTier(tier),
          totalPnlTon: 0,
          dailyPnlTon: dailyPnlStore.getTodayPnl(),
        };

        this.tiers[tier] = handle;

        // Initial tier_status row in DB
        statusStore.upsert({
          tier,
          status: tier === "high" && !highUnlocked ? "paused" : "running",
          wallet_address: address,
          started_at: handle.startedAt,
          bankroll_ton: balanceTon,
          open_positions: handle.openPositions,
          closed_trades: handle.closedTrades,
          total_pnl_ton: 0,
          realized_pnl_ton: 0,
          daily_pnl_ton: handle.dailyPnlTon,
          uptime_sec: 0,
          updated_at: Date.now(),
        });

        log.ok(
          "COORD",
          `[${tier.toUpperCase()}] addr=${address} bal=${balanceTon.toFixed(3)} TON ` +
            `status=${handle.unlocked ? "READY" : "LOCKED"} ` +
            `max=${handle.config.maxPositionTon}TON stop=${handle.config.stopLossPct}%`,
        );
      } catch (e: any) {
        log.err("COORD", `[${tier.toUpperCase()}] init failed: ${e.message}`);
        // Continue: missing tier should not kill the whole agent.
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. Trade gate — combines kill-switch, circuit breaker, bankroll
  // ─────────────────────────────────────────────────────────────────
  isTradeAllowed(tier: Tier, requestedTon: number): { allowed: boolean; reason?: string } {
    const handle = this.tiers[tier];
    const dailyPnl = dailyPnlStore.getTodayPnl();
    return evaluateTradeGate({
      tier,
      requestedTon,
      killSwitchActive: this.state.killSwitchActive,
      killSwitchReason: this.state.killSwitchReason,
      handle,
      dailyPnl,
      circuitBreakerOk: dailyPnl > -DAILY_LOSS_LIMIT_TON,
      observeOnly: CONFIG.observeOnly,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. Centralized swap execution — used by the brain
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build a TradeTicket from a swap request + optional risk fields.
   * Tickets are proposals only until SafetyCaps greenlights them.
   */
  buildTradeTicket(
    tier: Tier,
    p: SwapRequest,
    opts?: {
      cycleId?: string;
      risk?: RiskAssessment | null;
      slippagePct?: number;
      poolTvlTon?: number;
      aiScore?: number;
    },
  ): TradeTicket {
    return {
      cycle_id: opts?.cycleId ?? newId("cycle"),
      tier,
      side: p.side,
      jetton_master: p.jettonMaster,
      amount_ton: p.amountTon,
      risk: opts?.risk ?? null,
      slippage_pct: opts?.slippagePct,
      pool_tvl_ton: opts?.poolTvlTon,
      ai_score: opts?.aiScore,
    };
  }

  /**
   * Run SafetyCaps against a ticket for the live tier snapshot and journal it.
   * On success, registers a single-use authorization in the in-process registry.
   */
  authorizeForTier(
    tier: Tier,
    ticket: TradeTicket,
  ): CapCheckResult {
    const handle = this.tiers[tier];
    const dailyPnl = dailyPnlStore.getTodayPnl();
    const ctx = buildCapContext({
      tier,
      balanceTon: handle?.balanceTon ?? 0,
      openPositions: handle?.openPositions ?? 0,
      unlocked: handle?.unlocked ?? tier !== "high",
      killSwitchActive: this.state.killSwitchActive,
      killSwitchReason: this.state.killSwitchReason,
      circuitBreakerOk: dailyPnl > -DAILY_LOSS_LIMIT_TON,
      observeOnly: CONFIG.observeOnly,
      dailyPnlTon: dailyPnl,
    });
    const cap = authorizeTicket(ticket, ctx);
    decisionJournalStore.append({
      cycle_id: ticket.cycle_id,
      agent: "safetycaps",
      input_hash: cap.ticket_hash,
      cap_check_result: cap,
      final_action: cap.ok ? "cap_ok" : "cap_denied",
      output: { failures: cap.failures },
    });
    return cap;
  }

  async executeForTier(
    tier: Tier,
    p: SwapRequest,
    dex: Dex = CONFIG.strategy.preferredDex,
    auth?: {
      /** Pre-issued ticket_hash from authorizeForTier / authorizeTicket. */
      ticketHash?: string;
      /** Full ticket if already built (must match swap request intent). */
      ticket?: TradeTicket;
      /** Optional risk assessment folded into ticket when building one. */
      risk?: RiskAssessment | null;
      cycleId?: string;
      /** When true, skip single-use consume (pipeline internal re-entry). */
      skipConsume?: boolean;
      poolTvlTon?: number;
      slippagePct?: number;
      aiScore?: number;
      /** When true, this swap is an exit sell routed through the coordinator for
       *  cap-hash auth + minOut enforcement (US2). */
      isExit?: boolean;
    },
  ): Promise<{
    ok: boolean;
    dex: Dex;
    error?: string;
    txHash?: string;
    amountTokens?: string;
    cap?: CapCheckResult;
    cycle_id?: string;
  }> {
    const handle = this.tiers[tier];
    if (!handle) {
      return { ok: false, dex, error: `tier ${tier} not initialized` };
    }

    const ticket =
      auth?.ticket ??
      this.buildTradeTicket(tier, p, {
        cycleId: auth?.cycleId,
        risk: auth?.risk,
        poolTvlTon: auth?.poolTvlTon,
        slippagePct: auth?.slippagePct,
        aiScore: auth?.aiScore,
      });

    // Intent must match the ticket economic fields.
    if (
      ticket.tier !== tier ||
      ticket.side !== p.side ||
      ticket.jetton_master !== p.jettonMaster ||
      Number(ticket.amount_ton.toFixed(9)) !== Number(p.amountTon.toFixed(9))
    ) {
      const msg = "ticket does not match swap request intent";
      log.warn("COORD", `[${tier.toUpperCase()}] ${msg}`);
      decisionJournalStore.append({
        cycle_id: ticket.cycle_id,
        agent: "coordinator",
        input_hash: hashTradeTicket(ticket),
        final_action: "execute_denied_ticket_mismatch",
        output: { error: msg },
      });
      return { ok: false, dex, error: msg, cycle_id: ticket.cycle_id };
    }

    let cap: CapCheckResult | undefined;

    // Prefer consuming a pre-issued authorization (LLM presents ticket_hash only —
    // never trust a model-authored CapCheckResult JSON blob).
    if (auth?.ticketHash && !auth.skipConsume) {
      const issued = consumeAuthorization(auth.ticketHash);
      if (issued) {
        const bind = verifyCapBinding(ticket, issued);
        if (!bind.allowed) {
          log.warn("COORD", `[${tier.toUpperCase()}] auth bind failed: ${bind.reason}`);
          decisionJournalStore.append({
            cycle_id: ticket.cycle_id,
            agent: "coordinator",
            input_hash: issued.ticket_hash,
            cap_check_result: issued,
            final_action: "execute_denied_bind",
            output: { error: bind.reason },
          });
          return {
            ok: false,
            dex,
            error: bind.reason,
            cap: issued,
            cycle_id: ticket.cycle_id,
          };
        }
        cap = issued;
      } else {
        // Stale/unknown hash: re-run caps; only proceed if live hash matches claim.
        const live = this.authorizeForTier(tier, ticket);
        consumeAuthorization(live.ticket_hash);
        if (live.ticket_hash !== auth.ticketHash) {
          const msg = `ticket_hash mismatch: provided ${auth.ticketHash} != live ${live.ticket_hash}`;
          log.warn("COORD", `[${tier.toUpperCase()}] ${msg}`);
          decisionJournalStore.append({
            cycle_id: ticket.cycle_id,
            agent: "coordinator",
            input_hash: live.ticket_hash,
            cap_check_result: live,
            final_action: "execute_denied_hash_mismatch",
            output: { error: msg },
          });
          return { ok: false, dex, error: msg, cap: live, cycle_id: ticket.cycle_id };
        }
        cap = live;
      }
    }

    // No pre-auth: run SafetyCaps now (coordinator / pipeline path).
    if (!cap) {
      cap = this.authorizeForTier(tier, ticket);
      if (!auth?.skipConsume) {
        consumeAuthorization(cap.ticket_hash);
      }
    }

    if (!cap.ok) {
      const reason = cap.failures.map((f) => f.reason).join("; ") || "cap denied";
      log.warn("COORD", `[${tier.toUpperCase()}] SafetyCaps DENIED: ${reason}`);
      decisionJournalStore.append({
        cycle_id: ticket.cycle_id,
        agent: "coordinator",
        input_hash: cap.ticket_hash,
        cap_check_result: cap,
        final_action: "execute_denied_caps",
        output: { error: reason },
      });
      return { ok: false, dex, error: reason, cap, cycle_id: ticket.cycle_id };
    }

    // Route the swap on the DEX where the pool actually lives, not the
    // caller's preferred DEX. preferredDex defaults to stonfi, but
    // resolvePool returns DeDust when that's where the liquidity is —
    // opening a DeDust pool through the Ston.fi v1 router makes
    // getPoolData throw exit_code -13 and the trade dies with
    // cannot-enforce-slippage:no-quote. resolvePool is cached (24h) and
    // fail-soft, so an RPC hiccup here just keeps the caller's dex.
    let poolResolved: PoolResolutionResult | null = null;
    try {
      poolResolved = await resolvePool(this.client, Address.parse(p.jettonMaster));
    } catch {
      poolResolved = null;
    }
    const execDex: Dex =
      poolResolved && (poolResolved.source === "stonfi" || poolResolved.source === "dedust")
        ? poolResolved.source
        : dex;
    if (execDex !== dex) {
      log.info("COORD", `[${tier.toUpperCase()}] reroute: pool on ${poolResolved?.source} — executing via ${execDex} instead of ${dex}`);
    }

    log.trade(
      "COORD",
      `[${tier.toUpperCase()}] routing ${p.side} ${p.amountTon} TON jett=${p.jettonMaster.slice(0, 8)}… via ${execDex} hash=${cap.ticket_hash.slice(0, 8)}`,
    );

    decisionJournalStore.append({
      cycle_id: ticket.cycle_id,
      agent: "coordinator",
      input_hash: cap.ticket_hash,
      cap_check_result: cap,
      final_action: auth?.isExit ? "execute_submit_exit" : "execute_submit",
      output: { dex: execDex, side: p.side, amountTon: p.amountTon, isExit: auth?.isExit ?? false },
    });

    // ── Slippage enforcement (US1) ──────────────────────────────
    // Fetch a live quote, compute minOut from tier ceiling,
    // and reject if the implied slippage exceeds the tier's ceiling.
    const ceilingBps = getTierSlippageCeilingBps(tier);
    if (ceilingBps != null) {
      const jettonAmountIn = p.side === "buy"
        ? toNano(p.amountTon.toString()).toString()
        : p.jettonAmountNano;
      if (!jettonAmountIn) {
        log.warn("COORD", `[${tier.toUpperCase()}] cannot compute slippage — no input amount for ${p.side}`);
      } else {
        try {
          if (!poolResolved?.poolAddress) {
            const reason = "cannot-enforce-slippage:no-pool";
            log.warn("COORD", `[${tier.toUpperCase()}] ${reason}`);
            decisionJournalStore.append({
              cycle_id: ticket.cycle_id,
              agent: "coordinator",
              input_hash: cap.ticket_hash,
              final_action: reason,
              output: { dex: execDex, side: p.side, amountTon: p.amountTon },
            });
            return { ok: false, dex: execDex, error: reason, cap, cycle_id: ticket.cycle_id };
          }
          // Buy-side liquidity floor on the FRESH on-chain resolve. The
          // scanner's scoring gate may have been fed optimistic feed liquidity
          // (enrichCandidate trusts TONAPI's pool/liquidity when present), so
          // re-assert the same floor here against the authoritative resolve
          // BEFORE paying for a quote. A drained pool measures positive TON
          // depth but quotes zero output — reject it with a clear reason
          // instead of the misleading cannot-enforce-slippage:no-quote.
          // Sells must never be blocked by a depth floor (exits need the pool
          // regardless), mirroring checkPoolMinimum's buy-only gate.
          if (
            p.side === "buy" &&
            poolResolved.liquidityTon !== null &&
            poolResolved.liquidityTon < CONFIG.strategy.minLiquidityTon
          ) {
            const reason = "cannot-enforce-slippage:pool-liquidity-low";
            log.warn(
              "COORD",
              `[${tier.toUpperCase()}] ${reason} liq=${poolResolved.liquidityTon} floor=${CONFIG.strategy.minLiquidityTon} TON`,
            );
            decisionJournalStore.append({
              cycle_id: ticket.cycle_id,
              agent: "coordinator",
              input_hash: cap.ticket_hash,
              final_action: reason,
              output: { dex: execDex, side: p.side, amountTon: p.amountTon },
            });
            return { ok: false, dex: execDex, error: reason, cap, cycle_id: ticket.cycle_id };
          }
          const quote = await getSwapQuote(
            this.client,
            { dex: execDex, poolAddress: poolResolved.poolAddress },
            p.side,
            jettonAmountIn,
            p.jettonMaster,
          );
          if (!quote || !quote.available) {
            const reason = "cannot-enforce-slippage:no-quote";
            log.warn("COORD", `[${tier.toUpperCase()}] ${reason}`);
            decisionJournalStore.append({
              cycle_id: ticket.cycle_id,
              agent: "coordinator",
              input_hash: cap.ticket_hash,
              final_action: reason,
              output: { dex: execDex, side: p.side, amountTon: p.amountTon },
            });
            return { ok: false, dex: execDex, error: reason, cap, cycle_id: ticket.cycle_id };
          }

          const minOut = computeMinOut(quote.expectedOutNano, ceilingBps);
          p.minOutJettonNano = minOut;
          log.info("COORD", `[${tier.toUpperCase()}] slippage: quote=${quote.expectedOutNano} ceiling=${ceilingBps}bps minOut=${minOut}`);
        } catch (e: any) {
          const reason = `cannot-enforce-slippage:quote-error:${e.message ?? "unknown"}`;
          log.warn("COORD", `[${tier.toUpperCase()}] ${reason}`);
          decisionJournalStore.append({
            cycle_id: ticket.cycle_id,
            agent: "coordinator",
            input_hash: cap.ticket_hash,
            final_action: reason,
            output: { dex: execDex, side: p.side, amountTon: p.amountTon },
          });
          return { ok: false, dex: execDex, error: reason, cap, cycle_id: ticket.cycle_id };
        }
      }
    }

    const res = await executeSwap(this.client, p, tier, execDex);
    if (res.ok) {
      await this.refreshBalance(tier);
      decisionJournalStore.append({
        cycle_id: ticket.cycle_id,
        agent: "coordinator",
        input_hash: cap.ticket_hash,
        final_action: "execute_ok",
        output: { txHash: res.txHash, amountTokens: res.amountTokens },
      });
    } else {
      decisionJournalStore.append({
        cycle_id: ticket.cycle_id,
        agent: "coordinator",
        input_hash: cap.ticket_hash,
        final_action: "execute_failed",
        output: { error: res.error },
      });
    }
    return { ...res, cap, cycle_id: ticket.cycle_id };
  }

  /**
   * Process a signal via the FastPath engine, bypassing LLM reasoning but enforcing safety checks.
   * @param signal - The trading signal to process
   * @param tier - The tier to use for this trade
   * @returns Result indicating whether it was executed via FastPath
   */
  async processFastPathSignal(signal: FastPathSignal, tier: Tier = "low"): Promise<{
    executedViaFastPath: boolean;
    swapResult?: import("../dex/router").SwapResult;
    error?: string;
    fallbackToColdPath: boolean;
  }> {
    // Delegate to the FastPathEngine
    return fastPathEngine.processSignal(signal, tier);
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. Background loops: kill switch, promotion, status report
  // ─────────────────────────────────────────────────────────────────
  startBackgroundLoops(): void {
    log.info("COORD", `Starting background loops — kill-switch=${KILL_SWITCH_INTERVAL_MS}ms, status=${STATUS_REPORT_INTERVAL_MS}ms, promotion=${PROMOTION_CHECK_INTERVAL_MS}ms`);

    // Kill-switch polling (POST-friendly endpoint, env-configurable)
    setInterval(() => {
      this.pollKillSwitch().catch((e) =>
        log.err("COORD", `kill-switch poll failed: ${e.message}`),
      );
    }, KILL_SWITCH_INTERVAL_MS);

    // Tier status snapshot (bankroll + open positions)
    setInterval(() => {
      this.refreshAllAndReport().catch((e) =>
        log.err("COORD", `status refresh failed: ${e.message}`),
      );
    }, STATUS_REPORT_INTERVAL_MS);

    // Promotion check (HIGH tier unlock)
    setInterval(() => {
      this.checkPromotion().catch((e) =>
        log.err("COORD", `promotion check failed: ${e.message}`),
      );
    }, PROMOTION_CHECK_INTERVAL_MS);

    // Stale lock cleanup (release locks older than 5 minutes)
    setInterval(() => {
      try {
        tradeTransactionStore.releaseStaleLocks();
      } catch (e: any) {
        log.debug("COORD", `stale lock cleanup failed: ${e.message}`);
      }
    }, 60_000); // Run cleanup every minute
  }

  private async pollKillSwitch(): Promise<void> {
    const url = process.env.KILL_SWITCH_URL;
    if (!url) {
      // No kill-switch configured: ensure it's disabled and return.
      if (this.state.killSwitchActive) {
        log.ok("COORD", "Kill-switch cleared (no URL configured)");
        this.state.killSwitchActive = false;
        this.state.killSwitchReason = undefined;
        this.state.killSwitchAutoTripped = false;
      }
      this.state.killSwitchMisses = 0;
      return;
    }

    // Refuse to transmit the shared secret over cleartext HTTP to a remote host.
    // Sending X-Agent-Secret over plain http:// would leak it to any on-path
    // observer. localhost is exempt for local dev.
    if (!this.isSecureKillSwitchUrl(url)) {
      log.err(
        "COORD",
        `kill-switch URL is insecure (${url}) — refusing to send AGENT_SHARED_SECRET over cleartext. Use https:// or a localhost URL.`,
      );
      this.registerKillSwitchMiss("kill-switch URL rejected (insecure scheme)");
      return;
    }

    try {
      const r = await axios.get(url, {
        timeout: 5_000,
        headers: CONFIG.agentSharedSecret
          ? { "X-Agent-Secret": CONFIG.agentSharedSecret }
          : undefined,
      });
      // Successful reach: reset the miss counter and clear any auto-trip.
      this.state.killSwitchMisses = 0;

      const active = Boolean(r.data?.kill);
      const reason: string | undefined = r.data?.reason || undefined;
      if (active && !this.state.killSwitchActive) {
        log.err("COORD", `🛑 KILL-SWITCH ACTIVATED: ${reason ?? "no reason provided"}`);
        this.state.killSwitchActive = true;
        this.state.killSwitchReason = reason;
        this.state.killSwitchAutoTripped = false;
      } else if (!active && this.state.killSwitchActive) {
        // Only lift if the remote endpoint says it's clear. This also clears a
        // grace-window auto-trip, since we've now re-established contact.
        log.ok(
          "COORD",
          this.state.killSwitchAutoTripped
            ? "Kill-switch endpoint reachable again — auto-trip LIFTED, trading resumed"
            : "Kill-switch LIFTED — trading resumed",
        );
        this.state.killSwitchActive = false;
        this.state.killSwitchReason = undefined;
        this.state.killSwitchAutoTripped = false;
      }
    } catch (e: any) {
      log.debug("COORD", `kill-switch unreachable: ${e.message}`);
      this.registerKillSwitchMiss(`kill-switch unreachable: ${e.message}`);
    }
  }

  /**
   * Manually set the kill-switch state (operator override).
   * Resets auto-trip state and miss counter on manual change.
   */
  public setKillSwitch(active: boolean, reason?: string): void {
    if (active && !this.state.killSwitchActive) {
      log.warn("COORD", `🛑 KILL-SWITCH MANUALLY ACTIVATED: ${reason ?? "no reason provided"}`);
      this.state.killSwitchActive = true;
      this.state.killSwitchReason = reason;
      this.state.killSwitchAutoTripped = false;
      this.state.killSwitchMisses = 0;
    } else if (!active && this.state.killSwitchActive) {
      log.ok("COORD", "🟢 KILL-SWITCH MANUALLY LIFTED — trading resumed");
      this.state.killSwitchActive = false;
      this.state.killSwitchReason = undefined;
      this.state.killSwitchAutoTripped = false;
      this.state.killSwitchMisses = 0;
    }
  }

  /** Only https:// (any host) or http:// to loopback is allowed to carry the secret. */
  private isSecureKillSwitchUrl(raw: string): boolean {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false; // Unparseable URL — treat as insecure.
    }
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") {
      return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
    }
    return false;
  }

  /**
   * Record a failed kill-switch poll. Trading continues through transient
   * failures, but once misses reach KILL_SWITCH_MAX_MISSES we FAIL SAFE by
   * auto-activating the kill-switch. It auto-lifts on the next reachable poll.
   */
  private registerKillSwitchMiss(reason: string): void {
    this.state.killSwitchMisses += 1;
    if (
      this.state.killSwitchMisses >= KILL_SWITCH_MAX_MISSES &&
      !this.state.killSwitchActive
    ) {
      log.err(
        "COORD",
        `🛑 KILL-SWITCH AUTO-ACTIVATED — endpoint unreachable for ${this.state.killSwitchMisses} consecutive polls (fail-safe). Last error: ${reason}`,
      );
      this.state.killSwitchActive = true;
      this.state.killSwitchAutoTripped = true;
      this.state.killSwitchReason = `endpoint unreachable ${this.state.killSwitchMisses}× (fail-safe grace window)`;
    }
  }

  private async checkPromotion(): Promise<void> {
    if (this.state.lastPromotionCheck === 0) {
      this.state.lastPromotionCheck = Date.now();
    }
    try {
      const unlocked = isHighTierUnlocked();
      this.state.highUnlockedSnapshot = unlocked;
      const handle = this.tiers.high;
      if (handle && !handle.unlocked && unlocked) {
        log.ok("COORD", "🔓 HIGH tier UNLOCKED — enabling 5-TON positions");
        handle.unlocked = true;
        statusStore.upsert({
          tier: "high",
          status: "running",
          wallet_address: handle.address,
          updated_at: Date.now(),
        });
      } else if (handle && handle.unlocked && !unlocked) {
        // Promotion criteria regressed (rare). Re-lock.
        log.warn("COORD", "🔒 HIGH tier re-LOCKED — promotion criteria no longer satisfied");
        handle.unlocked = false;
        statusStore.upsert({
          tier: "high",
          status: "paused",
          wallet_address: handle.address,
          updated_at: Date.now(),
        });
      }
    } catch (e: any) {
      log.err("COORD", `promotion eval failed: ${e.message}`);
    }
  }

  private async refreshBalance(tier: Tier): Promise<void> {
    const handle = this.tiers[tier];
    if (!handle) return;
    try {
      const wallet = openWallet(this.client, handle.kp);
      const balanceNano = await wallet.getBalance();
      handle.balanceTon = Number(fromNano(balanceNano));
    } catch (e: any) {
      log.debug("COORD", `[${tier.toUpperCase()}] balance refresh failed: ${e.message}`);
    }
  }

  private async refreshAllAndReport(): Promise<void> {
    const uptimeSec = (Date.now() - this.state.startedAt) / 1000;
    let cbState = "ok";
    try {
      cbState = checkCircuitBreaker() ? "ok" : "TRIPPED";
    } catch {}

    for (const tier of ALL_TIERS) {
      const handle = this.tiers[tier];
      if (!handle) continue;

      // Refresh balance independently — a rate-limit (429) on balance fetch
      // must NOT prevent the status push to the dashboard.
      try {
        await this.refreshBalance(tier);
      } catch {
        // Already logged at debug level inside refreshBalance.
      }

      try {
        handle.openPositions = positionsStore.listOpenByTier(tier).length;
        handle.closedTrades = positionsStore.countClosedForTier(tier);
        handle.dailyPnlTon = dailyPnlStore.getTodayPnl();

        const startedAt = ((handle as any).startedAt) ?? this.state.startedAt;
        const statusRow = {
          tier,
          status: this.state.killSwitchActive
            ? "stopped"
            : !handle.unlocked
              ? "paused"
              : "running",
          wallet_address: handle.address,
          started_at: startedAt,
          bankroll_ton: handle.balanceTon,
          open_positions: handle.openPositions,
          closed_trades: handle.closedTrades,
          realized_pnl_ton: handle.totalPnlTon,
          daily_pnl_ton: handle.dailyPnlTon,
          uptime_sec: uptimeSec,
          updated_at: Date.now(),
        };

        statusStore.upsert(statusRow);

        // Push status to web app so the dashboard shows live balances.
        postEnvelope({
          kind: "status",
          walletTier: tier,
          payload: {
            status: statusRow.status,
            startedAt: this.state.startedAt,
            bankrollTon: handle.balanceTon,
            openPositions: handle.openPositions,
            totalPnLTon: handle.totalPnlTon,
            uptimeSec: Math.floor(uptimeSec),
            version: "1.0.0",
          },
          stableId: `status-${tier}`,
        }).catch((e: any) => log.warn("WEBHOOK", `[${tier.toUpperCase()}] status post failed: ${e.message}`));
      } catch (e: any) {
        log.warn("COORD", `[${tier.toUpperCase()}] status push failed: ${e.message}`);
      }
    }

    if (process.env.COORD_DEBUG_REPORT === "1") {
      log.info(
        "COORD-REPORT",
        `cb=${cbState} kill=${this.state.killSwitchActive ? "ON" : "off"} ` +
          ALL_TIERS.map((t) => {
            const h = this.tiers[t];
            return h
              ? `${t.toUpperCase()}=${h.balanceTon.toFixed(2)}T/${h.openPositions}o`
              : `${t.toUpperCase()}=?`;
          }).join(" "),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 5. Deterministic 9-Step Orchestrator Pipeline (T017 / FR-003)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Execute the full 9-step deterministic trade pipeline for a given tier:
   *
   * 1. Fetch Market Data   — (handled by radar/scanner, input via jettonMaster)
   * 2. Load Memory         — (handled by brain/skills, input via context)
   * 3. LLM Analysis        — (handled by brain/skills outside coordinator)
   * 4. Validate Risk       — Coord tier gate + portfolio allocation + slippage
   * 5. Plan Trade          — Build SwapRequest with adjusted size / path
   * 6. Simulate TX         — (DEX router simulation happens inside executeSwap)
   * 7. Execute Swap        — sign + broadcast via coordinator.executeForTier
   * 8. Log Results         — persist to trade_transactions + push envelope
   * 9. Sync State          — refresh balance, release lock, update memory
   *
   * Steps 1-3 are handled externally by the radar + brain modules. This method
   * implements steps 4-9 as a unified pipeline.
   */
  async executeTradePipeline(
    tier: Tier,
    req: SwapRequest,
    dex: Dex = CONFIG.strategy.preferredDex,
  ): Promise<{
    ok: boolean;
    error?: string;
    pipeline: {
      step4RiskVerdict: string;
      step5PlannedSizeTon: number;
      step6SimResult?: string;
      step7SwapResult?: SwapResult;
      step8TxHash?: string;
      step9Synced: boolean;
    };
  }> {
    const pipeline: any = {
      step4RiskVerdict: "pending",
      step5PlannedSizeTon: req.amountTon,
      step6SimResult: undefined,
      step7SwapResult: undefined,
      step8TxHash: undefined,
      step9Synced: false,
    };

    const handle = this.tiers[tier];
    if (!handle) {
      return { ok: false, error: `tier ${tier} not initialized`, pipeline };
    }

    // ── Step 4: Validate Risk via SafetyCaps (hard gates + journal) ──
    const cycleId = newId("cycle");
    const plannedTon = (() => {
      const allocCheck = checkPortfolioAllocation(req.amountTon, handle.balanceTon);
      if (!allocCheck.allowed && allocCheck.maxAllowedTon !== undefined) {
        return Math.min(req.amountTon, allocCheck.maxAllowedTon);
      }
      return req.amountTon;
    })();
    const ticket = this.buildTradeTicket(tier, { ...req, amountTon: plannedTon }, { cycleId });
    const cap = this.authorizeForTier(tier, ticket);
    if (!cap.ok) {
      const reason = cap.failures.map((f) => f.reason).join("; ") || "cap denied";
      pipeline.step4RiskVerdict = `DENIED: ${reason}`;
      log.warn("PIPELINE", `[${tier.toUpperCase()}] Step 4 FAIL: ${reason}`);
      return { ok: false, error: reason, pipeline };
    }
    pipeline.step4RiskVerdict = "PASS";
    log.ok("PIPELINE", `[${tier.toUpperCase()}] Step 4 (Validate Risk) PASS hash=${cap.ticket_hash.slice(0, 8)}`);

    // ── Step 5: Plan Trade ──
    pipeline.step5PlannedSizeTon = plannedTon;
    log.info("PIPELINE", `[${tier.toUpperCase()}] Step 5 (Plan) size=${plannedTon}TON`);

    // ── Step 6: Simulate TX ──
    const simulatedReq: SwapRequest = { ...req, amountTon: plannedTon };
    pipeline.step6SimResult = `simulating ${plannedTon}TON → ${req.jettonMaster.slice(0, 8)}…`;
    log.info("PIPELINE", `[${tier.toUpperCase()}] Step 6 (Simulate) ${pipeline.step6SimResult}`);

    // ── Step 7: Execute Swap (bound to cap ticket_hash) ──
    const swapResult = await this.executeForTier(tier, simulatedReq, dex, {
      ticket,
      ticketHash: cap.ticket_hash,
      cycleId,
    });
    pipeline.step7SwapResult = swapResult;

    if (!swapResult.ok) {
      log.err("PIPELINE", `[${tier.toUpperCase()}] Step 7 (Execute) FAILED: ${swapResult.error}`);
      return { ok: false, error: swapResult.error, pipeline };
    }
    pipeline.step8TxHash = swapResult.txHash;
    log.ok("PIPELINE", `[${tier.toUpperCase()}] Step 7 (Execute) OK tx=${swapResult.txHash?.slice(0, 16)}…`);

    // ── Step 8: Log Results ──
    try {
      const tx: DbTradeTransaction = {
        tx_hash: swapResult.txHash ?? newId("tx").replace("tx_", ""),
        wallet_address: handle.address,
        source_token: "TON",
        target_token: req.jettonMaster,
        input_amount: toNano(plannedTon.toString()).toString(),
        output_amount: swapResult.amountTokens,
        status: "PENDING",
        timestamp: Date.now(),
      };
      tradeTransactionStore.insert(tx);

      // Push event to web app
      // Compute and attach confidence score to the trade log
      const { computeConfidenceScore } = await import("../risk/scoring");
      const pipelineScore = req.side === "buy" ? computeConfidenceScore({
        renounced: true,
        lpLocked: true,
        honeypotSafe: true,
        holders: 0,
        ageHours: 0,
        liquidityTon: null,
        poolAvailable: true,
        tier,
        minAiScore: handle?.config?.minAiScore ?? 50,
      }) : { total: 0, audit: 0, holders: 0, age: 0, liquidity: 0, tierBonus: 0 };

      postEnvelope({
        kind: "trade_executed",
        walletTier: tier,
        payload: {
          tier,
          side: req.side,
          amountTon: plannedTon,
          jettonMaster: req.jettonMaster,
          txHash: swapResult.txHash,
          amountTokens: swapResult.amountTokens,
          dex: swapResult.dex,
          confidenceScore: pipelineScore.total,
        },
        stableId: `trade-${swapResult.txHash ?? newId("tx")}`,
      }).catch((e: any) => log.warn("WEBHOOK", `trade_executed post failed: ${e.message}`));

      log.ok("PIPELINE", `[${tier.toUpperCase()}] Step 8 (Log) OK tx=${tx.tx_hash.slice(0, 16)}… confidence=${pipelineScore.total}`);
    } catch (e: any) {
      log.warn("PIPELINE", `[${tier.toUpperCase()}] Step 8 (Log) failed: ${e.message}`);
    }

    // ── Step 9: Sync State ──
    try {
      await this.refreshBalance(tier);
      pipeline.step9Synced = true;
      log.ok("PIPELINE", `[${tier.toUpperCase()}] Step 9 (Sync) balance=${handle.balanceTon.toFixed(3)}TON`);
    } catch (e: any) {
      log.warn("PIPELINE", `[${tier.toUpperCase()}] Step 9 (Sync) failed: ${e.message}`);
    }

    return { ok: true, pipeline };
  }

  // ─────────────────────────────────────────────────────────────────
  // 6. Read-only helpers used by tools.ts
  // ─────────────────────────────────────────────────────────────────
  getTierHandle(tier: Tier): TierHandle | undefined {
    return this.tiers[tier];
  }

  getAllHandles(): TierHandle[] {
    return ALL_TIERS.map((t) => this.tiers[t]).filter(Boolean);
  }

  getKillSwitchState(): { active: boolean; reason?: string } {
    return {
      active: this.state.killSwitchActive,
      reason: this.state.killSwitchReason,
    };
  }

  isKillSwitchActive(): boolean {
    return this.state.killSwitchActive;
  }

  getSnapshot() {
    return {
      startedAt: this.state.startedAt,
      uptimeSec: (Date.now() - this.state.startedAt) / 1000,
      killSwitch: this.getKillSwitchState(),
      circuitBreaker: (() => {
        try {
          return { ok: checkCircuitBreaker(), todayPnl: dailyPnlStore.getTodayPnl() };
        } catch {
          return { ok: true, todayPnl: 0 };
        }
      })(),
      highUnlocked: this.state.highUnlockedSnapshot,
      tiers: this.getAllHandles().map((h) => ({
        tier: h.tier,
        address: h.address,
        balanceTon: h.balanceTon,
        unlocked: h.unlocked,
        openPositions: h.openPositions,
        closedTrades: h.closedTrades,
        dailyPnlTon: h.dailyPnlTon,
        maxPositionTon: h.config.maxPositionTon,
        maxOpen: h.config.maxOpen,
      })),
    };
  }

  /**
   * Stop ML services and cleanup
   */
  public async stop(): Promise<void> {
    try {
      if (this.retrainingScheduler) {
        await this.retrainingScheduler.stop();
        log.info("COORD", "Retraining scheduler stopped");
      }
    } catch (error) {
      log.warn("COORD", `Error stopping ML services: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
// Singleton-ish coordinator owned by the index.ts boot path.
let coordinatorInstance: TierCoordinator | null = null;
let coordinatorStarted = false;

export async function startCoordinator(): Promise<TierCoordinator> {
  if (coordinatorInstance) return coordinatorInstance;
  const client = makeClient();
  const coord = new TierCoordinator(client);
  await coord.init();
  coord.startBackgroundLoops();
  coordinatorInstance = coord;
  coordinatorStarted = true;
  return coord;
}

export function getCoordinator(): TierCoordinator {
  if (!coordinatorInstance) {
    throw new Error(
      "TierCoordinator not started yet — call startCoordinator() from index.ts first.",
    );
  }
  return coordinatorInstance;
}

export function isCoordinatorStarted(): boolean {
  return coordinatorStarted;
}
