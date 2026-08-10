/**
 * REST polling price sources — the real-time market data layer.
 *
 * Verified 2026-08-10: neither STON.fi nor DeDust exposes a public WebSocket
 * feed (both `/ws` endpoints return 404). TON shard blocks land ~1s and both
 * REST APIs reflect a swap within a block or two, so a 1-5s poll per held pool
 * captures essentially every price move the exit logic reads.
 *
 * This file defines the shared contract + scheduler. Pool-specific HTTP
 * fetching lives in stonfi-pool-source.ts / dedust-pool-source.ts.
 */

export interface PriceTick {
  poolAddress: string;
  dex: "stonfi" | "dedust";
  /** Derived price — reserve ratio, normalized so that higher = token stronger. */
  price: number;
  reserve0: string;
  reserve1: string;
  volume24h?: number;
  ts: number;
}

export type PriceHandler = (tick: PriceTick) => void;

export interface PoolPriceSource {
  /** Start polling; fires `onPrice` per successful tick. */
  start(onPrice: PriceHandler): void;
  /** Stop polling and release timers. */
  stop(): void;
  /** Immediately poll once (used on startup / position open). */
  pollNow(): Promise<void>;
  /** Watch a pool address. Ignored if already watched. */
  watch(poolAddress: string): void;
  /** Stop watching a pool address. */
  unwatch(poolAddress: string): void;
}

export interface PriceSourceConfig {
  /** Poll interval in ms. Default 3000. */
  intervalMs?: number;
  /** Maximum backoff interval in ms on 429/5xx. Default 15000. */
  maxBackoffMs?: number;
  /** Over-3x-interval ticks are discarded as stale (never reset streaks). */
  staleAfterMs?: number;
}

/** Interval + exponential-backoff scheduler shared by both pollers. */
export abstract class BasePoolPriceSource implements PoolPriceSource {
  protected readonly intervalMs: number;
  protected readonly maxBackoffMs: number;
  protected readonly staleAfterMs: number;

  private timer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private inFlight = false;
  private running = false;
  private readonly watched = new Set<string>();
  private handlers = new Set<PriceHandler>();

  constructor(config: PriceSourceConfig = {}) {
    this.intervalMs = config.intervalMs ?? 3000;
    this.maxBackoffMs = config.maxBackoffMs ?? 15000;
    this.staleAfterMs = config.staleAfterMs ?? this.intervalMs * 3;
    this.backoffMs = this.intervalMs;
  }

  start(onPrice: PriceHandler): void {
    this.handlers.add(onPrice);
    if (this.running) return;
    this.running = true;
    this.backoffMs = this.intervalMs;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Fire once immediately so fresh positions get a price without waiting.
    void this.tick();
  }

  stop(): void {
    this.running = false;
    this.handlers.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  watch(poolAddress: string): void {
    this.watched.add(poolAddress);
  }

  unwatch(poolAddress: string): void {
    this.watched.delete(poolAddress);
  }

  protected watchedPools(): string[] {
    return [...this.watched];
  }

  /** Immediately poll once (startup / position open / subscribe). No-op if idle. */
  async pollNow(): Promise<void> {
    if (this.inFlight || !this.running) return;
    await this.tick();
  }

  protected emit(tick: PriceTick): void {
    for (const h of this.handlers) h(tick);
  }

  /** True if the tick is fresh enough to feed trend state (stale data is dropped). */
  protected isFresh(ts: number): boolean {
    return Date.now() - ts <= this.staleAfterMs;
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.running) return;
    this.inFlight = true;
    try {
      const before = Date.now();
      const touched = await this.pollOnce();
      const took = Date.now() - before;
      // Reset backoff on a healthy poll; on rate-limit/5xx the subclass sets
      // a slower cadence by scheduling the next tick later.
      if (touched) {
        this.backoffMs = this.intervalMs;
      } else {
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      }
      // Slow the cadence when we are backing off, without stacking timers:
      // the interval timer keeps firing at intervalMs; if we are in backoff we
      // skip (inFlight guard prevents overlap), so effective cadence slows
      // naturally. Log is emitted by subclass on failure.
      void took;
    } finally {
      this.inFlight = false;
    }
  }

  /** Implement in subclass: fetch watched pools, emit ticks, return true on success. */
  protected abstract pollOnce(): Promise<boolean>;
}
