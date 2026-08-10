/**
 * DeDust REST pool source — poll `GET /v2/pools` once and filter client-side.
 *
 * Verified 2026-08-10: `/v2/pools` returns 200 with `reserve0`, `reserve1`,
 * `lastPrice`, `stats`. `/v2/pools/{addr}` → 404, so filtering is done by
 * address here. The list is fetched once per tick and each watched pool that
 * appears is emitted — amortizes N pools into 1 request.
 */

import axios, { AxiosError } from "axios";
import { log } from "../logger";
import { BasePoolPriceSource, type PriceTick } from "./price-source";

const DEDUST_API = (process.env.DEDUST_API_BASE || "https://mainnet.api.dedust.io").replace(/\/$/, "");

interface DeDustPool {
  address: string;
  assets: string[];
  reserve0: string;
  reserve1: string;
  lastPrice: string;
  stats?: { volumeUsd?: string; tvlUsd?: string };
}

export class DeDustPoolSource extends BasePoolPriceSource {
  protected async pollOnce(): Promise<boolean> {
    const watched = new Set(this.watchedPools());
    if (watched.size === 0) return true;
    try {
      const res = await axios.get<DeDustPool[]>(`${DEDUST_API}/v2/pools`, {
        timeout: 8000,
        params: { limit: 500 },
      });
      if (!Array.isArray(res.data)) return false;
      let touched = false;
      for (const pool of res.data) {
        if (!watched.has(pool.address)) continue;
        const r0 = BigInt(pool.reserve0 || "0");
        const r1 = BigInt(pool.reserve1 || "0");
        if (r0 <= 0n || r1 <= 0n) continue;
        // DeDust price convention: token0 per token1 (lastPrice is 1 USDT per
        // token on TON pairs) — invert for a "stronger = higher" convention.
        const raw = Number(pool.lastPrice);
        const price = raw > 0 && Number.isFinite(raw) ? 1 / raw : Number(r1) / Number(r0);
        if (!Number.isFinite(price) || price <= 0 || price > 1e12) continue;
        this.emit({
          poolAddress: pool.address,
          dex: "dedust",
          price,
          reserve0: pool.reserve0,
          reserve1: pool.reserve1,
          volume24h: pool.stats?.volumeUsd ? Number(pool.stats.volumeUsd) : undefined,
          ts: Date.now(),
        });
        touched = true;
      }
      return touched;
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      log.err("MARKET", `DeDust poll failed (${status ?? "net"})`);
      if (status === 429 || (status ?? 0) >= 500) throw err; // drive backoff
      return false;
    }
  }
}
