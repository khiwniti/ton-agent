import { log } from "../logger";
import { CONFIG } from "../config";
import type { Dex, SwapResult } from "../dex/router";
import { executeSwap, type SwapRequest } from "../dex/router";
import { poolStateCache, type PoolState } from "../market";
import { policyManager, policyTransport } from "./policy-manager";
import type { FastPathSignal, TradingPolicy } from "./policy-types";
import { evaluateTradeGate, type TradeGateInput } from "./gate";
import { getCoordinator, isCoordinatorStarted, type Tier } from "../core/coordinator";
import { type ModelPrediction } from "../ml/types";
import {
  compileBocTemplate,
  rebuildDedustNativeBuyLeaf,
  rebuildDedustJettonSellLeaf,
  validateBocTemplate,
  extractPoolSnapshot,
  type BocTemplate,
  type LeafCellData,
  type PoolSnapshot,
} from "./boc-template";
import { bocTemplateCache, fastPathPolicySubscription } from "./boc-template-cache";
import { fastPathMetrics } from "./fastpath-metrics";
import type { FastPathResult as FastPathTypesResult, FastPathConfig } from "./fastpath-types";
import { makeClient } from "../wallet/wallet";

/**
 * Result of a FastPath execution attempt.
 */
export interface FastPathResult {
  /** True if the trade was executed via FastPath */
  executedViaFastPath: boolean;
  /** The swap result if executed, otherwise undefined */
  swapResult?: SwapResult;
  /** Reason if not executed via FastPath */
  reason?: string;
  /** True if the system should fall back to cold path processing */
  fallbackToColdPath: boolean;
}

/**
   * FastPathEngine executes pre-approved trade signals in the hot path.
   * It bypasses the LLM reasoning loop but still enforces all safety checks via the policy manager.
   * It calls evaluateTradeGate from core/gate.ts as required by FR-001.
   */
export class FastPathEngine {
  public enabled: boolean;
  private config: FastPathConfig;
  private policySubscribed: boolean = false;

  constructor(config?: Partial<FastPathConfig>) {
    this.enabled = process.env.FAST_PATH_ENABLED === 'true';
    this.config = {
      enabled: this.enabled,
      maxHotPathLatencyUs: 1000,
      bocTemplateCacheSize: 100,
      bocTemplateTtlMs: 3600000,
      minLiquidityForTemplateUsd: 10000,
      preCompileTopPools: 50,
      ...config,
    };

    log.info("FAST_PATH", `FastPath engine initialized (enabled: ${this.enabled})`);

    // Subscribe to policy updates for hot path
    if (this.enabled) {
      this.subscribeToPolicyUpdates();
    }
  }

  private subscribeToPolicyUpdates(): void {
    if (this.policySubscribed) return;

    fastPathPolicySubscription.subscribe((policy, version) => {
      fastPathMetrics.setPolicyVersion(version);
      log.debug("FAST_PATH", `Policy updated to version ${version} in hot path`);
    });

    this.policySubscribed = true;
  }

  /**
   * Set whether the FastPath is enabled.
   * @param enabled - True to enable FastPath
   */
  public setEnabled(enabled: boolean): void {
    log.info("FAST_PATH", `FastPath ${enabled ? "enabled" : "disabled"}`);
    this.enabled = enabled;
    this.config.enabled = enabled;

    if (enabled && !this.policySubscribed) {
      this.subscribeToPolicyUpdates();
    } else if (!enabled && this.policySubscribed) {
      fastPathPolicySubscription.unsubscribeFromPolicy();
      this.policySubscribed = false;
    }
  }

  /**
   * Validate signal against policy (token blacklist, DEX allowlist).
   * @param signal - The signal to validate
   * @param policy - The current trading policy
   * @returns Error message if invalid, null if valid
   */
  private validateSignalPolicy(signal: FastPathSignal, policy: TradingPolicy): string | null {
    if (policy.blockedTokens.includes(signal.tokenAddress)) {
      return `Token ${signal.tokenAddress.slice(0, 8)}... is blacklisted`;
    }
    return null;
  }

  /**
   * Select a DEX for the signal based on policy and signal properties.
   * @param signal - The signal to trade
   * @param policy - The current trading policy
   * @returns The selected DEX or null if none suitable
   */
  private selectDex(signal: FastPathSignal, policy: TradingPolicy): Dex | null {
    if (policy.blockedTokens.includes(signal.tokenAddress)) {
      return null;
    }
    if (policy.allowedDexes.includes("stonfi")) {
      return "stonfi";
    }
    if (policy.allowedDexes.includes("dedust")) {
      return "dedust";
    }
    return null;
  }

  /**
   * Get pool state for a token pair from the cache.
   * @param tokenAddress - The jetton master address
   * @param dex - Preferred DEX
   * @returns Pool state data or null if not found
   */
  private getPoolStateForToken(tokenAddress: string, dex: Dex): PoolState | null {
    const poolStates = poolStateCache.getAll();
    for (const poolState of poolStates) {
      if (poolState.dex !== dex) {
        continue;
      }
      if (poolState.token0Address === tokenAddress || poolState.token1Address === tokenAddress) {
        return poolState;
      }
    }
    return null;
  }

  /**
   * Calculate the minimum output amount based on slippage tolerance.
   * @param amountTon - The input amount in TON
   * @param maxSlippageBps - Maximum slippage in basis points
   * @returns Minimum output amount in nano jetton as a string
   */
  private calculateMinOut(amountTon: number, maxSlippageBps: number): string {
    const slippageMultiplier = 1 - (maxSlippageBps / 10000);
    const expectedOutput = amountTon * 1_000_000_000;
    const minOut = Math.floor(expectedOutput * slippageMultiplier);
    return Math.max(minOut, 0).toString();
  }

  /**
   * Get a TonClient instance.
   * @returns TonClient instance
   */
  private async getTonClient(): Promise<any> {
    // Route through the shared STON.fi rate-limit bucket: toncenter RPC posts
    // are serialized under the same bucket as the wallet's (src/wallet/wallet.ts)
    // so FastPath cannot stampede the shared upstream on the same beat as the
    // other four subsystems (2026-08-12 prod 429 incident, Fix C).
    return makeClient();
  }

  /**
   * Get ML price prediction for a token
   * @param tokenAddress - The token contract address
   * @returns ML prediction or null if not available
   */
  private async getMlPrediction(tokenAddress: string): Promise<ModelPrediction | null> {
    try {
      if (!isCoordinatorStarted()) {
        return null;
      }
      const coord = getCoordinator();
      if (!coord.state.mlServicesInitialized || !coord.predictionService) {
        return null;
      }

      let ohlcvData: { 
        timestamp: number[]; 
        open: number[]; 
        high: number[]; 
        low: number[]; 
        close: number[]; 
        volume: number[] 
      } | null = null;

      // Try fetching historical data from poolMonitor's timeSeriesStore if available
      try {
        if (coord.poolMonitor && (coord.poolMonitor as any).timeSeriesStore) {
          const historicalData = await (coord.poolMonitor as any).timeSeriesStore.queryPoolData(
            tokenAddress,
            Date.now() - (24 * 60 * 60 * 1000),
            Date.now()
          );
          if (historicalData && historicalData.length > 0) {
            ohlcvData = {
              timestamp: historicalData.map((d: any) => new Date(d.time || d.timestamp).getTime()),
              open: historicalData.map((d: any) => d.open ?? d.price),
              high: historicalData.map((d: any) => d.high ?? d.price),
              low: historicalData.map((d: any) => d.low ?? d.price),
              close: historicalData.map((d: any) => d.close ?? d.price),
              volume: historicalData.map((d: any) => d.volume_24h ?? 1000)
            };
          }
        }
      } catch (err) {
        // Time series query failed, fall back to cached pool state
      }

      // Fall back to pool state cache if historical query produced no data
      if (!ohlcvData) {
        const poolState = this.getPoolStateForToken(tokenAddress, "stonfi") || this.getPoolStateForToken(tokenAddress, "dedust");
        if (!poolState) {
          return null;
        }
        const now = Date.now();
        const price = Number(poolState.price);
        ohlcvData = {
          timestamp: [now],
          open: [price],
          high: [price * 1.001],
          low: [price * 0.999],
          close: [price],
          volume: [poolState.volume24h || 1000]
        };
      }

      const prediction = await coord.predictionService.predict(ohlcvData);
      if (!prediction) return null;
      return {
        direction: prediction.signal === "buy" ? "up" : prediction.signal === "sell" ? "down" : "sideways",
        confidence: prediction.confidence,
        predictedChangePercent: prediction.expectedReturn,
      };
    } catch (error) {
      log.warn("FASTPATH_ML", `Failed to get ML prediction: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Process a FastPathSignal and attempt to execute it via the hot path.
   * Uses BOC template cache for ultra-fast leaf-only rebuild (<50μs target).
   * Falls back to cold path executeSwap if template unavailable.
   * @param signal - The trading signal to process
   * @param tier - The tier to use for this trade (low, mid, high).
   * @returns Result indicating whether it was executed via FastPath
   */
  public async processSignal(signal: FastPathSignal, tier: Tier = "low"): Promise<FastPathResult> {
    const startTime = Date.now();
    fastPathMetrics.recordSignalReceived();

    // Check if FastPath is enabled
    if (!this.enabled) {
      return this.fallbackResult("FastPath feature is disabled", startTime);
    }

    // Validate signal producer
    if (signal.producer !== "radar" && signal.producer !== "llm-preapproved") {
      return this.fallbackResult(`Invalid signal producer: ${signal.producer}`, startTime);
    }

    // Check policy freshness via zero-copy subscription (no lock)
    if (!fastPathPolicySubscription.isPolicyFresh(signal.policyVersion)) {
      const current = fastPathPolicySubscription.getCurrentPolicy();
      return this.fallbackResult(
        `Stale policy: signal version ${signal.policyVersion}, current ${current?.version ?? "none"}`,
        startTime
      );
    }

    // Get current policy for validation
    const policyData = fastPathPolicySubscription.getCurrentPolicy();
    if (!policyData) {
      return this.fallbackResult("No policy available", startTime);
    }
    const policy = policyData.policy;

    // Validate signal against policy (token blacklist, DEX allowlist)
    const policyValidationError = this.validateSignalPolicy(signal, policy);
    if (policyValidationError) {
      return this.fallbackResult(policyValidationError, startTime);
    }

    // Get the coordinator instance
    if (!isCoordinatorStarted()) {
      return this.fallbackResult("Coordinator not started", startTime);
    }
    const coord = getCoordinator();

    // Get the tier handle
    const handle = coord.getTierHandle(tier);
    if (!handle) {
      return this.fallbackResult(`Tier ${tier} not initialized`, startTime);
    }

    // Get coordinator state for gate inputs
    const killSwitchState = coord.getKillSwitchState();
    const snapshot = coord.getSnapshot();

    // Build the TradeGateInput for evaluateTradeGate (FR-001 requirement)
    const gateInput: TradeGateInput = {
      tier: tier,
      requestedTon: signal.amountTon,
      killSwitchActive: killSwitchState.active,
      killSwitchReason: killSwitchState.reason,
      handle: {
        tier: handle.tier,
        kp: handle.kp,
        address: handle.address,
        balanceTon: handle.balanceTon,
        openPositions: handle.openPositions,
        closedTrades: handle.closedTrades,
        config: handle.config,
        unlocked: handle.unlocked,
        startedAt: handle.startedAt,
        totalPnlTon: handle.totalPnlTon,
        dailyPnlTon: handle.dailyPnlTon
      },
      circuitBreakerOk: snapshot.circuitBreaker.ok,
      dailyPnl: snapshot.circuitBreaker.todayPnl,
      observeOnly: CONFIG.observeOnly
    };

    // Call evaluateTradeGate from core/gate.ts (FR-001 requirement)
    const gateResult = evaluateTradeGate(gateInput);
    if (!gateResult.allowed) {
      return this.fallbackResult(`Gate check failed: ${gateResult.reason}`, startTime);
    }

    // Select DEX
    const dex = this.selectDex(signal, policy);
    if (!dex) {
      return this.fallbackResult("No allowed DEX available for this signal", startTime);
    }

    // Check pool data
    const poolState = this.getPoolStateForToken(signal.tokenAddress, dex);
    if (!poolState) {
      return this.fallbackResult(`No pool data available for token ${signal.tokenAddress} on DEX ${dex}`, startTime);
    }

    // Try FastPath execution with BOC template
    const currentPolicyVersion = fastPathPolicySubscription.getCurrentPolicy()?.version ?? 0;
    const template = bocTemplateCache.get(
      dex,
      poolState.address,
      signal.tokenAddress,
      signal.side,
      currentPolicyVersion
    );

    let executedViaFastPath = false;
    let swapResult: SwapResult | undefined;
    let fallbackReason: string | undefined;
    let leafRebuildDurationUs = 0;
    let bocSerializeDurationUs = 0;
    let broadcastDurationUs = 0;

    if (template) {
      // FastPath: Rebuild leaf cell and broadcast
      const leafRebuildStart = Date.now();
      try {
        let rebuiltBoc: Buffer;

        if (dex === "dedust" && signal.side === "buy") {
          // DeDust native vault BUY
          const queryId = Date.now() & 0xffffffff; // Simple queryId
          const limit = this.calculateMinOutAmount(signal.amountTon, policy.maxSlippageBps, poolState);
          rebuiltBoc = rebuildDedustNativeBuyLeaf(template.templateBoc, BigInt(Math.floor(signal.amountTon * 1_000_000_000)), limit, queryId);
        } else if (dex === "dedust" && signal.side === "sell") {
          // DeDust jetton vault SELL
          const queryId = Date.now() & 0xffffffff;
          const forwardTonAmount = 300_000_000n; // 0.3 TON forward fee
          rebuiltBoc = rebuildDedustJettonSellLeaf(template.templateBoc, BigInt(Math.floor(signal.amountTon * 1_000_000_000)), forwardTonAmount, queryId);
        } else {
          // Ston.fi or other - use generic rebuild (fallback to cold path for now)
          throw new Error("Ston.fi template rebuild not yet implemented");
        }

        leafRebuildDurationUs = (Date.now() - leafRebuildStart) * 1000;

        // Broadcast the rebuilt BOC
        const broadcastStart = Date.now();
        const broadcastResult = await this.broadcastBoc(rebuiltBoc, handle.kp);
        broadcastDurationUs = (Date.now() - broadcastStart) * 1000;

        if (broadcastResult.ok) {
          executedViaFastPath = true;
          swapResult = {
            ok: true,
            dex: dex,
            txHash: broadcastResult.txHash,
            error: undefined,
          };
        } else {
          fallbackReason = `Broadcast failed: ${broadcastResult.error}`;
        }
      } catch (error: any) {
        fallbackReason = `FastPath rebuild error: ${error.message}`;
      }
    } else {
      // No template available - compile one for next time (cold path)
      fallbackReason = "No BOC template available, compiling for next execution";
      bocTemplateCache.set(
        compileBocTemplate(
          dex,
          poolState.address,
          signal.tokenAddress,
          signal.side,
          handle.address.toString(),
          handle.kp.pub,
          200000000, // estimated gas
          currentPolicyVersion
        )
      );
    }

    // If FastPath failed or no template, fall back to cold path executeSwap
    if (!executedViaFastPath) {
      try {
        const swapRequest: SwapRequest = {
          jettonMaster: signal.tokenAddress,
          amountTon: signal.amountTon,
          side: signal.side,
          ...(signal.side === "buy"
            ? { minOutJettonNano: this.calculateMinOut(signal.amountTon, policy.maxSlippageBps) }
            : { jettonAmountNano: Math.floor(signal.amountTon * 1_000_000_000).toString() }
          )
        };

        const tonClient = await this.getTonClient();
        swapResult = await executeSwap(tonClient, swapRequest, tier, dex);
        fallbackReason = fallbackReason ?? (swapResult.ok ? undefined : `Swap failed: ${swapResult.error}`);
        executedViaFastPath = false;
      } catch (error: any) {
        swapResult = { ok: false, dex: dex, error: error.message };
        fallbackReason = fallbackReason ?? `Cold path error: ${error.message}`;
      }
    }

    const hotPathDurationUs = (Date.now() - startTime) * 1000;

    // Record metrics
    const result: FastPathTypesResult = {
      executedViaFastPath,
      swapResult,
      hotPathDurationUs,
      leafRebuildDurationUs,
      bocSerializeDurationUs: 0, // Included in leafRebuild for now
      broadcastDurationUs,
      error: fallbackReason,
      fallbackReason,
      policyVersion: currentPolicyVersion,
    };
    fastPathMetrics.recordFastPathExecution(result);

    // Check latency budget
    if (fastPathMetrics.isLatencyBudgetExceeded(hotPathDurationUs)) {
      log.warn("FAST_PATH", `Hot path latency ${hotPathDurationUs}μs exceeds budget ${this.config.maxHotPathLatencyUs}μs`);
    }

    return {
      executedViaFastPath,
      swapResult,
      reason: fallbackReason,
      fallbackToColdPath: !executedViaFastPath,
    };
  }

  /**
   * Create a fallback result with timing
   */
  private fallbackResult(reason: string, startTime: number): FastPathResult {
    const hotPathDurationUs = (Date.now() - startTime) * 1000;
    const result: FastPathTypesResult = {
      executedViaFastPath: false,
      hotPathDurationUs,
      leafRebuildDurationUs: 0,
      bocSerializeDurationUs: 0,
      broadcastDurationUs: 0,
      fallbackReason: reason,
      policyVersion: fastPathPolicySubscription.getCurrentPolicy()?.version ?? 0,
    };
    fastPathMetrics.recordFastPathExecution(result);
    return {
      executedViaFastPath: false,
      fallbackToColdPath: true,
      reason,
    };
  }

  /**
   * Calculate minimum output amount for slippage
   */
  private calculateMinOutAmount(amountTon: number, maxSlippageBps: number, poolState: PoolState): bigint {
    // Simple constant product formula estimation
    // Need to determine which reserve is TON and which is Jetton based on token addresses
    // For now, assume token0 is TON (native) for TON/jetton pairs
    const reserveIn = poolState.reserve0; // TON reserve
    const reserveOut = poolState.reserve1; // Jetton reserve
    const amountIn = BigInt(Math.floor(amountTon * 1_000_000_000));
    const amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
    const slippageMultiplier = 1 - (maxSlippageBps / 10000);
    return BigInt(Math.floor(Number(amountOut) * slippageMultiplier));
  }

  /**
   * Broadcast a BOC to the network using sendTransferLocked pattern
   */
  private async broadcastBoc(boc: Buffer, keyPair: { pub: Buffer; sec: Buffer }): Promise<{ ok: boolean; txHash?: string; error?: string }> {
    try {
      const { WalletContractV5R1, internal, Cell, SendMode, Address } = await import("@ton/ton");
      // Throttled via the shared STON.fi bucket (see getTonClient note).
      const client = makeClient();

      const wallet = WalletContractV5R1.create({ publicKey: keyPair.pub, workchain: 0 });
      const contract = client.open(wallet);

      const seqno = await contract.getSeqno();
      const body = Cell.fromBoc(boc)[0];

      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.sec,
        messages: [internal({ to: Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), body, value: "0.05" })], // 0.05 TON for fees, to is required but ignored for external messages
        sendMode: SendMode.PAY_GAS_SEPARATELY,
      });

      // Wait for seqno increment (confirmation)
      const startSeqno = seqno;
      const startTime = Date.now();
      const timeoutMs = 45000;
      while (Date.now() - startTime < timeoutMs) {
        try {
          const seq = await contract.getSeqno();
          if (seq > startSeqno) {
            // Transaction confirmed - get the hash
            // Note: We can't easily get the tx hash without additional API calls
            // For now, return success without txHash
            return { ok: true };
          }
        } catch {
          // Ignore network/RPC glitches during polling
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      return { ok: false, error: "Confirmation timeout (seqno did not increase)" };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }
}

// Export a singleton instance
export const fastPathEngine = new FastPathEngine();
