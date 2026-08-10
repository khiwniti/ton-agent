/**
 * Sniper risk gates — PURE functions, unit-tested (test/sniper-filters.test.ts).
 *
 * The launchpad market is dominated by spam and rug-adjacent tokens, so a
 * sniper's edge is mostly *not buying garbage*. Every gate here is
 * intentionally conservative; a launch must pass ALL hard gates and reach
 * the score floor before the engine even requests a quote.
 *
 * Gate model:
 *   • HARD gates — fail-closed. verification level, liquidity floor,
 *     curve band, metadata sanity, symbol shape.
 *   • SOFT gates — score 0..100. Holder count, buy/sell balance, curve
 *     progress band, social links, ticker uniqueness in the scan window.
 */
import type { X1000Coin } from "./x1000-client";
import { nanoToTon } from "./x1000-client";

export interface SniperGateConfig {
  minVerificationLevel: number; // default 3 (DeDust "verified")
  minCurveTon: number; // curve_ton_collected floor (liquidity floor), TON
  maxCurvePct: number; // skip tokens near migration, 0..100
  /**
   * Minimum DISTINCT BUYER WALLETS in the 24h window.
   *
   * Replaces the former `minHolders` gate: the upstream API returns
   * `holders: 0` for every memepad coin, so gating on it rejected 100% of
   * candidates silently. `traders.buy.h24` is populated and measures the
   * same thing we actually cared about — is anyone other than the deployer
   * buying. Threshold intentionally carried over unchanged (3).
   */
  minDistinctBuyers: number;
  maxAgeSec: number; // ignore stale launches
  minScore: number; // soft-score floor for entry
  rejectTokenPatterns: RegExp[]; // spam name/symbol heuristics
}

export const DEFAULT_GATE_CONFIG: SniperGateConfig = {
  minVerificationLevel: 3,
  minCurveTon: 5,
  maxCurvePct: 60,
  minDistinctBuyers: 3,
  maxAgeSec: 24 * 3600,
  minScore: 55,
  rejectTokenPatterns: [
    /^a\d{4,}$/i, // "a12345" factory spam
    /^(test|faucet|airdrop|claim|bonus|free)/i,
    /[^\x20-\x7e]/,
  ],
};

export interface GateCtx {
  now: number;
  seenTickers: Map<string, number>; // ticker → first-seen ms in current window
  tonUsd?: number;
}

export interface GateResult {
  pass: boolean;
  reasons: string[]; // human-readable reject reasons (empty when pass)
  score: number; // soft score 0..100 (meaningful only when pass)
}


/** Spam heuristics on the token metadata itself. */
export function metadataSanity(c: X1000Coin): string[] {
  const out: string[] = [];
  const m = c.metadata;
  if (!m || !m.name || !m.ticker) out.push("no metadata");
  else {
    if (m.name.length < 2 || m.name.length > 64) out.push("bad name length");
    if (!/^[A-Za-z0-9]{3,10}$/.test(m.ticker)) out.push("bad ticker shape");
    if (m.description && m.description.length > 500) out.push("oversized description");
  }
  return out;
}

/**
 * Distinct buyer/seller WALLETS in the 24h window.
 *
 * Reads `traders` (distinct wallets), NOT `transactions` (raw trade counts):
 * a single wallet round-tripping inflates trade count but not wallet count.
 *
 * ⚠️ The API window keys are {m15,h1,h6,h24,d7}. There is NO `d1`. The former
 * code read `.d1` and got `undefined` on every call, so every participation
 * signal scored 0.
 *
 * No cross-window fallback on purpose. Observed live payloads often repeat the
 * same value across every bucket, so falling back h24→h6→h1 cannot distinguish
 * "quiet for 24h" from "missing bucket" and would silently inflate the gate in
 * our favour. Absent h24 reads as 0 and fails closed.
 */
export function participation(c: X1000Coin): { buyers: number; sellers: number } {
  return {
    buyers: c.traders?.buy?.h24 ?? 0,
    sellers: c.traders?.sell?.h24 ?? 0,
  };
}

/** Curve metrics in TON + percent. */
export function curveMetrics(c: X1000Coin): { collectedTon: number; maxTon: number; pct: number } {
  const d = c.memecoin_extra_details;
  const collectedTon = nanoToTon(d?.curve_ton_collected);
  const maxTon = nanoToTon(d?.curve_ton_max) || 2550; // Uranus standard cap
  const pct = maxTon > 0 ? (collectedTon / maxTon) * 100 : 0;
  return { collectedTon, maxTon, pct };
}

/** Hard gates — any failure → reject. Returns reasons (empty = pass). */
export function hardGates(c: X1000Coin, cfg: SniperGateConfig, ctx: GateCtx): string[] {
  const reasons: string[] = [];
  const { collectedTon, pct } = curveMetrics(c);

  if (typeof c.verification_level !== "number" || c.verification_level < cfg.minVerificationLevel) {
    reasons.push(`verification ${c.verification_level} < ${cfg.minVerificationLevel}`);
  }
  if (collectedTon < cfg.minCurveTon) {
    reasons.push(`curve ${collectedTon.toFixed(2)} TON < ${cfg.minCurveTon} floor`);
  }
  if (pct > cfg.maxCurvePct) {
    reasons.push(`curve ${pct.toFixed(1)}% > ${cfg.maxCurvePct}% band`);
  }
  const { buyers } = participation(c);
  if (buyers < cfg.minDistinctBuyers) {
    reasons.push(`distinct buyers ${buyers} < ${cfg.minDistinctBuyers}`);
  }
  const age = ctx.now - new Date(c.created_at).getTime();
  if (Number.isFinite(age) && (age < -60_000 || age > cfg.maxAgeSec * 1000)) {
    reasons.push(`age ${Math.round(age / 1000)}s outside window`);
  }
  for (const r of metadataSanity(c)) reasons.push(r);
  if (c.memecoin_extra_details?.migrated) reasons.push("already migrated");
  if (c.tags?.includes("scam") || c.tags?.includes("spam")) reasons.push("scam/spam tag");

  const name = c.metadata?.name ?? "";
  const ticker = c.metadata?.ticker ?? "";
  const blob = `${name} ${ticker}`;
  const fields = [name, ticker, blob];
  for (const p of cfg.rejectTokenPatterns) {
    if (fields.some((f) => p.test(f))) reasons.push(`pattern ${p}`);
  }
  return reasons;
}

/** Soft score 0..100 — used as the entry quality floor. */
export function softScore(c: X1000Coin, ctx: GateCtx): number {
  let score = 30; // base
  // Was `c.holders` — always 0 for memepad coins, so this block contributed
  // nothing. Distinct buyer wallets are the live equivalent.
  const { buyers, sellers } = participation(c);
  if (buyers >= 50) score += 25;
  else if (buyers >= 15) score += 15;
  else if (buyers >= DEFAULT_GATE_CONFIG.minDistinctBuyers) score += 5;

  const { pct } = curveMetrics(c);
  // Sweet spot: past the initial rug-check churn but before migration chaos.
  if (pct >= 8 && pct <= 45) score += 20;
  else if (pct > 45) score += 8;
  else score += 5;

  // Was `c.transactions.buy.d1` / `.sell.d1` — the API has no `d1` key, so
  // both read undefined and this whole block (worth up to +30) never fired.
  const total = buyers + sellers;
  if (total >= 5) {
    score += Math.min(20, 5 + total);
    if (sellers > 0 && buyers / sellers >= 1.5) score += 10; // buy pressure
  }

  const links = c.metadata?.social_links?.length ?? 0;
  if (links >= 2) score += 5;
  else if (links >= 1) score += 2;

  const ticker = c.metadata?.ticker?.toLowerCase() ?? "";
  if (ticker && ctx.seenTickers.has(ticker)) {
    // Duplicate ticker in the window = batch-launch spam. No bonus; the
    // engine can optionally apply a hard penalty via config.
    score -= 15;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}


/** Full evaluation — used by the scan tick. */
export function evaluateLaunch(c: X1000Coin, cfg: SniperGateConfig, ctx: GateCtx): GateResult {
  const reasons = hardGates(c, cfg, ctx);
  if (reasons.length > 0) return { pass: false, reasons, score: 0 };
  const score = softScore(c, ctx);
  if (score < cfg.minScore) return { pass: false, reasons: [`score ${score} < ${cfg.minScore}`], score };
  return { pass: true, reasons: [], score };
}

// ── Exit decisions (pure) ───────────────────────────────────────────

export interface ExitState {
  entryPriceTon: number; // TON per token at entry
  currentPriceTon: number;
  stopLossPct: number; // e.g. 35 → hard loss floor
  /**
   * Confirmed significant downtrend flip from exit/trend-monitor.ts
   * (operator directive 2026-08-09). When true → full `trend_exit`.
   */
  trendBearish?: boolean;
  /** Human-readable trend signal, journaled verbatim. */
  trendReason?: string;
  /**
   * Position notional at entry in TON. Used by the gas-aware noise floor:
   * closing a small lot is eaten alive by the flat round-trip router gas.
   */
  positionTon?: number;
  /** Flat round-trip router gas in TON (defaults to 0.2). */
  roundTripGasTon?: number;
}

export type ExitAction =
  | { action: "hold"; reason?: string }
  | { action: "stop_loss"; reason: string }
  | { action: "trend_exit"; reason: string };

/**
 * Net proceed from closing at `pnlPct` on a position of `positionTon`, after
 * the flat round-trip router gas. A close that nets NEGATIVE relative to the
 * cost basis is a guaranteed loss even when the price move is positive —
 * the trap that makes small lots unattractive to close.
 */
export function netProceedsTon(pnlPct: number, positionTon: number, gasTon: number): number {
  const gross = positionTon * (1 + pnlPct / 100);
  return gross - gasTon;
}

/**
 * Pure exit decision — unit-tested.
 *
 * 2026-08-09 OPERATOR DIRECTIVE: no take-profit targets, no trailing stop.
 * Winners ride the trend and close when it SIGNIFICANTLY flips to downtrend
 * (`trend_exit`); the static stop-loss is the hard loss floor. A confirmed
 * trend flip outranks the stop: acting on STRUCTURE instead of a price level
 * is what prevents the stop from being gapped through on an illiquid curve
 * (GULYA realized -80.5% against a -35% stop).
 *
 * 2026-08-09 GAS-AWARE NOISE FLOOR: the router gas is a flat 0.2 TON round
 * trip, so closing a small lot is dominated by gas. A confirmed flip on a
 * GROSS WINNER fires unconditionally (that is the point of riding winners).
 * A confirmed flip on a gross LOSER below the stop also fires (GULYA
 * gap-through protection — structure beats the price level). But a confirmed
 * flip on a shallow gross loser ABOVE the stop (PAWZ at −2% on a 0.44 lot,
 * where gas is 46% of notional) is a NOISE FLOOR: the exit cannot be proven
 * to save money, and firing would lock a net loss that the flat gas makes
 * permanent. Those hold, with the gas math journaled for the operator.
 */
export function decideExit(s: ExitState): ExitAction {
  const pnlPct = s.entryPriceTon > 0 ? (s.currentPriceTon / s.entryPriceTon - 1) * 100 : -100;
  const positionTon = s.positionTon ?? 1; // conservative default: assume viable size
  const gasTon = s.roundTripGasTon ?? 0.2;

  if (s.trendBearish) {
    // Winner → close on structure (operator rule). Gross loser BELOW the
    // stop → the stop was gapped through; structure outranks the level.
    if (pnlPct > 0 || pnlPct <= -Math.abs(s.stopLossPct)) {
      return {
        action: "trend_exit",
        reason: `trend flipped to downtrend: ${s.trendReason ?? "confirmed bearish"}`,
      };
    }
    // Shallow gross loser above the stop: gas dominates the outcome. Closing
    // now nets ${...}, and the flip is not proof the position is doomed.
    const net = netProceedsTon(pnlPct, positionTon, gasTon);
    return {
      action: "hold",
      reason:
        `trend flip on shallow loss: ${s.trendReason ?? "confirmed bearish"} but pnl ${pnlPct.toFixed(1)}% ` +
        `on ${positionTon.toFixed(2)} TON nets ${net.toFixed(3)} TON after ${gasTon.toFixed(2)} TON gas ` +
        `(noise floor)`,
    };
  }

  if (pnlPct <= -Math.abs(s.stopLossPct)) {
    return { action: "stop_loss", reason: `pnl ${pnlPct.toFixed(1)}% <= -${Math.abs(s.stopLossPct)}%` };
  }

  return { action: "hold" };
}

// ── Third-party exit confirmation (Fix 4, 2026-08-09) ───────────────
//
// The trend signal alone fired PAWZ's close at −2% after ~59s (seed-baseline
// EMA flip). Fix 4 requires live on-chain corroboration before a CONFIRMED
// trend flip is trusted to close a position. Pure gate — the feeds are read
// by the caller (engine.ts monitorTick); this only decides.

export interface ExitConfirmation {
  sellTraders24h: number;
  buyTraders24h: number;
  holdersDeltaPct: number; // negative = holders shrinking
}

/** Pure gate over the live feeds. Fail closed (false) on any gap. */
export function confirmedByFeeds(f: ExitConfirmation): boolean {
  const { sellTraders24h, buyTraders24h, holdersDeltaPct } = f;
  if (!Number.isFinite(sellTraders24h) || !Number.isFinite(buyTraders24h) || !Number.isFinite(holdersDeltaPct)) {
    return false;
  }
  if (sellTraders24h <= 0 || buyTraders24h < 0) return false;
  // Net-selling participation: sellers >= buyers (or no buyers at all).
  if (buyTraders24h > 0 && sellTraders24h < buyTraders24h) return false;
  // Holders must be shrinking (or flat): a growing holder base contradicts
  // a significant downtrend flip.
  if (holdersDeltaPct > 0) return false;
  return true;
}

// ── Fill accounting (pure) ──────────────────────────────────────────

export interface PositionFill {
  spentNano: bigint; // lot size in nanoTON (excludes flat router gas)
  tokensNano: bigint; // tokens received, 9-decimal nano units
}

export interface MergedFill {
  spentNano: bigint;
  tokensNano: bigint;
  avgEntryPriceTon: number; // TON per token, weighted across fills
  peakPriceTon: number;
}

/**
 * Merge a new fill into an existing position (or open a fresh one when
 * `prior` is null).
 *
 * Exists because the position row is keyed by jetton master, so a second buy
 * of the same token hits the same primary key and the store's `ON CONFLICT`
 * clause *replaces* spent/amount rather than adding to them. Six of seven MRG
 * fills vanished that way on 2026-08-07.
 *
 * Entry price is a weighted average, NOT the latest fill's price: every
 * TP/SL threshold measures against `entry_price_ton`, so using the last fill
 * would move the whole exit ladder each time the position is added to.
 */
export function mergeFill(
  prior: { spentNano: bigint; tokensNano: bigint; peakPriceTon: number } | null,
  fill: PositionFill,
): MergedFill {
  const spentNano = (prior?.spentNano ?? 0n) + fill.spentNano;
  const tokensNano = (prior?.tokensNano ?? 0n) + fill.tokensNano;
  const tokens = nanoToTon(tokensNano);
  // Fail closed at 0 rather than dividing by zero: a fill that returned no
  // tokens is a broken quote, and a 0 price reads as -100% PnL downstream.
  const avgEntryPriceTon = tokens > 0 ? nanoToTon(spentNano) / tokens : 0;
  return {
    spentNano,
    tokensNano,
    avgEntryPriceTon,
    // Re-anchor the trailing-stop high-water mark to the new basis; a peak set
    // under the old average would compare against a price that no longer means
    // the same thing.
    peakPriceTon: Math.max(prior?.peakPriceTon ?? 0, avgEntryPriceTon),
  };
}

// ── Position sizing (pure) ──────────────────────────────────────────

/** Per-trade cap chain: min(perTradeTon, portfolio cap, daily remaining). */
export function positionSizeTon(opts: {
  perTradeTon: number;
  portfolioAllocationPct: number;
  bankrollTon: number;
  dailyRemainingTon: number;
}): number {
  const alloc = (opts.bankrollTon * opts.portfolioAllocationPct) / 100;
  const cap = Math.max(0, Math.min(opts.perTradeTon, alloc, opts.dailyRemainingTon));
  return Math.round(cap * 1e9) / 1e9; // nano precision
}

