/**
 * Backtest harness for the trend-exit close signal over historical Uranus
 * memecoin lifetimes — OFFLINE, driven by the `dune` CLI.
 *
 * WHY: the PAWZ incident (2026-08-09) closed a position on trend_exit at −2%
 * after ~59s, when the flip was seeded-copy noise. The four hot-path fixes
 * (min-observations lock, gas-aware noise floor, clock consistency, third-party
 * confirmation) are unit-tested; this harness replays the REAL TrendTracker
 * against real on-chain price series to data-validate the parameters.
 *
 * Data source: `ton.dex_trades` (Dune), project = 'uranus'.
 *   - pool_address = jetton master (the tradable pool address)
 *   - amount_sold_raw / amount_bought_raw = nano raw units (jetton or TON)
 *   - the zero address 0:0000...00 is TON
 *   - volume_ton = the TON side of the trade
 *
 * Reconstructing a TON-price per trade:
 *   For a swap {TON in, jetton out}: priceTon = volume_ton / jettonAmount.
 *   Because TrendTracker logic is scale-invariant we only need the SHAPE of
 *   the price series, so any consistent price unit is fine — we use TON per
 *   token (nano-aware).
 *
 * SIMULATION MODEL (v2, multi-entry):
 *   - ALL pools in the window are simulated (not just the top-N by liquidity —
 *     the PAWZ class lives in mid-tier pools, and top-N selection is a
 *     winner-biased sample of the biggest pumps)
 *   - per pool, up to `maxEntries` entry points are sampled EVENLY across the
 *     pool's lifetime (launch through late-life), so post-pump and pullback
 *     entries that reproduce the PAWZ scenario are exercised, not just the
 *     launch entry
 *   - a position enters at the sampled entry price, then the REAL TrendTracker
 *     observes the pool price every `tickMs` (20s hot-path cadence) until a
 *     CONFIRMED flip (the only close signal here; stop-loss / gas floors are
 *     decisions layered above by decideExit) or `maxHoldMs` elapses
 *   - `premature` (the PAWZ class): the flip confirmed with `closeObs` real
 *     observations at or near the config's own minimum evidence (<= cfg
 *     .minObservations + 3) AND the price at close was NOT a meaningful
 *     decline (>= -stopLossPct%) — i.e. the flip fired on noise from minimal
 *     evidence. The `+3` margin captures flips that confirm essentially the
 *     instant the config allows, so the premature RATE is comparable across
 *     configs with different lock floors.
 *
 * Sweep: (confirmTicks, minObservations) including the OLD pre-lock behavior
 * (confirm3/minObs1) as the counterfactual. The hypothesis to test: the OLD
 * config fires premature flips from ~3 real observations; the PROD lock
 * (minObs6) forces >= 6 real observations, so its premature rate must drop.
 *
 * Run (Node 24):
 *   export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
 *   cd apps/agent && npx tsx scripts/backtest-trend-exit.ts
 *
 * Env:
 *   BT_START / BT_END / BT_STORE (cache path) / BT_MAX_POOLS / BT_MAX_ENTRIES
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TrendTracker, DEFAULT_TREND_CONFIG } from "../src/exit/trend-monitor";
import { decideExit } from "../src/sniper/filters";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "out", "backtest-trend-exit");
mkdirSync(OUT_DIR, { recursive: true });

// ── Dune query helper ────────────────────────────────────────────────
interface DuneTradeRow {
  block_time: string;
  pool_address: string;
  token_bought_address: string;
  token_sold_address: string;
  amount_bought_raw: string;
  amount_sold_raw: string;
  volume_ton: string;
}

function runDuneSql(sql: string): DuneTradeRow[] {
  const out = execFileSync("dune", ["query", "run-sql", "--sql", sql, "-o", "json"], {
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  // Envelope: { state, result: { metadata: { column_names }, rows: [...] } }.
  // The CLI `-o json` nests the result set under `result.rows`.
  const rows = parsed?.result?.rows ?? parsed?.rows ?? parsed?.results?.rows ?? parsed;
  if (!Array.isArray(rows)) throw new Error(`unexpected dune output shape: ${out.slice(0, 300)}`);
  return rows as DuneTradeRow[];
}

// ── Price-series reconstruction ──────────────────────────────────────
const TON_ADDRESS = "0:0000000000000000000000000000000000000000000000000000000000000000";

function jettonAmount(t: DuneTradeRow): bigint | null {
  // The jetton is whichever side is NOT TON. When TON is BOUGHT the user sold
  // jetton (amount_sold_raw is the jetton side); when TON is SOLD the user
  // bought jetton (amount_bought_raw is the jetton side).
  if (t.token_bought_address === TON_ADDRESS) return BigInt(t.amount_sold_raw);
  if (t.token_sold_address === TON_ADDRESS) return BigInt(t.amount_bought_raw);
  return null; // TON↔TON or jetton↔jetton — not usable
}

function tonAmount(t: DuneTradeRow): number | null {
  const vol = Number(t.volume_ton);
  if (!Number.isFinite(vol) || vol <= 0) return null;
  return vol;
}

/** TON per jetton-token (raw units already decimal-agnostic — shape only). */
function priceTon(t: DuneTradeRow): number | null {
  const jet = jettonAmount(t);
  const ton = tonAmount(t);
  if (jet === null || jet <= 0n || ton === null) return null;
  return ton / Number(jet);
}

// ── Per-entry simulation ─────────────────────────────────────────────
export interface SimEntry {
  pool: string;
  entryTime: number; // epoch ms
  priceAtEntry: number;
  closeObs: number; // real observations at the confirmed flip
  timeToCloseMs: number;
  pnlPctAtClose: number;
}

interface PricePoint {
  t: number;
  p: number;
}

/** First index of points with t >= target (binary search). */
function firstIndexAtOrAfter(points: PricePoint[], target: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let ans = points.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t >= target) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** Entry indices spread evenly across the pool lifetime (launch included). */
export function sampleEntryIdxs(points: PricePoint[], maxEntries: number): number[] {
  const n = Math.min(maxEntries, points.length);
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const idxs = new Set<number>([0]); // always include launch
  for (let k = 1; k < n; k++) {
    const target = t0 + ((t1 - t0) * k) / n;
    idxs.add(firstIndexAtOrAfter(points, target));
  }
  return [...idxs].sort((a, b) => a - b);
}

/**
 * Replay the REAL TrendTracker from one entry point until a confirmed flip
 * (the only close signal) or `maxHoldMs`. Returns null when the position
 * never confirms a flip (held to data end / max hold).
 */
export function simulateEntry(
  pool: string,
  points: PricePoint[],
  entryIdx: number,
  opts: {
    tickMs?: number;
    stopLossPct?: number;
    maxHoldMs?: number;
    cfg?: typeof DEFAULT_TREND_CONFIG;
  } = {},
): SimEntry | null {
  const cfg = opts.cfg ?? DEFAULT_TREND_CONFIG;
  const tickMs = opts.tickMs ?? 20_000;
  const stopLossPct = opts.stopLossPct ?? 35;
  const maxHoldMs = opts.maxHoldMs ?? 2 * 3600_000;

  if (points.length < cfg.slowEmaPeriod + 2) return null;
  const entryP = points[entryIdx].p;
  const t0 = points[entryIdx].t;
  const tEnd = Math.min(points[points.length - 1].t, t0 + maxHoldMs);

  const tracker = new TrendTracker(cfg);
  tracker.observe("p", entryP, entryP); // entry = first real observation
  let lastPrice = entryP;
  let i = entryIdx + 1;
  let closeObs = 0;
  let timeToCloseMs = 0;

  for (let t = t0; t < tEnd && i < points.length; t += tickMs) {
    const bucketEnd = t + tickMs;
    while (i < points.length && points[i].t <= bucketEnd) {
      lastPrice = points[i].p;
      i++;
    }
    const s = tracker.observe("p", lastPrice, entryP);
    if (s.confirmed) {
      closeObs = s.observations;
      timeToCloseMs = bucketEnd - t0;
      break;
    }
  }
  if (closeObs === 0) return null;

  const pnlPct = ((lastPrice - entryP) / entryP) * 100;

  return {
    pool,
    entryTime: t0,
    priceAtEntry: entryP,
    closeObs,
    timeToCloseMs,
    pnlPctAtClose: pnlPct,
  };
}

/** Build the usable (finite, TON↔jetton) price series for one pool. */
function buildSeries(trades: DuneTradeRow[]): PricePoint[] | null {
  const points: PricePoint[] = [];
  for (const t of trades) {
    const p = priceTon(t);
    if (p === null) continue;
    const ts = Date.parse(t.block_time);
    if (!Number.isFinite(ts)) continue;
    points.push({ t: ts, p });
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a.t - b.t);
  return filterArtifactPrices(points);
}

/**
 * Dune schema quirk (see replay-full-engine.ts for the full writeup):
 * `volume_ton` is populated inconsistently — on jetton→TON sells it is
 * sometimes a 1e-9-scaled value of the jetton amount, producing a derived
 * price ~6 orders of magnitude above the pool's real median. TrendTracker is
 * scale-invariant (flip detection only looks at SHAPE), so the flip counts
 * are unaffected either way — but the §4C right-tail PnL distribution is
 * computed from absolute prices, and a single mislabeled row inflates the
 * "largest winner" to 287M%. Drop per-pool outliers outside
 * [median/1e4, median×1e4]; only applied when it removes a genuine cluster.
 */
function filterArtifactPrices(points: PricePoint[]): PricePoint[] {
  const prices = points.map((p) => p.p).sort((a, b) => a - b);
  const median = prices[prices.length >> 1];
  if (!Number.isFinite(median) || median <= 0) return points;
  const lo = median / 1e4;
  const hi = median * 1e4;
  const kept = points.filter((p) => p.p >= lo && p.p <= hi);
  if (kept.length < points.length * 0.5) return points;
  return kept.length >= 2 ? kept : points;
}

/** Run every sampled entry for one pool. Returns closes + held-to-end count. */
export function simulatePool(
  pool: string,
  trades: DuneTradeRow[],
  opts: {
    tickMs?: number;
    stopLossPct?: number;
    maxHoldMs?: number;
    maxEntries?: number;
    cfg?: typeof DEFAULT_TREND_CONFIG;
  } = {},
): { closes: SimEntry[]; noClose: number } {
  const cfg = opts.cfg ?? DEFAULT_TREND_CONFIG;
  const maxEntries = opts.maxEntries ?? 20;
  const points = buildSeries(trades);
  if (!points || points.length < cfg.slowEmaPeriod + 2) return { closes: [], noClose: 0 };

  const closes: SimEntry[] = [];
  let noClose = 0;
  for (const idx of sampleEntryIdxs(points, maxEntries)) {
    const r = simulateEntry(pool, points, idx, opts);
    if (r) closes.push(r);
    else noClose++;
  }
  return { closes, noClose };
}

// ── Flip classification (fixed evidence bar) ────────────────────────
//
// The PAWZ bar is FIXED, not config-relative: a confirmed flip fired with
// `closeObs <= PAWZ_OBS` real observations AND no meaningful decline
// (`pnlPct >= -stopLossPct`) is a noise-flip. Using one fixed bar across the
// sweep makes the premature rates directly comparable — a config whose lock
// floor is above the bar simply cannot fire noise-flips.
const PAWZ_OBS = 6; // PAWZ's own evidence level: ~6 real observations in ~59s

export interface Flip {
  entry: SimEntry;
  action: "trend_exit" | "hold"; // what REAL decideExit would do at this flip
  reason: string;
}

/** PAWZ-class noise flip: minimal real evidence + no meaningful decline. */
export function isNoiseFlip(f: Flip, stopLossPct: number): boolean {
  return f.entry.closeObs <= PAWZ_OBS && f.entry.pnlPctAtClose >= -stopLossPct;
}

// ── Config sweep ─────────────────────────────────────────────────────
export interface SweepResult {
  label: string;
  cfg: typeof DEFAULT_TREND_CONFIG;
  /** Every confirmed flip, classified by the REAL decideExit (gas floor on). */
  flips: Flip[];
  noClose: number;
}

export function sweepConfigs(
  pools: { pool: string; trades: DuneTradeRow[] }[],
  opts: { stopLossPct?: number; positionTon?: number; roundTripGasTon?: number } = {},
) {
  const stopLossPct = opts.stopLossPct ?? 35;
  const positionTon = opts.positionTon ?? 0.44; // PAWZ's actual lot size
  const roundTripGasTon = opts.roundTripGasTon ?? 0.2;

  // Full matrix: isolates the confirmTicks lever from the minObservations lock.
  // confirm3/minObs10 and confirm5/minObs1 are the two corner cells that tell
  // us whether "0 noise-flips" is signal quality (confirm5) or a definitional
  // artifact (minObs10 > PAWZ_OBS=6 means a flip can never fire in the window).
  const variants = [
    { confirmTicks: 3, minObservations: 1, label: "confirm3/minObs1 (OLD, no lock)" },
    { confirmTicks: 3, minObservations: 3, label: "confirm3/minObs3" },
    { confirmTicks: 3, minObservations: 6, label: "confirm3/minObs6 (PROD)" },
    { confirmTicks: 3, minObservations: 10, label: "confirm3/minObs10" },
    { confirmTicks: 5, minObservations: 1, label: "confirm5/minObs1" },
    { confirmTicks: 5, minObservations: 6, label: "confirm5/minObs6" },
    { confirmTicks: 5, minObservations: 10, label: "confirm5/minObs10" },
  ];
  const results: SweepResult[] = [];

  // Build the price series ONCE per pool — it is cfg-independent.
  const series = new Map<string, PricePoint[] | null>();
  for (const { pool, trades } of pools) series.set(pool, buildSeries(trades));

  for (const v of variants) {
    const cfg = { ...DEFAULT_TREND_CONFIG, confirmTicks: v.confirmTicks, minObservations: v.minObservations };
    const flips: Flip[] = [];
    let noClose = 0;
    for (const { pool } of pools) {
      const pts = series.get(pool);
      if (!pts) continue;
      for (const idx of sampleEntryIdxs(pts, 20)) {
        const entry = simulateEntry(pool, pts, idx, { cfg, stopLossPct });
        if (!entry) {
          noClose++;
          continue;
        }
        // Model the real hot path: the flip is fed into decideExit with the
        // noise floor. A flip on a gross loser ABOVE the stop is held.
        const pnlPct = entry.pnlPctAtClose;
        const trendBearish = true;
        const action = decideExit({
          entryPriceTon: entry.priceAtEntry,
          currentPriceTon: entry.priceAtEntry * (1 + pnlPct / 100),
          stopLossPct,
          trendBearish,
          trendReason: `confirmed flip at ${entry.closeObs} real obs`,
          positionTon,
          roundTripGasTon,
        });
        flips.push({ entry, action: action.action, reason: action.reason ?? "" });
      }
    }
    results.push({ label: v.label, cfg, flips, noClose });
  }
  return results;
}

// ── Reporting ────────────────────────────────────────────────────────
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmtMs(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60_000).toFixed(1)}m`;
}

// ── Main ─────────────────────────────────────────────────────────────
const DATE_START = process.env.BT_START ?? "2026-01-27 00:00:00"; // first known Uranus trade
const DATE_END = process.env.BT_END ?? "2026-08-07 00:00:00";
const MAX_POOLS = Number(process.env.BT_MAX_POOLS ?? 2000); // all pools (1524 in window)
const MAX_ENTRIES = Number(process.env.BT_MAX_ENTRIES ?? 20);
const STORE = process.env.BT_STORE ?? join(OUT_DIR, "dune-trades.json");

interface RawPoolData { [pool: string]: DuneTradeRow[] }

function loadTrades(): RawPoolData {
  if (existsSync(STORE)) {
    console.log(`Loading cached trades from ${STORE}`);
    return JSON.parse(readFileSync(STORE, "utf-8")) as RawPoolData;
  }
  console.log(`Fetching Uranus trades ${DATE_START} → ${DATE_END} via dune CLI…`);
  const sql = `
    SELECT block_time, pool_address, token_bought_address, token_sold_address,
           amount_bought_raw, amount_sold_raw, volume_ton
    FROM ton.dex_trades
    WHERE project = 'uranus'
      AND block_time >= TIMESTAMP '${DATE_START}'
      AND block_time <  TIMESTAMP '${DATE_END}'
      AND event_type = 'trade'
    ORDER BY block_time ASC
  `;
  const rows = runDuneSql(sql);
  const byPool: RawPoolData = {};
  for (const r of rows) {
    (byPool[r.pool_address] ??= []).push(r);
  }
  writeFileSync(STORE, JSON.stringify(byPool, null, 1));
  console.log(`Cached ${rows.length} trades across ${Object.keys(byPool).length} pools → ${STORE}`);
  return byPool;
}

function main() {
  const byPool = loadTrades();
  const pools = Object.entries(byPool)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_POOLS)
    .map(([pool, trades]) => ({ pool, trades }));

  console.log(`\nSimulating ${pools.length} pools, ${MAX_ENTRIES} entries each (20s cadence, 2h max hold)…\n`);
  const results = sweepConfigs(pools);

  const summary = [];
  for (const { label, cfg, flips, noClose } of results) {
    const prem = flips.filter((f) => isNoiseFlip(f, 35));
    const held = flips.filter((f) => f.action === "hold"); // noise floor held them
    const fired = flips.filter((f) => f.action === "trend_exit");
    const rate = (prem.length / Math.max(1, flips.length)) * 100;
    const pnlPrem = prem.length ? median(prem.map((f) => f.entry.pnlPctAtClose)) : 0;
    const ttcPrem = prem.length ? median(prem.map((f) => f.entry.timeToCloseMs)) : 0;

    // §4C right-tail report: "did we keep the 40x" — the largest winner per
    // config, not the mean. A config that lifts the mean by clipping the tail
    // is a failure. `pnlPctAtClose` is the position pnl when the flip fired.
    const pnls = flips.map((f) => f.entry.pnlPctAtClose).sort((a, b) => a - b);
    const q = (p: number) => pnls[Math.min(pnls.length - 1, Math.floor(p * pnls.length))];
    const meanPnl = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    const firedPnl = fired.map((f) => f.entry.pnlPctAtClose);
    const tail = {
      n: pnls.length,
      max: pnls.length ? pnls[pnls.length - 1] : null,
      p99: pnls.length ? q(0.99) : null,
      p95: pnls.length ? q(0.95) : null,
      p75: pnls.length ? q(0.75) : null,
      median: pnls.length ? q(0.5) : null,
      mean: meanPnl,
      trendMax: firedPnl.length ? Math.max(...firedPnl) : null,
    };

    console.log(`── ${label} ──`);
    console.log(`   flips:        ${flips.length} (${noClose} held to end, no flip)`);
    console.log(`   noise-flips (obs<=6, pnl>=-35%): ${prem.length} (${rate.toFixed(2)}% of flips)`);
    console.log(`   noise floor held: ${held.length}, trend_exit fired: ${fired.length}`);
    console.log(`   right tail: max ${tail.max?.toFixed(1) ?? "-"}%  p99 ${tail.p99?.toFixed(1) ?? "-"}%  p95 ${tail.p95?.toFixed(1) ?? "-"}%  p75 ${tail.p75?.toFixed(1) ?? "-"}%  median ${tail.median?.toFixed(1) ?? "-"}%  mean ${tail.mean.toFixed(1)}%  | trend_exit max ${tail.trendMax?.toFixed(1) ?? "-"}%`);
    if (prem.length) {
      console.log(`   noise-flips: median pnl ${pnlPrem.toFixed(1)}%, median time-to-close ${fmtMs(ttcPrem)}`);
      const obsDist = new Map<number, number>();
      for (const f of prem) obsDist.set(f.entry.closeObs, (obsDist.get(f.entry.closeObs) ?? 0) + 1);
      console.log(`   noise-flip obs@close dist: ${[...obsDist.entries()].sort((a, b) => a[0] - b[0]).map(([o, n]) => `${o}:${n}`).join(" ")}`);
    }
    summary.push({ label, flips: flips.length, noClose, heldByFloor: held.length, noiseFlips: prem.length, noiseFlipRatePct: Number(rate.toFixed(2)), minObs: cfg.minObservations, tail });
  }

  const sumPath = join(OUT_DIR, "summary.json");
  writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  console.log(`\nSummary written to ${sumPath}`);

  // Dump the per-entry detail for the PROD config for inspection.
  const prod = results.find((r) => r.label.includes("PROD"))!;
  const prem = prod.flips.filter((f) => isNoiseFlip(f, 35));
  const detailPath = join(OUT_DIR, "detail-prod.json");
  writeFileSync(
    detailPath,
    JSON.stringify(
      { label: prod.label, cfg: prod.cfg, flips: prod.flips, noiseFlips: prem.slice(0, 25) },
      null,
      1,
    ),
  );
  console.log(`Detail written to ${detailPath}`);
  if (prem.length) {
    console.log("\nPAWZ-class noise-flips under PROD config (first 15):");
    for (const f of prem.slice(0, 15)) {
      const e = f.entry;
      console.log(`  ${e.pool.slice(0, 12)}… entry=${new Date(e.entryTime).toISOString()} pnl=${e.pnlPctAtClose.toFixed(1)}% obs@close=${e.closeObs} ttc=${fmtMs(e.timeToCloseMs)} → ${f.action}`);
    }
  }
}

main();
