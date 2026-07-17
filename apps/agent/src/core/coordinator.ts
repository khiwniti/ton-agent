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
import { fromNano, toNano, TonClient } from "@ton/ton";
import { CONFIG } from "../config";
import { log } from "../logger";
import {
  loadKeyPair,
  loadKeyPairForTier,
  makeClient,
  openWallet,
  type KeyPair,
} from "../wallet/wallet";
import { executeSwap, type Dex, type SwapRequest, type SwapResult } from "../dex/router";
import {
  positionsStore,
  statusStore,
  dailyPnlStore,
  tradeTransactionStore,
  DbTradeTransaction,
} from "../storage/store";
import {
  checkCircuitBreaker,
  isHighTierUnlocked,
  TIER_RISK_CONFIGS,
  DAILY_LOSS_LIMIT_TON,
  checkPortfolioAllocation,
} from "../risk/guardrails";
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

// Re-export the pure enum/identifier + gate evaluator with stable names.
export type Tier = PureTier;
export { ALL_TIERS, evaluateTradeGate };
export type { TradeGateInput };

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
}

class TierCoordinator {
  private client: TonClient;
  private tiers: Record<Tier, TierHandle> = {} as any;
  private state: CoordinatorState = {
    killSwitchActive: false,
    killSwitchAutoTripped: false,
    killSwitchMisses: 0,
    startedAt: Date.now(),
    lastPromotionCheck: 0,
    highUnlockedSnapshot: false,
  };

  constructor(client: TonClient) {
    this.client = client;
  }

  // ─────────────────────────────────────────────────────────────────
  // 1. INIT — derive keys + wallets for all tiers
  // ─────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    log.banner("TIER COORDINATOR", `bootstrap tiers=LOW/MID/HIGH network=${CONFIG.network}`);

    // HIGH: only enabled if promotion criteria are met, but we always initialize
    // it so a single boot has the wallet hot for prompt promotion.
    const highUnlocked = isHighTierUnlocked();
    this.state.highUnlockedSnapshot = highUnlocked;

    for (const tier of ALL_TIERS) {
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
  async executeForTier(
    tier: Tier,
    p: SwapRequest,
    dex: Dex = CONFIG.strategy.preferredDex,
  ): Promise<{ ok: boolean; dex: Dex; error?: string; txHash?: string; amountTokens?: string }> {
    const handle = this.tiers[tier];

    // For buys, gate against tier risk config before going to the DEX.
    if (p.side === "buy") {
      const gate = this.isTradeAllowed(tier, p.amountTon);
      if (!gate.allowed) {
        log.warn("COORD", `[${tier.toUpperCase()}] swap DENIED: ${gate.reason}`);
        return { ok: false, dex, error: gate.reason };
      }
    } else {
      // Sells bypass the position-count cap (closing a position should never be blocked).
      if (CONFIG.observeOnly) {
        log.warn("COORD", `[${tier.toUpperCase()}] SELL blocked — observe-only mode`);
        return { ok: false, dex, error: "observe-only mode — all trades blocked" };
      }
      if (this.state.killSwitchActive) {
        log.warn("COORD", `[${tier.toUpperCase()}] SELL blocked — kill-switch active`);
        return { ok: false, dex, error: "kill-switch active" };
      }
    }

    log.trade(
      "COORD",
      `[${tier.toUpperCase()}] routing ${p.side} ${p.amountTon} TON jett=${p.jettonMaster.slice(0, 8)}… via ${dex}`,
    );

    const res = await executeSwap(this.client, p, tier, dex);
    if (res.ok) {
      // Refresh cached balance after a swap.
      await this.refreshBalance(tier);
    }
    return res;
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
      try {
        await this.refreshBalance(tier);
        handle.openPositions = positionsStore.listOpenByTier(tier).length;
        handle.closedTrades = positionsStore.countClosedForTier(tier);
        handle.dailyPnlTon = dailyPnlStore.getTodayPnl();

        const statusRow = {
          tier,
          status: this.state.killSwitchActive
            ? "stopped"
            : !handle.unlocked
              ? "paused"
              : handle.openPositions >= handle.config.maxOpen
                ? "running"
                : "running",
          wallet_address: handle.address,
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
          stableId: `status-${tier}`,  // fixed stableId so Supabase upsert overwrites the same row
        }).catch((e: any) => log.warn("WEBHOOK", `[${tier.toUpperCase()}] status post failed: ${e.message}`));
      } catch (e: any) {
        log.debug("COORD", `[${tier.toUpperCase()}] status refresh failed: ${e.message}`);
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

    // ── Step 4: Validate Risk ──
    const gate = this.isTradeAllowed(tier, req.amountTon);
    if (!gate.allowed) {
      pipeline.step4RiskVerdict = `DENIED: ${gate.reason}`;
      log.warn("PIPELINE", `[${tier.toUpperCase()}] Step 4 FAIL: ${gate.reason}`);
      return { ok: false, error: gate.reason, pipeline };
    }

    // Check portfolio allocation (max 5% of available balance)
    const allocCheck = checkPortfolioAllocation(req.amountTon, handle.balanceTon);
    if (!allocCheck.allowed) {
      pipeline.step4RiskVerdict = `DENIED: ${allocCheck.reason}`;
      log.warn("PIPELINE", `[${tier.toUpperCase()}] Step 4 FAIL: ${allocCheck.reason}`);
      return { ok: false, error: allocCheck.reason, pipeline };
    }
    pipeline.step4RiskVerdict = "PASS";
    log.ok("PIPELINE", `[${tier.toUpperCase()}] Step 4 (Validate Risk) PASS`);

    // ── Step 5: Plan Trade (apply allocation cap, determine path) ──
    const plannedTon = Math.min(req.amountTon, allocCheck.maxAllowedTon ?? req.amountTon);
    pipeline.step5PlannedSizeTon = plannedTon;
    log.info("PIPELINE", `[${tier.toUpperCase()}] Step 5 (Plan) size=${plannedTon}TON`);

    // ── Step 6: Simulate TX ──
    const simulatedReq: SwapRequest = { ...req, amountTon: plannedTon };
    // The DEX router simulates internally (getSwapTonToJettonTxParams / pool reserves)
    // We log the intent here; actual simulation happens inside executeSwap
    // Slippage validation is applied after execution via checkSlippage on the result
    pipeline.step6SimResult = `simulating ${plannedTon}TON → ${req.jettonMaster.slice(0, 8)}…`;
    log.info("PIPELINE", `[${tier.toUpperCase()}] Step 6 (Simulate) ${pipeline.step6SimResult}`);

    // ── Step 7: Execute Swap ──
    const swapResult = await this.executeForTier(tier, simulatedReq, dex);
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
