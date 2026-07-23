/**
 * Test: swap-gas-guard — worst-case exit-reserve enforcement.
 *
 * See apps/agent/src/dex/swap-gas-guard.ts for the rule definitions.
 *
 * Why this test exists:
 *   The user requirement: "even in worst-case (lost all orders) wallet must
 *   still have enough TON to pay gas for swap-back." We enforce this with
 *   two guards:
 *     1. BUY gate — every buy is refused when balance < position+reserve.
 *     2. SELL gate — every sell is refused when balance < sell_gas_floor.
 *   These tests lock both behaviors down so a future refactor can't silently
 *   regress them (which would leave the bank stuck with un-unwindable
 *   positions during a rug).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  evaluateSellGasGuard,
  evaluateBuyGasGuard,
  EXIT_RESERVE_TON,
  SELL_GAS_FLOOR_TON,
} from "../src/dex/swap-gas-guard.js";

describe("swap-gas-guard — constants", () => {
  it("EXIT_RESERVE_TON is positive", () => {
    assert.ok(EXIT_RESERVE_TON > 0, `bad floor: ${EXIT_RESERVE_TON}`);
  });
  it("SELL_GAS_FLOOR_TON is positive and ≤ EXIT_RESERVE_TON", () => {
    assert.ok(SELL_GAS_FLOOR_TON > 0, `bad floor: ${SELL_GAS_FLOOR_TON}`);
    assert.ok(
      SELL_GAS_FLOOR_TON <= EXIT_RESERVE_TON,
      `sell floor (${SELL_GAS_FLOOR_TON}) must be ≤ exit reserve (${EXIT_RESERVE_TON}) — otherwise a buy can drain below the sell-gas cushion`,
    );
  });
});

describe("evaluateSellGasGuard", () => {
  it("wallet empty (0 TON) → ok=false, error includes need > SELL_GAS_FLOOR_TON", () => {
    const r = evaluateSellGasGuard(0);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /\[sell\]/);
    assert.match(r.error, /worst-case exit reserve/);
    assert.ok(r.needTon > 0);
  });

  it("wallet at floor−ε → refuse", () => {
    const r = evaluateSellGasGuard(SELL_GAS_FLOOR_TON - 0.01);
    assert.strictEqual(r.ok, false);
  });

  it("wallet AT floor exactly → ok=true (floor is the minimum, not strict)", () => {
    // Policy: "< floor" refuses. At-floor is allowed (just enough cushion).
    const r = evaluateSellGasGuard(SELL_GAS_FLOOR_TON);
    assert.strictEqual(r.ok, true);
  });

  it("wallet above floor → ok=true", () => {
    const r = evaluateSellGasGuard(SELL_GAS_FLOOR_TON + 0.1);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.error, "");
  });

  it("non-finite balance (NaN) is treated as 0 → refuse", () => {
    const r = evaluateSellGasGuard(Number.NaN);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.haveTon, 0);
  });

  it("negative balance is clamped to 0 → refuse", () => {
    const r = evaluateSellGasGuard(-1.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.haveTon, 0);
  });

  it("wallet at 0.01 TON → refuse (operator should top up before any exit)", () => {
    // 0.01 TON is far below the 0.35 floor — this is the user's exact worst
    // case ("lost all orders"). The guard must say NO rather than letting a
    // tx get broadcast and dropped by the chain.
    const r = evaluateSellGasGuard(0.01);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /insufficient balance: have=0\.010 TON/);
  });
});

describe("evaluateBuyGasGuard", () => {
  it("wallet not enough for: requested=1 TON, balance=0.5 TON → refuse", () => {
    const r = evaluateBuyGasGuard(0.5, 1.0);
    // need = 1.0 + 0.25 + 0.4 = 1.65 — far above 0.5
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /\[buy\] insufficient balance/);
    assert.match(r.error, /exit-reserve/);
  });

  it("wallet exactly equal to need → ok=true (boundary allowed; strict is <, not ≤)", () => {
    const need = 1.0 + 0.25 + EXIT_RESERVE_TON;
    const r = evaluateBuyGasGuard(need, 1.0);
    assert.strictEqual(r.ok, true);
  });

  it("wallet at need+ε → ok=true", () => {
    const need = 1.0 + 0.25 + EXIT_RESERVE_TON;
    const r = evaluateBuyGasGuard(need + 0.001, 1.0);
    assert.strictEqual(r.ok, true);
  });

  it("tiny buy (0.01 TON) is allowed even on a 1 TON wallet", () => {
    const r = evaluateBuyGasGuard(1.0, 0.01);
    assert.strictEqual(r.ok, true);
  });

  it("guard floors balance at 0 (negative → 0) and large requested → refuse", () => {
    const r = evaluateBuyGasGuard(-100, 50);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.haveTon, 0);
    // need = 50 + 0.25 + EXIT_RESERVE_TON = 50.65
    assert.ok(r.needTon > 50);
  });

  it("buy with non-finite requested amount → treated as 0 (need reduces to floor+cushion)", () => {
    // NaN requested = caller passed garbage; we safely treat it as 0-position.
    // The wallet still has to cover FORWARD_CUSHION + EXIT_RESERVE_TON.
    // balanceTon=1.0, needTon=0+0.25+0.4=0.65 → 1.0 ≥ 0.65 → ok=true.
    const r = evaluateBuyGasGuard(1.0, Number.NaN);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.needTon, 0.65);
  });

  it("the buy guard leaves at least EXIT_RESERVE_TON for sells after the buy", () => {
    // Property: when a buy is allowed, what remains after deducting the buy
    // (position + 0.25 forward cushion) is >= EXIT_RESERVE_TON. This is the
    // exact invariant the policy demands.
    const balanceTon = 2.0;
    const requested = 0.5;
    const r = evaluateBuyGasGuard(balanceTon, requested);
    assert.strictEqual(r.ok, true);
    const remainder = balanceTon - (requested + 0.25);
    assert.ok(
      remainder >= EXIT_RESERVE_TON,
      `after a successful buy of ${requested} TON with ${balanceTon} balance, remainder=${remainder} must be ≥ EXIT_RESERVE_TON=${EXIT_RESERVE_TON}`,
    );
  });
});
