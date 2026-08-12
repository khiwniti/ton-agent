import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PolicyTransport,
  SharedMemoryPolicyTransport,
  policyTransport,
} from "../src/core/policy-transport";
import type { TradingPolicy } from "../src/core/policy-types";

function createTestPolicy(overrides: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    version: 1,
    maxPositionTon: 10,
    maxOpen: 5,
    allowedDexes: ["stonfi", "dedust"],
    blockedTokens: [],
    maxSlippageBps: 500,
    minConfidence: 0.8,
    ...overrides,
  };
}

function createTestSignal(overrides: Partial<any> = {}) {
  return {
    tokenAddress: "EQD...token1",
    amountTon: 1.0,
    side: "buy",
    producer: "radar",
    policyVersion: 1,
    confidence: 0.9,
    poolAddress: "EQD...pool1",
    ...overrides,
  };
}

test("SharedMemoryPolicyTransport: getVersion returns 0 before any push", () => {
  const transport = new SharedMemoryPolicyTransport();
  assert.equal(transport.getVersion(), 0);
});

test("SharedMemoryPolicyTransport: getPolicy returns null before any push", () => {
  const transport = new SharedMemoryPolicyTransport();
  assert.equal(transport.getPolicy(), null);
});

test("SharedMemoryPolicyTransport: isInitialized returns false before any push", () => {
  const transport = new SharedMemoryPolicyTransport();
  assert.equal(transport.isInitialized(), false);
});

test("SharedMemoryPolicyTransport: push increments version and stores policy", () => {
  const transport = new SharedMemoryPolicyTransport();
  const policy = createTestPolicy({ version: 42, maxPositionTon: 5 });

  transport.push(policy);

  assert.equal(transport.getVersion(), 1);
  assert.equal(transport.isInitialized(), true);
  const retrieved = transport.getPolicy();
  assert.ok(retrieved);
  assert.equal(retrieved.version, 42);
  assert.equal(retrieved.maxPositionTon, 5);
});

test("SharedMemoryPolicyTransport: multiple pushes increment version", () => {
  const transport = new SharedMemoryPolicyTransport();
  transport.push(createTestPolicy({ version: 1 }));
  transport.push(createTestPolicy({ version: 2 }));
  transport.push(createTestPolicy({ version: 3 }));

  assert.equal(transport.getVersion(), 3);
  const retrieved = transport.getPolicy();
  assert.ok(retrieved);
  assert.equal(retrieved.version, 3);
});

test("SharedMemoryPolicyTransport: subscribe receives current policy immediately", () => {
  const transport = new SharedMemoryPolicyTransport();
  const policy = createTestPolicy({ version: 99 });
  transport.push(policy);

  let receivedPolicy: TradingPolicy | null = null;
  let receivedVersion = -1;

  const unsubscribe = transport.subscribe((p, v) => {
    receivedPolicy = p;
    receivedVersion = v;
  });

  assert.ok(receivedPolicy);
  assert.equal(receivedVersion, 1);
  assert.equal(receivedPolicy!.version, 99);

  unsubscribe();
});

test("SharedMemoryPolicyTransport: subscribe receives future updates", () => {
  const transport = new SharedMemoryPolicyTransport();
  transport.push(createTestPolicy({ version: 1 }));

  let updateCount = 0;
  let lastVersion = -1;

  const unsubscribe = transport.subscribe((p, v) => {
    updateCount++;
    lastVersion = v;
  });

  assert.equal(updateCount, 1); // initial notification
  assert.equal(lastVersion, 1);

  transport.push(createTestPolicy({ version: 2 }));
  assert.equal(updateCount, 2);
  assert.equal(lastVersion, 2);

  transport.push(createTestPolicy({ version: 3 }));
  assert.equal(updateCount, 3);
  assert.equal(lastVersion, 3);

  unsubscribe();
});

test("SharedMemoryPolicyTransport: unsubscribe stops notifications", () => {
  const transport = new SharedMemoryPolicyTransport();
  transport.push(createTestPolicy({ version: 1 }));

  let count = 0;
  const unsubscribe = transport.subscribe(() => count++);

  transport.push(createTestPolicy({ version: 2 }));
  assert.equal(count, 2); // initial + 1 update

  unsubscribe();
  transport.push(createTestPolicy({ version: 3 }));
  assert.equal(count, 2); // no more notifications
});

test("SharedMemoryPolicyTransport: multiple subscribers all notified", () => {
  const transport = new SharedMemoryPolicyTransport();
  transport.push(createTestPolicy({ version: 1 }));

  let count1 = 0;
  let count2 = 0;

  transport.subscribe(() => count1++);
  transport.subscribe(() => count2++);

  transport.push(createTestPolicy({ version: 2 }));

  assert.equal(count1, 2); // initial + update
  assert.equal(count2, 2);
});

test("SharedMemoryPolicyTransport: subscriber errors don't break transport", () => {
  const transport = new SharedMemoryPolicyTransport();
  transport.push(createTestPolicy({ version: 1 }));

  transport.subscribe(() => {
    throw new Error("subscriber error");
  });

  // Should not throw
  transport.push(createTestPolicy({ version: 2 }));
  assert.equal(transport.getVersion(), 2);
});

test("SharedMemoryPolicyTransport: policy buffer is independent copy", () => {
  const transport = new SharedMemoryPolicyTransport();
  const policy = createTestPolicy({ version: 1 });
  transport.push(policy);

  // Mutate original policy object
  policy.maxPositionTon = 999;

  // Transport should have its own copy
  const retrieved = transport.getPolicy();
  assert.ok(retrieved);
  assert.equal(retrieved.maxPositionTon, 10); // original value
});

test("PolicyTransport interface: singleton instance exists", () => {
  assert.ok(policyTransport);
  assert.equal(typeof policyTransport.push, "function");
  assert.equal(typeof policyTransport.subscribe, "function");
  assert.equal(typeof policyTransport.getVersion, "function");
  assert.equal(typeof policyTransport.getPolicy, "function");
  assert.equal(typeof policyTransport.isInitialized, "function");
});

test("SharedMemoryPolicyTransport: works with complex policy including blocked tokens", () => {
  const transport = new SharedMemoryPolicyTransport();
  const policy = createTestPolicy({
    version: 5,
    blockedTokens: ["EQD...bad1", "EQD...bad2"],
    allowedDexes: ["stonfi"],
    maxSlippageBps: 1000,
  });

  transport.push(policy);

  const retrieved = transport.getPolicy();
  assert.ok(retrieved);
  assert.equal(retrieved.blockedTokens.length, 2);
  assert.equal(retrieved.allowedDexes.length, 1);
  assert.equal(retrieved.maxSlippageBps, 1000);
});