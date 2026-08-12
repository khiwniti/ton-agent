/**
 * FULL-ENGINE replay harness — workstream B (§4B of
 * docs/superpowers/specs/2026-08-11-per-technique-exit-policy-design.md).
 *
 * Extends the trend-exit backtest (scripts/backtest-trend-exit.ts) PAST the
 * flip signal to drive the REAL exit decision chain end-to-end:
 *
 *   TrendTracker (flip) ─→ decideExit (gas-aware noise floor, sniper/filters)
 *                       ─→ evaluateExitPolicy (exit/policy-engine.ts)
 *
 * so it validates the EXIT SYSTEM (the hot path's decision layer) rather than
 * one component. The pure facts the hot path would compute each tick
 * (hotpath/position-monitor.ts) are reproduced here:
 *
 *   - trend flip           → exit/trend-monitor.ts (the same TrendTracker)
 *   - volatility regime    → exit/volatility-regime.ts RegimeClassifier
 *   - ATR (close proxy)    → exit/volatility-regime.ts atrClose
 *   - structure stop       → exit/volatility-regime.ts structureStopLevel
 *   - effective stop       → economics/trade-economics.ts effectiveStopLossPct
 *   - noise floor          → decideExit (round-trip gas economics)
 *   - time exit            → evaluateExitPolicy maxHoldMs
 *   - rug / audit          → simulated ABSENT (null) — the harness replays a
 *                            single price series, not live liquidity state
 *
 * Exit criterion (§4B): a historical price series can be replayed through
 * either engine and produce the full action sequence.
 *
 * Run (Node 24):
 *   export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
 *   cd apps/agent && npx tsx scripts/replay-full-engine.ts
 *
 * Env: BT_STORE (cached dune-trades.json) / BT_MAX_POOLS / BT_MAX_ENTRIES /
 *      RE_STOP_LOSS_PCT (default 35, LOW tier) / RE_MAX_HOLD_MS (default 2h) /
 *      RE_POSITION_TON (default 0.44) / RE_TICK_MS (default 20000)
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TrendTracker, DEFAULT_TREND_CONFIG } from "../src/exit/trend-monitor";
import { decideExit } from "../src/sniper/filters";
import { evaluateExitPolicy, type ExitPolicyContext } from "../src/exit/policy-engine";
import {
  atrClose,
  RegimeClassifier,
  structureStopLevel,
} from "../src/exit/volatility-regime";
import { effectiveStopLossPct } from "../src/economics/trade-economics";
import type { TierRiskConfig } from "../src/risk/guardrails";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "out", "replay-full-engine");
mkdirSync(OUT_DIR, { recursive: true });

// ── Config (mirrors hot path CONFIG.strategy defaults) ──────────────────
const TREND_CFG = {
  ...DEFAULT_TREND_CONFIG,
  fastEmaPeriod: 7,
  slowEmaPeriod: 25,
  confirmTicks: 3,
  historySize: 60,
  minObservations: 6,
};

const VOL_PERIOD = 14;
const VOL_SPIKE = 2.5;
const VOL_CALM = 0.5;
const VOL_CONFIRM_TICKS = 2;
const STOP_ATR_MULT = 1.0;
const STOP_CONFIRM_TICKS = 2;
const TREND_EXIT_SPIKED_EXTRA_TICKS = 2;

// LOW tier config (the tier that owns PAWZ-class memecoins).
const stopLossPct = Number(process.env.RE_STOP_LOSS_PCT ?? 35);
const maxHoldMs = Number(process.env.RE_MAX_HOLD_MS ?? 2 * 3600_000);
const positionTon = Number(process.env.RE_POSITION_TON ?? 0.44);
const roundTripGasTon = 0.2;
const tickMs = Number(process.env.RE_TICK_MS ?? 20_000);

const tierCfg: TierRiskConfig = {
  maxPositionTon: 1.0,
  maxOpen: 5,
  takeProfitPct: 25,
  stopLossPct, // effective (gas-widened) stop is computed per tick below
  minAiScore: 80,
};

// ── Dataset ─────────────────────────────────────────────────────────────
interface DuneTradeRow {
  block_time: string;
  pool_address: string;
  token_bought_address: string;
  token_sold_address: string;
  amount_bought_raw: string;
  amount_sold_raw: string;
  volume_ton: string;
}
interface PricePoint { t: number; p: number }

const TON_ADDRESS = "0:0000000000000000000000000000000000000000000000000000000000000000";

function priceTon(t: DuneTradeRow): number | null {
  const vol = Number(t.volume_ton);
  if (!Number.isFinite(vol) || vol <= 0) return null;
  const jet =
    t.token_bought_address === TON_ADDRESS ? BigInt(t.amount_sold_raw)
    : t.token_sold_address === TON_ADDRESS ? BigInt(t.amount_bought_raw)
    : null;
  if (jet === null || jet <= 0n) return null;
  return vol / Number(jet);
}

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
 * Dune schema quirk (verified against the cached dataset): `volume_ton` is
 * populated inconsistently. On TON→jetton buys it is the true TON volume; on
 * jetton→TON sells it is sometimes a 1e-9-scaled value of the jetton amount,
 * producing a derived price ~6 orders of magnitude above the pool's real
 * median (e.g. pool 0:0E52... median 2.6e-15 vs a 1.000000e-9 cluster).
 *
 * The trend-exit backtest was unaffected because TrendTracker is
 * scale-invariant — it only looks at the SHAPE of the series. The full-engine
 * replay computes ATR / structure-stop in NORMALIZED units, so a single
 * mislabeled row can inflate the high-water close by millions and make the
 * structure stop fire on every tick.
 *
 * Fix: drop per-pool points whose price is an extreme outlier vs. the pool's
 * own median (outside [median/1e4, median×1e4]). This keeps the true price
 * shape (including real pumps) while removing the mislabeled rows.
 */
function filterArtifactPrices(points: PricePoint[]): PricePoint[] {
  const prices = points.map((p) => p.p).sort((a, b) => a - b);
  const median = prices[prices.length >> 1];
  if (!Number.isFinite(median) || median <= 0) return points;
  const lo = median / 1e4;
  const hi = median * 1e4;
  const kept = points.filter((p) => p.p >= lo && p.p <= hi);
  // Only apply when it actually removes something — a pool that is genuinely
  // that volatile (no clear mislabeled cluster) keeps its full series.
  if (kept.length < points.length * 0.5) return points;
  return kept.length >= 2 ? kept : points;
}

function firstIndexAtOrAfter(points: PricePoint[], target: number): number {
  let lo = 0, hi = points.length - 1, ans = points.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t >= target) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return ans;
}

function sampleEntryIdxs(points: PricePoint[], maxEntries: number): number[] {
  const n = Math.min(maxEntries, points.length);
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const idxs = new Set<number>([0]);
  for (let k = 1; k < n; k++) {
    idxs.add(firstIndexAtOrAfter(points, t0 + ((t1 - t0) * k) / n));
  }
  return [...idxs].sort((a, b) => a - b);
}

// ── Per-tick decision chain (mirrors hotpath/position-monitor.ts) ────────
interface ReplayState {
  tracker: TrendTracker;
  regime: RegimeClassifier;
  closes: number[]; // running close series for ATR / structure-stop
  lastClose: number;
  structLevel: number | null;
  structTicks: number;
  highWaterClose: number;
}

function newReplayState(): ReplayState {
  return {
    tracker: new TrendTracker(TREND_CFG),
    regime: new RegimeClassifier({
      period: VOL_PERIOD, spikeThreshold: VOL_SPIKE, calmRatio: VOL_CALM,
      confirmTicks: VOL_CONFIRM_TICKS,
    }),
    closes: [],
    lastClose: 0,
    structLevel: null,
    structTicks: 0,
    highWaterClose: 0,
  };
}

export interface ReplayDecision {
  trigger: string;
  reason: string;
  atMs: number;
  obs: number; // trend-tracker observations at the firing tick
  pnlPct: number;
  entryPrice: number;
}

/**
 * Replay one position from `entryIdx` until ANY exit trigger fires or the
 * pool's data / maxHold ends. Returns the full action sequence (normally one
 * terminal decision; a degenerate series may produce several rows before the
 * position reaches a terminal status).
 */
export function replayPosition(
  pool: string,
  points: PricePoint[],
  entryIdx: number,
  opts: {
    tickMs?: number;
    maxHoldMs?: number;
    stopLossPct?: number;
    positionTon?: number;
    roundTripGasTon?: number;
  } = {},
): { actions: ReplayDecision[]; heldToEnd: boolean } {
  const tick = opts.tickMs ?? tickMs;
  const holdMs = opts.maxHoldMs ?? maxHoldMs;
  const stopPct = opts.stopLossPct ?? stopLossPct;
  const posTon = opts.positionTon ?? positionTon;
  const gas = opts.roundTripGasTon ?? roundTripGasTon;

  if (points.length < TREND_CFG.slowEmaPeriod + 2) return { actions: [], heldToEnd: true };

  const s = newReplayState();
  const entryP = points[entryIdx].p;
  const t0 = points[entryIdx].t;
  const tEnd = Math.min(points[points.length - 1].t, t0 + holdMs);
  const entryPriceUsd = 1; // normalised basis, exactly as the hot path does

  // Entry = first real observation (same as the trend-exit backtest).
  s.tracker.observe("p", entryP, entryP);
  s.closes.push(entryP);
  s.highWaterClose = entryP;
  s.lastClose = entryP;

  // The position is OPEN for the whole replay (no partials, status OPEN).
  const position = {
    status: "OPEN",
    entry_at: t0,
    entry_price_usd: entryPriceUsd,
    exit_by_ms: t0 + holdMs,
  };

  const actions: ReplayDecision[] = [];
  let i = entryIdx + 1;

  for (let t = t0; t < tEnd && i < points.length; t += tick) {
    const bucketEnd = t + tick;
    while (i < points.length && points[i].t <= bucketEnd) {
      s.lastClose = points[i].p;
      i++;
    }
    const price = s.lastClose;
    if (!Number.isFinite(price) || price <= 0) continue;

    // ── Facts the hot path computes per tick ────────────────────────────
    const signal = s.tracker.observe("p", price, entryP);
    s.closes.push(price);
    if (s.closes.length > 100) s.closes.shift();
    if (price > s.highWaterClose) s.highWaterClose = price;

    // Normalised price basis: current = entry * (1 + pnl/100), clamped above 0.
    const pnl = ((price - entryP) / entryP) * 100;
    const currentPriceUsd = Math.max(1e-9, 1 + pnl / 100);

    // NORMALIZED basis, exactly like the hot path (position-monitor.ts lines
    // 686-717): closes are divided by the entry price, so the structure-stop
    // level is computed on the same 1.0 scale the engine compares against
    // `currentPriceUsd` (= 1 + pnl/100).
    //
    // This normalization is what exposed the Dune `volume_ton` mis-population
    // (see filterArtifactPrices above): raw pool prices can contain an exact
    // 1.000000e-9 constant cluster on jetton→TON sells, and dividing a legit
    // later close by a launch entry ~1e-6 of it inflated normHw to ~1e6 — the
    // structure stop then fired on every tick at a million-scale level. The
    // filter strips those rows in buildSeries, so normHw stays on a plausible
    // scale. Residual risk: the ±1e4 median band can also drop a GENUINE pump
    // that 100,000×s from the median; the memecoin class can do this for real.
    const normCloses = s.closes.map((c) => c / entryP);
    const normHw = s.highWaterClose / entryP;
    const atr = atrClose(normCloses, VOL_PERIOD);
    const regime = s.regime.observe(normCloses);
    const level = structureStopLevel(normHw, 1, atr, STOP_ATR_MULT, stopPct);
    s.structLevel = level;
    if (level != null && currentPriceUsd <= level) s.structTicks++;
    else s.structTicks = 0;

    const effStop = effectiveStopLossPct({
      configuredStopPct: stopPct,
      positionTon: posTon,
      gasTon: gas,
    });

    // ── 1. decideExit (gas-aware noise floor) ───────────────────────────
    // Production gates trendBearish on the CONFIRMED flip (sniper/engine.ts
    // line 589, hotpath/position-monitor.ts line 730/769) — which includes the
    // min-observations lock. Passing raw `signal.bearish` would fire trend
    // exits the real hot path never would (PAWZ-class obs<6 flips), so use
    // `signal.confirmed` here exactly as production does.
    const dec = decideExit({
      entryPriceTon: entryP,
      currentPriceTon: price,
      stopLossPct: effStop,
      trendBearish: signal.confirmed,
      trendReason: signal.reason ?? "",
      positionTon: posTon,
      roundTripGasTon: gas,
    });
    // decideExit's "hold" (noise floor) is advisory; the engine below decides.

    // ── 2. evaluateExitPolicy (the authoritative decision) ──────────────
    const ctx: ExitPolicyContext = {
      now: bucketEnd,
      currentPriceUsd,
      entryPriceUsd,
      tierCfg: { ...tierCfg, stopLossPct: effStop },
      auditVerdict: null,
      rugSignal: null,
      // Production feeds trendSignal ONLY on a confirmed flip (minObs6 lock
      // included) — position-monitor.ts lines 729-777. The engine's SPIKED
      // re-gate then re-checks `confirmations` against the raised threshold.
      trendSignal: signal.confirmed
        ? { bearish: true, confirmations: signal.confirmations, reason: signal.reason ?? "" }
        : undefined,
      maxHoldMs: holdMs,
      volatility: {
        atrCloseTon: atr,
        regime,
        realizedVol: s.regime.state().realizedVol,
      },
      structureStop: { levelTon: level, confirmedTicks: s.structTicks },
      stopConfirmTicks: STOP_CONFIRM_TICKS,
      trendConfirmTicks: TREND_CFG.confirmTicks,
      trendExitSpikedExtraTicks: TREND_EXIT_SPIKED_EXTRA_TICKS,
    };
    const decision = evaluateExitPolicy(position, ctx);
    if (decision) {
      actions.push({
        trigger: decision.trigger,
        reason: decision.reason,
        atMs: bucketEnd,
        obs: signal.observations,
        pnlPct: pnl,
        entryPrice: entryP,
      });
      break; // terminal action — the position exits this tick
    }
    void dec; // advisory only; the engine is authoritative
  }

  return { actions, heldToEnd: actions.length === 0 };
}

// ── Reporting ───────────────────────────────────────────────────────────
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(n: number, d: number): string {
  return ((n / Math.max(1, d)) * 100).toFixed(1) + "%";
}

function main() {
  const store = process.env.BT_STORE ?? join(join(HERE, "..", "out", "backtest-trend-exit"), "dune-trades.json");
  if (!existsSync(store)) {
    console.error(`No cached dataset at ${store} — run scripts/backtest-trend-exit.ts first.`);
    process.exit(1);
  }
  const byPool = JSON.parse(readFileSync(store, "utf-8")) as Record<string, DuneTradeRow[]>;
  const maxPools = Number(process.env.BT_MAX_POOLS ?? 2000);
  const maxEntries = Number(process.env.BT_MAX_ENTRIES ?? 20);

  const pools = Object.entries(byPool)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxPools)
    .map(([pool, trades]) => ({ pool, trades }));

  console.log(`Replaying ${pools.length} pools × ${maxEntries} entries (tick ${tickMs}ms, hold ${maxHoldMs}ms, stop ${stopLossPct}%, pos ${positionTon} TON)…\n`);

  const byTrigger = new Map<string, { n: number; pnls: number[]; obs: number[] }>();
  let heldToEnd = 0;
  let replayed = 0;

  for (const { pool, trades } of pools) {
    const pts = buildSeries(trades);
    if (!pts) continue;
    for (const idx of sampleEntryIdxs(pts, maxEntries)) {
      const { actions, heldToEnd: hte } = replayPosition(pool, pts, idx, {});
      replayed++;
      if (hte) { heldToEnd++; continue; }
      const a = actions[0];
      const row = byTrigger.get(a.trigger) ?? { n: 0, pnls: [], obs: [] };
      row.n++;
      row.pnls.push(a.pnlPct);
      row.obs.push(a.obs);
      byTrigger.set(a.trigger, row);
    }
  }

  const triggers = [...byTrigger.entries()].sort((a, b) => b[1].n - a[1].n);
  const summary = { tickMs, maxHoldMs, stopLossPct, positionTon, replayed, heldToEnd, triggers };
  const outPath = join(OUT_DIR, "summary.json");
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Summary written to ${outPath}`);
  console.log(`\nReplayed ${replayed} entries; held to data-end / maxHold: ${heldToEnd} (${pct(heldToEnd, replayed)})`);
  console.log("Exit triggers:");
  for (const [trigger, { n, pnls, obs }] of triggers) {
    console.log(
      `  ${trigger.padEnd(14)} ${String(n).padStart(6)}  (${pct(n, replayed)})  median pnl ${median(pnls).toFixed(1)}%  median obs@fire ${median(obs)}`,
    );
  }

  const detail = [];
  for (const { pool, trades } of pools.slice(0, 50)) {
    const pts = buildSeries(trades);
    if (!pts) continue;
    for (const idx of sampleEntryIdxs(pts, 5)) {
      const { actions } = replayPosition(pool, pts, idx, {});
      if (actions.length) {
        detail.push({ pool: pool.slice(0, 16), entryIdx: idx, ...actions[0] });
      }
    }
  }
  writeFileSync(join(OUT_DIR, "detail.json"), JSON.stringify(detail, null, 1));
  console.log(`\nDetail written to ${join(OUT_DIR, "detail.json")}`);
}

main();
