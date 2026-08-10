/**
 * CoinGecko sanity feed — the user asked for CoinGecko as a data source.
 *
 * Reality check on role: brand-new Uranus memepad tokens are NOT listed on
 * CoinGecko for hours/days after launch, so CoinGecko cannot gate entries.
 * It earns its keep in three places:
 *   1. TON→USD rate for USD-denominated risk caps (daily loss, portfolio).
 *   2. Post-migration sanity: a migrated token that shows up on CoinGecko
 *      with a sane market cap is a provenance signal (optional boost).
 *   3. Symbol lookup to detect "impersonation" launches — a token that
 *      copies the ticker of an established CoinGecko coin is NOT that coin.
 *
 * Free tier: ~10-30 req/min unauthenticated; we cache aggressively.
 */
import { log } from "../logger";

const CG_API = "https://api.coingecko.com/api/v3";
const CACHE_TTL_MS = 5 * 60 * 1000;

let tonUsdCache: { at: number; price: number } | null = null;

async function cgGet<T>(path: string, timeoutMs = 8_000): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${CG_API}${path}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch (e) {
    log.warn("COINGECKO", `${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** TON→USD price, cached 5 min. Returns null when unavailable. */
export async function getTonUsd(): Promise<number | null> {
  if (tonUsdCache && Date.now() - tonUsdCache.at < CACHE_TTL_MS) return tonUsdCache.price;
  const j = await cgGet<{ "the-open-network"?: { usd?: number } }>(
    "/simple/price?ids=the-open-network&vs_currencies=usd"
  );
  const price = j?.["the-open-network"]?.usd;
  if (typeof price === "number" && price > 0) {
    tonUsdCache = { at: Date.now(), price };
    return price;
  }
  return tonUsdCache?.price ?? null;
}

export interface CgCoin {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  market_cap?: number;
  current_price?: number;
  total_volume?: number;
}

/** Coins whose symbol matches (case-insensitive) — for impersonation checks. */
export async function searchSymbol(symbol: string): Promise<CgCoin[]> {
  const j = await cgGet<{ coins?: Array<{ id: string; symbol: string; name: string; market_cap_rank: number | null }> }>(
    `/search?query=${encodeURIComponent(symbol)}`
  );
  if (!j?.coins) return [];
  return j.coins
    .filter((c) => c.symbol.toLowerCase() === symbol.toLowerCase())
    .map((c) => ({ ...c, market_cap: undefined, current_price: undefined, total_volume: undefined }));
}

/** TON meme-coin category table (top N by market cap). */
export async function tonMemeCategory(perPage = 20): Promise<CgCoin[]> {
  const j = await cgGet<CgCoin[]>(
    `/coins/markets?vs_currency=usd&category=ton-meme-coins&order=market_cap_desc&per_page=${perPage}&page=1`
  );
  return j ?? [];
}

/**
 * Post-migration sanity: is this symbol known to CoinGecko with a real
 * market cap? Returns null when unknown (fresh launch — expected) or when
 * the API is unavailable.
 */
export async function knownSymbolCap(symbol: string): Promise<number | null> {
  const coins = await searchSymbol(symbol);
  const ranked = coins.find((c) => c.market_cap_rank !== null);
  return ranked?.market_cap_rank ? ranked.market_cap_rank : null;
}
