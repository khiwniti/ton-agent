/**
 * Unit tests for dynamic configuration defaulting based on NETWORK env var.
 *
 * Run:
 *   npx tsx --test test/config.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("config: defaults are correct when NETWORK=testnet", async () => {
  // Save original env vars
  const origNetwork = process.env.NETWORK;
  const origRpc = process.env.TON_RPC_ENDPOINT;
  const origTonapiBase = process.env.TONAPI_BASE;

  try {
    // Set env to testnet
    process.env.NETWORK = "testnet";
    delete process.env.TON_RPC_ENDPOINT;
    delete process.env.TONAPI_BASE;

    // Delete cache and require again
    const configPath = require.resolve("../src/config");
    delete require.cache[configPath];
    const { CONFIG } = require("../src/config");

    assert.equal(CONFIG.network, "testnet");
    assert.equal(CONFIG.rpcEndpoint, "https://testnet.toncenter.com/api/v2/jsonRPC");
    assert.equal(CONFIG.tonapiBase, "https://testnet.tonapi.io/v2");
  } finally {
    // Restore original env
    if (origNetwork === undefined) delete process.env.NETWORK;
    else process.env.NETWORK = origNetwork;

    if (origRpc === undefined) delete process.env.TON_RPC_ENDPOINT;
    else process.env.TON_RPC_ENDPOINT = origRpc;

    if (origTonapiBase === undefined) delete process.env.TONAPI_BASE;
    else process.env.TONAPI_BASE = origTonapiBase;

    // Clear cache again so other tests aren't messed up
    const configPath = require.resolve("../src/config");
    delete require.cache[configPath];
  }
});

test("config: defaults are correct when NETWORK=mainnet", async () => {
  // Save original env vars
  const origNetwork = process.env.NETWORK;
  const origRpc = process.env.TON_RPC_ENDPOINT;
  const origTonapiBase = process.env.TONAPI_BASE;

  try {
    // Set env to mainnet
    process.env.NETWORK = "mainnet";
    delete process.env.TON_RPC_ENDPOINT;
    delete process.env.TONAPI_BASE;

    // Delete cache and require again
    const configPath = require.resolve("../src/config");
    delete require.cache[configPath];
    const { CONFIG } = require("../src/config");

    assert.equal(CONFIG.network, "mainnet");
    assert.equal(CONFIG.rpcEndpoint, "https://toncenter.com/api/v2/jsonRPC");
    assert.equal(CONFIG.tonapiBase, "https://tonapi.io/v2");
  } finally {
    // Restore original env
    if (origNetwork === undefined) delete process.env.NETWORK;
    else process.env.NETWORK = origNetwork;

    if (origRpc === undefined) delete process.env.TON_RPC_ENDPOINT;
    else process.env.TON_RPC_ENDPOINT = origRpc;

    if (origTonapiBase === undefined) delete process.env.TONAPI_BASE;
    else process.env.TONAPI_BASE = origTonapiBase;

    // Clear cache again
    const configPath = require.resolve("../src/config");
    delete require.cache[configPath];
  }
});
