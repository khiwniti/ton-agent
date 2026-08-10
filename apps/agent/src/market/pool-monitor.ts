/**
 * Pool monitor service for real-time market data collection.
 *
 * Drives REST polling sources (STON.fi `/v1/pools/{addr}` + `/v1/assets`,
 * DeDust `/v2/pools`) instead of WebSockets — verified 2026-08-10 that neither
 * DEX exposes a public WS feed (`/ws` → 404 on both). Aggregates data into an
 * in-memory pool-state cache and persists to TimescaleDB on an interval.
 */

import { StonFiPoolSource } from './stonfi-pool-source';
import { DeDustPoolSource } from './dedust-pool-source';
import { TimeSeriesStore } from './time-series-store';
import type { PriceTick, PriceHandler } from './price-source';

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

export interface TradeEvent {
  poolAddress: string;
  dex: 'stonfi' | 'dedust';
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  price: number;
  timestamp: number;
}

export class PoolMonitorService {
  private stonFiSource: StonFiPoolSource;
  private dedustSource: DeDustPoolSource;
  private poolStates: Map<string, PoolState> = new Map();
  private tradeHistory: TradeEvent[] = [];
  private isRunning = false;
  public readonly timeSeriesStore: TimeSeriesStore;
  private persistenceInterval: NodeJS.Timeout | null = null;
  private readonly tickHandlers = new Set<PriceHandler>();

  constructor(timeSeriesStore?: TimeSeriesStore) {
    this.timeSeriesStore = timeSeriesStore ?? new TimeSeriesStore();

    this.stonFiSource = new StonFiPoolSource();
    this.dedustSource = new DeDustPoolSource();
  }

  /**
   * Register a per-tick subscriber. Fired on every fresh polled tick from
   * either DEX — the event bus the exit hot path reads between its own ticks.
   * Returns an unsubscribe closure.
   */
  onTick(handler: PriceHandler): () => void {
    this.tickHandlers.add(handler);
    return () => {
      this.tickHandlers.delete(handler);
    };
  }

  /**
   * Start the pool monitor service.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[PoolMonitor] Already running');
      return;
    }

    console.log('[PoolMonitor] Starting...');

    // Initialize TimescaleDB (non-fatal if DB is unavailable)
    await this.timeSeriesStore.initialize();

    // Wire REST pollers → in-memory pool state
    this.stonFiSource.start(this.handleStonFiTick.bind(this));
    this.dedustSource.start(this.handleDeDustTick.bind(this));

    // Start persistence interval (every 5 seconds)
    this.persistenceInterval = setInterval(() => {
      void this.persistPoolStates();
    }, 5000);

    this.isRunning = true;
    console.log('[PoolMonitor] Started successfully');
  }

  /**
   * Stop the pool monitor service.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.warn('[PoolMonitor] Not running');
      return;
    }

    console.log('[PoolMonitor] Stopping...');

    // Stop REST pollers
    this.stonFiSource.stop();
    this.dedustSource.stop();

    // Clear persistence interval
    if (this.persistenceInterval) {
      clearInterval(this.persistenceInterval);
      this.persistenceInterval = null;
    }

    // Persist final state
    await this.persistPoolStates();

    // Close TimescaleDB connection
    await this.timeSeriesStore.close();

    this.isRunning = false;
    console.log('[PoolMonitor] Stopped');
  }

  /**
   * Watch a pool so its state is polled and cached.
   */
  subscribeToPool(poolAddress: string, dex: 'stonfi' | 'dedust'): () => void {
    const source = dex === 'stonfi' ? this.stonFiSource : this.dedustSource;
    source.watch(poolAddress);
    // Fire once immediately so the cache populates without waiting a tick.
    void this.pollOnce(dex);
    return () => source.unwatch(poolAddress);
  }

  /**
   * Get current state for a specific pool.
   * Accepts an optional dex parameter for compatibility; the map key is poolAddress only.
   */
  getPoolState(poolAddress: string, _dex?: 'stonfi' | 'dedust'): PoolState | undefined {
    return this.poolStates.get(poolAddress);
  }

  /**
   * Get all pool states.
   */
  getAllPoolStates(): PoolState[] {
    return Array.from(this.poolStates.values());
  }

  /**
   * Alias for getAllPoolStates — used by mcp/tools.
   */
  getAllPools(_dex?: 'stonfi' | 'dedust'): PoolState[] {
    const all = this.getAllPoolStates();
    if (_dex) return all.filter(p => p.dex === _dex);
    return all;
  }

  /**
   * Get recent trade history.
   */
  getTradeHistory(limit: number = 100): TradeEvent[] {
    return this.tradeHistory.slice(-limit);
  }

  /**
   * Get price history from TimescaleDB.
   */
  async getPriceHistory(
    poolAddress: string,
    _startTime: Date,
    _endTime: Date
  ): Promise<{ timestamp: Date; price: number }[]> {
    return this.timeSeriesStore.queryPriceSeries(poolAddress, '1 hour', 100);
  }

  private async pollOnce(dex: 'stonfi' | 'dedust'): Promise<void> {
    try {
      if (dex === 'stonfi') {
        await this.stonFiSource.pollNow();
      } else {
        await this.dedustSource.pollNow();
      }
    } catch {
      // Non-fatal: next scheduled tick will retry.
    }
  }

  private handleStonFiTick(tick: PriceTick): void {
    this.upsertFromTick(tick);
    for (const h of this.tickHandlers) h(tick);
  }

  private handleDeDustTick(tick: PriceTick): void {
    this.upsertFromTick(tick);
    for (const h of this.tickHandlers) h(tick);
  }

  private upsertFromTick(tick: PriceTick): void {
    const existing = this.poolStates.get(tick.poolAddress);
    const state: PoolState = {
      address: tick.poolAddress,
      dex: tick.dex,
      token0Address: existing?.token0Address ?? '',
      token1Address: existing?.token1Address ?? '',
      token0Symbol: existing?.token0Symbol ?? '',
      token1Symbol: existing?.token1Symbol ?? '',
      reserve0: BigInt(tick.reserve0 || '0'),
      reserve1: BigInt(tick.reserve1 || '0'),
      price: tick.price,
      liquidity: existing?.liquidity ?? 0,
      volume24h: tick.volume24h ?? existing?.volume24h ?? 0,
      lastUpdate: tick.ts,
    };
    this.poolStates.set(tick.poolAddress, state);
  }

  private async persistPoolStates(): Promise<void> {
    const dataPoints = Array.from(this.poolStates.values()).map(state => ({
      timestamp: state.lastUpdate,
      dex: state.dex,
      pool_address: state.address,
      token0_address: state.token0Address,
      token1_address: state.token1Address,
      token0_symbol: state.token0Symbol,
      token1_symbol: state.token1Symbol,
      price: state.price,
      liquidity: state.liquidity,
      volume_24h: state.volume24h,
      reserve0: state.reserve0.toString(),
      reserve1: state.reserve1.toString(),
    }));

    if (dataPoints.length > 0) {
      await this.timeSeriesStore.insertBatch(dataPoints);
    }
  }
}

export const poolMonitorService = new PoolMonitorService();
