import type { TradingPolicy } from "./policy-types";
import type { FastPathSignal } from "./policy-types";

/**
 * PolicyManager shares the trading policy between the cold path (LLM/reasoning) and hot path (FastPath).
 * It holds the current policy and version to detect stale signals.
 */
export class PolicyManager {
  private currentPolicy: TradingPolicy | null = null;
  private versionCounter = 0;

  /**
   * Update the policy and notify listeners.
   * @param policy - The new trading policy (without version, which we add)
   */
  public updatePolicy(policy: Omit<TradingPolicy, "version">): void {
    this.versionCounter++;
    const newPolicy: TradingPolicy = {
      ...policy,
      version: this.versionCounter,
      updatedAt: Date.now()
    };
    this.currentPolicy = newPolicy;
    console.log(`Policy updated to version ${this.versionCounter}`);
  }

  /**
   * Get the current policy.
   * @returns The current policy or null if none set
   */
  public getPolicy(): TradingPolicy | null {
    return this.currentPolicy;
  }

  /**
   * Check if a signal's policy version matches the current policy.
   * @param signal - The signal to check
   * @returns True if the signal is not stale
   */
  public isPolicyFresh(signal: Pick<FastPathSignal, "policyVersion">): boolean {
    return this.currentPolicy !== null && 
           this.currentPolicy.version === signal.policyVersion;
  }
}

// Singleton instance for use across modules
export const policyManager = new PolicyManager();