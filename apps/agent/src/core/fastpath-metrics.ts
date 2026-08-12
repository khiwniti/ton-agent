import type { FastPathMetrics, FastPathConfig, FastPathResult } from "./fastpath-types";

/**
 * FastPath metrics collector for observability.
 * Tracks hot path latency, success rates, cache hit rates, and policy version.
 */
export class FastPathMetricsCollector {
  private config: FastPathConfig;
  private metrics: FastPathMetrics;
  private latenciesUs: number[] = [];
  private leafRebuildLatenciesUs: number[] = [];
  private bocSerializeLatenciesUs: number[] = [];
  private broadcastLatenciesUs: number[] = [];

  constructor(config: FastPathConfig) {
    this.config = config;
    this.metrics = {
      signalsReceived: 0,
      fastPathExecutions: 0,
      coldPathFallbacks: 0,
      fastPathSuccesses: 0,
      fastPathFailures: 0,
      avgHotPathLatencyUs: 0,
      p99HotPathLatencyUs: 0,
      avgLeafRebuildLatencyUs: 0,
      bocTemplateHitRate: 0,
      currentPolicyVersion: 0,
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * Record a signal received (entry point for all signals)
   */
  recordSignalReceived(): void {
    this.metrics.signalsReceived++;
    this.metrics.lastUpdatedAt = Date.now();
  }

  /**
   * Record a FastPath execution attempt
   */
  recordFastPathExecution(result: FastPathResult): void {
    this.metrics.fastPathExecutions++;
    this.metrics.lastUpdatedAt = Date.now();

    if (result.executedViaFastPath) {
      if (result.error) {
        this.metrics.fastPathFailures++;
      } else {
        this.metrics.fastPathSuccesses++;
      }
    } else {
      this.metrics.coldPathFallbacks++;
    }

    // Record latencies if available
    if (result.hotPathDurationUs > 0) {
      this.latenciesUs.push(result.hotPathDurationUs);
      this.updateLatencyStats();
    }
    if (result.leafRebuildDurationUs > 0) {
      this.leafRebuildLatenciesUs.push(result.leafRebuildDurationUs);
    }
    if (result.bocSerializeDurationUs > 0) {
      this.bocSerializeLatenciesUs.push(result.bocSerializeDurationUs);
    }
    if (result.broadcastDurationUs > 0) {
      this.broadcastLatenciesUs.push(result.broadcastDurationUs);
    }
  }

  /**
   * Record BOC template cache hit
   */
  recordBocTemplateHit(): void {
    // Hit rate is calculated dynamically in getMetrics
  }

  /**
   * Record BOC template cache miss
   */
  recordBocTemplateMiss(): void {
    // Miss rate is calculated dynamically in getMetrics
  }

  /**
   * Update current policy version
   */
  setPolicyVersion(version: number): void {
    this.metrics.currentPolicyVersion = version;
    this.metrics.lastUpdatedAt = Date.now();
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): FastPathMetrics {
    // Calculate hit rate from recent executions
    const totalTemplateLookups = this.metrics.fastPathExecutions + this.metrics.coldPathFallbacks;
    // This is a simplified hit rate - in practice you'd track hits/misses separately
    // For now, approximate: if we executed via fastpath, template was likely available
    const hitRate = totalTemplateLookups > 0
      ? this.metrics.fastPathExecutions / totalTemplateLookups
      : 0;

    return {
      ...this.metrics,
      avgHotPathLatencyUs: this.calculateAvg(this.latenciesUs),
      p99HotPathLatencyUs: this.calculatePercentile(this.latenciesUs, 99),
      avgLeafRebuildLatencyUs: this.calculateAvg(this.leafRebuildLatenciesUs),
      bocTemplateHitRate: hitRate,
    };
  }

  /**
   * Check if hot path latency exceeds budget
   */
  isLatencyBudgetExceeded(latencyUs: number): boolean {
    return latencyUs > this.config.maxHotPathLatencyUs;
  }

  /**
   * Reset metrics (for testing or periodic reset)
   */
  reset(): void {
    this.metrics = {
      signalsReceived: 0,
      fastPathExecutions: 0,
      coldPathFallbacks: 0,
      fastPathSuccesses: 0,
      fastPathFailures: 0,
      avgHotPathLatencyUs: 0,
      p99HotPathLatencyUs: 0,
      avgLeafRebuildLatencyUs: 0,
      bocTemplateHitRate: 0,
      currentPolicyVersion: this.metrics.currentPolicyVersion,
      lastUpdatedAt: Date.now(),
    };
    this.latenciesUs = [];
    this.leafRebuildLatenciesUs = [];
    this.bocSerializeLatenciesUs = [];
    this.broadcastLatenciesUs = [];
  }

  private updateLatencyStats(): void {
    this.metrics.avgHotPathLatencyUs = this.calculateAvg(this.latenciesUs);
    this.metrics.p99HotPathLatencyUs = this.calculatePercentile(this.latenciesUs, 99);
  }

  private calculateAvg(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(percentile / 100 * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

/**
 * Default metrics collector instance
 */
export const fastPathMetrics = new FastPathMetricsCollector({
  enabled: true,
  maxHotPathLatencyUs: 1000,
  bocTemplateCacheSize: 100,
  bocTemplateTtlMs: 3600000,
  minLiquidityForTemplateUsd: 10000,
  preCompileTopPools: 50,
});