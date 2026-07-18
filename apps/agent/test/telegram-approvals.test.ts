/**
 * Pure Telegram HITL approval + command parser tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearAuthorizationRegistry,
  consumeAuthorization,
  type TradeTicket,
} from "../src/safetycaps";
import {
  approveApproval,
  clearApprovals,
  createApproval,
  denyApproval,
  expireStaleApprovals,
  listPending,
  parseTelegramCommand,
} from "../src/telegram";
import { checkTicket } from "../src/safetycaps";

const jetton = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

function ticket(): TradeTicket {
  return {
    cycle_id: "c_tg",
    tier: "low",
    side: "buy",
    jetton_master: jetton,
    amount_ton: 0.5,
    risk: { score: 50, verdict: "caution" },
  };
}

function capFor(t: TradeTicket) {
  return checkTicket(t, {
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
    max_portfolio_allocation_pct: 50,
    max_slippage_pct: 1.5,
    max_trade_pool_tvl_pct: 5,
    require_pool_tvl: false,
    gas_cushion_ton: 0.3,
  });
}

test("parseTelegramCommand handles slash and callbacks", () => {
  assert.equal(parseTelegramCommand("/halt").type, "halt");
  assert.equal(parseTelegramCommand("resume").type, "resume");
  assert.equal(parseTelegramCommand("/status").type, "status");
  const a = parseTelegramCommand("approve:appr_abc");
  assert.equal(a.type, "approve");
  if (a.type === "approve") assert.equal(a.approvalId, "appr_abc");
  const d = parseTelegramCommand("deny:appr_xyz");
  assert.equal(d.type, "deny");
  const sc = parseTelegramCommand("/setcap max_open 2");
  assert.equal(sc.type, "setcap");
});

test("create + approve re-issues consumable authorization", () => {
  clearApprovals();
  clearAuthorizationRegistry();
  const t = ticket();
  const cap = capFor(t);
  assert.equal(cap.hitl_required, true);
  const appr = createApproval({ cycleId: t.cycle_id, ticket: t, cap });
  assert.equal(listPending().length, 1);

  const res = approveApproval(appr.id);
  assert.equal(res.ok, true);
  assert.equal(res.cap?.hitl_status, "approved");
  assert.equal(res.cap?.ok, true);

  const consumed = consumeAuthorization(res.cap!.ticket_hash);
  assert.ok(consumed);
  assert.equal(consumed!.hitl_status, "approved");
});

test("deny marks approval denied", () => {
  clearApprovals();
  const t = ticket();
  const appr = createApproval({ cycleId: t.cycle_id, ticket: t, cap: capFor(t) });
  const res = denyApproval(appr.id);
  assert.equal(res.ok, true);
  assert.equal(res.approval?.status, "denied");
  assert.equal(listPending().length, 0);
});

test("expireStaleApprovals times out old pending", () => {
  clearApprovals();
  const t = ticket();
  const appr = createApproval({ cycleId: t.cycle_id, ticket: t, cap: capFor(t) });
  // Force age by mutating via expire with 0 ttl
  const n = expireStaleApprovals(0);
  assert.ok(n >= 1);
  assert.equal(listPending().find((p) => p.id === appr.id), undefined);
});
