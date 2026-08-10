/**
 * In-memory cache layer for market data.
 * Provides fast access to recent pool states and trades with TTL support.
 */

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class DataCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private defaultTTL: number;

  constructor(defaultTTL: number = 60000) {
    this.defaultTTL = defaultTTL;
  }

  /**
   * Set a value in the cache.
   */
  set(key: string, data: T, ttl?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTTL,
    });
  }

  /**
   * Get a value from the cache.
   * Returns null if not found or expired.
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }

    const now = Date.now();
    const age = now - entry.timestamp;

    if (age > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete a key from the cache.
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of entries in the cache.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get all valid (non-expired) values from the cache.
   */
  getAll(): T[] {
    const results: T[] = [];
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      } else {
        results.push(entry.data);
      }
    }
    return results;
  }
  /**
   * Clean up expired entries.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age > entry.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get all keys in the cache.
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values in the cache (excluding expired).
   */
  values(): T[] {
    const now = Date.now();
    const values: T[] = [];

    for (const entry of this.cache.values()) {
      const age = now - entry.timestamp;
      if (age <= entry.ttl) {
        values.push(entry.data);
      }
    }

    return values;
  }
}

/**
 * Cache for pool states with 30-second TTL.
 */
export class PoolStateCache extends DataCache<PoolState> {
  constructor() {
    super(30000); // 30 seconds default TTL
  }
}

/**
 * Cache for recent trades with 60-second TTL.
 */
export class TradeCache extends DataCache<Trade> {
  constructor() {
    super(60000); // 60 seconds default TTL
  }
}

export const poolStateCache = new PoolStateCache();
export const tradeCache = new TradeCache();

export interface PoolState {
  address: string;
  dex: 'stonfi' | 'dedust';
  token0Address: string;
  token1Address: string;
  token0Symbol: string;
  token1Symbol: string;
  reserve0: bigint;
  reserve1: bigint;
  price: number;
  liquidity: number;
  volume24h: number;
  lastUpdate: number;
}

export interface Trade {
  poolAddress: string;
  dex: 'stonfi' | 'dedust';
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  price: number;
  timestamp: number;
}
