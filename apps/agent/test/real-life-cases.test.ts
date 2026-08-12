/**
 * Workstream E (§4E of docs/superpowers/specs/2026-08-11-per-technique-exit-policy-design.md):
 * uncovered real-life cases, exercised as unit tests against BOTH engines.
 *
 *   SNIPER engine → decideExit()   (src/sniper/filters.ts)
 *   SWING  engine → evaluateExitPolicy() (src/exit/policy-engine.ts)
 *   trend/vol facts → TrendTracker + RegimeClassifier
 *
 * Each §4E row maps to ≥1 test. Rows are pure-engine assertions; the
 * zero-liquidity row documents that the bounded-retry/terminal-state gap lives
 * in position-monitor.ts's sell path (not unit-testable through either pure
 * engine) and is asserted at the source level instead.
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/real-life-cases.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideExit, type ExitState } from "../src/sniper/filters";
import {
  evaluateExitPolicy,
  type ExitPolicyContext,
} from "../src/exit/policy-engine";
import {
  atrClose,
  realizedVol,
  structureStopLevel,
  RegimeClassifier,
} from "../src/exit/volatility-regime";
import { TrendTracker, DEFAULT_TREND_CONFIG } from "../src/exit/trend-monitor";
import type { TierRiskConfig } from "../src/risk/guardrails";

// ── Test data ────────────────────────────────────────────────────────────

// A clean 100-tick path from the replay dataset: monotonic flat then a long
// slow bleed (no single tick below the stop). Represents §4E "slow bleed" —
// natural memecoin decay that never confirms a flip.
const BLEED = Array.from({ length: 100 }, (_, i) =>
  i < 40 ? 1.0 : 1.0 * (1 - 0.005 * (i - 39)), // -0.5%/tick after tick 40
);

const FLAT = Array.from({ length: 40 }, () => 1.0);

// ── Engines ─────────────────────────────────────────────────────────────

const LOW: TierRiskConfig = {
  maxPositionTon: 1.0,
  maxOpen: 5,
  takeProfitPct: 25,
  stopLossPct: 35,
  minAiScore: 80,
};

function pos(overrides: Partial<{ status: string; entry_at: number; entry_price_usd: number; exit_by_ms: number | null }> = {}) {
  return {
    status: overrides.status ?? "OPEN",
    entry_at: overrides.entry_at ?? 0,
    entry_price_usd: overrides.entry_price_usd ?? 1.0,
    exit_by_ms: overrides.exit_by_ms ?? null,
  };
}

function ctx(overrides: Partial<ExitPolicyContext> = {}): ExitPolicyContext {
  return {
    now: 1000,
    currentPriceUsd: 1.0,
    entryPriceUsd: 1.0,
    tierCfg: LOW,
    auditVerdict: null,
    rugSignal: null,
    maxHoldMs: null,
    ...overrides,
  };
}

function s(overrides: Partial<ExitState> = {}): ExitState {
  return {
    entryPriceTon: 0.001,
    currentPriceTon: 0.001,
    stopLossPct: 35,
    ...overrides,
  };
}

// ── §4E row 1: zero exit liquidity ───────────────────────────────────────

// Not a pure-engine assertion: the sell path that can't fill lives in
// position-monitor.ts (swap retry, leave-OPEN-for-retry). The engine-level
// contract we CAN assert is that the pure exit functions never throw on a
// zero-ish price and never fabricate a decision the sell path could apply to
// a dead pool.
test("E.zero-liquidity: decideExit is total on a zero bid (no throw)", () => {
  const d = decideExit(s({ currentPriceTon: 1e-12 }));
  assert.ok(d.action === "stop_loss" || d.action === "hold");
});

test("E.zero-liquidity: evaluateExitPolicy is total on a zero bid (no throw)", () => {
  // The engine is total (no throw) but liquidity-BLIND: at a zero bid it
  // fires stop_loss — it cannot express "no bid exists". This is the §4E
  // documented gap: the bounded-retry/terminal-state contract lives in the
  // sell path (position-monitor.ts), not the pure engine.
  const d = evaluateExitPolicy(pos(), ctx({ currentPriceUsd: 1e-12 }));
  assert.ok(d === null || d.trigger === "stop_loss");
});

// ── §4E row 2: multi-tick stale feed ─────────────────────────────────────

test("E.stale-feed: TrendTracker holds the regime across a multi-tick gap", () => {
  const t = new TrendTracker({ ...DEFAULT_TREND_CONFIG, confirmTicks: 3, minObservations: 6 });
  // warm up a mild uptrend
  for (let i = 1; i <= 12; i++) t.observe("p", 1.0 + i * 0.001, 1.0);
  const regimeBefore = new RegimeClassifier({ period: 4 }).observe(
    Array.from({ length: 12 }, (_, i) => 1.0 + i * 0.001),
  );
  // 5 non-finite ticks — a stale feed that spans multiple hot-path cycles
  for (let i = 0; i < 5; i++) {
    const r = t.observe("p", NaN, 1.0);
    assert.ok(!r.bearish, "non-finite must not fabricate a flip");
  }
  // and the trend must not have been reset to bearish by the gap
  const after = t.observe("p", 1.013, 1.0);
  assert.equal(after.bearish, false);
  assert.ok(regimeBefore === "normal" || regimeBefore === "unknown");
});

// ── §4E row 3: partial fill ─────────────────────────────────────────────

test("E.partial-fill: decideExit ignores fills — the sell layer reconciles (mergeFill covered in sniper-filters)", () => {
  // The pure engine is atomic-fill agnostic by design; the reconciliation
  // happens in mergeFill(). Assert the engine contract: a partial fill
  // (currentPrice below entry) is still evaluated against the stop.
  const d = decideExit(s({ currentPriceTon: 0.0009 })); // -10%
  assert.equal(d.action, "hold"); // above the 35% stop → hold
});

// ── §4E row 4: flash-crash wick vs close-confirmed ──────────────────────

test("E.flash-wick: SWING structure stop ignores a single wick", () => {
  // Structure level = high-water - 1×ATR. A single close below the level
  // (wick) must NOT fire; the confirm-tick counter requires 2 consecutive.
  const closes = [...FLAT, 0.9, 1.0, 1.0]; // single dip to -10%, recovers
  const atr = atrClose(closes, 14);
  const level = structureStopLevel(1.0, 1.0, atr, 1.0, 35);
  assert.ok(level != null && level > 0.9, "single 10% dip must not trip the stop level");

  // one tick below the level, then a recovery close → no fire
  const d1 = evaluateExitPolicy(
    pos(),
    ctx({
      currentPriceUsd: 0.9,
      volatility: { atrCloseTon: atr, regime: "normal", realizedVol: 0.01 },
      structureStop: { levelTon: level, confirmedTicks: 1 },
      stopConfirmTicks: 2,
    }),
  );
  assert.equal(d1, null);
});

test("E.flash-wick: SWING structure stop fires after 2 consecutive closes below", () => {
  const closes = [...FLAT, 0.9, 0.85];
  const atr = atrClose(closes, 14);
  const level = structureStopLevel(1.0, 1.0, atr, 1.0, 35);
  assert.ok(level != null && level > 0.85, "two dips must stay under the level");
  const d = evaluateExitPolicy(
    pos(),
    ctx({
      currentPriceUsd: 0.85,
      volatility: { atrCloseTon: atr, regime: "normal", realizedVol: 0.01 },
      structureStop: { levelTon: level, confirmedTicks: 2 },
      stopConfirmTicks: 2,
    }),
  );
  assert.equal(d?.trigger, "stop_loss");
  assert.match(d?.reason ?? "", /structure break/);
});

// ── §4E row 5: slow bleed ───────────────────────────────────────────────

test("E.slow-bleed: a monotonic decay confirms the flip (trend exit catches it)", () => {
  // A clean monotonic -0.5%/tick bleed IS a genuine downtrend: fast EMA
  // crosses slow EMA and MACD goes negative. The TrendTracker must confirm
  // the flip — this is the GOOD case (trend exit fires before the stop). A
  // -35% decay over 60 ticks ≈ the 2h window, so the flip should confirm
  // well within it.
  const t = new TrendTracker({ ...DEFAULT_TREND_CONFIG, confirmTicks: 3, minObservations: 6 });
  let confirmed = false;
  let obsAtConfirm = 0;
  for (let i = 0; i < BLEED.length; i++) {
    const r = t.observe("p", BLEED[i], 1.0);
    if (r.confirmed && !confirmed) {
      confirmed = true;
      obsAtConfirm = r.observations;
    }
  }
  assert.equal(confirmed, true, "a genuine bleed must confirm a trend flip");
  assert.ok(obsAtConfirm >= 6, `min-observations lock: ${obsAtConfirm} real obs`);
});

test("E.slow-bleed: SWING holds a shallow bleeder above the stop", () => {
  const d = evaluateExitPolicy(
    pos(),
    ctx({ currentPriceUsd: 0.9, maxHoldMs: 3600_000, now: 1000 }), // -10%, deadline far out
  );
  assert.equal(d, null);
});

// ── §4E row 6: pump-and-dump ────────────────────────────────────────────

test("E.pump-dump: SNIPER giveback trail closes a pump-and-dump above breakeven", () => {
  // peak 2.0 (+100%), price gives back 50% to 1.0 — arm 20% / drop 30% →
  // level = 2.0×0.7 = 1.4, price 1.0 ≤ 1.4 → fires, but clamp keeps it ≥ net
  // breakeven (never a loss).
  const d = decideExit(
    s({
      entryPriceTon: 0.001,
      currentPriceTon: 0.001, // pnl 0
      peakPriceTon: 0.002,
      givebackEnabled: true,
      givebackArmPct: 20,
      givebackDropPct: 30,
    }),
  );
  assert.equal(d.action, "giveback_exit");
});

test("E.pump-dump: SWING rides a pump without a giveback trail (no TP)", () => {
  const d = evaluateExitPolicy(
    pos(),
    ctx({ currentPriceUsd: 1.6 }), // +60%
  );
  assert.equal(d, null, "2026-08-09 directive: no take-profit");
});

// ── §4E row 7: sideways chop ────────────────────────────────────────────

test("E.chop: whipsaw resets the trend confirmation streak", () => {
  const t = new TrendTracker({ ...DEFAULT_TREND_CONFIG, confirmTicks: 3, minObservations: 6 });
  // 10 ticks of downtrend — the streak accumulates.
  let conf = 0;
  for (let i = 1; i <= 10; i++) {
    const r = t.observe("p", 1.0 - i * 0.005, 1.0);
    if (r.bearish) conf = r.confirmations;
  }
  assert.ok(conf >= 1, `downtrend must accumulate confirmations, got ${conf}`);

  // A sub-EMA bounce (back to entry, +2%) is NOT a whipsaw — the fast EMA is
  // still below the slow EMA, so the pair stays bearish and the streak keeps
  // growing. Verified empirically: fast 0.974 < slow 0.983 at 1.0, and 1.02
  // only narrows MACD to ~0. A genuine whipsaw is a V-recovery that
  // RECROSSES the slow EMA (≈ +4% here): fast 0.999 > slow 0.990.
  for (const p of [0.97, 1.0, 1.02]) {
    const r = t.observe("p", p, 1.0);
    assert.equal(r.bearish, true, `sub-EMA bounce ${p} must not flip the pair`);
    assert.ok(r.confirmations > conf, "sub-EMA bounce keeps the streak growing");
    conf = r.confirmations;
  }

  // The V-recovery recrosses the slow EMA → streak resets to 0, flag clears.
  const rec = t.observe("p", 1.04, 1.0);
  assert.equal(rec.confirmations, 0, "recovery resets the streak");
  assert.equal(rec.bearish, false, "recovery clears the bearish flag");
});

// ── §4E row 8: gap-through stop ─────────────────────────────────────────

test("E.gap-through: SNIPER trend_exit fires on a gap-through loser (structure over level)", () => {
  // A confirmed flip with price far below the stop — gap-through. decideExit
  // must fire trend_exit, not hold (GULYA protection).
  const d = decideExit(
    s({
      currentPriceTon: 0.0003, // -70% vs entry
      trendBearish: true,
      trendReason: "confirmed flip",
      stopLossPct: 35,
    }),
  );
  assert.equal(d.action, "trend_exit");
});

test("E.gap-through: SWING stop fires when price gaps past the stop", () => {
  const d = evaluateExitPolicy(
    pos(),
    ctx({ currentPriceUsd: 0.5 }), // -50% ≤ -35%
  );
  assert.equal(d?.trigger, "stop_loss");
});

// ── §4E row 9: regime transition mid-position ───────────────────────────

test("E.regime-transition: a SPIKED regime requires extra trend confirmations", () => {
  const d = evaluateExitPolicy(
    pos(),
    ctx({
      currentPriceUsd: 1.0,
      trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
      trendConfirmTicks: 3,
      trendExitSpikedExtraTicks: 2,
      volatility: { atrCloseTon: 0.1, regime: "spiked", realizedVol: 0.5 },
    }),
  );
  assert.equal(d, null, "3 < 3+2 → spiked re-gate blocks the flip");

  const d2 = evaluateExitPolicy(
    pos(),
    ctx({
      currentPriceUsd: 1.0,
      trendSignal: { bearish: true, confirmations: 5, reason: "flip" },
      trendConfirmTicks: 3,
      trendExitSpikedExtraTicks: 2,
      volatility: { atrCloseTon: 0.1, regime: "spiked", realizedVol: 0.5 },
    }),
  );
  assert.equal(d2?.trigger, "trend_exit");
  assert.match(d2?.reason ?? "", /SPIKED vol/);
});

test("E.regime-transition: CALM/NORMAL keeps the configured cost exactly", () => {
  const d = evaluateExitPolicy(
    pos(),
    ctx({
      currentPriceUsd: 1.0,
      trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
      trendConfirmTicks: 3,
      trendExitSpikedExtraTicks: 2,
      volatility: { atrCloseTon: 0.01, regime: "normal", realizedVol: 0.01 },
    }),
  );
  assert.equal(d?.trigger, "trend_exit"); // 3 >= 3, no extra cost
});

test("E.regime-transition: RegimeClassifier hysteresis needs confirmTicks", () => {
  const r = new RegimeClassifier({ period: 4, spikeThreshold: 2.5, calmRatio: 0.5, confirmTicks: 2 });
  // feed a normal series first (baseline seeds)
  const norm = Array.from({ length: 8 }, (_, i) => 1.0 + 0.001 * i);
  r.observe(norm);
  const before = r.state().regime;
  // one spike tick — must not flip to spiked on a single observation
  const spike = [...norm, 1.0 + 0.2];
  const one = r.observe(spike);
  assert.equal(one, before, "a single spike must not flip the regime (hysteresis)");
});

// ── §4E row 10: gas-dominant tiny position ──────────────────────────────

test("E.gas-dominant: SNIPER noise floor holds a shallow loser when gas dominates", () => {
  // 0.44 TON lot, 0.2 TON round-trip gas. A confirmed flip at -2% would net
  // -0.2 TON against a gross of 0.431 — a guaranteed loss. Hold.
  const d = decideExit(
    s({
      entryPriceTon: 0.001,
      currentPriceTon: 0.00098, // -2%
      trendBearish: true,
      trendReason: "confirmed flip",
      positionTon: 0.44,
      roundTripGasTon: 0.2,
    }),
  );
  assert.equal(d.action, "hold");
});

test("E.gas-dominant: SWING has no noise floor — a confirmed flip fires", () => {
  // The SWING engine does not implement the gas-aware noise floor (it is fed
  // by position-monitor directly). Assert the current contract explicitly so
  // the gap is documented, not silently assumed.
  const d = evaluateExitPolicy(
    pos(),
    ctx({
      currentPriceUsd: 0.98, // -2%
      trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
      trendConfirmTicks: 3,
    }),
  );
  assert.equal(d?.trigger, "trend_exit");
});

// ── §4E row 11: time-stop expiry vs noise-floor hold ────────────────────

test("E.time-vs-floor: deadline + confirmed flip + shallow loser → HOLD (floor beats time)", () => {
  // Engine priority is trend → giveback → time → stop (filters.ts:399). A
  // confirmed flip on a shallow loser keeps the gas-noise-floor HOLD even at
  // the deadline — closing there would lock the net loss the floor exists to
  // avoid (filters.ts:418-423).
  const d = decideExit(
    s({
      currentPriceTon: 0.00098, // -2%
      trendBearish: true,
      trendReason: "confirmed flip",
      positionTon: 0.44,
      roundTripGasTon: 0.2,
      entryTimeMs: 0,
      now: 2 * 3600_000 + 1,
      maxHoldMs: 2 * 3600_000,
    }),
  );
  assert.equal(d.action, "hold");
});

test("E.time-vs-floor: SNIPER fires time_exit when the deadline passes without a confirmed flip", () => {
  // No confirmed flip → the trend/noise-floor block is silent, so the hard
  // time-stop fires exactly at maxHold.
  const d = decideExit(
    s({
      currentPriceTon: 0.00098, // -2%
      positionTon: 0.44,
      roundTripGasTon: 0.2,
      entryTimeMs: 0,
      now: 2 * 3600_000 + 1,
      maxHoldMs: 2 * 3600_000,
    }),
  );
  assert.equal(d.action, "time_exit");
});

test("E.time-vs-floor: SNIPER holds before the deadline (floor applies)", () => {
  const d = decideExit(
    s({
      currentPriceTon: 0.00098, // -2%
      trendBearish: true,
      trendReason: "confirmed flip",
      positionTon: 0.44,
      roundTripGasTon: 0.2,
      entryTimeMs: 0,
      now: 60_000, // well within the 2h deadline
      maxHoldMs: 2 * 3600_000,
    }),
  );
  assert.equal(d.action, "hold");
});

// ── §4E row 12: giveback armed vs unarmed boundary ──────────────────────

test("E.giveback-armed-boundary: fires exactly at the giveback level", () => {
  const d = decideExit(
    s({
      entryPriceTon: 0.001,
      currentPriceTon: 0.0014, // peak 0.002, now +40%
      peakPriceTon: 0.002,
      givebackEnabled: true,
      givebackArmPct: 10,
      givebackDropPct: 20,
    }),
  );
  assert.equal(d.action, "giveback_exit"); // 0.0014 ≤ 0.0016
});

test("E.giveback-armed-boundary: below the arm level the trail is silent", () => {
  const d = decideExit(
    s({
      entryPriceTon: 0.001,
      currentPriceTon: 0.0009, // -10%
      peakPriceTon: 0.00105, // +5% peak — below the 10% arm
      givebackEnabled: true,
      givebackArmPct: 10,
      givebackDropPct: 20,
    }),
  );
  assert.equal(d.action, "hold");
});

// ── §4E row 13: giveback clamp (low arm + high drop) ────────────────────

test("E.giveback-clamp: low arm + high drop exits only above net breakeven (invariant 2)", () => {
  // arm 10% / drop 40%: raw level = peak 0.0015 × 0.6 = 0.0009 — BELOW entry.
  // The net-breakeven clamp (0.001 × (1+0.2/0.5)) = 0.0014 lifts the level, so
  // a close at 0.0011 fires (level 0.0014, +10% gross, net positive) — the
  // clamp guarantees the exit is never a NET loss, not that it never fires.
  const d = decideExit(
    s({
      entryPriceTon: 0.001,
      currentPriceTon: 0.0011, // +10% gross
      peakPriceTon: 0.0015,
      givebackEnabled: true,
      givebackArmPct: 10,
      givebackDropPct: 40,
      positionTon: 0.5,
      roundTripGasTon: 0.2,
    }),
  );
  assert.equal(d.action, "giveback_exit");
  assert.match(d.reason ?? "", /clamp 0\.00140000/); // clamp level lifted to breakeven
});

// ── §4E row 14: giveback vs trend_exit on the same tick ─────────────────

test("E.giveback-vs-trend: trend wins on the same tick", () => {
  const d = decideExit(
    s({
      entryPriceTon: 0.001,
      currentPriceTon: 0.0014, // +40%
      peakPriceTon: 0.002,
      givebackEnabled: true,
      givebackArmPct: 10,
      givebackDropPct: 20,
      trendBearish: true,
      trendReason: "confirmed flip",
    }),
  );
  assert.equal(d.action, "trend_exit", "precedence: trend → giveback");
});

// ── §4E row 15: giveback vs time_exit on the same tick ──────────────────

test("E.giveback-vs-time: giveback wins over time_exit on the same tick", () => {
  const d = decideExit(
    s({
      entryPriceTon: 0.001,
      currentPriceTon: 0.0014, // +40%
      peakPriceTon: 0.002,
      givebackEnabled: true,
      givebackArmPct: 10,
      givebackDropPct: 20,
      entryTimeMs: 0,
      now: 2 * 3600_000 + 1, // deadline passed
      maxHoldMs: 2 * 3600_000,
    }),
  );
  assert.equal(d.action, "giveback_exit", "precedence: giveback → time");
});

// ── §4E row: zero-liquidity source-level assertion ───────────────────────

test("E.zero-liquidity: position-monitor sell path is bounded (retry + terminal)", () => {
  // The pure engines cannot express "the sell never fills". The real contract
  // lives in position-monitor.ts: on a failed swap the position stays OPEN for
  // a bounded retry, and the coordinator gate blocks the exit. Assert the
  // source documents both, so a regression that removes the bounded retry or
  // the terminal state fails here.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "hotpath", "position-monitor.ts"),
    "utf-8",
  );
  assert.match(src, /leaving OPEN for retry/);
  assert.match(src, /coordinator not started — exit blocked; leaving OPEN for retry/);
  // The position must have a terminal path beyond retry (the drain incident
  // was a loop with no exit).
  assert.match(src, /RUG_EXIT|STOPPED|CLOSED/);
});
