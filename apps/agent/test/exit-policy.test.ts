/**
 * Unit tests for the pure exit policy engine (src/exit/policy-engine.ts).
 *
 * Tests the per-position state machine from spec 002 §8.5:
 *   Monitoring → TakeProfit | StopLoss | Trailing | TimeExit | EmergencyExit → Exited
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

const tier = TIER_RISK_CONFIGS.low; // { takeProfitPct: 25, stopLossPct: 15, ... }

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

test("take_profit (TP1) fires when pnl >= takeProfitPct on OPEN", () => {
  const ctx = context({
    currentPriceUsd: 125, // +25% pnl = exactly takeProfitPct
    entryPriceUsd: 100,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "take_profit");
  assert.equal(decision.nextStatus, "TP1_HIT");
  assert.equal(decision.sellFraction, 0.5);
  assert.equal(decision.costBasisScale, 0.5);
});

test("trailing fires from TP1_HIT when pnl <= 0", () => {
  const ctx = context({
    currentPriceUsd: 95, // -5% pnl
    entryPriceUsd: 100,
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "trailing");
  assert.equal(decision.nextStatus, "CLOSED");
  assert.equal(decision.sellFraction, 1.0);
});

test("tp2 fires from TP1_HIT when pnl >= 2x takeProfitPct", () => {
  const ctx = context({
    currentPriceUsd: 150, // +50% pnl = 2x takeProfitPct (25%)
    entryPriceUsd: 100,
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "tp2");
  assert.equal(decision.nextStatus, "CLOSED");
  assert.equal(decision.sellFraction, 1.0);
});

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
  // Should return null or something other than time_exit
  // (benign pnl means no SL/TP either → null)
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
  // TP1_HIT can only fire trailing (pnl<=0) or tp2 (pnl>=2x)
  // Here pnl is +5% → neither fires
  assert.equal(decision, null);
});

test("emergency_exit fires when auditVerdict.ok = false on OPEN", () => {
  const ctx = context({
    auditVerdict: { ok: false, honeypotSafe: false, lpLocked: false, renounced: false },
    currentPriceUsd: 105, // benign pnl
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "emergency_exit");
  assert.equal(decision.nextStatus, "RUG_EXIT");
  assert.equal(decision.sellFraction, 1.0);
});

test("emergency_exit fires from TP1_HIT too (not OPEN-only-gated)", () => {
  const ctx = context({
    auditVerdict: { ok: false, honeypotSafe: true, lpLocked: false, renounced: true },
    currentPriceUsd: 105,
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.ok(decision);
  assert.equal(decision.trigger, "emergency_exit");
  assert.equal(decision.nextStatus, "RUG_EXIT");
});

test("emergency_exit does NOT fire when auditVerdict = null (fail closed)", () => {
  const ctx = context({
    auditVerdict: null,
    currentPriceUsd: 105, // benign pnl
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  // No trigger should fire with benign pnl and null verdict
  assert.equal(decision, null);
});

test("priority: emergency beats time and stop_loss", () => {
  const ctx = context({
    auditVerdict: { ok: false, honeypotSafe: false, lpLocked: false, renounced: false },
    now: 1_050_000,
    maxHoldMs: 50_000,
    currentPriceUsd: 70, // -30% pnl (would trigger SL)
  });
  const pos = position({
    entry_at: 900_000,
    exit_by_ms: 950_000, // deadline passed (would trigger time_exit)
  });
  const decision = evaluateExitPolicy(pos, ctx);
  // Emergency should win over both time and SL
  assert.equal(decision?.trigger, "emergency_exit");
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
  // Time should beat SL
  assert.equal(decision?.trigger, "time_exit");
});

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

test("returns null when OPEN with benign pnl, auditVerdict ok, no time limit", () => {
  const ctx = context({
    currentPriceUsd: 110, // +10% (between 0 and 25%)
    maxHoldMs: null,
  });
  const pos = position();
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("returns null when TP1_HIT with pnl between trailing (0) and tp2 (2x)", () => {
  const ctx = context({
    currentPriceUsd: 135, // +35% (between 0 and 50%)
  });
  const pos = position({ status: "TP1_HIT" });
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision, null);
});

test("pnl calculation matches spec", () => {
  // Entry: 100, Current: 150 → pnl = (150-100)/100 * 100 = 50%
  const ctx = context({
    entryPriceUsd: 100,
    currentPriceUsd: 150,
  });
  const pos = position({ entry_price_usd: 100 });
  // TP1 fires at 25%, so 50% should fire TP1
  const decision = evaluateExitPolicy(pos, ctx);
  assert.equal(decision?.trigger, "take_profit");
  // Entry: 100, Current: 80 → pnl = (80-100)/100 * 100 = -20%
  const ctx2 = context({
    entryPriceUsd: 100,
    currentPriceUsd: 80,
  });
  const decision2 = evaluateExitPolicy(pos, ctx2);
  assert.equal(decision2?.trigger, "stop_loss"); // -20% < -15%
});
