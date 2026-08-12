/**
 * Unit tests for src/sniper/sizing.ts — sizing guards for the aligned TP/SL.
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" npx tsx --test test/sizing-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { worstCaseSlLossOk } from "../src/sniper/sizing";

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