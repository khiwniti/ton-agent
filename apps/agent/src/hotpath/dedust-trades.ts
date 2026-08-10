/**
 * DeDust Trades — Fetches recent trade data from DeDust pools.
 * Used for feed corroboration in position monitoring.
 */
export interface DedustTrade {
  hash: string;
  timestamp: number;
  amount: string;
  price: number;
  side: "buy" | "sell";
}

export interface TradesWindowResult {
  ok: boolean;
  sellTraders24h: number;
  buyTraders24h: number;
  error?: string;
}

/**
 * Fetch recent DeDust trades for a pool (24h window).
 * Placeholder implementation - returns empty result.
 */
export async function fetchTradesWindow(
  poolAddress: string
): Promise<TradesWindowResult> {
  // Placeholder - would query DeDust API or indexer
  return { ok: false, sellTraders24h: 0, buyTraders24h: 0, error: "not implemented" };
}

/**
 * Fetch recent DeDust trades for a pool.
 * Placeholder implementation - returns empty array.
 */
export async function fetchDedustTrades(
  poolAddress: string,
  since: number
): Promise<DedustTrade[]> {
  // Placeholder - would query DeDust API or indexer
  return [];
}

/**
 * Get recent trades for a pool (last N trades).
 * Placeholder implementation - returns empty array.
 */
export async function getRecentTrades(
  poolAddress: string,
  limit: number
): Promise<DedustTrade[]> {
  // Placeholder - would query DeDust API or indexer
  return [];
}