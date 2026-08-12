/**
 * Unit tests for the pure exit policy engine (src/exit/policy-engine.ts).
 *
 * Tests the per-position state machine from spec 002 §8.5 as of the
 * 2026-08-09 OPERATOR DIRECTIVE:
 *   Monitoring → EmergencyExit | TrendExit | TimeExit | StopLoss → Exited
 *
 * The take-profit ladder (TP1 half-sell → trailing/TP2) and the trailing stop
 * are GONE. Winners ride the trend with no fixed profit target and close only
 * on a CONFIRMED significant downtrend flip (`trend_exit`). The static
 * stop-loss remains the hard loss floor. Emergencies require a measured DELTA
 * (`rugSignal.rugged`), never a static `auditVerdict.ok = false`.
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/exit-policy.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateExitPolicy,
  type AuditVerdict,
  type ExitPolicyContext,
  type ExitPolicyPosition,
} from "../src/exit/policy-engine";
import { TIER_RISK_CONFIGS } from "../src/risk/guardrails";

const tier = TIER_RISK_CONFIGS.low; // { stopLossPct: 15, ... }

function position(overrides: Partial<ExitPolicyPosition> = {}): ExitPolicyPosition {
  return {
    status: "OPEN",
    entry_at: 900_000,
    entry_price_usd: 100,
    ...overrides,
  };
}

function context(overrides: Partial<ExitPolicyContext> = {}): ExitPolicyContext {
  return {
    now: 1_000_000,
    currentPriceUsd: 100,
    entryPriceUsd: 100,
    tierCfg: tier,
    auditVerdict: { ok: true, honeypotSafe: true, lpLocked: true, renounced: true },
    maxHoldMs: null,
    ...overrides,
  };
}

// ── Stop-loss (the hard loss floor) ───────────────────────────────────────

test("stop_loss fires when pnl <= -stopLossPct on OPEN", () => {
  const ctx = context({
    currentPriceUsd: 85, // -15% pnl = exactly -stopLossPct
    entryPriceUsd: 100,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "stop_loss");
  assert.equal(decision.nextStatus, "STOPPED");
  assert.equal(decision.sellFraction, 1.0);
  assert.equal(decision.costBasisScale, 1.0);
});

test("stop_loss fires at -2x stopLossPct", () => {
  const ctx = context({
    currentPriceUsd: 70, // -30% pnl
    entryPriceUsd: 100,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "stop_loss");
});

test("stop_loss fires from legacy TP1_HIT too (not OPEN-only)", () => {
  const ctx = context({
    currentPriceUsd: 80, // -20% pnl
    entryPriceUsd: 100,
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "stop_loss");
  assert.equal(decision?.nextStatus, "STOPPED");
});

// ── Trend exit (the 2026-08-09 close rule) ────────────────────────────────

test("trend_exit fires on confirmed bearish trendSignal", () => {
  const ctx = context({
    currentPriceUsd: 125, // +25% pnl — a WINNER, still exits on trend flip
    entryPriceUsd: 100,
    trendSignal: { bearish: true, reason: "significant downtrend flip" },
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "trend_exit");
  assert.equal(decision.nextStatus, "CLOSED");
  assert.equal(decision.sellFraction, 1.0);
  assert.equal(decision.costBasisScale, 1.0);
  assert.match(decision.reason, /downtrend flip/);
});

test("trend_exit fires from legacy TP1_HIT too (any open status)", () => {
  const ctx = context({
    currentPriceUsd: 110,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, reason: "flip" },
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "trend_exit");
});

test("NO take-profit: +50% winner on OPEN rides (null)", () => {
  // Operator directive 2026-08-09: winners ride with no profit target.
  // A +50% winner with a healthy trend must NOT fire any exit.
  const ctx = context({
    currentPriceUsd: 150, // +50% pnl
    entryPriceUsd: 100,
    trendSignal: { bearish: false },
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("NO trailing: +35% winner on legacy TP1_HIT rides (null)", () => {
  // Previously +35% from TP1_HIT sat between trailing (pnl<=0) and tp2 (2x).
  // With both gone, a +35% winner keeps riding.
  const ctx = context({
    currentPriceUsd: 135, // +35% pnl
    entryPriceUsd: 100,
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

// ── Time exit ─────────────────────────────────────────────────────────────

test("time_exit fires on OPEN when deadline passed", () => {
  const now = 1_000_000;
  const entry_at = 900_000;
  const maxHoldMs = 50_000; // 50 seconds
  const exit_by_ms = entry_at + maxHoldMs; // 950_000
  const ctx = context({
    now: now + 60_000, // 60 seconds later → past deadline
    maxHoldMs,
    currentPriceUsd: 105, // benign pnl
  });
  const pos = position({
    entry_at,
    exit_by_ms,
  });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "time_exit");
  assert.equal(decision.nextStatus, "CLOSED");
  assert.equal(decision.sellFraction, 1.0);
});

test("time_exit does NOT fire when maxHoldMs = 0 (disabled)", () => {
  const ctx = context({
    now: 1_050_000, // well past any reasonable deadline
    maxHoldMs: 0,
    currentPriceUsd: 105, // benign pnl
  });
  const pos = position({
    entry_at: 900_000,
    exit_by_ms: 950_000, // even if deadline exists, maxHoldMs=0 disables it
  });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("time_exit does NOT fire from TP1_HIT (OPEN-only gated)", () => {
  const ctx = context({
    now: 1_050_000, // well past deadline
    maxHoldMs: 50_000,
    currentPriceUsd: 105, // benign pnl for TP1_HIT
  });
  const pos = position({
    status: "TP1_HIT",
    entry_at: 900_000,
    exit_by_ms: 950_000,
  });
  const decision = evaluateExitPolicy(pos, ctx);
  // TP1_HIT legacy status: time exit is OPEN-only, pnl is benign, no trend
  // flip, no rug → nothing fires.
  assert.equal(decision, null);
});

// ── Emergency exit (measured rug delta only) ──────────────────────────────

test("emergency_exit fires on measured rugSignal.rugged", () => {
  const ctx = context({
    currentPriceUsd: 105, // benign pnl
    rugSignal: { rugged: true, reason: "liquidity drain: -62% vs high-water mark" },
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "emergency_exit");
  assert.equal(decision.nextStatus, "RUG_EXIT");
  assert.equal(decision.sellFraction, 1.0);
});

test("emergency_exit fires from TP1_HIT too on rug", () => {
  const ctx = context({
    currentPriceUsd: 105,
    rugSignal: { rugged: true, reason: "liquidity drain" },
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "emergency_exit");
  assert.equal(decision?.nextStatus, "RUG_EXIT");
});

test("static auditVerdict.ok=false alone does NOT fire emergency", () => {
  // 2026-08-08 regression guard: `ok` folds the STATIC `renounced` dimension
  // (and data gaps) into false. Treating it as a rug closed 26 positions at
  // the spread. An exit gate must never be stricter than the entry gate.
  const ctx = context({
    auditVerdict: { ok: false, honeypotSafe: false, lpLocked: false, renounced: false },
    currentPriceUsd: 105, // benign pnl
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("emergency_exit does NOT fire when auditVerdict = null and no rugSignal", () => {
  const ctx = context({
    auditVerdict: null,
    currentPriceUsd: 105, // benign pnl
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("auditVerdict = null but rugSignal present → emergency still fires", () => {
  // The data gap (null verdict) fails closed on the AUDIT dimension, but a
  // measured rug delta is stronger than a missing verdict: a rugged pool may
  // report any price, so the measurement wins.
  const ctx = context({
    auditVerdict: null,
    currentPriceUsd: 70, // even a lying, stop-loss-triggering price
    rugSignal: { rugged: true, reason: "hard dimension went good → bad" },
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "emergency_exit");
});

// ── Priority order: emergency → trend → time → stop-loss ─────────────────

test("priority: emergency beats time and stop_loss", () => {
  const ctx = context({
    now: 1_050_000,
    maxHoldMs: 50_000,
    currentPriceUsd: 70, // -30% pnl (would trigger SL)
    rugSignal: { rugged: true, reason: "liquidity drain" },
  });
  const pos = position({
    entry_at: 900_000,
    exit_by_ms: 950_000, // deadline passed (would trigger time_exit)
  });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "emergency_exit");
});

test("priority: trend beats time and stop_loss", () => {
  const ctx = context({
    now: 1_050_000,
    maxHoldMs: 50_000,
    currentPriceUsd: 70, // -30% pnl (would trigger SL)
    trendSignal: { bearish: true, reason: "confirmed flip" },
  });
  const pos = position({
    entry_at: 900_000,
    exit_by_ms: 950_000, // deadline passed (would trigger time_exit)
  });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "trend_exit");
});

test("priority: time_exit beats stop_loss", () => {
  const ctx = context({
    auditVerdict: { ok: true, honeypotSafe: true, lpLocked: true, renounced: true },
    now: 1_050_000,
    maxHoldMs: 50_000,
    currentPriceUsd: 70, // -30% pnl (would trigger SL)
  });
  const pos = position({
    entry_at: 900_000,
    exit_by_ms: 950_000, // deadline passed
  });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "time_exit");
});

// ── Fail closed on bad price ──────────────────────────────────────────────

test("fail-closed: currentPriceUsd = NaN → null", () => {
  const ctx = context({ currentPriceUsd: NaN });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("fail-closed: currentPriceUsd = 0 → null", () => {
  const ctx = context({ currentPriceUsd: 0 });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("fail-closed: currentPriceUsd = -1 → null", () => {
  const ctx = context({ currentPriceUsd: -1 });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("fail-closed: entryPriceUsd = 0 → null", () => {
  const ctx = context({ entryPriceUsd: 0 });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

// ── Benign states → continue monitoring (null) ────────────────────────────

test("returns null when OPEN with benign pnl, auditVerdict ok, no time limit", () => {
  const ctx = context({
    currentPriceUsd: 110, // +10% winner riding the trend
    maxHoldMs: null,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("pnl calculation matches spec", () => {
  // Entry: 100, Current: 150 → pnl = (150-100)/100 * 100 = +50%
  // A +50% winner with no trend flip rides (no TP ladder anymore).
  const ctx = context({
    entryPriceUsd: 100,
    currentPriceUsd: 150,
  });
  const pos = position({ entry_price_usd: 100 });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
  // Entry: 100, Current: 80 → pnl = (80-100)/100 * 100 = -20% → stop_loss.
  const ctx2 = context({
    entryPriceUsd: 100,
    currentPriceUsd: 80,
  });
  const decision2 = evaluateExitPolicy(pos, ctx2);
  assert.equal(decision2?.trigger, "stop_loss"); // -20% < -15%
});

// ── Phase 4.5: structure stop (close-confirmation SL) ─────────────────────
// level = highWater − k×ATR, clamped above the static % floor. Fires ONLY
// after `stopConfirmTicks` CONSECUTIVE closes beyond the level — a single
// wick/intrabar excursion does not stop the position out.

test("structure stop: fires only after stopConfirmTicks consecutive closes beyond the level", () => {
  const ctx = context({
    currentPriceUsd: 90, // mark below the level (say 92) but pnl above -15%
    entryPriceUsd: 100,
    structureStop: { levelTon: 92, confirmedTicks: 1 },
    stopConfirmTicks: 2,
  });
  const pos = position();
  // confirmedTicks 1 < 2 → no fire, even though the mark is beyond the level.
  assert.equal(evaluateExitPolicy(pos, ctx), null);
  // second consecutive close beyond the level → fires.
  const ctx2 = { ...ctx, structureStop: { levelTon: 92, confirmedTicks: 2 } };
  const decision = evaluateExitPolicy(pos, ctx2);
  assert.ok(decision);
  assert.equal(decision.trigger, "stop_loss");
  assert.equal(decision.nextStatus, "STOPPED");
  assert.match(decision.reason, /structure break/);
});

test("structure stop: mark above the level → no fire regardless of ticks", () => {
  const ctx = context({
    currentPriceUsd: 95, // above level 92
    entryPriceUsd: 100,
    structureStop: { levelTon: 92, confirmedTicks: 5 },
    stopConfirmTicks: 2,
  });
  const pos = position();
  assert.equal(evaluateExitPolicy(pos, ctx), null);
});

test("structure stop: static % floor still fires immediately (no confirmation needed)", () => {
  // pnl -20% <= -15% floor → fires stop_loss with the static reason, even
  // though the structure stop has only 1/2 confirmations.
  const ctx = context({
    currentPriceUsd: 80,
    entryPriceUsd: 100,
    structureStop: { levelTon: 92, confirmedTicks: 1 },
    stopConfirmTicks: 2,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "stop_loss");
  assert.match(decision.reason, /stop loss: pnl/); // static reason, not structure
});

test("structure stop: absent stopConfirmTicks → inert (no structure stop fires)", () => {
  const ctx = context({
    currentPriceUsd: 88, // below structure level 92, but above the static floor 85
    entryPriceUsd: 100,
    structureStop: { levelTon: 92, confirmedTicks: 5 },
    // stopConfirmTicks undefined → engine defaults to 0 → guard fails.
  });
  const pos = position();
  assert.equal(evaluateExitPolicy(pos, ctx), null);
});

test("structure stop: null levelTon → no structure stop (static line only)", () => {
  const ctx = context({
    currentPriceUsd: 88,
    entryPriceUsd: 100,
    structureStop: { levelTon: null, confirmedTicks: 5 },
    stopConfirmTicks: 2,
  });
  const pos = position();
  assert.equal(evaluateExitPolicy(pos, ctx), null); // -12% > -15%, no structure
});

test("structure stop: absent structureStop entirely → backward-compatible null", () => {
  const ctx = context({
    currentPriceUsd: 88,
    entryPriceUsd: 100,
    stopConfirmTicks: 2,
  });
  const pos = position();
  assert.equal(evaluateExitPolicy(pos, ctx), null);
});

// ── Phase 4.5: SPIKED-regime extra trend-exit confirmation cost ───────────
// In a SPIKED regime, single-tick noise passes a fixed confirmation counter
// faster. When the engine knows both the base tick count and the extra cost,
// a bearish flip needs `trendConfirmTicks + trendExitSpikedExtraTicks`
// confirmations before trend_exit fires. CALM/NORMAL keeps configured ticks.

test("SPIKED: bearish below the raised threshold → no trend_exit yet", () => {
  const ctx = context({
    currentPriceUsd: 125,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
    volatility: { atrCloseTon: 0.05, regime: "spiked", realizedVol: 0.4 },
    trendConfirmTicks: 3,
    trendExitSpikedExtraTicks: 2, // needs 3 + 2 = 5
  });
  const pos = position();
  assert.equal(evaluateExitPolicy(pos, ctx), null);
});

test("SPIKED: bearish at the raised threshold → trend_exit fires", () => {
  const ctx = context({
    currentPriceUsd: 125,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, confirmations: 5, reason: "flip" },
    volatility: { atrCloseTon: 0.05, regime: "spiked", realizedVol: 0.4 },
    trendConfirmTicks: 3,
    trendExitSpikedExtraTicks: 2,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "trend_exit");
  assert.match(decision.reason, /SPIKED vol/);
});

test("NORMAL regime: bearish at configured ticks fires immediately", () => {
  const ctx = context({
    currentPriceUsd: 125,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
    volatility: { atrCloseTon: 0.05, regime: "normal", realizedVol: 0.1 },
    trendConfirmTicks: 3,
    trendExitSpikedExtraTicks: 2,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "trend_exit");
  assert.ok(!/SPIKED/.test(decision.reason));
});

test("absent volatility facts → SPIKED gate skipped (plain bearish fires)", () => {
  // Backward compatibility: no volatility/trendConfirmTicks/extra → the
  // pre-4.5 behavior — a confirmed bearish flip fires trend_exit.
  const ctx = context({
    currentPriceUsd: 125,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, reason: "flip" },
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "trend_exit");
});

test("SPIKED regime without extra-tick config → plain bearish fires (no gate)", () => {
  // regime says spiked but the engine lacks the extra-cost facts → the
  // SPIKED gate is skipped entirely, matching pre-4.5 behavior.
  const ctx = context({
    currentPriceUsd: 125,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
    volatility: { atrCloseTon: 0.05, regime: "spiked", realizedVol: 0.4 },
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "trend_exit");
});

test("SPIKED: emergency (rug) still outranks the delayed trend exit", () => {
  const ctx = context({
    currentPriceUsd: 125,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
    volatility: { atrCloseTon: 0.05, regime: "spiked", realizedVol: 0.4 },
    trendConfirmTicks: 3,
    trendExitSpikedExtraTicks: 2,
    rugSignal: { rugged: true, reason: "liquidity drain" },
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "emergency_exit");
});

// ── Phase 4.5: structure stop vs trend exit priority ───────────────────────

test("structure stop: trend_exit outranks a half-confirmed structure stop", () => {
  // bearish flip (would trend_exit) while the structure stop is only 1/2
  // confirmed → trend wins (it appears earlier in the priority order).
  const ctx = context({
    currentPriceUsd: 90,
    entryPriceUsd: 100,
    trendSignal: { bearish: true, confirmations: 3, reason: "flip" },
    structureStop: { levelTon: 92, confirmedTicks: 1 },
    stopConfirmTicks: 2,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "trend_exit");
});

