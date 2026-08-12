import { Address, TonClient, toNano } from "@ton/ton";
import { Factory, PoolType, Asset, MAINNET_FACTORY_ADDR, ReadinessStatus } from "@dedust/sdk";
import { DEX, pTON } from "@ston-fi/sdk";
import { CONFIG, isTestnet } from "../config";
import { log } from "../logger";

export type PoolSource = "stonfi" | "dedust" | "tonapi" | "none";

export interface PoolResolutionResult {
  poolAddress: string | null;
  liquidityTon: number | null;
  source: PoolSource;
  error?: string;
  resolvedAt: number;
}

/**
 * Ston.fi **v1** mainnet router (verified against the ston-fi/dex-core README
 * and the live on-chain account, which self-identifies as "STON.fi DEX").
 *
 * This must stay in lockstep with `dex/router.ts`, which executes swaps through
 * `DEX.v1.Router`. Resolving a pool with a different protocol version than the
 * one that will execute the swap yields an address the executor cannot trade.
 */
export const STONFI_V1_ROUTER_ADDR = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";

const cache = new Map<string, { result: PoolResolutionResult; ts: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCached(master: string): PoolResolutionResult | null {
  const entry = cache.get(master);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.result;
  cache.delete(master);
  return null;
}

function setCache(master: string, result: PoolResolutionResult): void {
  cache.set(master, { result, ts: Date.now() });
}

function noPoolResult(error?: string): PoolResolutionResult {
  return {
    poolAddress: null,
    liquidityTon: null,
    source: "none",
    error,
    resolvedAt: Date.now(),
  };
}

async function resolveStonfi(
  client: TonClient,
  jettonMaster: Address
): Promise<PoolResolutionResult | null> {
  try {
    // v1 — must match dex/router.ts, which swaps via DEX.v1.Router.
    const router = client.open(DEX.v1.Router.create(STONFI_V1_ROUTER_ADDR));
    const poolAddress = await router.getPoolAddress({
      token0: pTON.v1.address,
      token1: jettonMaster,
    });
    if (!poolAddress) return null;

    // Reserve0 is the TON side. We query the pool as (token0=pTON,
    // token1=jetton), and `dex/router.ts` relies on the same ordering when it
    // reads `token1WalletAddress` as the jetton wallet for buy estimation —
    // so reserve0/token0 is pTON by construction of the query.
    const pool = client.open(DEX.v1.Pool.create(poolAddress));
    let liquidityTon: number | null = null;
    try {
      const data = await pool.getPoolData();
      liquidityTon = Number(data.reserve0) / 1e9;
    } catch {
      // Depth unknown. Leave null so evaluateExecutionConfidence fails closed
      // rather than letting an unmeasured pool through.
    }

    return {
      poolAddress: poolAddress.toString({ bounceable: true, testOnly: false }),
      liquidityTon,
      source: "stonfi",
      resolvedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function resolveDeDust(
  client: TonClient,
  jettonMaster: Address
): Promise<PoolResolutionResult | null> {
  try {
    if (isTestnet()) return null;
    const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
    const tonAsset = Asset.native();
    const jetAsset = Asset.jetton(jettonMaster);
    const pool = await factory.getPool(PoolType.VOLATILE, [tonAsset, jetAsset]);
    if (!pool) return null;

    // getPool() derives the pool address by pure arithmetic — it returns a
    // Pool object even when nothing is deployed on-chain. Calling getReserves()
    // on such a pool throws `exit_code: -13`, which the old empty catch turned
    // into liquidityTon = 0, cached for 24h, failing the 5 TON gate all day.
    // getReadinessStatus() is the correct gate: it short-circuits on a
    // non-active contract state BEFORE calling getReserves, so an undeployed
    // pool is reported as NOT_DEPLOYED instead of throwing. Any non-READY pool
    // returns null here so resolvePool falls through to the (uncached)
    // noPoolResult path instead of caching a depthless address for 24h.
    const openedPool = client.open(pool);
    let readiness: ReadinessStatus;
    try {
      readiness = await openedPool.getReadinessStatus();
    } catch {
      return null;
    }
    if (readiness !== ReadinessStatus.READY) return null;

    let liquidityTon: number;
    try {
      const reserves = await openedPool.getReserves();
      if (!reserves || reserves.length < 2) return null;
      const reserveTon = BigInt(reserves[0]);
      const reserveJetton = BigInt(reserves[1]);
      // Tradability, not just depth: a pool with an empty (or single-dust-unit)
      // jetton side measures positive TON depth yet quotes zero output for any
      // buy — exactly the drained pools that silently died with
      // `cannot-enforce-slippage:no-quote` (task #7). Re-run the same
      // constant-product math as dex/router.ts getSwapQuote against a reference
      // buy of the configured snip size; when no output is possible the pool is
      // depthless for the gate, so report 0 and let the liquidity floor reject it.
      const refBuyNano = toNano(String(CONFIG.strategy.defaultSnipeTon));
      const denom = reserveTon * 1000n + refBuyNano * 997n;
      const refOut = denom > 0n ? (reserveJetton * refBuyNano * 997n) / denom : 0n;
      if (reserveTon <= 0n || reserveJetton <= 0n || refOut <= 0n) {
        liquidityTon = 0;
      } else {
        liquidityTon = Number(reserveTon) / 1e9;
      }
    } catch {
      return null;
    }
    return {
      poolAddress: pool.address.toString({ bounceable: true, testOnly: false }),
      liquidityTon,
      source: "dedust",
      resolvedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function resolvePool(
  client: TonClient,
  jettonMaster: Address
): Promise<PoolResolutionResult> {
  const masterKey = jettonMaster.toString();
  const cached = getCached(masterKey);
  if (cached) return cached;

  const stonfiResult = await resolveStonfi(client, jettonMaster);
  if (stonfiResult) {
    log.info(
      "POOL",
      `stonfi ${masterKey.slice(0, 8)}… liq=${stonfiResult.liquidityTon ?? "?"} TON`
    );
    // Only accept a Ston.fi hit outright when its depth is known. A pool we
    // cannot measure fails the execution-confidence gate anyway, so returning
    // it here would mask a DeDust pool that *is* measurable.
    if (stonfiResult.liquidityTon !== null) {
      setCache(masterKey, stonfiResult);
      return stonfiResult;
    }
  }

  const dedustResult = await resolveDeDust(client, jettonMaster);
  if (dedustResult) {
    log.info(
      "POOL",
      `dedust ${masterKey.slice(0, 8)}… liq=${dedustResult.liquidityTon ?? "?"} TON`
    );
    setCache(masterKey, dedustResult);
    return dedustResult;
  }

  // Fall back to the depthless Ston.fi hit: a pool address with unknown depth
  // still beats "no pool" for callers that only need routing.
  if (stonfiResult) {
    setCache(masterKey, stonfiResult);
    return stonfiResult;
  }

  // Deliberately NOT cached. "No pool" is frequently a transient RPC failure,
  // and a 24h negative cache would blacklist a perfectly tradeable jetton for
  // the rest of the day. Re-resolving costs two RPC calls on the next tick.
  return noPoolResult("no pool found on Ston.fi or DeDust");
}

/**
 * Derive a jetton's TON price from its resolved DEX pool's live reserves.
 *
 * Both STON.fi (pTON-first query) and DeDust (`Asset.native()` first) reserve
 * ordering place the TON side at index 0, so one formula serves both:
 *   priceNano = reserve0(raw TON) × 10^decimals / reserve1(raw jetton)
 * i.e. nanoTON per one whole jetton. BigInt throughout so trillion-supply
 * reserves don't lose precision at Number range. Returns null when the pool
 * is unreadable, the DeDust readiness gate fails, or the derived price is out
 * of a sane bound — callers fall back to TONAPI market_data.
 */
export async function poolPrice(
  client: TonClient,
  jettonMaster: Address,
  pool: PoolResolutionResult,
  jettonDecimals: number,
): Promise<{ priceTon: number; priceNano: bigint } | null> {
  if (!pool.poolAddress || pool.source === "none") return null;
  const dec =
    Number.isFinite(jettonDecimals) && jettonDecimals > 0 ? Math.floor(jettonDecimals) : 9;
  try {
    let tonNano: bigint;
    let jettonRaw: bigint;
    if (pool.source === "stonfi") {
      const poolObj = client.open(DEX.v1.Pool.create(Address.parse(pool.poolAddress)));
      const data = await poolObj.getPoolData();
      tonNano = data.reserve0;
      jettonRaw = data.reserve1;
    } else if (pool.source === "dedust") {
      const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
      const p = await factory.getPool(PoolType.VOLATILE, [
        Asset.native(),
        Asset.jetton(jettonMaster),
      ]);
      const opened = client.open(p);
      const readiness = await opened.getReadinessStatus();
      if (readiness !== ReadinessStatus.READY) return null;
      const reserves = await opened.getReserves();
      if (!reserves || reserves.length < 2) return null;
      tonNano = BigInt(reserves[0]);
      jettonRaw = BigInt(reserves[1]);
    } else {
      return null;
    }
    if (tonNano <= 0n || jettonRaw <= 0n) return null;
    const scale = BigInt(10 ** dec);
    const priceNano = (tonNano * scale) / jettonRaw; // nanoTON per 1 whole jetton
    if (priceNano <= 0n || priceNano > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const priceTon = Number(priceNano) / 1e9;
    if (!Number.isFinite(priceTon) || priceTon <= 0) return null;
    return { priceTon, priceNano };
  } catch {
    return null;
  }
}

/**
 * USD market cap from a pool-derived price + the master's raw total supply.
 * BigInt math; returns null when the result overflows safe Number range.
 */
export function marketCapUsdFromPool(
  priceNano: bigint,
  totalSupplyRaw: bigint,
  jettonDecimals: number,
  tonUsd: number,
): number | null {
  if (priceNano <= 0n || totalSupplyRaw <= 0n) return null;
  if (!Number.isFinite(tonUsd) || tonUsd <= 0) return null;
  const dec =
    Number.isFinite(jettonDecimals) && jettonDecimals > 0 ? Math.floor(jettonDecimals) : 9;
  const scale = BigInt(10 ** dec);
  // Cap in nanoTON = (whole supply) × (nanoTON per whole jetton).
  const capNano = (totalSupplyRaw * priceNano) / scale;
  if (capNano > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return (Number(capNano) / 1e9) * tonUsd;
}