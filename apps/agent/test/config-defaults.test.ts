/**
 * Pin the aligned-TP/SL config defaults (spec 2026-08-12). CONFIG is an
 * eager singleton reading process.env at import; the runner provides
 * DATA_DIR + mnemonic. These assertions fail first, then flip the defaults.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../src/config.js";

test("aligned TP/SL: giveback trail ships enabled by default", () => {
  assert.equal(CONFIG.sniper.givebackEnabled, true);
});
