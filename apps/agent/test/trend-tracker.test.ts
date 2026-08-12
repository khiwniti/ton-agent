/**
 * Unit tests for the trend-exit CLOSE decision — `src/exit/trend-monitor.ts`.
 *
 * The operator rule (2026-08-09): NO take-profit and NO trailing stop; a
 * winner closes only when the trend SIGNIFICANTLY flips up → down. The flip
 * must persist `confirmTicks` consecutive bearish observations before it is
 * confirmed (whipsaw guard), and needs `minObservations` real prices first
 * (seed-baseline lock).
 *
 * Pure module — no DB, no network. Series are generated with a flat baseline
 * (entry price) followed by a synthetic move, mirroring how the tracker is
 * seeded in the hot path (position-monitor.ts:252).
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/trend-tracker.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TrendTracker,
  evaluateTrendSignal,
  DEFAULT_TREND_CONFIG,
  type TrendConfig,
} from "../src/exit/trend-monitor.js";

const ENTRY = 100;

/** flat at ENTRY, then a linear drift over `declM` ticks to `target`. */
function gen(flatN: number, declM: number, target: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < flatN; i++) out.push(ENTRY);
  for (let i = 1; i <= declM; i++) out.push(ENTRY + ((target - ENTRY) * i) / declM);
  return out;
}

/** Watch which tick index first reaches a given state. */
function firstBearish(t: TrendTracker, series: number[]): number {
  for (let i = 0; i < series.length; i++) {
    if (t.observe("p", series[i], ENTRY).bearish) return i;
  }
  return -1;
}

function firstConfirmed(t: TrendTracker, series: number[]): number {
  for (let i = 0; i < series.length; i++) {
    if (t.observe("p", series[i], ENTRY).confirmed) return i;
  }
  return -1;
}

// ── 1. Pure signal ─────────────────────────────────────────────────────────

test("evaluateTrendSignal: sustained downtrend flips bearish", () => {
  // flat 20 @100, then decline to 60 — calibrated to cross both EMA pair and MACD hist.
  const closes = gen(20, 12, 60);
  const s = evaluateTrendSignal(closes, DEFAULT_TREND_CONFIG);
  assert.ok(s.bearish, `expected bearish (fast ${s.fastEma} slow ${s.slowEma} hist ${s.macdHistogram})`);
  assert.ok(s.fastEma < s.slowEma);
  assert.ok(s.macdHistogram < 0);
});

test("evaluateTrendSignal: uptrend is NOT bearish", () => {
  const closes = gen(20, 15, 200);
  const s = evaluateTrendSignal(closes, DEFAULT_TREND_CONFIG);
  assert.equal(s.bearish, false);
  assert.ok(s.fastEma > s.slowEma);
  assert.ok(s.macdHistogram > 0);
});

test("evaluateTrendSignal: series shorter than slowEmaPeriod+2 fails closed", () => {
  const short = gen(5, 2, 60);
  const s = evaluateTrendSignal(short, DEFAULT_TREND_CONFIG);
  assert.equal(s.bearish, false);
  assert.equal(s.confirmed, false);
});

// ── 2. Tracker confirmations ───────────────────────────────────────────────

test("uptrend never confirms a flip", () => {
  const t = new TrendTracker();
  const series = gen(20, 15, 200);
  for (const c of series) {
    const s = t.observe("p", c, ENTRY);
    assert.equal(s.bearish, false);
    assert.equal(s.confirmed, false);
  }
});

test("sustained downtrend confirms the flip after confirmTicks", () => {
  const t = new TrendTracker();
  const series = gen(20, 12, 60);
  const b = firstBearish(t, series);
  assert.ok(b > 0, "decline should eventually go bearish");
  // calibration: first bearish at index 20 (of 32), confirmed at 22
  assert.ok(b <= 20, `bearish too late: ${b}`);
  const t2 = new TrendTracker();
  const c = firstConfirmed(t2, series);
  assert.ok(c >= 0, "confirmed never reached");
  assert.ok(c - b <= 3, `confirmation should come quickly after bearish (b=${b} c=${c})`);
  // final observation is confirmed with full detail
  const final = t2.observe("p", series[series.length - 1], ENTRY);
  assert.equal(final.confirmed, true);
  assert.ok(final.reason.length > 0);
  assert.ok(final.observations >= DEFAULT_TREND_CONFIG.minObservations);
});

test("whipsaw: a recovery resets confirmations (fresh streak required)", () => {
  const t = new TrendTracker();
  const series = gen(20, 12, 60);
  for (const c of series) t.observe("p", c, ENTRY);
  const before = t.observe("p", series[series.length - 1], ENTRY);
  assert.equal(before.bearish, true);
  assert.ok(before.confirmations >= 1);
  // A single recovery tick (120) is NOT enough to flip the EMA pair — the
  // trend only turns after the buffer refills with several higher prices.
  // Feed a 5-tick climb back toward 120; the signal flips and — per observe()
  // `conf = valid ? (base.bearish ? priorConf + 1 : 0) : priorConf` — the
  // counter drops straight to 0 on the first non-bearish valid tick.
  const single = t.observe("p", ENTRY + 20, ENTRY);
  assert.equal(single.bearish, true, "one tick cannot flip a deeply crossed EMA pair");
  assert.ok(single.confirmations >= 1, "streak preserved until the signal actually turns");
  let after;
  for (let i = 1; i <= 5; i++) {
    after = t.observe("p", 60 + ((120 - 60) * i) / 5, ENTRY);
  }
  assert.equal(after.bearish, false, "recovery sequence must flip the signal");
  assert.equal(after.confirmations, 0, "any non-bearish valid tick resets the streak");
  // A fresh decline must re-accumulate a full confirmTicks streak from scratch.
  for (let i = 1; i <= 12; i++) {
    after = t.observe("p", 120 + ((60 - 120) * i) / 12, ENTRY);
  }
  assert.ok(after.confirmations >= DEFAULT_TREND_CONFIG.confirmTicks, "re-decline re-accumulates the streak");
});

test("data gap (non-finite tick) preserves the streak, never resets it", () => {
  const t = new TrendTracker();
  const series = gen(20, 12, 60);
  for (const c of series) t.observe("p", c, ENTRY);
  const before = t.observe("p", series[series.length - 1], ENTRY);
  assert.ok(before.confirmations >= 1);
  // NaN tick = a data gap, not a recovery: the streak is PAUSED (not reset).
  // The buffer still holds the last valid series, so `bearish` may stay true —
  // the invariant is that confirmations and observations are preserved.
  const gap = t.observe("p", Number.NaN, ENTRY);
  assert.equal(gap.confirmations, before.confirmations); // streak preserved
  assert.equal(gap.observations, before.observations); // not a real observation
  // next real bearish tick continues the streak
  const next = t.observe("p", series[series.length - 1] * 0.95, ENTRY);
  assert.equal(next.confirmations, before.confirmations + 1);
});

test("minObservations lock: a fresh tracker with few real ticks cannot confirm", () => {
  // The PAWZ case (2026-08-09): a fresh tracker seeds `slowEmaPeriod+2` flat
  // copies of the entry price, so a ~3-tick decline could cross the EMA pair
  // against that baseline and confirm a "flip" from almost no evidence. The
  // lock requires >= minObservations REAL observations first. Only 3 real
  // ticks (obs=3 < 6) must NEVER confirm — regardless of the EMA crossing.
  const t = new TrendTracker();
  const series = gen(0, 3, 92); // no flats — just 3 real declining ticks
  let confirmed = false;
  let bearishSeen = false;
  for (const c of series) {
    const s = t.observe("p", c, ENTRY);
    if (s.confirmed) confirmed = true;
    if (s.bearish) bearishSeen = true;
  }
  assert.equal(confirmed, false, "3 real ticks must be locked by minObservations");
  // keep the guard honest: the EMA pair may or may not cross here, but the
  // lock is what blocks confirmation — never assert on bearishSeen.
  assert.ok(series.length < DEFAULT_TREND_CONFIG.minObservations);
});

test("forget() drops per-position trend state", () => {
  const t = new TrendTracker();
  const series = gen(20, 12, 60);
  for (const c of series) t.observe("p", c, ENTRY);
  assert.ok(t.observe("p", series[series.length - 1], ENTRY).confirmed);
  t.forget("p");
  // after forget, the next observation reseeds fresh from the new price
  const s = t.observe("p", 100, 100);
  assert.equal(s.observations, 1);
  assert.equal(s.confirmations, 0);
  assert.equal(s.confirmed, false);
});

// ── 3. Config clamps ───────────────────────────────────────────────────────

test("confirmTicks is clamped to >= 1", () => {
  const cfg: TrendConfig = {
    ...DEFAULT_TREND_CONFIG,
    confirmTicks: 0,
    minObservations: 1,
  };
  const series = gen(20, 12, 60);
  // fresh trackers for each scan (a used tracker continues from its end)
  const b = firstBearish(new TrendTracker(cfg), series);
  const c = firstConfirmed(new TrendTracker(cfg), series);
  assert.ok(c >= 0, "should confirm");
  assert.equal(c, b, "confirm on the first bearish tick");
});

test("historySize shorter than slowEmaPeriod+2 is clamped (signal not disabled)", () => {
  const cfg: TrendConfig = {
    ...DEFAULT_TREND_CONFIG,
    historySize: 5,
  };
  const t = new TrendTracker(cfg);
  const series = gen(20, 12, 60);
  const c = firstConfirmed(t, series);
  assert.ok(c >= 0, "clamped history must still allow a confirmed flip");
});

// ── 4. Phase 4.5 accessors (highWaterClose / closes) ───────────────────────

test("highWaterClose returns the max of the ring buffer", () => {
  const t = new TrendTracker();
  t.observe("p", 100, ENTRY);
  t.observe("p", 105, ENTRY);
  t.observe("p", 102, ENTRY);
  t.observe("p", 110, ENTRY);
  t.observe("p", 108, ENTRY);
  assert.equal(t.highWaterClose("p"), 110);
});

test("highWaterClose returns the seeded entry price before any higher close", () => {
  const t = new TrendTracker();
  t.observe("p", 100, ENTRY);
  t.observe("p", 99, ENTRY);
  t.observe("p", 98, ENTRY);
  // seed is ENTRY (100) — nothing has exceeded it yet
  assert.equal(t.highWaterClose("p"), 100);
});

test("highWaterClose is null for an unknown key", () => {
  const t = new TrendTracker();
  assert.equal(t.highWaterClose("nope"), null);
});

test("highWaterClose ignores non-finite closes", () => {
  const t = new TrendTracker();
  t.observe("p", 100, ENTRY);
  t.observe("p", 120, ENTRY);
  t.observe("p", Number.NaN, ENTRY); // data gap — skipped from the buffer
  assert.equal(t.highWaterClose("p"), 120);
});

test("closes returns a copy of the live window (seed + real prices)", () => {
  const t = new TrendTracker();
  const series = gen(4, 2, 90); // 4 flat @100 then 2 declining
  for (const c of series) t.observe("p", c, ENTRY);
  const closes = t.closes("p");
  // seeded with slowEmaPeriod+2 = 27 copies of ENTRY, then 6 real ticks
  assert.equal(closes.length, 27 + 6);
  assert.equal(closes[closes.length - 1], series[series.length - 1]);
  assert.equal(closes[0], ENTRY); // seed baseline
  // mutating the returned copy must not affect the tracker
  closes.push(1);
  assert.equal(t.closes("p").length, 27 + 6);
});

test("closes returns [] for an unknown key", () => {
  const t = new TrendTracker();
  assert.deepEqual(t.closes("nope"), []);
});

test("forget() drops the high-water/close state too", () => {
  const t = new TrendTracker();
  t.observe("p", 100, ENTRY);
  t.observe("p", 115, ENTRY);
  assert.equal(t.highWaterClose("p"), 115);
  t.forget("p");
  assert.equal(t.highWaterClose("p"), null);
  assert.deepEqual(t.closes("p"), []);
});
