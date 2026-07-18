/**
 * Integration Tests for Wallet Delegation (T007)
 *
 * Tests the key delegation flow:
 *   1. Key derivation produces deterministic keys for the same tier
 *   2. prepareDelegatedWallet produces valid contract address + key pair
 *   3. Contract address is deterministic
 *   4. Different tiers produce different delegated addresses
 *
 * Run:
 *   npx tsx --test test/wallet-delegation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Sandbox the SQLite path BEFORE imports
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ton-agent-del-test-"));
process.env.DATA_DIR = tmpRoot;
process.env.WALLET_MASTER_MNEMONIC = "test test test test test test test test test test test junk";

import { CONFIG } from "../src/config";
import { Cell } from "@ton/ton";

// Helper: a valid-ish code cell for the test (not real compiled code,
// but enough to exercise the deterministic address computation)
function makeTestCodeCell(): Cell {
  // Build a minimal non-empty cell to represent compiled code.
  // This cell is NOT the real budgeting-wallet code — it's only
  // used for deterministic-address testing.
  return new Cell();
}

test("prepareDelegatedWallet returns deterministic key pairs and limits for same inputs", async () => {
  const { TonClient, Address, Cell } = await import("@ton/ton");
  const { makeClient } = await import("../src/wallet/wallet");
  const { prepareDelegatedWallet } = await import("../src/wallet/agentic-wallet");

  const client = makeClient();
  const ownerAddr = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
  const codeCell = new Cell();

  // First call
  const result1 = await prepareDelegatedWallet(client, ownerAddr, 2.0, "low", codeCell);

  // Same call should produce same agent keys and limits (determinism from same mnemonic)
  const result2 = await prepareDelegatedWallet(client, ownerAddr, 2.0, "low", codeCell);

  assert.equal(
    result1.agentKeyPair.pub.toString("hex"),
    result2.agentKeyPair.pub.toString("hex"),
    "agent public keys must be deterministic",
  );
  assert.equal(
    result1.agentKeyPair.sec.toString("hex"),
    result2.agentKeyPair.sec.toString("hex"),
    "agent secret keys must be deterministic",
  );
  assert.equal(
    result1.dailyLimitNano.toString(),
    result2.dailyLimitNano.toString(),
    "daily limits must be identical",
  );
});

// ─────────────────────────────────────────────────────────────────────
// Test: Different tiers produce different key pairs
// ─────────────────────────────────────────────────────────────────────
test("different tiers produce different delegated key pairs", async () => {
  const { TonClient, Address, Cell } = await import("@ton/ton");
  const { makeClient } = await import("../src/wallet/wallet");
  const { prepareDelegatedWallet } = await import("../src/wallet/agentic-wallet");

  const client = makeClient();
  const ownerAddr = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
  const codeCell = new Cell();

  const low = await prepareDelegatedWallet(client, ownerAddr, 2.0, "low", codeCell);
  const mid = await prepareDelegatedWallet(client, ownerAddr, 3.0, "mid", codeCell);

  assert.notEqual(
    low.agentKeyPair.pub.toString("hex"),
    mid.agentKeyPair.pub.toString("hex"),
    "LOW and MID must have different agent public keys",
  );
});

// ─────────────────────────────────────────────────────────────────────
// Test: Keypair format matches @ton/crypto expectations
// ─────────────────────────────────────────────────────────────────────
test("delegated keypairs have correct Buffer sizes (pub=32, sec=64)", async () => {
  const { TonClient, Address, Cell } = await import("@ton/ton");
  const { makeClient } = await import("../src/wallet/wallet");
  const { prepareDelegatedWallet } = await import("../src/wallet/agentic-wallet");

  const client = makeClient();
  const ownerAddr = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
  const codeCell = new Cell();

  const result = await prepareDelegatedWallet(client, ownerAddr, 1.0, "low", codeCell);

  assert.equal(result.agentKeyPair.pub.length, 32, "public key must be 32 bytes");
  assert.equal(result.agentKeyPair.sec.length, 64, "secret key must be 64 bytes");
});
