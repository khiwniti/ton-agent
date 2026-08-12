import type { TradingPolicy } from "./policy-types";
import type { FastPathSignal } from "./policy-types";
import { policyTransport, SharedMemoryPolicyTransport, type PolicyTransport } from "./policy-transport";

/**
 * PolicyManager shares the trading policy between the cold path (LLM/reasoning) and hot path (FastPath).
 * It holds the current policy and version to detect stale signals.
 * Now delegates to PolicyTransport for zero-copy shared-memory access.
 */
export class PolicyManager {
  private transport: PolicyTransport;

  constructor(transport: PolicyTransport = policyTransport) {
    this.transport = transport;
  }

  /**
   * Update the policy and notify listeners via transport.
   * @param policy - The new trading policy (without version, which we add)
   */
  public updatePolicy(policy: Omit<TradingPolicy, "version">): void {
    const newPolicy: TradingPolicy = {
      ...policy,
      version: this.transport.getVersion() + 1,
      updatedAt: Date.now()
    };
    this.transport.push(newPolicy);
    console.log(`Policy updated to version ${newPolicy.version}`);
  }

  /**
   * Get the current policy from transport.
   * @returns The current policy or null if none set
   */
  public getPolicy(): TradingPolicy | null {
    return this.transport.getPolicy();
  }

  /**
   * Check if a signal's policy version matches the current policy.
   * @param signal - The signal to check
   * @returns True if the signal is not stale
   */
  public isPolicyFresh(signal: Pick<FastPathSignal, "policyVersion">): boolean {
    const currentPolicy = this.transport.getPolicy();
    return currentPolicy !== null &&
           currentPolicy.version === signal.policyVersion;
  }

  /** Get current policy version */
  public getVersion(): number {
    return this.transport.getVersion();
  }

  /** Check if transport is initialized */
  public isInitialized(): boolean {
    return this.transport.isInitialized();
  }

  /** Get underlying transport for advanced use (e.g., direct subscription) */
  public getTransport(): PolicyTransport {
    return this.transport;
  }
}

// Singleton instance for use across modules
export const policyManager = new PolicyManager();

// Export the transport for direct access
export { policyTransport };