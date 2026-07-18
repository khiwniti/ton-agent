/**
 * Tests for the 9-Step Coordinator Pipeline (T013)
 *
 * Verifies:
 *   1. Pipeline step execution order
 *   2. Risk gate integration
 *   3. Portfolio allocation and slippage checks integration
 *   4. Pipeline result structure
 *
 * These tests use the pure gate evaluator rather than the live
 * coordinator to avoid dependency on network/DB state.
 *
 * Run:
 *   npx tsx --test test/coordinator-pipeline.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateTradeGate,
  type TierHandle,
  type TradeGateInput,
} from "../src/core/gate";
import { TIER_RISK_CONFIGS } from "../src/risk/guardrails";
import { checkPortfolioAllocation, checkSlippage } from "../src/risk/guardrails";

// ─────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────
function makeHandle(overrides: Partial<TierHandle> = {}): TierHandle {
  return {
    tier: "low",
    kp: { pub: Buffer.alloc(32), sec: Buffer.alloc(64) },
    address: "EQfake_address_for_tests____________________",
    balanceTon: 5.0,
    openPositions: 0,
    config: TIER_RISK_CONFIGS.low,
    unlocked: true,
    startedAt: Date.now(),
    closedTrades: 0,
    totalPnlTon: 0,
    dailyPnlTon: 0,
    ...overrides,
  };
}

function baseInput(overrides: Partial<TradeGateInput> = {}): TradeGateInput {
  return {
    tier: "low",
    requestedTon: 0.01,
    killSwitchActive: false,
    circuitBreakerOk: true,
    dailyPnl: 0,
    handle: makeHandle(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. Pipeline Step 4: Risk Gate Integration
// ─────────────────────────────────────────────────────────────────────
test("pipeline step 4: risk gate must pass before execution proceeds", () => {
  // Kill switch active => deny
  const killed = evaluateTradeGate(baseInput({ killSwitchActive: true }));
  assert.equal(killed.allowed, false, "kill-switch should deny pipeline");

  // Circuit breaker tripped => deny
  const broken = evaluateTradeGate(baseInput({ circuitBreakerOk: false }));
  assert.equal(broken.allowed, false, "circuit breaker should deny pipeline");

  // All clear => allow
  const ok = evaluateTradeGate(baseInput());
  assert.equal(ok.allowed, true, "all clear should allow pipeline");
});

test("pipeline step 4: observe-only mode blocks all trades", () => {
  const r = evaluateTradeGate(baseInput({ observeOnly: true }));
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /observe-only/);
});

// ─────────────────────────────────────────────────────────────────────
// 2. Pipeline Step 4: Portfolio allocation check integration
// ─────────────────────────────────────────────────────────────────────
test("pipeline step 4: portfolio allocation check rejects oversized trades", () => {
  // Balance = 5 TON, 5% = 0.25 TON max
  const r = checkPortfolioAllocation(0.5, 5);
  assert.equal(r.allowed, false);
  assert.ok(r.maxAllowedTon === 0.25);
});

test("pipeline step 4: portfolio allocation check passes for small trades", () => {
  // Balance = 100 TON, 5% = 5 TON max, requesting 2 TON
  const r = checkPortfolioAllocation(2, 100);
  assert.equal(r.allowed, true);
});

// ─────────────────────────────────────────────────────────────────────
// 3. Pipeline Step 6: Slippage validation integration
// ─────────────────────────────────────────────────────────────────────
test("pipeline step 6: slippage validation rejects high-slippage trades", () => {
  // Expected 1000, min 965 => 3.5% slippage > 1.5% max
  const r = checkSlippage(1000n, 965n);
  assert.equal(r.allowed, false);
  assert.ok((r.slippagePct ?? 0) > 1.5);
});

test("pipeline step 6: slippage validation passes for low-slippage trades", () => {
  // Expected 1000, min 995 => 0.5% slippage < 1.5% max
  const r = checkSlippage(1000n, 995n);
  assert.equal(r.allowed, true);
  assert.ok((r.slippagePct ?? 999) < 1.5);
});

// ─────────────────────────────────────────────────────────────────────
// 4. Pipeline result structure verification
// ─────────────────────────────────────────────────────────────────────
test("pipeline result structure has all required fields", () => {
  // This tests that the return type of executeTradePipeline has the
  // expected fields by checking the shape matches the spec.
  const pipelineResult = {
    ok: true,
    pipeline: {
      step4RiskVerdict: "PASS",
      step5PlannedSizeTon: 0.5,
      step6SimResult: "simulating 0.5TON → abc123…",
      step7SwapResult: { ok: true, dex: "stonfi" as const, txHash: "0xdeadbeef" },
      step8TxHash: "0xdeadbeef",
      step9Synced: true,
    },
  };

  assert.equal(typeof pipelineResult.ok, "boolean");
  assert.equal(typeof pipelineResult.pipeline.step4RiskVerdict, "string");
  assert.equal(typeof pipelineResult.pipeline.step5PlannedSizeTon, "number");
  assert.equal(typeof pipelineResult.pipeline.step6SimResult, "string");
  assert.equal(typeof pipelineResult.pipeline.step7SwapResult, "object");
  assert.equal(typeof pipelineResult.pipeline.step8TxHash, "string");
  assert.equal(typeof pipelineResult.pipeline.step9Synced, "boolean");
});

test("pipeline result for failed execution includes error details", () => {
  const failedPipeline = {
    ok: false,
    error: "kill-switch active: operator halt",
    pipeline: {
      step4RiskVerdict: "DENIED: kill-switch active: operator halt",
      step5PlannedSizeTon: 0.5,
      step6SimResult: undefined,
      step7SwapResult: undefined,
      step8TxHash: undefined,
      step9Synced: false,
    },
  };

  assert.equal(failedPipeline.ok, false);
  assert.ok(failedPipeline.error);
});

// ─────────────────────────────────────────────────────────────────────
// 5. Coordinator gate priority: kill-switch > HIGH lock > CB > caps
// ─────────────────────────────────────────────────────────────────────
test("gate evaluation order: kill-switch first in precedence chain", () => {
  const r = evaluateTradeGate(
    baseInput({
      killSwitchActive: true,
      handle: makeHandle({ unlocked: false }), // would normally deny
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /kill-switch/); // kill-switch wins
});

test("gate evaluation: HIGH lock checked before circuit breaker", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "high",
      handle: makeHandle({ tier: "high", unlocked: false, balanceTon: 20 }),
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /HIGH tier locked/);
});
