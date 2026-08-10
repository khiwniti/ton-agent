/**
 * Time series storage for market data using TimescaleDB.
 * Stores pool states, trades, and price history for backtesting and analysis.
 */

import { Client } from 'pg';

export interface TimeSeriesData {
  timestamp: number;
  pool_address: string;
  dex: 'stonfi' | 'dedust';
  token0_address: string;
  token1_address: string;
  token0_symbol: string;
  token1_symbol: string;
  price: number;
  liquidity: number;
  volume_24h: number;
  reserve0: string;
  reserve1: string;
}

export interface TradeData {
  timestamp: number;
  pool_address: string;
  dex: 'stonfi' | 'dedust';
  token_in: string;
  token_out: string;
  amount_in: string;
  amount_out: string;
  price: number;
}

export class TimeSeriesStore {
  private client: Client;
  private isConnected = false;
  private readonly connectionString: string;

  constructor(connectionString: string = process.env.DATABASE_URL ?? '') {
    this.connectionString = connectionString;
    this.client = new Client({ connectionString });
  }

  /**
   * Connect to TimescaleDB and initialize tables.
   * Aliased as `initialize` for callers that prefer that name.
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;
    try {
      await this.client.connect();
      this.isConnected = true;
      console.log('[TimeSeriesStore] Connected to TimescaleDB');
      await this.initializeTables();
    } catch (error) {
      console.error('[TimeSeriesStore] Failed to connect:', error);
      // Non-fatal: market data will simply not be persisted
    }
  }

  /** Alias for connect() — used by pool-monitor. */
  async initialize(): Promise<void> {
    return this.connect();
  }

  /**
   * Disconnect from TimescaleDB.
   * Aliased as `close` for callers that prefer that name.
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    try {
      await this.client.end();
    } catch {
      // ignore
    }
    this.isConnected = false;
    console.log('[TimeSeriesStore] Disconnected from TimescaleDB');
  }

  /** Alias for disconnect() — used by pool-monitor. */
  async close(): Promise<void> {
    return this.disconnect();
  }

  /**
   * Insert a single time series data point.
   */
  async insert(data: TimeSeriesData): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    const query = `
      INSERT INTO market_data (
        timestamp, pool_address, dex, token0_address, token1_address,
        token0_symbol, token1_symbol, price, liquidity, volume_24h, reserve0, reserve1
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (timestamp, pool_address) DO UPDATE SET
        price = EXCLUDED.price,
        liquidity = EXCLUDED.liquidity,
        volume_24h = EXCLUDED.volume_24h,
        reserve0 = EXCLUDED.reserve0,
        reserve1 = EXCLUDED.reserve1;
    `;

    const values = [
      data.timestamp,
      data.pool_address,
      data.dex,
      data.token0_address,
      data.token1_address,
      data.token0_symbol,
      data.token1_symbol,
      data.price,
      data.liquidity,
      data.volume_24h,
      data.reserve0,
      data.reserve1,
    ];

    try {
      await this.client.query(query, values);
    } catch (error) {
      console.error('[TimeSeriesStore] Failed to insert data:', error);
    }
  }

  /**
   * Insert multiple time series data points in batch (single Client, manual transaction).
   */
  async insertBatch(data: TimeSeriesData[]): Promise<void> {
    if (!this.isConnected || data.length === 0) {
      return;
    }

    const query = `
      INSERT INTO market_data (
        timestamp, pool_address, dex, token0_address, token1_address,
        token0_symbol, token1_symbol, price, liquidity, volume_24h, reserve0, reserve1
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (timestamp, pool_address) DO UPDATE SET
        price = EXCLUDED.price,
        liquidity = EXCLUDED.liquidity,
        volume_24h = EXCLUDED.volume_24h,
        reserve0 = EXCLUDED.reserve0,
        reserve1 = EXCLUDED.reserve1;
    `;

    try {
      await this.client.query('BEGIN');
      for (const dataPoint of data) {
        const values = [
          dataPoint.timestamp,
          dataPoint.pool_address,
          dataPoint.dex,
          dataPoint.token0_address,
          dataPoint.token1_address,
          dataPoint.token0_symbol,
          dataPoint.token1_symbol,
          dataPoint.price,
          dataPoint.liquidity,
          dataPoint.volume_24h,
          dataPoint.reserve0,
          dataPoint.reserve1,
        ];
        await this.client.query(query, values);
      }
      await this.client.query('COMMIT');
    } catch (error) {
      try { await this.client.query('ROLLBACK'); } catch { /* ignore */ }
      console.error('[TimeSeriesStore] Failed to insert batch:', error);
    }
  }

  /**
   * Insert a trade record.
   */
  async insertTrade(data: TradeData): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    const query = `
      INSERT INTO trades (
        timestamp, pool_address, dex, token_in, token_out, amount_in, amount_out, price
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
    `;

    const values = [
      data.timestamp,
      data.pool_address,
      data.dex,
      data.token_in,
      data.token_out,
      data.amount_in,
      data.amount_out,
      data.price,
    ];

    try {
      await this.client.query(query, values);
    } catch (error) {
      console.error('[TimeSeriesStore] Failed to insert trade:', error);
    }
  }

  /**
   * Query historical data for a pool between two timestamps (ms since epoch).
   */
  async queryPoolData(
    poolAddress: string,
    startTime: number,
    endTime: number
  ): Promise<TimeSeriesData[]> {
    if (!this.isConnected) {
      return [];
    }

    const query = `
      SELECT * FROM market_data
      WHERE pool_address = $1
        AND timestamp >= $2
        AND timestamp <= $3
      ORDER BY timestamp ASC;
    `;

    try {
      const result = await this.client.query(query, [poolAddress, startTime, endTime]);
      return result.rows as TimeSeriesData[];
    } catch (error) {
      console.error('[TimeSeriesStore] Failed to query pool data:', error);
      return [];
    }
  }

  /**
   * Query price series for a pool, returning at most `limit` rows bucketed by `interval`.
   * Used by pool-monitor's getPriceHistory helper.
   */
  async queryPriceSeries(
    poolAddress: string,
    interval: string,
    limit: number
  ): Promise<{ timestamp: Date; price: number }[]> {
    if (!this.isConnected) {
      return [];
    }

    const query = `
      SELECT
        time_bucket($1, to_timestamp(timestamp / 1000)) AS timestamp,
        AVG(price) AS price
      FROM market_data
      WHERE pool_address = $2
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $3;
    `;

    try {
      const result = await this.client.query(query, [interval, poolAddress, limit]);
      return result.rows.map((row: { timestamp: Date; price: string }) => ({
        timestamp: row.timestamp,
        price: Number(row.price),
      }));
    } catch (error) {
      console.error('[TimeSeriesStore] Failed to query price series:', error);
      return [];
    }
  }

  /**
   * Initialize TimescaleDB tables (called internally after connect).
   */
  private async initializeTables(): Promise<void> {
    const createMarketDataTable = `
      CREATE TABLE IF NOT EXISTS market_data (
        timestamp BIGINT NOT NULL,
        pool_address VARCHAR NOT NULL,
        dex VARCHAR NOT NULL,
        token0_address VARCHAR NOT NULL,
        token1_address VARCHAR NOT NULL,
        token0_symbol VARCHAR NOT NULL,
        token1_symbol VARCHAR NOT NULL,
        price NUMERIC NOT NULL,
        liquidity NUMERIC NOT NULL,
        volume_24h NUMERIC,
        reserve0 VARCHAR NOT NULL,
        reserve1 VARCHAR NOT NULL,
        PRIMARY KEY (timestamp, pool_address)
      );
    `;

    const createTradesTable = `
      CREATE TABLE IF NOT EXISTS trades (
        timestamp BIGINT NOT NULL,
        pool_address VARCHAR NOT NULL,
        dex VARCHAR NOT NULL,
        token_in VARCHAR NOT NULL,
        token_out VARCHAR NOT NULL,
        amount_in VARCHAR NOT NULL,
        amount_out VARCHAR NOT NULL,
        price NUMERIC NOT NULL
      );
    `;

    try {
      await this.client.query(createMarketDataTable);
      await this.client.query(createTradesTable);
      console.log('[TimeSeriesStore] Tables initialized');
    } catch (error) {
      console.error('[TimeSeriesStore] Failed to initialize tables (non-fatal):', error);
    }
  }
}
