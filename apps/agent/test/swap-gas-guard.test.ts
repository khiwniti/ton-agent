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
  BANKROLL_FLOOR_TON,
  effectiveBuyReserveTon,
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
  it("BANKROLL_FLOOR_TON is positive and ≥ SELL_GAS_FLOOR_TON", () => {
    // Operator's per-wallet bankroll floor must be at least the sell-gas floor
    // so the worst-case exit is always affordable. Defaults to 1 TON.
    assert.ok(BANKROLL_FLOOR_TON > 0, `bad floor: ${BANKROLL_FLOOR_TON}`);
    assert.ok(
      BANKROLL_FLOOR_TON >= SELL_GAS_FLOOR_TON,
      `bankroll floor (${BANKROLL_FLOOR_TON}) must be ≥ sell-gas floor (${SELL_GAS_FLOOR_TON})`,
    );
  });
  it("effectiveBuyReserveTon() returns max of EXIT_RESERVE_TON vs BANKROLL_FLOOR_TON", () => {
    assert.strictEqual(
      effectiveBuyReserveTon(),
      Math.max(EXIT_RESERVE_TON, BANKROLL_FLOOR_TON),
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
    // need = 1.0 + 0.25 + 1.0 (BANKROLL_FLOOR > EXIT_RESERVE) = 2.25
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /\[buy\] insufficient balance/);
    assert.match(r.error, /reserve-floor/);
  });

  it("wallet exactly equal to need (position + cushion + bankroll floor) → ok=true", () => {
    const need = 1.0 + 0.25 + effectiveBuyReserveTon();
    const r = evaluateBuyGasGuard(need, 1.0);
    assert.strictEqual(r.ok, true);
  });

  it("wallet at need+ε → ok=true", () => {
    const need = 1.0 + 0.25 + effectiveBuyReserveTon();
    const r = evaluateBuyGasGuard(need + 0.001, 1.0);
    assert.strictEqual(r.ok, true);
  });

  it("tiny buy (0.01 TON) on a 1 TON wallet → refuse (bankroll floor wins)", () => {
    // With BANKROLL_FLOOR_TON=1.0 effective, the buy must leave ≥1 TON behind.
    // need = 0.01 + 0.25 + 1.0 = 1.26 > 1.0 → refuse.
    // This is the user's worst-case requirement: never draw below the
    // operator-configured bankroll floor.
    const r = evaluateBuyGasGuard(1.0, 0.01);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /reserve-floor/);
  });

  it("buy leaves at least BANKROLL_FLOOR_TON behind after a small position", () => {
    // Property: when a buy is allowed and the bankroll floor > 0, the wallet
    // must still hold ≥ BANKROLL_FLOOR_TON after the buy settles.
    const balanceTon = 1.5;                   // > 0.01 + 0.25 + 1.0 = 1.26
    const requested = 0.1;
    const r = evaluateBuyGasGuard(balanceTon, requested);
    assert.strictEqual(r.ok, true);
    const remainder = balanceTon - (requested + 0.25);
    assert.ok(
      remainder >= BANKROLL_FLOOR_TON,
      `after a successful buy of ${requested} TON with ${balanceTon} balance, remainder=${remainder} must be ≥ BANKROLL_FLOOR_TON=${BANKROLL_FLOOR_TON}`,
    );
  });

  it("guard floors balance at 0 (negative → 0) and large requested → refuse", () => {
    const r = evaluateBuyGasGuard(-100, 50);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.haveTon, 0);
    // need = 50 + 0.25 + EXIT_RESERVE_TON = 50.65
    assert.ok(r.needTon > 50);
  });

  it("buy with non-finite requested amount → refuse (need reduces to cushion + bankroll floor)", () => {
    // NaN requested = caller passed garbage; we safely treat it as 0-position.
    // But the bankroll floor still applies: balanceTon=1.0 must still cover
    // FORWARD_CUSHION + BANKROLL_FLOOR_TON = 0.25 + 1.0 = 1.25. 1.0 < 1.25 → refuse.
    const r = evaluateBuyGasGuard(1.0, Number.NaN);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needTon, 0.25 + BANKROLL_FLOOR_TON);
  });

  it("the buy guard leaves at least effectiveBuyReserveTon() untouched", () => {
    // Property: when a buy is allowed, what remains after the buy (position
    // + 0.25 forward cushion) is >= max(EXIT_RESERVE_TON, BANKROLL_FLOOR_TON).
    // This is the exact invariant the policy demands: both the sell-gas
    // cushion and the operator-configured bankroll floor are preserved.
    const balanceTon = 2.0;
    const requested = 0.5;
    const r = evaluateBuyGasGuard(balanceTon, requested);
    assert.strictEqual(r.ok, true);
    const remainder = balanceTon - (requested + 0.25);
    const floor = effectiveBuyReserveTon();
    assert.ok(
      remainder >= floor,
      `after a successful buy of ${requested} TON with ${balanceTon} balance, remainder=${remainder} must be ≥ effectiveBuyReserveTon()=${floor}`,
    );
  });
});
