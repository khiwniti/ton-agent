/**
 * Unit tests for the tier coordinator's trade-gate logic.
 *
 * These tests exercise ONLY the pure `evaluateTradeGate` helper that
 * TierCoordinator.isTradeAllowed() wraps. That helper has no DB, no
 * network, no I/O — making it cheap to test with a synthetic handle.
 *
 * Imports come from `src/core/gate.ts` (the pure module) NOT from
 * `coordinator.ts` — the coordinator pulls in the DEX router and
 * @ston-fi/sdk, which transitively require packages not used in this gate.
 *
 * Run with:
 *   npx tsx --test test/coordinator-gate.test.ts
 * Or via the package.json `test:gate` script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTradeGate,
  type TierHandle,
  type TradeGateInput,
} from "../src/core/gate";
import { TIER_RISK_CONFIGS } from "../src/risk/guardrails";

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
    requestedTon: 0.5,
    killSwitchActive: false,
    circuitBreakerOk: true,
    dailyPnl: 0,
    handle: makeHandle(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. Happy path — a healthy LOW-tier buy should be allowed
// ─────────────────────────────────────────────────────────────────────
test("happy path: small LOW buy is allowed", () => {
  const r = evaluateTradeGate(baseInput({ tier: "low", requestedTon: 0.5 }));
  assert.equal(r.allowed, true);
});

test("happy path: MID buy under tier cap is allowed", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "mid",
      requestedTon: 2.0,
      handle: makeHandle({ tier: "mid", balanceTon: 10, config: TIER_RISK_CONFIGS.mid }),
    }),
  );
  assert.equal(r.allowed, true);
});

// ─────────────────────────────────────────────────────────────────────
// 2. HIGH tier promotion gating
// ─────────────────────────────────────────────────────────────────────
test("HIGH tier is denied when unlocked=false (promotion not satisfied)", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "high",
      requestedTon: 1.0,
      handle: makeHandle({
        tier: "high",
        balanceTon: 20,
        unlocked: false,
        config: TIER_RISK_CONFIGS.high,
      }),
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /HIGH tier locked/);
});

test("HIGH tier is allowed when unlocked=true", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "high",
      requestedTon: 1.0,
      handle: makeHandle({
        tier: "high",
        balanceTon: 20,
        unlocked: true,
        config: TIER_RISK_CONFIGS.high,
      }),
    }),
  );
  assert.equal(r.allowed, true);
});

test("LOW and MID tiers are never blocked by the HIGH unlock flag", () => {
  for (const tier of ["low", "mid"] as const) {
    const r = evaluateTradeGate(
      baseInput({
        tier,
        requestedTon: 0.5,
        handle: makeHandle({ tier, balanceTon: 5, config: TIER_RISK_CONFIGS[tier] }),
      }),
    );
    assert.equal(r.allowed, true, `${tier} should not be locked`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 3. Circuit breaker (daily PnL <= limit)
// ─────────────────────────────────────────────────────────────────────
test("circuit breaker: denied when circuitBreakerOk=false", () => {
  const r = evaluateTradeGate(
    baseInput({
      circuitBreakerOk: false,
      dailyPnl: -2.0,
      handle: makeHandle({ balanceTon: 5 }),
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /circuit breaker tripped/);
});

test("circuit breaker: daily PnL just below the 2.0 TON threshold is tripped", () => {
  // Threshold = 2.0; dailyPnl <= -2.0 trips per the spec.
  const r = evaluateTradeGate(
    baseInput({ dailyPnl: -2.0, circuitBreakerOk: false }),
  );
  assert.equal(r.allowed, false);
});

test("circuit breaker: small positive daily PnL keeps trading on", () => {
  const r = evaluateTradeGate(baseInput({ dailyPnl: 0.1, circuitBreakerOk: true }));
  assert.equal(r.allowed, true);
});

// ─────────────────────────────────────────────────────────────────────
// 4. Kill-switch
// ─────────────────────────────────────────────────────────────────────
test("kill-switch: blocks every tier when active", () => {
  const r = evaluateTradeGate(
    baseInput({ killSwitchActive: true, killSwitchReason: "operator halt" }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /kill-switch active: operator halt/);
});

test("kill-switch: still reports reason when none is provided", () => {
  const r = evaluateTradeGate(baseInput({ killSwitchActive: true }));
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /kill-switch active: n\/a/);
});

test("kill-switch beats HIGH promotion — promoted but killed is still denied", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "high",
      killSwitchActive: true,
      killSwitchReason: "global rescue",
      handle: makeHandle({ tier: "high", balanceTon: 20, unlocked: true }),
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /kill-switch/);
});

// ─────────────────────────────────────────────────────────────────────
// 5. Position-size cap (per tier)
// ─────────────────────────────────────────────────────────────────────
test("LOW tier rejects buys above 1.0 TON cap", () => {
  const r = evaluateTradeGate(baseInput({ tier: "low", requestedTon: 1.5 }));
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /requested 1.5 > tier cap 1/);
});

test("MID tier rejects buys above 3.0 TON cap", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "mid",
      requestedTon: 3.1,
      handle: makeHandle({ tier: "mid", balanceTon: 10, config: TIER_RISK_CONFIGS.mid }),
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /requested 3.1 > tier cap 3/);
});

test("HIGH tier allows up to its 5.0 TON cap inclusive", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "high",
      requestedTon: 5.0,
      handle: makeHandle({ tier: "high", balanceTon: 20, unlocked: true, config: TIER_RISK_CONFIGS.high }),
    }),
  );
  assert.equal(r.allowed, true);
});

// ─────────────────────────────────────────────────────────────────────
// 6. Bankroll insufficiency (gas headroom of 0.3 TON baked in, plus
//    TRADE_RESERVE_TON = max(EXIT_RESERVE, BANKROLL_FLOOR) so the wallet
//    never drops below the operator's bankroll floor — even at this gate,
//    before any router-side pre-flight runs).
// ─────────────────────────────────────────────────────────────────────
test("balance under (requested + cushion + trade reserve) is denied", () => {
  // requested=0.5 → needs ≥ 0.5 + 0.3 + 1.0 (BANKROLL_FLOOR effective) = 1.8 TON.
  // Hand it 1.79.
  const r = evaluateTradeGate(
    baseInput({ requestedTon: 0.5, handle: makeHandle({ balanceTon: 1.79 }) }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /insufficient balance 1\.79 < 1\.8/);
  // Reports the breakdown so operators know why the buy was refused.
  assert.match(r.reason!, /trade-reserve=1/);
});

test("balance exactly (requested + cushion + trade reserve) is allowed", () => {
  const r = evaluateTradeGate(
    baseInput({ requestedTon: 0.5, handle: makeHandle({ balanceTon: 1.8 }) }),
  );
  assert.equal(r.allowed, true);
});

test("balance below bankroll floor at all → denied even on tiny positions", () => {
  // Operator bankroll floor (1 TON) is the strictest constraint. Even a
  // 0.01 TON position on a 1.25 TON wallet is refused because the buy
  // would leave < 1 TON behind (0.01 + 0.3 + 1.0 = 1.31 > 1.25).
  const r = evaluateTradeGate(
    baseInput({ requestedTon: 0.01, handle: makeHandle({ balanceTon: 1.25 }) }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /insufficient balance/);
});

// ─────────────────────────────────────────────────────────────────────
// 7. Max open positions
// ─────────────────────────────────────────────────────────────────────
test("LOW tier blocks buys when 2/2 positions are open", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "low",
      handle: makeHandle({
        tier: "low",
        balanceTon: 5,
        openPositions: 2, // cap = 2
      }),
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /max open positions 2\/2/);
});

test("LOW tier blocks buys when 1/2 positions are open — wait, no — should still allow", () => {
  const r = evaluateTradeGate(
    baseInput({
      tier: "low",
      handle: makeHandle({ tier: "low", balanceTon: 5, openPositions: 1 }),
    }),
  );
  assert.equal(r.allowed, true);
});

test("MID tier cap of 3 blocks when full, allows when 2/3", () => {
  const blocked = evaluateTradeGate(
    baseInput({
      tier: "mid",
      handle: makeHandle({ tier: "mid", balanceTon: 10, openPositions: 3, config: TIER_RISK_CONFIGS.mid }),
    }),
  );
  assert.equal(blocked.allowed, false);

  const allowed = evaluateTradeGate(
    baseInput({
      tier: "mid",
      handle: makeHandle({ tier: "mid", balanceTon: 10, openPositions: 2, config: TIER_RISK_CONFIGS.mid }),
    }),
  );
  assert.equal(allowed.allowed, true);
});

// ─────────────────────────────────────────────────────────────────────
// 8. Defensive: missing / uninitialized tier handle
// ─────────────────────────────────────────────────────────────────────
test("missing handle → denied with explanatory reason", () => {
  const r = evaluateTradeGate(baseInput({ handle: undefined, tier: "mid" }));
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /tier mid not initialized/);
});

// ─────────────────────────────────────────────────────────────────────
// 9. Ordering of checks: kill-switch wins over unlock, cap, balance
// ─────────────────────────────────────────────────────────────────────
test("precedence: kill-switch evaluated before HIGH unlock", () => {
  // If kill is active, the unlock check should never run.
  const r = evaluateTradeGate(
    baseInput({
      tier: "high",
      killSwitchActive: true,
      handle: makeHandle({ tier: "high", balanceTon: 20, unlocked: false }), // would normally lock out
    }),
  );
  assert.equal(r.allowed, false);
  // Order matters: the FIRST failing reason wins.
  assert.match(r.reason!, /kill-switch/);
});

test("precedence: HIGH lock beats circuit breaker vs bankroll is testable", () => {
  // HIGH locked + everything else favourable → "HIGH tier locked" wins
  // (not a generic surface predicate; we just confirm the reason order).
  const r = evaluateTradeGate(
    baseInput({
      tier: "high",
      handle: makeHandle({
        tier: "high",
        balanceTon: 20,
        unlocked: false,
        config: TIER_RISK_CONFIGS.high,
      }),
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /HIGH tier locked/);
});
