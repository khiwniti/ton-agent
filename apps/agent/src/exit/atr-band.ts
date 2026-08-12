/**
 * Chandelier-style ATR corroboration band (journal-only, spec 2026-08-12 §1).
 *
 * Trails `atrMult × ATR` below the running peak, mirroring the existing
 * `TREND_EXIT_ATR_MULT=3.0` (also journal-only today). The engine journals the
 * band state every monitor tick; it is NEVER an exit trigger on its own — the
 * spec's final-close priority (structure-stop, giveback, trend-flip) stays
 * authoritative. Its job is a post-trade seat at the table: journal data will
 * tell us whether the Chandelier signal agrees with the giveback trail before
 * it is ever promoted to a hard trigger.
 */
import { atrClose } from "./volatility-regime.js";

export interface AtrBandOptions {
  /** Real close series from the trend tracker (price deltas, not times). */
  closes: number[];
  /** ATR multiplier for the band width. Default mirrors TREND_EXIT_ATR_MULT. */
  atrMult?: number;
  entryPriceTon: number;
  peakPriceTon: number;
}

export interface AtrBandState {
  /** `peak − atrMult × ATR`; null when the series cannot yet price a band. */
  bandLevelTon: number | null;
  /** True when the last close pierced below the band. Never an exit action. */
  breached: boolean;
}

export function atrBandState(opts: AtrBandOptions): AtrBandState {
  const atrMult = opts.atrMult ?? 3.0;
  // A single close carries no price delta to price volatility from — no band.
  // atrClose itself degrades to a floor for one sample, so guard here first.
  if (opts.closes.length < 2) {
    return { bandLevelTon: null, breached: false };
  }
  const atr = atrClose(opts.closes);
  if (!Number.isFinite(atr) || atr <= 0) {
    return { bandLevelTon: null, breached: false };
  }
  const band = opts.peakPriceTon - atrMult * atr;
  // Clamp below entry: a winner that merely breathes cannot "breach" its own
  // cost basis — only a giveback/trend-flip below entry should ever close it.
  const clamped = Math.max(band, opts.entryPriceTon);
  const lastClose = opts.closes[opts.closes.length - 1];
  return { bandLevelTon: clamped, breached: lastClose < clamped };
}
