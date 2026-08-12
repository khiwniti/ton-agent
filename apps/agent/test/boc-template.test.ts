import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileBocTemplate,
  findLeafPath,
  rebuildLeafCell,
  rebuildDedustNativeBuyLeaf,
  rebuildDedustJettonSellLeaf,
  validateBocTemplate,
  extractPoolSnapshot,
} from "../src/core/boc-template";
import type { BocTemplate, LeafCellData, PoolSnapshot } from "../src/core/fastpath-types";
import { beginCell, Address, Cell, toNano } from "@ton/core";

// Use raw address format for testing (workchain: 0, hash: 32 bytes)
// This avoids checksum validation issues with test addresses
const TEST_POOL_ADDR = new Address(0, Buffer.from("aa".repeat(32), "hex"));
const TEST_WALLET_ADDR = new Address(0, Buffer.from("bb".repeat(32), "hex"));
const TEST_TOKEN_ADDR = new Address(0, Buffer.from("cc".repeat(32), "hex"));
const TEST_TON_ADDR = new Address(0, Buffer.from("dd".repeat(32), "hex"));

function addrToString(addr: Address): string {
  return addr.toString({ testOnly: true });
}

function createTestTemplate(overrides: Partial<BocTemplate> = {}): BocTemplate {
  const side = overrides.side || "buy";

  let cell: Cell;
  if (side === "buy") {
    cell = beginCell()
      .storeUint(0xea06185d, 32)
      .storeUint(12345n, 64)
      .storeCoins(toNano("1"))
      .storeAddress(TEST_POOL_ADDR)
      .storeUint(0, 1)
      .storeCoins(0n)
      .storeMaybeRef(null)
      .storeRef(
        beginCell()
          .storeUint(0, 32)
          .storeAddress(TEST_WALLET_ADDR)
          .storeAddress(null)
          .storeMaybeRef(null)
          .storeMaybeRef(null)
          .endCell()
      )
      .endCell();
  } else {
    // DeDust sell template
    const forwardPayloadCell = beginCell()
      .storeUint(0x178d4519, 32)
      .storeAddress(TEST_POOL_ADDR)
      .storeCoins(0n)
      .storeMaybeRef(null)
      .storeRef(
        beginCell()
          .storeUint(0, 32)
          .storeAddress(TEST_WALLET_ADDR)
          .storeAddress(null)
          .storeMaybeRef(null)
          .storeMaybeRef(null)
          .endCell()
      )
      .endCell();

    cell = beginCell()
      .storeUint(0xf8a7ea5, 32)
      .storeUint(12345n, 64)
      .storeCoins(toNano("1"))
      .storeAddress(TEST_POOL_ADDR)
      .storeAddress(TEST_WALLET_ADDR)
      .storeBit(0)
      .storeCoins(0n)
      .storeBit(1)
      .storeRef(forwardPayloadCell)
      .endCell();
  }

  const boc = Buffer.from(cell.toBoc({ idx: false }));
  const hash = cell.hash();

  return {
    templateBoc: boc,
    templateHash: Buffer.from(hash),
    dex: "dedust",
    poolAddress: addrToString(TEST_POOL_ADDR),
    tokenAddress: addrToString(TEST_TOKEN_ADDR),
    side,
    estimatedGasNanoTon: 200000000,
    compiledAt: Date.now(),
    policyVersion: 1,
    ...overrides,
  };
}

function createTestLeafData(overrides: Partial<LeafCellData> = {}): LeafCellData {
  return {
    queryId: 999,
    amount: toNano("2"),
    recipient: TEST_POOL_ADDR,
    responseDestination: TEST_WALLET_ADDR,
    forwardPayload: null,
    forwardTonAmount: toNano("0.25"),
    ...overrides,
  };
}

function createTestPoolSnapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    address: addrToString(TEST_POOL_ADDR),
    reserve0: toNano("1000"),
    reserve1: toNano("5000000"),
    token0: addrToString(TEST_TON_ADDR),
    token1: addrToString(TEST_TOKEN_ADDR),
    dex: "dedust",
    timestamp: Date.now(),
    feeBps: 30,
    ...overrides,
  };
}

test("compileBocTemplate: creates valid template for DeDust buy", () => {
  const template = compileBocTemplate(
    "dedust",
    addrToString(TEST_POOL_ADDR),
    addrToString(TEST_TOKEN_ADDR),
    "buy",
    addrToString(TEST_WALLET_ADDR),
    Buffer.alloc(32),
    200000000,
    5
  );

  assert.ok(template);
  assert.equal(template.dex, "dedust");
  assert.equal(template.side, "buy");
  assert.equal(template.policyVersion, 5);
  assert.ok(template.templateBoc.length > 0);
  assert.ok(template.templateHash.length === 32);
});

test("compileBocTemplate: creates valid template for DeDust sell", () => {
  const template = compileBocTemplate(
    "dedust",
    addrToString(TEST_POOL_ADDR),
    addrToString(TEST_TOKEN_ADDR),
    "sell",
    addrToString(TEST_WALLET_ADDR),
    Buffer.alloc(32),
    200000000,
    5
  );

  assert.ok(template);
  assert.equal(template.side, "sell");
});

test("compileBocTemplate: creates valid template for Ston.fi buy", () => {
  const template = compileBocTemplate(
    "stonfi",
    addrToString(TEST_POOL_ADDR),
    addrToString(TEST_TOKEN_ADDR),
    "buy",
    addrToString(TEST_WALLET_ADDR),
    Buffer.alloc(32),
    200000000,
    5
  );

  assert.ok(template);
  assert.equal(template.dex, "stonfi");
});

test("compileBocTemplate: creates valid template for Ston.fi sell", () => {
  const template = compileBocTemplate(
    "stonfi",
    addrToString(TEST_POOL_ADDR),
    addrToString(TEST_TOKEN_ADDR),
    "sell",
    addrToString(TEST_WALLET_ADDR),
    Buffer.alloc(32),
    200000000,
    5
  );

  assert.ok(template);
  assert.equal(template.dex, "stonfi");
  assert.equal(template.side, "sell");
});

test("findLeafPath: returns path for buy template", () => {
  const cell = beginCell()
    .storeUint(0xea06185d, 32)
    .storeUint(12345n, 64)
    .storeCoins(toNano("1"))
    .storeAddress(TEST_POOL_ADDR)
    .endCell();

  const path = findLeafPath(cell, "buy");
  assert.ok(Array.isArray(path));
  assert.ok(path.includes(2)); // Amount is typically at index 2
});

test("findLeafPath: returns path for sell template", () => {
  const cell = beginCell()
    .storeUint(0xf8a7ea5, 32)
    .storeUint(12345n, 64)
    .storeCoins(toNano("1"))
    .storeAddress(TEST_POOL_ADDR)
    .endCell();

  const path = findLeafPath(cell, "sell");
  assert.ok(Array.isArray(path));
  assert.ok(path.includes(2));
});

test("rebuildLeafCell: rebuilds cell with new dynamic values", () => {
  const template = createTestTemplate();
  const leafData = createTestLeafData();

  const rebuiltBoc = rebuildLeafCell(template.templateBoc, leafData);

  assert.ok(rebuiltBoc.length > 0);

  // Verify the rebuilt cell can be parsed
  const rebuiltCell = Cell.fromBoc(rebuiltBoc)[0];
  const slice = rebuiltCell.beginParse();

  assert.equal(slice.loadUint(32), 0xea06185d); // opcode
  assert.equal(slice.loadUint(64), 999); // queryId
  assert.equal(slice.loadCoins(), toNano("2")); // amount
  assert.equal(slice.loadAddress().toString({ testOnly: true }), TEST_POOL_ADDR.toString({ testOnly: true }));
});

test("rebuildDedustNativeBuyLeaf: rebuilds DeDust native buy payload", () => {
  const template = createTestTemplate({ side: "buy" });
  const newAmount = toNano("3");
  const newLimit = toNano("2.9");
  const queryId = 555;

  const rebuiltBoc = rebuildDedustNativeBuyLeaf(template.templateBoc, newAmount, newLimit, queryId);

  assert.ok(rebuiltBoc.length > 0);

  const rebuiltCell = Cell.fromBoc(rebuiltBoc)[0];
  const slice = rebuiltCell.beginParse();

  assert.equal(slice.loadUint(32), 0xea06185d);
  assert.equal(slice.loadUint(64), 555);
  assert.equal(slice.loadCoins(), newAmount);
  assert.equal(slice.loadAddress().toString({ testOnly: true }), TEST_POOL_ADDR.toString({ testOnly: true }));
  assert.equal(slice.loadUint(1), 0);
  assert.equal(slice.loadCoins(), newLimit);
});

test("rebuildDedustJettonSellLeaf: rebuilds DeDust jetton sell payload", () => {
  const template = createTestTemplate({ side: "sell" });
  const newAmount = toNano("1000000");
  const newForwardTon = toNano("0.3");
  const queryId = 777;

  const rebuiltBoc = rebuildDedustJettonSellLeaf(template.templateBoc, newAmount, newForwardTon, queryId);

  assert.ok(rebuiltBoc.length > 0);

  const rebuiltCell = Cell.fromBoc(rebuiltBoc)[0];
  const slice = rebuiltCell.beginParse();

  assert.equal(slice.loadUint(32), 0xf8a7ea5);
  assert.equal(slice.loadUint(64), 777);
  assert.equal(slice.loadCoins(), newAmount);
});

test("validateBocTemplate: returns true for matching pool and policy", () => {
  const template = createTestTemplate({ policyVersion: 10 });
  const poolSnapshot = createTestPoolSnapshot({ address: addrToString(TEST_POOL_ADDR), dex: "dedust" });

  const result = validateBocTemplate(template, poolSnapshot, 10);
  assert.equal(result, true);
});

test("validateBocTemplate: returns false for mismatched pool address", () => {
  const template = createTestTemplate({ poolAddress: "EQD...pool1" });
  const poolSnapshot = createTestPoolSnapshot({ address: "EQD...pool2" });

  const result = validateBocTemplate(template, poolSnapshot, 10);
  assert.equal(result, false);
});

test("validateBocTemplate: returns false for mismatched DEX", () => {
  const template = createTestTemplate({ dex: "dedust" });
  const poolSnapshot = createTestPoolSnapshot({ dex: "stonfi" });

  const result = validateBocTemplate(template, poolSnapshot, 10);
  assert.equal(result, false);
});

test("validateBocTemplate: returns false for stale policy version", () => {
  const template = createTestTemplate({ policyVersion: 5 });
  const poolSnapshot = createTestPoolSnapshot();

  const result = validateBocTemplate(template, poolSnapshot, 10); // current is 10, template is 5
  assert.equal(result, false);
});

test("validateBocTemplate: returns true for policy version within 1 (grace)", () => {
  const template = createTestTemplate({ policyVersion: 9 });
  const poolSnapshot = createTestPoolSnapshot();

  const result = validateBocTemplate(template, poolSnapshot, 10); // current is 10, template is 9 (within 1)
  assert.equal(result, true);
});

test("validateBocTemplate: returns false for mismatched token", () => {
  const template = createTestTemplate({ tokenAddress: "EQD...token1" });
  const poolSnapshot = createTestPoolSnapshot({ token0: "EQD...token2", token1: "EQD...token3" });

  const result = validateBocTemplate(template, poolSnapshot, 10);
  assert.equal(result, false);
});

test("validateBocTemplate: returns false for expired template (age > 1 hour)", () => {
  const template = createTestTemplate({ compiledAt: Date.now() - 7200000 }); // 2 hours ago
  const poolSnapshot = createTestPoolSnapshot();

  const result = validateBocTemplate(template, poolSnapshot, 10);
  assert.equal(result, false);
});

test("extractPoolSnapshot: extracts data from pool data", () => {
  const poolData = {
    reserve_0: 1000000000000n,
    reserve_1: 5000000000000n,
    token_0_address: "EQD...ton",
    token_1_address: "EQD...jetton",
    fee_bps: 30,
  };

  const snapshot = extractPoolSnapshot("dedust", "EQD...pool", poolData, "EQD...jetton");

  assert.equal(snapshot.address, "EQD...pool");
  assert.equal(snapshot.dex, "dedust");
  assert.equal(snapshot.reserve0, 1000000000000n);
  assert.equal(snapshot.reserve1, 5000000000000n);
  assert.equal(snapshot.feeBps, 30);
});

test("extractPoolSnapshot: handles missing fields gracefully", () => {
  const poolData = {};

  const snapshot = extractPoolSnapshot("stonfi", "EQD...pool", poolData, "EQD...jetton");

  assert.equal(snapshot.address, "EQD...pool");
  assert.equal(snapshot.dex, "stonfi");
  assert.equal(snapshot.reserve0, 0n);
  assert.equal(snapshot.reserve1, 0n);
  assert.equal(snapshot.feeBps, 30); // default
});