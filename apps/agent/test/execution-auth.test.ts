/**
 * Authorization envelope binding tests — pure, no network, no signer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPS_VERSION, checkTicket, type CapCheckContext, type TradeTicket } from "../src/safetycaps";
import { makeAuthorizedExecution } from "../src/orchestration/nodes/execution";

const jetton = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

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

function ticket(overrides: Partial<TradeTicket> = {}): TradeTicket {
  return {
    cycle_id: "c_exec",
    tier: "low",
    side: "buy",
    jetton_master: jetton,
    amount_ton: 0.5,
    risk: { score: 90, verdict: "pass" },
    ...overrides,
  };
}

test("CAPS_VERSION is v2 so v1 authorizations cannot replay", () => {
  assert.equal(CAPS_VERSION, "safetycaps-v2");
});

test("makeAuthorizedExecution binds ticket to cap with no hitl field", () => {
  const t = ticket();
  const cap = checkTicket(t, ctx());
  const auth = makeAuthorizedExecution(t, cap);
  assert.equal(auth.ticket, t);
  assert.equal(auth.cap, cap);
  assert.equal("hitl" in auth, false);
  assert.equal(auth.idempotency_key, `${cap.cycle_id}:${cap.ticket_hash}`);
});

test("caution ticket produces a fully authorized envelope", () => {
  const t = ticket({ risk: { score: 55, verdict: "caution" } });
  const cap = checkTicket(t, ctx());
  assert.equal(cap.ok, true);
  const auth = makeAuthorizedExecution(t, cap);
  assert.equal(auth.cap.caps_version, CAPS_VERSION);
});
