import { TradingPolicy } from "./policy-types";

/**
 * PolicyTransport — shared-memory transport for TradingPolicy between
 * Cold Path (brain/coordinator) and Hot Path (FastPath).
 *
 * Design goals:
 * - Zero-copy reads for hot path (<0.1ms target)
 * - Versioned policy for stale-policy rejection (FR-001, FR-002)
 * - No external dependencies — pure TS, in-process
 * - Thread-safe via single-writer (cold path) + version counter
 */
export interface PolicyTransport {
  /** Push a new policy version (cold path only) */
  push(policy: TradingPolicy): void;

  /** Subscribe to policy updates (hot path) */
  subscribe(callback: (policy: TradingPolicy, version: number) => void): () => void;

  /** Get current policy version without reading full policy */
  getVersion(): number;

  /** Get current policy snapshot */
  getPolicy(): TradingPolicy | null;

  /** Check if transport has been initialized with a policy */
  isInitialized(): boolean;
}

/**
 * SharedMemoryPolicyTransport — single-process, in-memory implementation.
 * Uses Buffer for policy JSON + atomic version counter.
 * All reads are lock-free; single writer guarantees consistency.
 */
export class SharedMemoryPolicyTransport implements PolicyTransport {
  private policyBuffer: Buffer | null = null;
  private currentVersion: number = 0;
  private subscribers: Set<(policy: TradingPolicy, version: number) => void> = new Set();
  private policyCache: TradingPolicy | null = null;

  /**
   * Push a new policy. Increments version, serializes to buffer, notifies subscribers.
   * @param policy - The new TradingPolicy to publish
   */
  push(policy: TradingPolicy): void {
    // Serialize to JSON buffer (single writer, no locking needed)
    const json = JSON.stringify(policy);
    this.policyBuffer = Buffer.from(json, "utf8");
    // Store a deep copy to prevent external mutations from affecting transport state
    this.policyCache = JSON.parse(json);
    this.currentVersion += 1;

    // Notify all subscribers (synchronous, fast)
    const version = this.currentVersion;
    for (const cb of this.subscribers) {
      try {
        cb(policy, version);
      } catch (err) {
        // Subscriber errors must not break transport
        console.error("[PolicyTransport] Subscriber error:", err);
      }
    }
  }

  /**
   * Subscribe to policy updates.
   * @param callback - Called with (policy, version) on each push
   * @returns Unsubscribe function
   */
  subscribe(callback: (policy: TradingPolicy, version: number) => void): () => void {
    this.subscribers.add(callback);
    // Immediately notify with current policy if exists
    if (this.policyCache && this.currentVersion > 0) {
      try {
        callback(this.policyCache, this.currentVersion);
      } catch (err) {
        console.error("[PolicyTransport] Initial subscriber callback error:", err);
      }
    }
    return () => this.subscribers.delete(callback);
  }

  /** Get current policy version (lock-free, O(1)) */
  getVersion(): number {
    return this.currentVersion;
  }

  /** Get current policy snapshot (lock-free, O(1) parse from buffer) */
  getPolicy(): TradingPolicy | null {
    if (!this.policyBuffer || this.currentVersion === 0) {
      return null;
    }
    // Parse from cached object if available, else from buffer
    if (this.policyCache) {
      return this.policyCache;
    }
    try {
      return JSON.parse(this.policyBuffer.toString("utf8"));
    } catch {
      return null;
    }
  }

  /** Check if transport has been initialized with at least one policy */
  isInitialized(): boolean {
    return this.currentVersion > 0 && this.policyBuffer !== null;
  }
}

/** Singleton instance for app-wide use */
export const policyTransport = new SharedMemoryPolicyTransport();