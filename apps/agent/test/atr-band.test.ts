import { test } from "node:test";
import assert from "node:assert/strict";
import { atrBandState } from "../src/exit/atr-band.js";

test("atrBandState: computes a Chandelier-style band below the peak", () => {
  const closes = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0];
  const r = atrBandState({ closes, atrMult: 3, entryPriceTon: 1.0, peakPriceTon: 2.0 });
  assert.ok(r.bandLevelTon != null && r.bandLevelTon < 2.0, `band ${r.bandLevelTon} below peak`);
  assert.ok(r.bandLevelTon > 1.0, `band ${r.bandLevelTon} above entry (3xATR on this series)`);
});

test("atrBandState: never reports a band without enough closes", () => {
  const r = atrBandState({ closes: [1.0], atrMult: 3, entryPriceTon: 1.0, peakPriceTon: 1.5 });
  assert.equal(r.bandLevelTon, null);
  assert.equal(r.breached, false);
});

test("atrBandState: breached when the last close pierces the band", () => {
  const closes = [1.0, 1.2, 1.4, 1.6, 1.8, 1.5]; // high ATR then a drop
  const r = atrBandState({ closes, atrMult: 1, entryPriceTon: 1.0, peakPriceTon: 1.8 });
  assert.equal(r.breached, true);
});

test("atrBandState: band clamps to entry — a winner cannot 'breach' below its cost", () => {
  const closes = [1.0, 1.01, 1.02, 1.03, 1.04, 1.05];
  const r = atrBandState({ closes, atrMult: 3, entryPriceTon: 1.0, peakPriceTon: 1.05 });
  assert.ok(r.bandLevelTon == null || r.bandLevelTon >= 1.0, `clamped band ${r.bandLevelTon}`);
});
