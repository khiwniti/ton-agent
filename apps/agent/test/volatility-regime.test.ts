/**
 * Unit tests for the Phase 4.5 volatility- & structure-adaptive exit facts —
 * `src/exit/volatility-regime.ts`.
 *
 * The market layer produces only tick CLOSES (no OHLCV), so ATR is a
 * Wilder-smoothed |Δclose| proxy, realized vol is the per-tick stdev of log
 * returns, the regime classifier is CALM/NORMAL/SPIKED with consecutive-tick
 * hysteresis, and the structure stop is high-water − k×ATR clamped at the
 * static % floor.
 *
 * Pure module — no DB, no network. Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/volatility-regime.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atrClose,
  realizedVol,
  RegimeClassifier,
  structureStopLevel,
  type VolatilityRegime,
} from "../src/exit/volatility-regime.js";

// ── atrClose ────────────────────────────────────────────────────────────────

test("atrClose: empty series → NaN (fail closed, never 0)", () => {
  assert.ok(Number.isNaN(atrClose([])));
  assert.ok(Number.isNaN(atrClose([Number.NaN, Number.NaN])));
});

test("atrClose: single close → floor = lastClose * 0.02", () => {
  const a = atrClose([100]);
  assert.equal(a, 2); // 100 * 0.02
});

test("atrClose: warm-up (< period deltas) = plain mean of |Δ|", () => {
  // closes 100, 101, 103 → deltas [1, 2] → mean 1.5
  const a = atrClose([100, 101, 103], 14);
  assert.equal(a, 1.5);
});

test("atrClose: Wilder smoothing converges on constant step", () => {
  // constant step of 1 → |Δ| = 1 forever → ATR → 1
  const closes: number[] = [];
  for (let i = 0; i <= 100; i++) closes.push(100 + i);
  const a = atrClose(closes, 14);
  assert.ok(Math.abs(a - 1) < 1e-9, `expected ~1, got ${a}`);
});

test("atrClose: larger moves → larger ATR (scales with Δ magnitude)", () => {
  const small: number[] = [];
  const big: number[] = [];
  for (let i = 0; i <= 60; i++) {
    small.push(100 + i * 0.1); // step 0.1
    big.push(100 + i * 2.0); // step 2.0
  }
  const aSmall = atrClose(small, 14);
  const aBig = atrClose(big, 14);
  assert.ok(aBig > aSmall * 10, `big(${aBig}) should dwarf small(${aSmall})`);
});

test("atrClose: non-finite closes are filtered before computing", () => {
  const a = atrClose([100, Number.NaN, 102, 104], 14);
  // finite closes 100,102,104 → deltas [2,2] → mean 2
  assert.equal(a, 2);
});

// ── realizedVol ─────────────────────────────────────────────────────────────

test("realizedVol: NaN for < 2 finite closes", () => {
  assert.ok(Number.isNaN(realizedVol([])));
  assert.ok(Number.isNaN(realizedVol([100])));
  assert.ok(Number.isNaN(realizedVol([Number.NaN, 100])));
});

test("realizedVol: constant series → 0", () => {
  assert.equal(realizedVol([100, 100, 100, 100]), 0);
});

test("realizedVol: larger dispersion → larger σ (self-referential scale)", () => {
  const a = realizedVol([100, 110, 100, 110, 100, 110]);
  const b = realizedVol([100, 103, 100, 103, 100, 103]);
  assert.ok(a > b, `a=${a} b=${b}`);
});

test("realizedVol: scale-invariant (log returns)", () => {
  // multiplying every close by a constant changes nothing
  const base = [100, 110, 100, 110, 100, 110];
  const scaled = base.map((c) => c * 1000);
  assert.ok(Math.abs(realizedVol(base) - realizedVol(scaled)) < 1e-9);
});

// ── RegimeClassifier ────────────────────────────────────────────────────────

test("regime: unknown until the lookback fills (period real closes)", () => {
  const rc = new RegimeClassifier({ period: 5, confirmTicks: 1 });
  // flat-then-tiny-jitter: for i < period the classifier must report unknown
  const closes: number[] = [];
  for (let i = 0; i < 4; i++) {
    closes.push(100 + (i % 2) * 0.1);
    const regime = rc.observe(closes);
    if (closes.length < 5) {
      assert.equal(regime, "unknown", `at ${closes.length} closes`);
    }
  }
  closes.push(100.5);
  const regime = rc.observe(closes);
  assert.notEqual(regime, "unknown");
});

test("regime: sustained SPIKED (10x baseline) classifies as spiked", () => {
  // quiet baseline first: flat prices → realizedVol ~ 0
  const rc = new RegimeClassifier({ period: 5, spikeThreshold: 2.5, confirmTicks: 1 });
  const quiet: number[] = [];
  for (let i = 0; i < 8; i++) quiet.push(100);
  // observe the quiet series to seed the baseline low
  rc.observe(quiet);
  // now alternate wildly 100/120 — log-return ≈ ±0.18 each tick
  const loud: number[] = [...quiet];
  for (let i = 0; i < 12; i++) loud.push(i % 2 ? 100 : 120);
  const regime = rc.observe(loud);
  assert.equal(regime, "spiked");
});

test("regime: sustained CALM classifies as calm", () => {
  const rc = new RegimeClassifier({ period: 5, calmRatio: 0.5, confirmTicks: 2 });
  const baseline: number[] = [];
  for (let i = 0; i < 8; i++) baseline.push(100 + (i % 2) * 10); // vol baseline
  assert.equal(rc.observe(baseline), "unknown"); // seed baseline (needs 2 ticks to leave unknown)
  assert.equal(rc.observe(baseline), "normal"); // steady NORMAL
  const calm: number[] = [];
  for (let i = 0; i < 12; i++) calm.push(100); // flat → vol 0 → target CALM
  assert.equal(rc.observe(calm), "normal", "first calm tick is candidate only");
  assert.equal(rc.observe(calm), "calm", "second consecutive calm tick flips");
});

test("regime: hysteresis — 2 consecutive ticks required before switching", () => {
  // Pin the baseline so the ratio is purely input-driven (the EMA baseline
  // would otherwise chase the spiked window and converge the ratio back to 1).
  const rc = new RegimeClassifier({
    period: 5,
    baselineVol: 0.05,
    spikeThreshold: 2.5,
    calmRatio: 0.5,
    confirmTicks: 2,
  });
  // Seed a NORMAL regime: alternating 100/105 → realized vol ≈ baseline.
  const seed: number[] = [];
  for (let i = 0; i < 8; i++) seed.push(100 + (i % 2) * 5);
  assert.equal(rc.observe(seed), "unknown"); // leaving "unknown" also needs 2 ticks
  assert.equal(rc.observe(seed), "normal"); // steady-state NORMAL
  // Feed a violent spiked burst one observation at a time. First spiked tick
  // must NOT flip — it enters the candidate state with streak 1 < confirmTicks.
  const spike = [100, 200, 100, 200, 100, 200];
  assert.equal(
    rc.observe(spike),
    "normal",
    "first spiked tick must not flip with confirmTicks=2",
  );
  assert.equal(
    rc.observe(spike),
    "spiked",
    "second consecutive spiked tick flips",
  );
});

test("regime: a data gap (NaN) holds the current regime, never errors", () => {
  const rc = new RegimeClassifier({ period: 5, confirmTicks: 1 });
  const closes = [100, 100, 100, 100, 100];
  rc.observe(closes);
  const regimeBefore = rc.observe(closes);
  const regimeGap = rc.observe([Number.NaN, Number.NaN]);
  assert.equal(regimeGap, regimeBefore);
});

// ── structureStopLevel ──────────────────────────────────────────────────────

test("structureStopLevel: level = highWater − mult×ATR", () => {
  // hw 110, entry 100, atr 2, mult 1 → 108
  const level = structureStopLevel(110, 100, 2, 1, 15);
  assert.equal(level, 108);
});

test("structureStopLevel: clamped to never sit below the static % floor", () => {
  // hw 102, entry 100, atr 10, mult 2 → 82 raw; floor = 85 → returns 85
  const level = structureStopLevel(102, 100, 10, 2, 15);
  assert.equal(level, 85);
});

test("structureStopLevel: mult clamped to [0.5, 2]", () => {
  // hw 110, entry 100, atr 4:
  //   mult 0.3 → clamped 0.5 → level 108
  //   mult 99 → clamped 2   → level 102
  assert.equal(structureStopLevel(110, 100, 4, 0.3, 15), 108);
  assert.equal(structureStopLevel(110, 100, 4, 99, 15), 102);
});

test("structureStopLevel: non-finite inputs → null (fail closed to static line)", () => {
  assert.equal(structureStopLevel(Number.NaN, 100, 2, 1, 15), null);
  assert.equal(structureStopLevel(110, 100, Number.NaN, 1, 15), null);
  assert.equal(structureStopLevel(110, 100, 2, 1, Number.NaN), null);
  assert.equal(structureStopLevel(110, 100, -1, 1, 15), null); // negative atr
  assert.equal(structureStopLevel(110, 100, 2, 1, 0), null); // maxLossPct <= 0
});
