/**
 * Trend monitoring for the CLOSE decision — the operator's 2026-08-09 rule:
 *
 *   "for TP please don't set any stop and use trend change significantly for
 *   close order"
 *
 * Winners ride the trend with NO fixed take-profit and NO trailing stop; a
 * position closes only when the trend has SIGNIFICANTLY flipped to downtrend.
 * The static stop-loss remains the hard loss floor for the losing side.
 *
 * The signal is deliberately symmetric with the ENTRY side
 * (strategy/trend-following-strategy.ts): the fast EMA crossing below the slow
 * EMA AND a negative MACD histogram. To avoid whipsaw on single wicks —
 * memecoin pools wick hard — the flip must persist for `confirmTicks`
 * consecutive observations before it counts as confirmed.
 *
 * Pure module — no DB, no network, no `config.ts` import (callers construct
 * `TrendConfig`). Mirrors `exit/rug-detector.ts`: pure functions + one small
 * in-memory tracker, so all of it is unit-testable.
 */

import { calculateEMA, calculateMACD } from "../ml/features";

/** Tunables for the trend signal. Callers build this from CONFIG. */
export interface TrendConfig {
  /** Fast EMA period, e.g. 7. */
  fastEmaPeriod: number;
  /** Slow EMA period, e.g. 25. */
  slowEmaPeriod: number;
  /**
   * Consecutive bearish observations required before the flip is CONFIRMED.
   * 3 ticks ≈ 30s on the hot path (10s cadence) / 1min on the sniper (20s).
   */
  confirmTicks: number;
  /** Max price points kept per position (rolling window). */
  historySize: number;
  /**
   * Minimum count of REAL price observations (not the seeded flat copies)
   * before a downtrend flip may be CONFIRMED.
   *
   * 2026-08-09 PAWZ: the ring buffer is seeded with `slowEmaPeriod + 2`
   * copies of the entry price, so a ~3-real-tick decline could push the fast
   * EMA below the slow EMA against a flat baseline and confirm a "flip" from
   * almost no evidence — PAWZ closed on trend_exit at −2% after ~59s. The
   * lock refuses to confirm until a position has accumulated a meaningful
   * sample of real prices, so the seed baseline cannot be the signal.
   */
  minObservations: number;
}

export const DEFAULT_TREND_CONFIG: TrendConfig = {
  fastEmaPeriod: 7,
  slowEmaPeriod: 25,
  confirmTicks: 3,
  historySize: 60,
  minObservations: 6,
};

/** Outcome of one trend observation. */
export interface TrendSignal {
  /** fast EMA < slow EMA AND MACD histogram < 0. */
  bearish: boolean;
  /** Consecutive bearish observations so far (0 on any non-bearish tick). */
  confirmations: number;
  /** `confirmations >= confirmTicks` — the only state that may fire a close. */
  confirmed: boolean;
  /** Real (non-seed) price observations seen for the key so far. */
  observations: number;
  fastEma: number;
  slowEma: number;
  macdHistogram: number;
  /** Human-readable reason, populated only when confirmed. */
  reason: string;
}

const EMPTY: TrendSignal = {
  bearish: false,
  confirmations: 0,
  confirmed: false,
  observations: 0,
  fastEma: 0,
  slowEma: 0,
  macdHistogram: 0,
  reason: "",
};

/** Compact number formatting for the reason string (prices are ~1e-8). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "NaN";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e5)) return n.toExponential(3);
  return n.toFixed(4);
}

/**
 * Pure signal evaluation over a close-price series. Stateless: the caller
 * (TrendTracker) owns the history and the confirmation counter.
 *
 * Returns a non-bearish signal when the series is too short or contains a
 * non-finite/non-positive price — fail closed, never a guess.
 */
export function evaluateTrendSignal(
  closes: number[],
  cfg: TrendConfig,
): TrendSignal {
  if (!closes || closes.length < cfg.slowEmaPeriod + 2) return { ...EMPTY };
  for (const c of closes) {
    if (!Number.isFinite(c) || c <= 0) return { ...EMPTY };
  }
  const fastEma = calculateEMA(closes, cfg.fastEmaPeriod);
  const slowEma = calculateEMA(closes, cfg.slowEmaPeriod);
  // CLOCK CONSISTENCY (2026-08-09): the MACD pair must run on the SAME
  // periods as the crossover it is corroborating. `calculateMACD` defaults to
  // 12/26/9, which disagreed with the configured 7/25 EMA pair — so the two
  // halves of the signal measured the market on different clocks and could
  // contradict each other. Passing the configured fast/slow keeps one clock.
  const macd = calculateMACD(closes, cfg.fastEmaPeriod, cfg.slowEmaPeriod);
  if (!Number.isFinite(fastEma) || !Number.isFinite(slowEma) || !Number.isFinite(macd.histogram)) {
    return { ...EMPTY };
  }
  const bearish = fastEma < slowEma && macd.histogram < 0;
  return {
    bearish,
    confirmations: 0,
    confirmed: false,
    observations: 0,
    fastEma,
    slowEma,
    macdHistogram: macd.histogram,
    reason: "",
  };
}

/**
 * Per-position price-series tracker with a consecutive-confirmation counter.
 *
 * On first observation the ring buffer is SEEDED with the entry price so the
 * EMA pair has a well-defined baseline from the first real tick (a flat
 * pre-entry series is the honest assumption — we bought at that price). A
 * non-finite tick is skipped WITHOUT resetting the confirmation counter: a
 * data gap is not a recovery.
 */
export class TrendTracker {
  private series = new Map<string, number[]>();
  private confirmations = new Map<string, number>();
  private observations = new Map<string, number>();
  private readonly cfg: TrendConfig;

  constructor(cfg: TrendConfig = DEFAULT_TREND_CONFIG) {
    // A history shorter than the slow-EMA warm-up silently disables the
    // signal (evaluateTrendSignal needs slowEmaPeriod + 2 points), so clamp it
    // rather than failing closed forever. confirmTicks < 1 is degenerate (fires
    // on the first bearish tick) — clamp to 1.
    this.cfg = {
      ...cfg,
      historySize: Math.max(cfg.historySize, cfg.slowEmaPeriod + 2),
      confirmTicks: Math.max(1, Math.round(cfg.confirmTicks)),
      minObservations: Math.max(1, Math.round(cfg.minObservations)),
    };
  }

  /** Record a price observation for `key` and return the current signal. */
  observe(key: string, price: number, seedPrice?: number): TrendSignal {
    let buf = this.series.get(key);
    if (!buf) {
      const seed =
        Number.isFinite(seedPrice) && seedPrice > 0 ? seedPrice : price;
      // historySize is clamped >= slowEmaPeriod + 2 in the constructor.
      buf = new Array(this.cfg.slowEmaPeriod + 2).fill(seed);
      this.series.set(key, buf);
    }
    const valid = Number.isFinite(price) && price > 0;
    if (valid) {
      buf.push(price);
      if (buf.length > this.cfg.historySize) buf.shift();
      this.series.set(key, buf);
      this.observations.set(key, (this.observations.get(key) ?? 0) + 1);
    }

    const base = evaluateTrendSignal(buf, this.cfg);
    const priorConf = this.confirmations.get(key) ?? 0;
    // A skipped (non-finite) tick is a data gap, not a new observation — it
    // neither counts toward confirmation nor resets the streak.
    const conf =
      valid
        ? base.bearish
          ? priorConf + 1
          : 0
        : priorConf;
    this.confirmations.set(key, conf);
    const obs = this.observations.get(key) ?? 0;
    // The MIN-OBSERVATIONS LOCK (2026-08-09): a confirmed flip also requires
    // a meaningful sample of REAL prices. Without it, the EMA pair only needs
    // to move against the flat seed baseline — which a 3-tick dip can do —
    // and trend_exit fires from almost no evidence (PAWZ closed at −2%).
    const confirmed = conf >= this.cfg.confirmTicks && obs >= this.cfg.minObservations;
    return {
      ...base,
      confirmations: conf,
      observations: obs,
      confirmed,
      reason: confirmed
        ? `fast EMA ${fmt(base.fastEma)} < slow EMA ${fmt(base.slowEma)}, MACD hist ${fmt(
            base.macdHistogram,
          )} < 0 for ${conf} consecutive ticks (${obs} real obs)`
        : "",
    };
  }

  /** Drop per-position state once the position is closed. */
  forget(key: string): void {
    this.series.delete(key);
    this.confirmations.delete(key);
    this.observations.delete(key);
  }
}
