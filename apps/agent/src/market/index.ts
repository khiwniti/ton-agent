/**
 * Market data module exports.
 * Provides real-time market data infrastructure for the trading bot.
 *
 * Verified 2026-08-10: neither STON.fi nor DeDust exposes a public WebSocket
 * feed (`/ws` → 404 on both). "Real-time" is REST poll → derive → event bus;
 * the pollers in this module are the source of that event bus.
 */

export { PoolMonitorService, poolMonitorService } from './pool-monitor';
export { StonFiPoolSource } from './stonfi-pool-source';
export { DeDustPoolSource } from './dedust-pool-source';
export { BasePoolPriceSource, type PriceTick, type PriceHandler, type PoolPriceSource, type PriceSourceConfig } from './price-source';
export { TimeSeriesStore } from './time-series-store';
export { DataCache, PoolStateCache, TradeCache, poolStateCache, tradeCache } from './data-cache';
export { DataValidator } from './data-validator';
export type { PoolState, Trade } from './data-cache';
export type { PoolState as MarketPoolState, TradeEvent } from './pool-monitor';
