/**
 * Unit tests for the rug detector (src/exit/rug-detector.ts).
 *
 * Tests the pure functions: detectAuditDegradation, detectLiquidityDrain,
 * detectRug, and the LiquidityTracker class.
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/rug-detector.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAuditDegradation,
  detectLiquidityDrain,
  detectRug,
  LiquidityTracker,
  RUG_LIQUIDITY_DROP_PCT,
  RUG_LIQUIDITY_MIN_BASE_TON,
  type AuditSnapshot,
} from "../src/exit/rug-detector";

function auditSnap(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    honeypotSafe: true,
    lpLocked: true,
    renounced: true,
    ...overrides,
  };
}

// ── detectAuditDegradation ───────────────────────────────────────────────────

test("detectAuditDegradation returns null when both null", () => {
  assert.equal(detectAuditDegradation(null, null), null);
});

test("detectAuditDegradation returns null when current is null (no fresh measurement)", () => {
  const baseline = auditSnap();
  assert.equal(detectAuditDegradation(baseline, null), null);
});

test("detectAuditDegradation fires on honeypot degradation", () => {
  const baseline = auditSnap({ honeypotSafe: true });
  const current = auditSnap({ honeypotSafe: false });
  const result = detectAuditDegradation(baseline, current);
  assert.ok(result);
  assert.ok(result.includes("honeypot detected"));
});

test("detectAuditDegradation does NOT fire when honeypot was already unsafe at entry", () => {
  const baseline = auditSnap({ honeypotSafe: false });
  const current = auditSnap({ honeypotSafe: false });
  assert.equal(detectAuditDegradation(baseline, current), null);
});

test("detectAuditDegradation fires on explicit LP unlock (string state)", () => {
  const baseline = auditSnap({ lpState: "locked" });
  const current = auditSnap({ lpState: "unlocked" });
  const result = detectAuditDegradation(baseline, current);
  assert.ok(result);
  assert.ok(result.includes("LP unlocked"));
});

test("detectAuditDegradation fires on explicit LP unlock (legacy boolean)", () => {
  const baseline = auditSnap({ lpLocked: true });
  const current = auditSnap({ lpLocked: false });
  const result = detectAuditDegradation(baseline, current);
  assert.ok(result);
  assert.ok(result.includes("LP unlocked"));
});

test("detectAuditDegradation does NOT fire on undetermined lpState", () => {
  const baseline = auditSnap({ lpState: "locked" });
  const current = auditSnap({ lpState: "undetermined" });
  assert.equal(detectAuditDegradation(baseline, current), null);
});

test("detectAuditDegradation does NOT fire on renounced change (excluded by design)", () => {
  const baseline = auditSnap({ renounced: true });
  const current = auditSnap({ renounced: false });
  assert.equal(detectAuditDegradation(baseline, current), null);
});

test("detectAuditDegradation treats missing baseline as safe at entry", () => {
  const current = auditSnap({ honeypotSafe: false, lpState: "unlocked" });
  const result = detectAuditDegradation(null, current);
  assert.ok(result);
  // Should fire on both dimensions since baseline defaults to safe
  assert.ok(result.includes("honeypot") || result.includes("LP unlocked"));
});

// ── detectLiquidityDrain ──────────────────────────────────────────────────────

test("detectLiquidityDrain returns null when peak is null", () => {
  assert.equal(detectLiquidityDrain(null, 10), null);
});

test("detectLiquidityDrain returns null when current is null", () => {
  assert.equal(detectLiquidityDrain(10, null), null);
});

test("detectLiquidityDrain returns null when peak below min base (dust noise)", () => {
  const minBase = RUG_LIQUIDITY_MIN_BASE_TON; // 1 TON
  assert.equal(detectLiquidityDrain(minBase / 2, minBase / 4), null);
});

test("detectLiquidityDrain fires at default 50% drop", () => {
  const peak = 10.0;
  const current = 4.9; // 51% drop
  const result = detectLiquidityDrain(peak, current);
  assert.ok(result);
  assert.ok(result.includes("liquidity drained"));
  assert.ok(result.includes("51.0%"));
});

test("detectLiquidityDrain does NOT fire at exactly 50% drop (threshold is strictly below)", () => {
  const peak = 10.0;
  const current = 5.0; // exactly 50% drop
  assert.equal(detectLiquidityDrain(peak, current), null);
});

test("detectLiquidityDrain respects custom dropPct", () => {
  const peak = 10.0;
  const current = 7.0; // 30% drop
  assert.equal(detectLiquidityDrain(peak, current, 50), null); // default 50%
  const result = detectLiquidityDrain(peak, current, 25); // 25% threshold
  assert.ok(result);
  assert.ok(result.includes("30.0%"));
});

test("detectLiquidityDrain handles non-finite values", () => {
  assert.equal(detectLiquidityDrain(NaN, 10), null);
  assert.equal(detectLiquidityDrain(10, Infinity), null);
  assert.equal(detectLiquidityDrain(Infinity, 10), null);
});

// ── detectRug (combined verdict) ──────────────────────────────────────────────

test("detectRug returns rugged=true when liquidity drain detected first", () => {
  const result = detectRug({
    baselineAudit: null,
    currentAudit: null,
    peakLiquidityTon: 10,
    currentLiquidityTon: 4,
  });
  assert.equal(result.rugged, true);
  assert.ok(result.reason.includes("liquidity drained"));
});

test("detectRug returns rugged=true when audit degradation but no liquidity drain", () => {
  const result = detectRug({
    baselineAudit: auditSnap({ honeypotSafe: true }),
    currentAudit: auditSnap({ honeypotSafe: false }),
    peakLiquidityTon: 10,
    currentLiquidityTon: 10,
  });
  assert.equal(result.rugged, true);
  assert.ok(result.reason.includes("honeypot"));
});

test("detectRug returns rugged=false when nothing degrades", () => {
  const result = detectRug({
    baselineAudit: auditSnap(),
    currentAudit: auditSnap(),
    peakLiquidityTon: 10,
    currentLiquidityTon: 9.5, // only 5% drop
  });
  assert.equal(result.rugged, false);
  assert.equal(result.reason, "");
});

test("detectRug liquidity drain takes precedence over audit degradation", () => {
  const result = detectRug({
    baselineAudit: auditSnap({ honeypotSafe: true }),
    currentAudit: auditSnap({ honeypotSafe: false }),
    peakLiquidityTon: 10,
    currentLiquidityTon: 4, // 60% drain
  });
  assert.equal(result.rugged, true);
  assert.ok(result.reason.includes("liquidity drained"));
  assert.ok(!result.reason.includes("honeypot"));
});

test("detectRug handles missing current audit gracefully", () => {
  const result = detectRug({
    baselineAudit: auditSnap(),
    currentAudit: null,
    peakLiquidityTon: 10,
    currentLiquidityTon: 4,
  });
  assert.equal(result.rugged, true);
  assert.ok(result.reason.includes("liquidity drained"));
});

// ── LiquidityTracker ──────────────────────────────────────────────────────────

test("LiquidityTracker first observation sets peak to observed value", () => {
  const tracker = new LiquidityTracker();
  const result = tracker.observe("token-A", 10.0);
  assert.equal(result.peakTon, 10.0);
  assert.equal(result.currentTon, 10.0);
  assert.equal(tracker.peak("token-A"), 10.0);
});

test("LiquidityTracker peak increases but never decreases", () => {
  const tracker = new LiquidityTracker();
  tracker.observe("token-B", 5.0);
  tracker.observe("token-B", 8.0);
  tracker.observe("token-B", 6.0);
  assert.equal(tracker.peak("token-B"), 8.0);
  const result = tracker.observe("token-B", 6.0);
  assert.equal(result.peakTon, 8.0);
  assert.equal(result.currentTon, 6.0);
});

test("LiquidityTracker returns null currentTon for non-finite observations", () => {
  const tracker = new LiquidityTracker();
  tracker.observe("token-C", 10.0);
  const result = tracker.observe("token-C", NaN);
  assert.equal(result.peakTon, 10.0);
  assert.equal(result.currentTon, null);
});

test("LiquidityTracker returns null currentTon for null observations", () => {
  const tracker = new LiquidityTracker();
  tracker.observe("token-D", 10.0);
  const result = tracker.observe("token-D", null);
  assert.equal(result.peakTon, 10.0);
  assert.equal(result.currentTon, null);
});

test("LiquidityTracker forget removes the key", () => {
  const tracker = new LiquidityTracker();
  tracker.observe("token-E", 10.0);
  tracker.forget("token-E");
  assert.equal(tracker.peak("token-E"), null);
  const result = tracker.observe("token-E", 5.0);
  assert.equal(result.peakTon, 5.0); // fresh start after forget
});

test("LiquidityTracker separate keys are independent", () => {
  const tracker = new LiquidityTracker();
  tracker.observe("token-X", 10.0);
  tracker.observe("token-Y", 20.0);
  assert.equal(tracker.peak("token-X"), 10.0);
  assert.equal(tracker.peak("token-Y"), 20.0);
});

// ── Constants (sanity checks on defaults) ────────────────────────────────────

test("RUG_LIQUIDITY_DROP_PCT default is 50", () => {
  assert.equal(RUG_LIQUIDITY_DROP_PCT, 50);
});

test("RUG_LIQUIDITY_MIN_BASE_TON default is 1", () => {
  assert.equal(RUG_LIQUIDITY_MIN_BASE_TON, 1);
});

// ── Production-incident regression scenarios (spec §4D) ─────────────────────
//
// The two incidents in the module header, reproduced as scenario tests:
//   (1) the 26 false RUG_EXITs — a static `renounced` flip must not fire when
//       liquidity is intact (a static property can never be a rug signal);
//   (2) the 2 genuine rugs — a clean audit with a gradual liquidity drawdown
//       against a monotonic high-water mark MUST fire.

test("scenario: static renounced flip with intact liquidity does NOT fire (26 false RUG_EXITs regression)", () => {
  const tracker = new LiquidityTracker();
  // Enter: healthy pool, clean audit, static renounced=false.
  const entryAudit = auditSnap({ honeypotSafe: true, lpLocked: true, renounced: false });
  tracker.observe("memecoin", 10.0);
  // Normal volatility while holding: peak stays high, drawdown stays shallow.
  tracker.observe("memecoin", 9.6);
  tracker.observe("memecoin", 9.8);
  // A strict exit gate re-scores and sees renounced=false (the 2026-08-08 bug).
  const exitAudit = auditSnap({ honeypotSafe: true, lpLocked: true, renounced: true });
  const verdict = detectRug({
    baselineAudit: entryAudit,
    currentAudit: exitAudit,
    peakLiquidityTon: tracker.peak("memecoin"),
    currentLiquidityTon: 9.6,
  });
  assert.equal(verdict.rugged, false, `must not fire: ${verdict.reason}`);
  assert.equal(verdict.reason, "");
});

test("scenario: clean audit + gradual monotonic drawdown DOES fire (2 genuine rugs)", () => {
  const tracker = new LiquidityTracker();
  // Both real rugs had clean audits the whole way — liquidity was the tell.
  const audit = auditSnap();
  tracker.observe("rug-token", 10.0);
  // Gradual bleed across observations, each single step well under the 50%
  // threshold, until the cumulative drawdown against the high-water crosses it.
  tracker.observe("rug-token", 9.0);
  tracker.observe("rug-token", 8.0);
  tracker.observe("rug-token", 7.0);
  tracker.observe("rug-token", 6.0);
  tracker.observe("rug-token", 5.0);
  tracker.observe("rug-token", 4.9);
  // High-water stays 10.0; current 4.9 is a 51.0% cumulative drawdown → fires.
  const verdict = detectRug({
    baselineAudit: audit,
    currentAudit: audit,
    peakLiquidityTon: tracker.peak("rug-token"),
    currentLiquidityTon: 4.9,
  });
  assert.equal(verdict.rugged, true);
  assert.ok(verdict.reason.includes("liquidity drained"));
  assert.ok(verdict.reason.includes("51.0%"));
});

test("scenario: deep single-step drawdown fires with high-water not entry-level (gradual cumulative)", () => {
  const tracker = new LiquidityTracker();
  const audit = auditSnap();
  tracker.observe("token", 10.0);
  tracker.observe("token", 12.0); // pumps to a new high-water mark
  // Then a steep drop below 50% of the HIGH-WATER (12.0), not the entry (10.0).
  tracker.observe("token", 5.5);
  const verdict = detectRug({
    baselineAudit: audit,
    currentAudit: audit,
    peakLiquidityTon: tracker.peak("token"),
    currentLiquidityTon: 5.5,
  });
  assert.equal(verdict.rugged, true);
  assert.ok(verdict.reason.includes("liquidity drained"));
  assert.ok(verdict.reason.includes("54.2%"));
});

test("scenario: drain vs. normal volatility — a sharp single-tick dip that recovers is NOT a drain", () => {
  const tracker = new LiquidityTracker();
  const audit = auditSnap();
  tracker.observe("token", 10.0);
  tracker.observe("token", 9.6); // shallow dip
  tracker.observe("token", 9.9); // recovery; high-water stays 10.0
  const verdict = detectRug({
    baselineAudit: audit,
    currentAudit: audit,
    peakLiquidityTon: tracker.peak("token"),
    currentLiquidityTon: 9.9,
  });
  assert.equal(verdict.rugged, false, `must not fire: ${verdict.reason}`);
  assert.equal(verdict.reason, "");
});