/**
 * Unit tests for src/sniper/sizing.ts — sizing guards for the aligned TP/SL.
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" npx tsx --test test/sizing-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { worstCaseSlLossOk, poolDepthCapTon, slippageProbeOk } from "../src/sniper/sizing";

test("worstCaseSlLossOk: a 0.15 lot clears the floor at the widened stop", () => {
  // perTradeTon × (1 − slVolWidenMaxPct/100) = 0.15 × 0.5 = 0.075 ≥ minViable
  assert.equal(worstCaseSlLossOk({ perTradeTon: 0.15, slVolWidenMaxPct: 50, minViablePositionTon: 0.05 }), true);
});

test("worstCaseSlLossOk: a lot that cannot survive the widened SL is refused", () => {
  // 0.06 × 0.5 = 0.03 < 0.05 → refuse (worst-case SL eats the gas floor)
  assert.equal(worstCaseSlLossOk({ perTradeTon: 0.06, slVolWidenMaxPct: 50, minViablePositionTon: 0.05 }), false);
});

test("worstCaseSlLossOk: no widening → plain perTradeTon floor applies", () => {
  assert.equal(worstCaseSlLossOk({ perTradeTon: 0.06, slVolWidenMaxPct: 0, minViablePositionTon: 0.05 }), true);
});

// Task 6: pool depth cap
test("poolDepthCapTon: caps the lot at maxSharePct of pool depth", () => {
  // 10 TON depth, 2% → cap 0.2 TON
  assert.equal(poolDepthCapTon("10000000000", 2), 0.2);
});

test("poolDepthCapTon: null when the pool reports no depth", () => {
  assert.equal(poolDepthCapTon(undefined, 2), null);
  assert.equal(poolDepthCapTon(null, 2), null);
});

test("poolDepthCapTon: zero/malformed depth → null (no cap)", () => {
  assert.equal(poolDepthCapTon("0", 2), null);
  assert.equal(poolDepthCapTon("abc", 2), null);
});

// Task 7: slippage probe
test("slippageProbeOk: over-tolerance price impact → skip", () => {
  const r = slippageProbeOk({ swap_is_possible: true, price_impact: 12 }, 5);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /impact/i);
});

test("slippageProbeOk: within tolerance → proceed", () => {
  const r = slippageProbeOk({ swap_is_possible: true, price_impact: 2 }, 5);
  assert.equal(r.ok, true);
});

test("slippageProbeOk: impossible swap → skip", () => {
  const r = slippageProbeOk({ swap_is_possible: false, price_impact: undefined }, 5);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /not possible/i);
});

test("slippageProbeOk: no impact data → proceed (legacy quote)", () => {
  const r = slippageProbeOk({ swap_is_possible: true, price_impact: undefined }, 5);
  assert.equal(r.ok, true);
});