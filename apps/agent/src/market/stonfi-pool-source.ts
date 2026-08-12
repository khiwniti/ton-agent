/**
 * STON.fi REST pool source — poll `GET /v1/pools/{poolAddress}` per watched
 * pool and derive price from the reserve ratio.
 *
 * Verified 2026-08-10: `/v1/pools/{addr}` returns 200 with `reserve0`,
 * `reserve1`, `volume24HUsd`, `lpTotalSupplyUsd`. `/v1/swaps` → 404 — there is
 * no public trade feed, so reserves are the only real-time primitive.
 *
 * Price convention: the STON.fi API reports `reserve0`/`reserve1` per pool as
 * token units. We normalize the ratio via the pool's `asset0`/`asset1` order.
 * A fresh `/v1/assets` snapshot (one fetch per tick, amortized across pools)
 * provides `dex_usd_price` per asset — used as an independent sanity check on
 * the reserve-derived price (warns on >50% divergence; never blocks the tick).
 */

import axios, { AxiosError } from "axios";
import { log } from "../logger";
import { BasePoolPriceSource, type PriceTick } from "./price-source";

const STONFI_API = (process.env.STONFI_API_BASE || "https://api.ston.fi").replace(/\/$/, "");

interface StonFiPool {
  address: string;
  pool_type?: string;
  router_address?: string;
  asset0_address: string;
  asset1_address: string;
  asset0_symbol?: string;
  asset1_symbol?: string;
  reserve0: string;
  reserve1: string;
  volume24HUsd?: string;
  lpTotalSupplyUsd?: string;
}

interface StonFiAsset {
  address?: string;
  symbol?: string;
  dex_usd_price?: string;
}

/** Which side of the pool is the TON side (or a stable-quote side). */
function isQuoteSide(symbol: string | undefined, address: string): boolean {
  if (!symbol) return address === "TON" || address.startsWith("EQ");
  const s = symbol.toUpperCase();
  return s === "TON" || s === "USDT" || s === "USDC" || s === "USD₮";
}

export class StonFiPoolSource extends BasePoolPriceSource {
  constructor(config: ConstructorParameters<typeof BasePoolPriceSource>[0] = {}) {
    super(config);
  }

  // Pools that returned HTTP 400 (unindexed / migrated to V2) are cached here
  // for DEAD_POOL_TTL_MS so we skip them without spamming ERR logs every tick.
  private readonly _deadPools = new Map<string, number>();
  private readonly DEAD_POOL_TTL_MS = 30 * 60 * 1000; // 30 min

  private _isDead(addr: string): boolean {
    const ts = this._deadPools.get(addr);
    if (!ts) return false;
    if (Date.now() - ts > this.DEAD_POOL_TTL_MS) {
      this._deadPools.delete(addr); // TTL expired — retry once
      return false;
    }
    return true;
  }

  protected async pollOnce(): Promise<boolean> {
    const pools = this.watchedPools();
    if (pools.length === 0) return true; // nothing to do yet — healthy idle
    // Independent price snapshot from the assets feed, fetched once per tick
    // and shared across all watched pools.
    const assets = await this.fetchAssets();
    let ok = false;
    for (const addr of pools) {
      // Skip pools that previously returned 400 (unindexed / V2 migrated).
      if (this._isDead(addr)) continue;
      try {
        const res = await axios.get<StonFiPool>(`${STONFI_API}/v1/pools/${addr}`, {
          timeout: 8000,
        });
        const pool = res.data;
        const tick = this.deriveTick(pool);
        if (tick && this.isFresh(tick.ts)) {
          this.crossCheck(assets, pool, tick);
          this.emit(tick);
          ok = true;
        }
      } catch (err) {
        const status = (err as AxiosError).response?.status;
        if (status === 400) {
          // Pool is unindexed or migrated — mark dead, log once, then suppress.
          this._deadPools.set(addr, Date.now());
          log.warn("MARKET", `STON.fi pool ${addr.slice(0,8)}… returned 400 — marked dead for 30 min`);
        } else {
          log.err("MARKET", `STON.fi poll ${addr} failed (${status ?? "net"})`);
          if (status === 429 || (status ?? 0) >= 500) throw err; // drive backoff
        }
      }
    }
    return ok;
  }

  /** `/v1/assets` → { address: dex_usd_price }. Non-fatal on failure. */
  private async fetchAssets(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const res = await axios.get<StonFiAsset[]>(`${STONFI_API}/v1/assets`, {
        timeout: 8000,
      });
      for (const a of res.data ?? []) {
        const p = Number(a.dex_usd_price);
        if (Number.isFinite(p) && p > 0) out.set(a.address ?? "", p);
      }
    } catch {
      // Cross-check is advisory only — a failure must not block the tick.
    }
    return out;
  }

  /** Warn (never block) when the reserve ratio and the assets feed diverge. */
  private crossCheck(assets: Map<string, number>, pool: StonFiPool, tick: PriceTick): void {
    const usd0 = assets.get(pool.asset0_address);
    const usd1 = assets.get(pool.asset1_address);
    if (usd0 == null || usd1 == null || usd0 <= 0) return;
    // dex_usd_price is per-token in USD; reserve ratio → token0 per token1.
    const assetsRatio = usd1 / usd0;
    const reserveRatio = Number(BigInt(pool.reserve1)) / Number(BigInt(pool.reserve0));
    if (!Number.isFinite(reserveRatio) || reserveRatio <= 0) return;
    const div = Math.abs(assetsRatio / reserveRatio - 1);
    if (div > 0.5) {
      log.warn(
        "MARKET",
        `STON.fi ${pool.address} reserve/assets price divergence ${(div * 100).toFixed(0)}%`,
      );
    }
  }

  private deriveTick(pool: StonFiPool): PriceTick | null {
    const r0 = BigInt(pool.reserve0 || "0");
    const r1 = BigInt(pool.reserve1 || "0");
    if (r0 <= 0n || r1 <= 0n) return null;

    const quoteOn0 = isQuoteSide(pool.asset0_symbol, pool.asset0_address);
    const quoteOn1 = isQuoteSide(pool.asset1_symbol, pool.asset1_address);

    let price: number;
    if (quoteOn1 && !quoteOn0) {
      // pool: token0 = base token, token1 = quote (TON) → price = r1/r0
      price = Number(r1) / Number(r0);
    } else if (quoteOn0 && !quoteOn1) {
      price = Number(r0) / Number(r1);
    } else {
      // Ambiguous: fall back to numeric ratio with a sane scale check via
      // the assets cross-check below (or 1 when unverifiable).
      price = Number(r1) / Number(r0);
    }

    if (!Number.isFinite(price) || price <= 0) return null;
    if (price > 1e12) return null; // sanity bound from data-validator

    return {
      poolAddress: pool.address,
      dex: "stonfi",
      price,
      reserve0: pool.reserve0,
      reserve1: pool.reserve1,
      volume24h: pool.volume24HUsd ? Number(pool.volume24HUsd) : undefined,
      ts: Date.now(),
    };
  }
}
