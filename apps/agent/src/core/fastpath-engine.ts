import { log } from "../logger";
import { CONFIG } from "../config";
import type { Dex } from "../dex/router";
import { executeSwap, type SwapRequest, type SwapResult } from "../dex/router";
import { poolStateCache, type PoolState } from "../market";
import { policyManager } from "./policy-manager";
import type { FastPathSignal, TradingPolicy } from "./policy-types";
import { evaluateTradeGate, type TradeGateInput } from "./gate";
import { getCoordinator, isCoordinatorStarted, type Tier } from "../core/coordinator";
import { type ModelPrediction } from "../ml/types";

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

  constructor() {
    this.enabled = process.env.FAST_PATH_ENABLED === 'true';
    log.info("FAST_PATH", `FastPath engine initialized (enabled: ${this.enabled})`);
  }

  /**
   * Set whether the FastPath is enabled.
   * @param enabled - True to enable FastPath
   */
  public setEnabled(enabled: boolean): void {
    log.info("FAST_PATH", `FastPath ${enabled ? "enabled" : "disabled"}`);
    this.enabled = enabled;
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
    const { TonClient } = await import("@ton/ton");
    const endpoint = CONFIG.network === "mainnet" 
      ? "https://toncenter.com/api/v2/jsonRPC" 
      : "https://testnet.toncenter.com/api/v2/jsonRPC";
    return new TonClient({ endpoint });
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
      return prediction || null;
    } catch (error) {
      log.warn("FASTPATH_ML", `Failed to get ML prediction: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Process a FastPathSignal and attempt to execute it via the hot path.
   * @param signal - The trading signal to process
   * @param tier - The tier to use for this trade (low, mid, high).
   * @returns Result indicating whether it was executed via FastPath
   */
  public async processSignal(signal: FastPathSignal, tier: Tier = "low"): Promise<FastPathResult> {
    // Check if FastPath is enabled
    if (!this.enabled) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: "FastPath feature is disabled"
      };
    }

    // Validate signal producer
    if (signal.producer !== "radar" && signal.producer !== "llm-preapproved") {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: `Invalid signal producer: ${signal.producer}`
      };
    }

    // Check if the policy is fresh (matches current policy version)
    if (!policyManager.isPolicyFresh(signal)) {
      const current = policyManager.getPolicy();
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: `Stale policy: signal version ${signal.policyVersion}, current ${current?.version ?? "none"}`
      };
    }

    // Get the current policy for validation
    const policy = policyManager.getPolicy();
    if (!policy) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: "No policy available"
      };
    }

    // Validate signal against policy (token blacklist, DEX allowlist)
    const policyValidationError = this.validateSignalPolicy(signal, policy);
    if (policyValidationError) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: policyValidationError
      };
    }

    // Get the coordinator instance
    if (!isCoordinatorStarted()) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: "Coordinator not started"
      };
    }
    const coord = getCoordinator();

    // Get the tier handle
    const handle = coord.getTierHandle(tier);
    if (!handle) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: `Tier ${tier} not initialized`
      };
    }

    // Get coordinator state for gate inputs
    const killSwitchState = coord.getKillSwitchState();
    const snapshot = coord.getSnapshot();

    // Build the TradeGateInput for evaluateTradeGate
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
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: `Gate check failed: ${gateResult.reason}`
      };
    }

    // Get ML prediction for enhanced decision making
    if (coord.state.mlServicesInitialized && CONFIG.mlEnabled) {
      const mlPrediction = await this.getMlPrediction(signal.tokenAddress);
      
      if (mlPrediction) {
        log.info(
          "FASTPATH_ML", 
          `ML prediction for ${signal.tokenAddress.slice(0, 8)}...: direction=${mlPrediction.direction}, confidence=${mlPrediction.confidence.toFixed(2)}, predictedChange=${mlPrediction.predictedChangePercent.toFixed(2)}%`
        );

        if (mlPrediction.confidence < CONFIG.mlMinConfidenceForTrade) {
          return {
            executedViaFastPath: false,
            fallbackToColdPath: true,
            reason: `ML confidence too low: ${mlPrediction.confidence.toFixed(2)} < ${CONFIG.mlMinConfidenceForTrade}`
          };
        }
      }
    }

    // Select DEX
    const dex = this.selectDex(signal, policy);
    if (!dex) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: "No allowed DEX available for this signal"
      };
    }

    // Check pool data
    const poolState = this.getPoolStateForToken(signal.tokenAddress, dex);
    if (!poolState) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: `No pool data available for token ${signal.tokenAddress} on DEX ${dex}`
      };
    }

    // Execute swap
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
      const swapResult = await executeSwap(tonClient, swapRequest, tier, dex);

      if (swapResult.ok) {
        return {
          executedViaFastPath: true,
          swapResult,
          fallbackToColdPath: false
        };
      } else {
        return {
          executedViaFastPath: false,
          fallbackToColdPath: true,
          reason: `Swap failed: ${swapResult.error}`
        };
      }
    } catch (error: any) {
      return {
        executedViaFastPath: false,
        fallbackToColdPath: true,
        reason: `FastPath execution error: ${error.message}`
      };
    }
  }
}

// Export a singleton instance
export const fastPathEngine = new FastPathEngine();
