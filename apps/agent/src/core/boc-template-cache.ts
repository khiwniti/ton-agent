import type { BocTemplate, BocTemplateMeta, PoolSnapshot } from "./fastpath-types";
import { policyTransport } from "./policy-transport";

/**
 * BOC Template Cache with LRU eviction and TTL support.
 * Provides fast access to pre-compiled swap transaction templates.
 */
export class BocTemplateCache {
  private cache: Map<string, BocTemplateMeta> = new Map();
  private maxSize: number;
  private ttlMs: number;
  private accessOrder: string[] = [];

  constructor(maxSize: number = 100, ttlMs: number = 3600000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Generate cache key from template properties
   */
  private getKey(dex: string, poolAddress: string, tokenAddress: string, side: string): string {
    return `${dex}:${poolAddress}:${tokenAddress}:${side}`;
  }

  /**
   * Get a template from cache if valid
   */
  get(dex: string, poolAddress: string, tokenAddress: string, side: string, currentPolicyVersion: number): BocTemplate | null {
    const key = this.getKey(dex, poolAddress, tokenAddress, side);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check TTL
    const ageMs = Date.now() - entry.template.compiledAt;
    if (ageMs > this.ttlMs) {
      this.delete(key);
      return null;
    }

    // Check policy version (allow within 1 for grace period)
    if (entry.template.policyVersion < currentPolicyVersion - 1) {
      this.delete(key);
      return null;
    }

    // Update access order for LRU
    this.updateAccessOrder(key);
    entry.useCount++;
    entry.lastUsedAt = Date.now();

    return entry.template;
  }

  /**
   * Put a template in cache
   */
  set(template: BocTemplate): void {
    const key = this.getKey(template.dex, template.poolAddress, template.tokenAddress, template.side);

    // Evict if at capacity and this is a new entry
    if (!this.cache.has(key) && this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    const meta: BocTemplateMeta = {
      template,
      useCount: 0,
      lastUsedAt: Date.now(),
    };

    this.cache.set(key, meta);
    this.updateAccessOrder(key);
  }

  /**
   * Delete a specific entry
   */
  delete(key: string): void {
    this.cache.delete(key);
    const idx = this.accessOrder.indexOf(key);
    if (idx >= 0) {
      this.accessOrder.splice(idx, 1);
    }
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number; hitRate: number; entries: BocTemplateMeta[] } {
    let totalUseCount = 0;
    for (const entry of this.cache.values()) {
      totalUseCount += entry.useCount;
    }
    const hitRate = totalUseCount > 0 ? 1 : 0; // Simplified - would need hit/miss tracking for real rate

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate,
      entries: Array.from(this.cache.values()),
    };
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      const ageMs = now - entry.template.compiledAt;
      if (ageMs > this.ttlMs) {
        this.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  private updateAccessOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx >= 0) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(key);
  }

  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;
    const lruKey = this.accessOrder.shift()!;
    this.cache.delete(lruKey);
  }
}

/**
 * Default BOC template cache instance
 */
export const bocTemplateCache = new BocTemplateCache(100, 3600000);

/**
 * PolicyTransport subscription handler for FastPath hot path.
 * Allows the hot path to subscribe to policy updates without polling.
 */
export class FastPathPolicySubscription {
  private unsubscribe: (() => void) | null = null;
  private currentPolicy: { policy: any; version: number } | null = null;
  private onPolicyUpdate: ((policy: any, version: number) => void) | null = null;

  /**
   * Subscribe to policy updates
   * @param onPolicyUpdate - Callback when policy changes
   */
  subscribe(onPolicyUpdate: (policy: any, version: number) => void): void {
    this.onPolicyUpdate = onPolicyUpdate;

    // Get initial policy
    const policy = policyTransport.getPolicy();
    if (policy) {
      this.currentPolicy = { policy, version: policy.version };
      onPolicyUpdate(policy, policy.version);
    }

    // Subscribe to future updates
    this.unsubscribe = policyTransport.subscribe((newPolicy) => {
      this.currentPolicy = { policy: newPolicy, version: newPolicy.version };
      if (this.onPolicyUpdate) {
        this.onPolicyUpdate(newPolicy, newPolicy.version);
      }
    });
  }

  /**
   * Unsubscribe from policy updates
   */
  unsubscribeFromPolicy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Get current policy (synchronous, no RPC)
   */
  getCurrentPolicy(): { policy: any; version: number } | null {
    if (!this.currentPolicy) {
      const policy = policyTransport.getPolicy();
      if (policy) {
        this.currentPolicy = { policy, version: policy.version };
      }
    }
    return this.currentPolicy;
  }

  /**
   * Check if a signal's policy version is fresh
   */
  isPolicyFresh(signalPolicyVersion: number): boolean {
    const current = this.getCurrentPolicy();
    return current !== null && current.version === signalPolicyVersion;
  }
}

/**
 * Default policy subscription instance for FastPath
 */
export const fastPathPolicySubscription = new FastPathPolicySubscription();