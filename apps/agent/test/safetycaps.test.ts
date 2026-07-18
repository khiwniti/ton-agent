/**
 * Unit tests for SafetyCaps pure evaluation, hash binding, and registry.
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/safetycaps.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPS_VERSION,
  authorizeTicket,
  buildCapContext,
  checkTicket,
  clearAuthorizationRegistry,
  consumeAuthorization,
  hashTradeTicket,
  issueAuthorization,
  verifyCapBinding,
  withHitlApproved,
  type CapCheckContext,
  type TradeTicket,
} from "../src/safetycaps";

function baseCtx(overrides: Partial<CapCheckContext> = {}): CapCheckContext {
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
    auto_approve_ceiling_pct: 100,
    max_portfolio_allocation_pct: 50, // 5 TON of 10
    max_slippage_pct: 1.5,
    max_trade_pool_tvl_pct: 5,
    require_pool_tvl: false,
    gas_cushion_ton: 0.3,
    ...overrides,
  };
}

function buyTicket(overrides: Partial<TradeTicket> = {}): TradeTicket {
  return {
    cycle_id: "cycle_test_1",
    tier: "low",
    side: "buy",
    jetton_master: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
    amount_ton: 0.5,
    risk: { score: 80, verdict: "pass" },
    ...overrides,
  };
}

test("happy path: small buy with pass verdict is ok and not HITL", () => {
  const t = buyTicket();
  const r = checkTicket(t, baseCtx());
  assert.equal(r.ok, true);
  assert.equal(r.hitl_required, false);
  assert.equal(r.caps_version, CAPS_VERSION);
  assert.equal(r.ticket_hash, hashTradeTicket(t));
});

test("hash is stable for same ticket fields", () => {
  const a = buyTicket();
  const b = buyTicket();
  assert.equal(hashTradeTicket(a), hashTradeTicket(b));
});

test("hash changes when amount changes", () => {
  const a = buyTicket({ amount_ton: 0.5 });
  const b = buyTicket({ amount_ton: 0.6 });
  assert.notEqual(hashTradeTicket(a), hashTradeTicket(b));
});

test("risk verdict reject is hard fail", () => {
  const r = checkTicket(
    buyTicket({ risk: { score: 0, verdict: "reject" } }),
    baseCtx(),
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === "RISK_REJECT"));
});

test("caution forces HITL even when otherwise ok", () => {
  const r = checkTicket(
    buyTicket({ risk: { score: 55, verdict: "caution" } }),
    baseCtx(),
  );
  assert.equal(r.ok, true);
  assert.equal(r.hitl_required, true);
  assert.equal(r.hitl_status, "pending");
});

test("kill-switch denies buys and sells", () => {
  const ctx = baseCtx({ kill_switch_active: true, kill_switch_reason: "test" });
  const buy = checkTicket(buyTicket(), ctx);
  assert.equal(buy.ok, false);
  assert.ok(buy.failures.some((f) => f.code === "KILL_SWITCH"));

  const sell = checkTicket(buyTicket({ side: "sell" }), ctx);
  assert.equal(sell.ok, false);
});

test("circuit breaker denies buys but not needed for size-only sell path", () => {
  const buy = checkTicket(buyTicket(), baseCtx({ circuit_breaker_ok: false }));
  assert.equal(buy.ok, false);
  assert.ok(buy.failures.some((f) => f.code === "CIRCUIT_BREAKER"));
});

test("portfolio allocation hard gate", () => {
  // 50% of 10 = 5 max; request 6
  const r = checkTicket(buyTicket({ amount_ton: 6 }), baseCtx());
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === "ALLOCATION"));
});

test("liquidity depth gate when pool TVL provided", () => {
  const r = checkTicket(
    buyTicket({ amount_ton: 1, pool_tvl_ton: 10 }), // 5% of 10 = 0.5 max
    baseCtx({ max_trade_pool_tvl_pct: 5 }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === "DEPTH"));
});

test("require_pool_tvl fails closed when missing", () => {
  const r = checkTicket(buyTicket(), baseCtx({ require_pool_tvl: true }));
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === "POOL_TVL_REQUIRED"));
});

test("auto-approve ceiling forces HITL when size exceeds % of balance", () => {
  // balance 10, ceiling 1% => 0.1 TON; amount 0.5 requires HITL
  const r = checkTicket(
    buyTicket({ amount_ton: 0.5 }),
    baseCtx({ auto_approve_ceiling_pct: 1 }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.hitl_required, true);
});

test("verifyCapBinding rejects forged ok result with wrong hash", () => {
  const ticket = buyTicket();
  const real = checkTicket(ticket, baseCtx());
  const forged = { ...real, ticket_hash: "deadbeef".repeat(4) };
  const v = verifyCapBinding(ticket, forged);
  assert.equal(v.allowed, false);
  assert.ok(v.reason?.includes("ticket_hash mismatch"));
});

test("verifyCapBinding requires HITL approved when hitl_required", () => {
  const ticket = buyTicket({ risk: { score: 40, verdict: "caution" } });
  const cap = checkTicket(ticket, baseCtx());
  assert.equal(cap.hitl_required, true);
  assert.equal(verifyCapBinding(ticket, cap).allowed, false);
  assert.equal(verifyCapBinding(ticket, withHitlApproved(cap)).allowed, true);
});

test("registry: only issued authorizations can be consumed", () => {
  clearAuthorizationRegistry();
  const ticket = buyTicket();
  const cap = authorizeTicket(ticket, baseCtx());
  assert.equal(cap.ok, true);
  const consumed = consumeAuthorization(cap.ticket_hash);
  assert.ok(consumed);
  assert.equal(consumeAuthorization(cap.ticket_hash), undefined); // single-use
});

test("registry: LLM-fabricated hash cannot be consumed", () => {
  clearAuthorizationRegistry();
  assert.equal(consumeAuthorization("f".repeat(32)), undefined);
});

test("issueAuthorization does not register denied caps", () => {
  clearAuthorizationRegistry();
  const denied = checkTicket(
    buyTicket({ risk: { score: 0, verdict: "reject" } }),
    baseCtx(),
  );
  issueAuthorization(denied);
  assert.equal(consumeAuthorization(denied.ticket_hash), undefined);
});

test("buildCapContext wires tier configs", () => {
  const ctx = buildCapContext({
    tier: "low",
    balanceTon: 2,
    openPositions: 0,
    unlocked: true,
    killSwitchActive: false,
    circuitBreakerOk: true,
    observeOnly: false,
    dailyPnlTon: 0,
  });
  assert.ok(ctx.max_position_ton > 0);
  assert.ok(ctx.gas_cushion_ton > 0);
});
