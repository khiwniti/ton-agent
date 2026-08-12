import { test } from "node:test";
import assert from "node:assert/strict";
import { clearAuthorizationRegistry, type CapCheckContext } from "../src/safetycaps";
import { emptyGramState, runMultiAgentPipeline } from "../src/orchestration";

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
    auto_approve_ceiling_pct: 100,
    max_portfolio_allocation_pct: 50,
    max_slippage_pct: 1.5,
    max_trade_pool_tvl_pct: 5,
    require_pool_tvl: false,
    gas_cushion_ton: 0.3,
    ...overrides,
  };
}

const jetton = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

test("Multi-Agent Graph: Perfect candidates trigger EXECUTE_BUY", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_multi_perfect",
    tier: "low",
    candidate: {
      jetton_master: jetton,
      symbol: "TEST_PAIR",
    },
    pair_metadata: {
      jetton_admin_revoked: true,
      lp_locked: true,
      mint_disabled: true,
      buy_tax: 0,
      sell_tax: 0,
      top_10_concentration: 10.0, // extremely low concentration -> high microstructure score
      unique_buyers: 150,
      total_tx: 160, // organic trading ratio
      smart_wallets_count: 4, // high whale count -> high smart money score
      scraped_messages: ["Perfect coin launch", "LP is fully burned"],
    },
  });

  const out = await runMultiAgentPipeline(state, ctx());

  assert.equal(out.discarded, false);
  assert.equal(out.security_passed, true);
  assert.ok(out.composite_score !== undefined);
  assert.ok(out.composite_score >= 78.0);
  assert.equal(out.decision, "EXECUTE_BUY");
  assert.ok(out.execution_payload?.target === jetton);
});

test("Multi-Agent Graph: Non-renounced admin rights triggers HARD FAIL (discard)", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_multi_admin_fail",
    tier: "low",
    candidate: {
      jetton_master: jetton,
      symbol: "SCAM_COIN",
    },
    pair_metadata: {
      jetton_admin_revoked: false, // NOT renounced -> hard fail
      lp_locked: true,
      mint_disabled: false,
      buy_tax: 0,
      sell_tax: 0,
    },
  });

  const out = await runMultiAgentPipeline(state, ctx());

  assert.equal(out.discarded, true);
  assert.equal(out.security_passed, false);
  assert.equal(out.decision, "REJECT");
});

test("Multi-Agent Graph: Poor distribution and high tax leads to REJECT", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_multi_poor",
    tier: "low",
    candidate: {
      jetton_master: jetton,
      symbol: "HIGH_TAX_PAIR",
    },
    pair_metadata: {
      jetton_admin_revoked: true,
      lp_locked: true,
      mint_disabled: true,
      buy_tax: 5.0, // buy tax too high -> hard fail
      sell_tax: 5.0,
    },
  });

  const out = await runMultiAgentPipeline(state, ctx());

  assert.equal(out.discarded, true);
  assert.equal(out.decision, "REJECT");
});
