/**
 * Volatility- & structure-adaptive exit facts (Phase 4.5, operator-approved).
 *
 * The market layer only produces tick CLOSES (PriceTick: poolAddress, dex,
 * price, reserve0, reserve1, ts — no OHLCV, no high/low per poll window), so
 * classic ATR is impossible. The honest proxy is WILDER-SMOOTHED |Δclose|,
 * which degenerates gracefully to a floor before the lookback fills, plus a
 * rolling realized-volatility (stdev of log returns) classified into
 * CALM / NORMAL / SPIKED regimes.
 *
 * Everything here is PURE and unit-testable with no I/O — the hot path
 * (hotpath/position-monitor.ts) computes these facts each tick and injects
 * them into the pure exit policy engine via ExitPolicyContext. Absent facts =
 * the engine behaves exactly as before the enhancement.
 *
 * ⚠️ Flash-crash separation: the smoothing layer in this module deliberately
 * sits on the trend/stop path. The flash-crash circuit breaker (emergency
 * exit → rugSignal in exit/rug-detector.ts) measures liquidity drain / safety
 * deltas on RAW ticks and is NOT routed through these smoothed facts — a
 * genuine liquidity drain must trip instantly, not after N smoothed closes.
 */
import { log } from "../logger";

export type VolatilityRegime = "calm" | "normal" | "spiked" | "unknown";

/** When too few real deltas exist, fall back to this fraction of the last close. */
const ATR_FLOOR_FRACTION = 0.02;

/** Baseline for a fresh classifier (no history yet) — treated as NORMAL until real vol lands. */
const DEFAULT_BASELINE_VOL = 0.01;

/**
 * Wilder-smoothed mean absolute close-to-close change — the close-only ATR
 * proxy. First value = SMA of |Δclose| over the period; thereafter
 *   atr = (prevAtr * (period - 1) + |Δclose|) / period
 * so recent volatility is weighted more heavily and the value is continuous.
 *
 * Degrades to `lastClose * ATR_FLOOR_FRACTION` when fewer than `period` real
 * deltas exist (mirrors ml/features.ts:489's `atr: lastClose * 0.02` fallback)
 * so callers never see 0/NaN during warm-up. Returns NaN only for an empty or
 * all-non-finite series.
 */
export function atrClose(closes: number[], period = 14): number {
  const fin = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (fin.length === 0) return NaN;
  const lastClose = fin[fin.length - 1];
  const floor = lastClose * ATR_FLOOR_FRACTION;
  if (fin.length < 2) return floor;

  const deltas: number[] = [];
  for (let i = 1; i < fin.length; i++) deltas.push(Math.abs(fin[i] - fin[i - 1]));
  if (deltas.length < period) {
    // Warm-up: plain average is the honest estimate before Wilder converges.
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    return avg > 0 ? avg : floor;
  }

  let atr =
    deltas.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < deltas.length; i++) {
    atr = (atr * (period - 1) + deltas[i]) / period;
  }
  return atr > 0 ? atr : floor;
}

/**
 * Rolling realized volatility: population stdev of log-returns over the same
 * window (per-tick σ, deliberately NOT annualized — the regime classifier
 * only needs the RATIO against this pool's own baseline). Returns NaN when
 * fewer than 2 finite closes exist.
 */
export function realizedVol(closes: number[]): number {
  const fin = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (fin.length < 2) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < fin.length; i++) rets.push(Math.log(fin[i] / fin[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

export interface RegimeOpts {
  /** Wilder/realized-vol window. */
  period?: number;
  /**
   * EMA-smoothed baseline of realized vol — the pool's OWN "normal" noise.
   * First real observation seeds it; thereafter `base = 0.1*v + 0.9*base`.
   * When null (no history), classification uses DEFAULT_BASELINE_VOL and
   * reports "unknown" until `period` real observations exist.
   */
  baselineVol?: number | null;
  /** realizedVol/baseline above this → SPIKED. */
  spikeThreshold?: number;
  /** realizedVol/baseline below this → CALM. */
  calmRatio?: number;
  /** Consecutive ticks required in a new regime before switching (hysteresis). */
  confirmTicks?: number;
}

export interface RegimeState {
  regime: VolatilityRegime;
  realizedVol: number | null;
  baselineVol: number | null;
}

/**
 * Stateful CALM / NORMAL / SPIKED classifier with consecutive-tick hysteresis
 * (mirrors TrendTracker's confirmation pattern). SPIKED means "much noisier
 * than this pool's own recent history" — self-referential, which is what
 * memecoin vol regimes need. Regime stays "unknown" until the lookback fills.
 */
export class RegimeClassifier {
  private readonly opts: Required<RegimeOpts> & { baselineVol: number | null };
  private baseline: number | null;
  private candidate: VolatilityRegime | null = null;
  private candidateStreak = 0;
  private regime: VolatilityRegime = "unknown";
  private lastRealizedVol: number | null = null;

  constructor(opts: RegimeOpts = {}) {
    this.opts = {
      period: Math.max(2, Math.round(opts.period ?? 14)),
      baselineVol: opts.baselineVol ?? null,
      spikeThreshold: Number.isFinite(opts.spikeThreshold ?? NaN) ? (opts.spikeThreshold as number) : 2.5,
      calmRatio: Number.isFinite(opts.calmRatio ?? NaN) ? (opts.calmRatio as number) : 0.5,
      confirmTicks: Math.max(1, Math.round(opts.confirmTicks ?? 2)),
    };
    this.baseline = this.opts.baselineVol;
  }

  /**
   * Feed the latest close window and return the current regime. `closes` is
   * the full per-position window (e.g. TrendTracker's ring buffer) — the
   * classifier derives realized vol and the EMA baseline itself.
   */
  observe(closes: number[]): VolatilityRegime {
    const v = realizedVol(closes);
    if (!Number.isFinite(v)) return this.regime; // data gap — hold the current regime
    this.lastRealizedVol = v;
    const period = this.opts.period;
    const fin = closes.filter((c) => Number.isFinite(c) && c > 0).length;

    // Baseline: seed from the first real measurement, then EMA-smooth.
    if (this.baseline == null || this.baseline <= 0) this.baseline = v;
    else this.baseline = 0.1 * v + 0.9 * this.baseline;
    if (this.baseline <= 0) this.baseline = DEFAULT_BASELINE_VOL;

    if (fin < period) {
      // Not enough history to trust a classification.
      this.regime = "unknown";
      this.candidate = null;
      this.candidateStreak = 0;
      return this.regime;
    }

    const ratio = v / this.baseline;
    const target: VolatilityRegime =
      ratio > this.opts.spikeThreshold ? "spiked" : ratio < this.opts.calmRatio ? "calm" : "normal";

    // Hysteresis: only switch after confirmTicks CONSECUTIVE ticks in the new
    // target regime, so a single noisy tick cannot flap the classification.
    if (target === this.regime) {
      this.candidate = null;
      this.candidateStreak = 0;
      return this.regime;
    }
    if (this.candidate === target) {
      this.candidateStreak++;
    } else {
      this.candidate = target;
      this.candidateStreak = 1;
    }
    if (this.candidateStreak >= this.opts.confirmTicks) {
      this.regime = target;
      this.candidate = null;
      this.candidateStreak = 0;
      log.info(
        "VOL",
        `regime → ${target} (realizedVol=${v.toPrecision(3)}, baseline=${this.baseline.toPrecision(3)})`,
      );
    }
    return this.regime;
  }

  /** Current state, for journaling. */
  state(): RegimeState {
    return {
      regime: this.regime,
      realizedVol: this.lastRealizedVol,
      baselineVol: this.baseline,
    };
  }
}

/**
 * Structure stop level = highest close since entry (high-water) − mult × ATR.
 * The 0.5–1× ATR buffer from the operator's spec is enforced by clamping
 * `mult` into [0.5, 2]; the level is additionally clamped so it can never sit
 * below `entry × (1 − maxLossPct)` — the static % line stays the HARD loss
 * floor, and a stop below it would be meaningless (the floor fires first).
 *
 * Returns null when the inputs are non-finite (fail closed to the static % line).
 */
export function structureStopLevel(
  highWaterClose: number,
  entryPrice: number,
  atr: number,
  mult: number,
  maxLossPct: number,
): number | null {
  if (
    !Number.isFinite(highWaterClose) || highWaterClose <= 0 ||
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    !Number.isFinite(atr) || atr < 0 ||
    !Number.isFinite(maxLossPct) || maxLossPct <= 0
  ) {
    return null;
  }
  const clampedMult = Math.min(2, Math.max(0.5, Number.isFinite(mult) ? mult : 1));
  const level = highWaterClose - clampedMult * atr;
  const floor = entryPrice * (1 - maxLossPct / 100);
  if (!Number.isFinite(floor) || floor <= 0) return null;
  return Math.max(level, floor);
}
