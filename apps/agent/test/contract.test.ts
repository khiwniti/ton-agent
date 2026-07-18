/**
 * Contract Compilation & Sandbox Setup Tests (T005)
 *
 * Verifies:
 *   1. The budgeting-wallet.tolk contract source exists
 *   2. @ton/sandbox can be initialized (import check)
 *   3. @ton/core cell serialization/deserialization works
 *
 * These are infrastructure smoke tests — the full Tolk contract
 * logic is tested in budgeting-wallet.test.ts (T006).
 *
 * Run:
 *   npx tsx --test test/contract.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────
// Test 1: Source file exists
// ─────────────────────────────────────────────────────────────────────
test("contract source file exists at expected path", () => {
  const contractPath = path.resolve(__dirname, "../../../contracts/budgeting-wallet.tolk");
  assert.ok(fs.existsSync(contractPath), `contract file not found at ${contractPath}`);

  const content = fs.readFileSync(contractPath, "utf-8");
  // NOTE: this is a Tolk contract (TON's FunC successor). Tolk renamed the
  // FunC-era `recv_internal`/`load_data`/`save_data` to camelCase entrypoints.
  assert.ok(content.includes("onInternalMessage"), "contract must have onInternalMessage entrypoint");
  assert.ok(content.includes("loadStorage"), "contract must have loadStorage helper");
  assert.ok(content.includes("saveStorage"), "contract must have saveStorage helper");
  assert.ok(content.includes("check_signature"), "contract must use check_signature");
  assert.ok(content.includes("daily_spent_limit"), "contract must have daily_spent_limit check");
});

// ─────────────────────────────────────────────────────────────────────
// Test 2: @ton/sandbox imports correctly
// ─────────────────────────────────────────────────────────────────────
test("@ton/sandbox module can be imported (environment check)", async () => {
  const { Blockchain } = await import("@ton/sandbox");
  assert.ok(typeof Blockchain.create === "function", "Blockchain.create should be a function");
  const bc = await Blockchain.create();
  assert.ok(bc, "Blockchain instance should be created");
});

// ─────────────────────────────────────────────────────────────────────
// Test 3: @ton/core cell operations work (used by contract ABI)
// ─────────────────────────────────────────────────────────────────────
test("@ton/core cell operations work correctly", async () => {
  const { beginCell, Cell } = await import("@ton/core");

  // Build and parse a cell matching the contract's storage layout
  const cell = beginCell()
    .storeUint(42, 32)    // last_reset_timestamp
    .storeCoins(100n)     // accumulated_spend
    .storeCoins(2000n)    // daily_limit
    .storeUint(0xdeadbeefn, 256) // agent_public_key (simplified)
    .endCell();

  const parsed = cell.beginParse();
  const ts = parsed.loadUint(32);
  const accumulated = parsed.loadCoins();
  const limit = parsed.loadCoins();
  const key = parsed.loadUintBig(256);

  assert.equal(ts, 42);
  assert.equal(accumulated, 100n);
  assert.equal(limit, 2000n);
  assert.equal(key, 0xdeadbeefn);
});

// ─────────────────────────────────────────────────────────────────────
// Test 4: Contract state layout matches spec (5 storage fields)
// ─────────────────────────────────────────────────────────────────────
test("contract storage layout has correct field structure (owner, agent_key, limit, accumulated, reset_ts)", () => {
  // Verify the contract has the 5 expected storage variables
  const contractPath = path.resolve(__dirname, "../../../contracts/budgeting-wallet.tolk");
  const content = fs.readFileSync(contractPath, "utf-8");

  const globals = [
    "owner_address",
    "agent_public_key",
    "daily_spent_limit",
    "daily_spent_accumulated",
    "last_reset_timestamp",
  ];

  for (const g of globals) {
    assert.ok(content.includes(g), `contract should declare global variable '${g}'`);
  }
});
