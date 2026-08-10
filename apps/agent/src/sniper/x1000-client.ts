/**
 * x1000 (DeDust v4) API client — the authoritative execution path for
 * Uranus memepad (dedust_v3_memepad) tokens.
 *
 * Protocol research (2026-08-06, on-chain + frontend reverse-engineering):
 *   • Launches are listed by the DeDust public coins API; each coin carries
 *     `memecoin_extra_details` (curve_ton_collected / curve_ton_max,
 *     holders, verification_level, tags).
 *   • Buys/sells are NOT hand-built here: POST /v4/router/quote then
 *     POST /v4/router/swap returns the exact signed payload — {address,
 *     amount, payload BOC} — identical to the messages observed on-chain
 *     (buy opcode 0x94826557 → jetton master; sell opcode 0xb7459e2c →
 *     per-token memepad contract). Building payloads by hand would require
 *     re-implementing curve math + fee routing; the router API does it for
 *     us and matches what the x1000 frontend itself sends.
 *   • Fill confirmation: POST /v2/traces with msg_hash[] (DeDust proxies
 *     the TonAPI trace API) returns trace_state + per-tx compute success.
 *
 * All endpoints are public (no auth). Rate limits are generous; we still
 * use the repo's retry/backoff discipline for 429s.
 */
import axios, { AxiosError } from "axios";
import { Cell, Address } from "@ton/ton";
import { log } from "../logger";
import { CONFIG } from "../config";

export const DEDUST_API =
  (process.env.DEDUST_API_BASE || "https://mainnet.api.dedust.io").replace(/\/$/, "");

const AFFILIATE = { partner_id: "x1000", referrer_id: "x1000" };

// ── Types (mirror the DeDust v4 API shapes we consume) ─────────────

export interface MemecoinExtraDetails {
  author: string;
  contract_type: string;
  curve_ton_collected: string; // nanoTON currently in the curve
  curve_ton_max: string; // nanoTON at which migration triggers
  migrated: boolean;
  migration_ton?: string;
}

/** Windowed metric buckets returned by the DeDust v4 coins API. */
export interface TradeWindow {
  m15?: number;
  h1?: number;
  h6?: number;
  h24?: number;
  d7?: number;
}

export interface X1000Coin {
  asset: string; // "jetton:0:<hex>"
  created_at: string; // ISO
  /**
   * ⚠️ ALWAYS 0 for memepad coins — the upstream API does not populate this
   * field for `dedust_v3_memepad` tags (verified against 50 live coins,
   * 2026-08-07). Do NOT gate on it. Use `traders.buy` instead.
   */
  holders?: number;
  market_cap?: string;
  liquidity?: string;
  volume?: string;
  price?: string;
  /**
   * Trade COUNTS per window. NOTE: the DeDust v4 API emits
   * {m15,h1,h6,h24,d7} — there is NO `d1` key. Reading `d1` yields
   * undefined and silently scores 0.
   */
  transactions?: {
    buy: TradeWindow;
    sell: TradeWindow;
  };
  /**
   * DISTINCT WALLET counts per window. Preferred over `transactions` for
   * rug-resistance: one wallet can inflate trade count by round-tripping,
   * but distinct-wallet count is harder (not impossible) to fake.
   */
  traders?: {
    buy: TradeWindow;
    sell: TradeWindow;
    total?: TradeWindow;
  };
  verification_level: number;
  tags?: string[];
  metadata?: {
    name: string;
    ticker: string;
    description?: string;
    image?: string;
    decimals: number;
    social_links?: string[];
  };
  memecoin_extra_details?: MemecoinExtraDetails;
}

export interface LaunchPage {
  items: X1000Coin[];
  total?: number;
}

export interface RouterQuote {
  in_amount: string;
  out_amount: string;
  swap_data: unknown;
  display_data?: unknown[];
  /**
   * FALSE when the router cannot route this pair (dead/empty pool, migrated,
   * unverified). The endpoint still returns HTTP 200 with out_amount "0" —
   * this flag is the real error channel, not the status code.
   */
  swap_is_possible?: boolean;
  price_impact?: number;
}

export interface SwapTransaction {
  address: string; // destination contract (jetton master / memepad)
  amount: string; // nanoTON to attach (includes network fee)
  payload: string; // base64 BOC
}

export interface SwapPayload {
  query_id: string;
  transactions: SwapTransaction[];
}

export interface TraceSummary {
  trace_state: "complete" | "pending" | "aborted" | "noop";
  all_compute_ok: boolean;
  tx_count: number;
}

// ── HTTP plumbing ───────────────────────────────────────────────────

const http = axios.create({ timeout: 12_000 });

async function post<T>(path: string, body: unknown): Promise<T> {
  const url = `${DEDUST_API}${path}`;
  let attempt = 0;
  for (;;) {
    try {
      const r = await http.post<T>(url, body, {
        headers: { "Content-Type": "application/json" },
      });
      return r.data;
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: unknown }; message?: string };
      const status = err?.response?.status;
      if (status === 429 || !status || status >= 500) {
        if (attempt >= 4) throw new Error(`dedust ${path} failed after retries: ${err?.message}`);
        attempt += 1;
        const backoff = Math.min(60_000, 1_000 * 2 ** attempt) + Math.random() * 1_000;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, backoff);
        await promise;
        continue;
      }
      throw new Error(`dedust ${path} ${status}: ${JSON.stringify(err?.response?.data ?? err?.message).slice(0, 300)}`);
    }
  }
}

async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const url = `${DEDUST_API}${path}`;
  try {
    const r = await http.get<T>(url, { params });
    return r.data;
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: unknown }; message?: string };
    const status = err?.response?.status;
    if (status === 429 || !status || status >= 500) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 2_000 + Math.random() * 1_000);
      await promise;
      return (await http.get<T>(url, { params })).data;
    }
    throw new Error(`dedust GET ${path} ${status}: ${JSON.stringify(err?.response?.data ?? err?.message).slice(0, 300)}`);
  }
}

// ── Discovery ───────────────────────────────────────────────────────

/**
 * Newest Uranus memepad launches (bonding-curve phase only, migrated
 * tokens excluded by the curve filter). `filter_by_level=4,3` skips
 * unverified junk; pass `level` to widen if wanted.
 */
export async function fetchNewLaunches(opts: {
  limit?: number;
  maxCurvePct?: number; // 0..100 — exclude nearly-migrated tokens
  level?: string; // default "4,3"
}): Promise<X1000Coin[]> {
  const { limit = 30, maxCurvePct = 60, level = "4,3" } = opts;
  const params: Record<string, unknown> = {
    memecoin_extra_details: "true",
    sort_by: "age",
    sort_direction: "desc",
    sort_period: "24h",
    filter_period: "24h",
    include_without_price: "true",
    skip_total_count: "true",
    filter_by_tags: "dedust_v3_memepad",
    filter_by_level: level,
    bonding_curve_percentage_max: String(maxCurvePct),
    compact: "false",
  };
  const page = await get<LaunchPage>("/v4/api/coins", params);
  return (page.items || []).slice(0, limit);
}

/**
 * Single coin record (fresh data for the monitor loop).
 *
 * NOTE: the DeDust v4 API has NO `/v4/api/coins/{asset}` path route — it 404s
 * for both raw and URL-encoded assets. The coin must be requested through the
 * LIST endpoint filtered by `filter_by_assets` (verified 2026-08-07).
 *
 * ⚠️ This API silently IGNORES unrecognised query params and returns the full
 * unfiltered page (HTTP 200). `asset=`, `address=` and `search=` all look like
 * they work but return 20 rows. Only `filter_by_assets` actually filters, so
 * the exact-match `.find()` below is load-bearing, not belt-and-braces.
 * Getting this wrong is silent: the caller sees `null` and loses `migrated`.
 */
export async function fetchCoin(asset: string): Promise<X1000Coin | null> {
  try {
    const page = await get<LaunchPage>("/v4/api/coins", {
      filter_by_assets: asset,
      memecoin_extra_details: "true",
      include_without_price: "true",
      skip_total_count: "true",
      compact: "false",
    });
    // Defensive: unknown query params are silently IGNORED by this API and it
    // returns the full unfiltered page, so never trust items[0] — match exactly.
    return page.items?.find((c) => c.asset === asset) ?? null;
  } catch {
    return null;
  }
}

// ── Quotes & payloads ───────────────────────────────────────────────

export interface QuoteRequest {
  inMinter: string; // "native" | "jetton:0:<hex>"
  outMinter: string;
  amountNano: string; // exact_in amount
  slippageBps: number;
  protocols?: string[];
}

/** Price quote for a memepad route (buy: native→jetton, sell: jetton→native). */
export async function getMemepadQuote(req: QuoteRequest): Promise<RouterQuote> {
  const body = {
    in_minter: req.inMinter,
    out_minter: req.outMinter,
    amount: req.amountNano,
    swap_mode: "exact_in",
    only_verified_pools: true,
    slippage_bps: req.slippageBps,
    max_splits: 5,
    max_length: 2, // DeDust v4 rejects max_length >= 3
    min_pool_usd_tvl: "0",
    min_economy_bps: 0,
    protocols: req.protocols ?? ["dedust_v3_memepad"],
    dedust_v3_affiliate_details: AFFILIATE,
  };
  const q = await post<RouterQuote>("/v4/router/quote", body);
  // The router answers HTTP 200 for unroutable pairs with
  // {swap_is_possible:false, out_amount:"0", swap_data:null}. Fail closed on
  // ALL THREE: "0" is a truthy string, so a downstream `!out_amount` guard
  // does not catch it, and a 0 price reads as -100% PnL — which trips the
  // stop-loss and force-sells a healthy position on a transient outage.
  if (q?.swap_is_possible === false) {
    throw new Error("quote: swap_is_possible=false (unroutable pair)");
  }
  if (!q?.swap_data) throw new Error("quote returned no swap_data");
  if (!q.out_amount || BigInt(q.out_amount) <= 0n) {
    throw new Error(`quote: non-positive out_amount ${q.out_amount}`);
  }
  return q;
}

/**
 * Build the exact swap message(s) the wallet must sign+send.
 * Returns the tx list; each tx = {to, valueNano, bodyCell}.
 */
export async function buildSwapPayload(opts: {
  swapData: unknown;
  senderAddress: string; // non-bounceable form: "0:<hex>"
}): Promise<SwapTransaction[]> {
  const body = {
    include_external_boc: false,
    jetton_wallet_state_init: null,
    custom_payload: null,
    sender_address: opts.senderAddress,
    swap_data: opts.swapData,
    external_tag: "x1000-trading-terminal",
  };
  const r = await post<SwapPayload>("/v4/router/swap", body);
  if (!r?.transactions?.length) throw new Error("swap returned no transactions");
  return r.transactions;
}

// ── Fill confirmation ───────────────────────────────────────────────

/**
 * Poll the trace API for a broadcast message hash until the trace is
 * complete. Returns null while pending. Throws when the trace shows a
 * compute failure (swap reverted).
 */
interface TraceTx {
  description?: { compute_ph?: { success?: boolean } };
}

interface TraceShape {
  traces?: Array<{
    trace_info?: { trace_state?: string };
    transactions?: Record<string, TraceTx>;
  }>;
}

export async function getTraceStatus(msgHashHex: string): Promise<TraceSummary | null> {
  const body = { msg_hash: [msgHashHex] };
  const r = await post<TraceShape>("/v2/traces", body);
  const trace = r?.traces?.[0];
  if (!trace || !trace.trace_info?.trace_state) return null;
  const txs = trace.transactions ? Object.values(trace.transactions) : [];
  const allOk = txs.every((t) => t.description?.compute_ph?.success !== false);
  return {
    trace_state: trace.trace_info.trace_state as TraceSummary["trace_state"],
    all_compute_ok: allOk,
    tx_count: txs.length,
  };
}

/** Broadcast a signed external message (base64 BOC) via the DeDust /send endpoint. */
export async function broadcastBoc(bocBase64: string): Promise<void> {
  await post("/send", { boc: bocBase64 });
}

// ── Helpers ─────────────────────────────────────────────────────────

export function assetToMaster(asset: string): string {
  if (asset.startsWith("jetton:")) return asset.slice("jetton:".length);
  return asset;
}

export function masterToAsset(master: string): string {
  return master.startsWith("0:") || master.startsWith("-1:") ? `jetton:${master}` : master;
}

/** Flat TON gas attached to one memepad router swap. Measured against live
 *  quotes 2026-08-07: `network_fee` is 0.1 TON in BOTH directions and does not
 *  scale with trade size, so a round trip costs ~0.2 TON regardless of lot.
 *  Any PnL or sizing math that ignores this is wrong by that amount. */
export const ROUTER_GAS_TON = 0.1;

/** Round-trip gas for one position (entry + exit). */
export const ROUND_TRIP_GAS_TON = ROUTER_GAS_TON * 2;

export function nanoToTon(nano: string | number | bigint | undefined): number {
  if (nano === undefined || nano === null || nano === "") return 0;
  return Number(BigInt(nano)) / 1e9;
}

export function parseCellFromB64(payload: string): Cell {
  return Cell.fromBase64(payload);
}

export function makeAddress(addr: string): Address {
  return Address.parse(addr);
}

export function logAxiosError(label: string, e: unknown): void {
  if (e instanceof AxiosError) {
    log.err("X1000", `${label}: ${e.response?.status} ${JSON.stringify(e.response?.data ?? e.message).slice(0, 240)}`);
  } else if (e instanceof Error) {
    log.err("X1000", `${label}: ${e.message}`);
  } else {
    log.err("X1000", `${label}: ${String(e)}`);
  }
}

export { CONFIG };
