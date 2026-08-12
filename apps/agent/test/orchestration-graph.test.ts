/**
 * Phase 2 risk graph skeleton tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearAuthorizationRegistry, type CapCheckContext } from "../src/safetycaps";
import { emptyGramState, runRiskPipeline } from "../src/orchestration";

function ctx(overrides: Partial<CapCheckContext> = {}): CapCheckContext {
  return {
    balance_ton: 10,
    open_positions: 0,
    max_position_ton: 5,
    max_open: 3,
    min_ai_score: 50,
    unlocked: true,
    kill_switch_active: false,
    circuit_breaker_ok: true,
    observe_only: false,
    daily_pnl_ton: 0,
    max_portfolio_allocation_pct: 50,
    max_slippage_pct: 1.5,
    max_trade_pool_tvl_pct: 5,
    require_pool_tvl: false,
    gas_cushion_ton: 0.3,
    ...overrides,
  };
}

const jetton = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

test("reject risk verdict discards before SafetyCaps", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_reject",
    tier: "low",
    risk_assessment: { score: 0, verdict: "reject" },
    proposed_ticket: {
      cycle_id: "c_reject",
      tier: "low",
      side: "buy",
      jetton_master: jetton,
      amount_ton: 0.5,
    },
  });
  const out = await runRiskPipeline(state, ctx());
  assert.equal(out.discarded, true);
  assert.ok(out.discard_reason?.includes("reject"));
  assert.equal(out.cap_check_result, null);
});

test("pass risk + valid ticket greenlights caps", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_pass",
    tier: "low",
    risk_assessment: { score: 90, verdict: "pass" },
    proposed_ticket: {
      cycle_id: "c_pass",
      tier: "low",
      side: "buy",
      jetton_master: jetton,
      amount_ton: 0.5,
      risk: { score: 90, verdict: "pass" },
    },
  });
  const out = await runRiskPipeline(state, ctx());
  assert.equal(out.discarded, false);
  assert.equal(out.cap_check_result?.ok, true);
  assert.ok(out.cap_check_result?.ticket_hash);
});

test("kill-switch in context discards at SafetyCaps", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_kill",
    tier: "low",
    risk_assessment: { score: 90, verdict: "pass" },
    proposed_ticket: {
      cycle_id: "c_kill",
      tier: "low",
      side: "buy",
      jetton_master: jetton,
      amount_ton: 0.5,
    },
  });
  const out = await runRiskPipeline(
    state,
    ctx({ kill_switch_active: true, kill_switch_reason: "test" }),
  );
  assert.equal(out.discarded, true);
  assert.equal(out.cap_check_result?.ok, false);
});

test("caution path greenlights autonomously — no pending approval", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_caution",
    tier: "low",
    risk_assessment: { score: 55, verdict: "caution" },
    proposed_ticket: {
      cycle_id: "c_caution",
      tier: "low",
      side: "buy",
      jetton_master: jetton,
      amount_ton: 0.5,
    },
  });
  const out = await runRiskPipeline(state, ctx());
  assert.equal(out.discarded, false);
  assert.equal(out.cap_check_result?.ok, true);
  assert.equal("hitl_status" in out, false, "state must not carry hitl_status");
  assert.equal(
    "hitl_required" in (out.cap_check_result ?? {}),
    false,
    "cap must not carry hitl_required",
  );
});
