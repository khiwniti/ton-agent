import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyManager } from "../src/core/policy-manager";
import { SharedMemoryPolicyTransport } from "../src/core/policy-transport";
import type { TradingPolicy, FastPathSignal } from "../src/core/policy-types";

function createTestPolicy(overrides: Partial<TradingPolicy> = {}): Omit<TradingPolicy, "version"> {
  return {
    maxPositionTon: 10,
    maxOpen: 5,
    allowedDexes: ["stonfi", "dedust"],
    blockedTokens: [],
    maxSlippageBps: 500,
    minConfidence: 0.8,
    ...overrides,
  };
}

function createTestSignal(overrides: Partial<FastPathSignal> = {}): FastPathSignal {
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

test("PolicyManager: getPolicy returns null before any update", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);
  assert.equal(manager.getPolicy(), null);
});

test("PolicyManager: isPolicyFresh returns false before any update", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);
  const signal = createTestSignal({ policyVersion: 1 });
  assert.equal(manager.isPolicyFresh(signal), false);
});

test("PolicyManager: updatePolicy pushes to transport and increments version", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);

  manager.updatePolicy(createTestPolicy({ maxPositionTon: 5 }));

  const policy = manager.getPolicy();
  assert.ok(policy);
  assert.equal(policy.version, 1);
  assert.equal(policy.maxPositionTon, 5);
  assert.equal(manager.getVersion(), 1);
  assert.equal(transport.getVersion(), 1);
});

test("PolicyManager: multiple updates increment version", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);

  manager.updatePolicy(createTestPolicy({ maxPositionTon: 1 }));
  manager.updatePolicy(createTestPolicy({ maxPositionTon: 2 }));
  manager.updatePolicy(createTestPolicy({ maxPositionTon: 3 }));

  assert.equal(manager.getVersion(), 3);
  assert.equal(transport.getVersion(), 3);
  const policy = manager.getPolicy();
  assert.ok(policy);
  assert.equal(policy.maxPositionTon, 3);
});

test("PolicyManager: isPolicyFresh returns true for matching version", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);

  manager.updatePolicy(createTestPolicy());
  const signal = createTestSignal({ policyVersion: 1 });

  assert.equal(manager.isPolicyFresh(signal), true);
});

test("PolicyManager: isPolicyFresh returns false for stale version", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);

  manager.updatePolicy(createTestPolicy()); // version 1
  manager.updatePolicy(createTestPolicy()); // version 2
  const signal = createTestSignal({ policyVersion: 1 });

  assert.equal(manager.isPolicyFresh(signal), false);
});

test("PolicyManager: isPolicyFresh returns false for future version", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);

  manager.updatePolicy(createTestPolicy()); // version 1
  const signal = createTestSignal({ policyVersion: 99 });

  assert.equal(manager.isPolicyFresh(signal), false);
});

test("PolicyManager: isInitialized reflects transport state", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);

  assert.equal(manager.isInitialized(), false);
  manager.updatePolicy(createTestPolicy());
  assert.equal(manager.isInitialized(), true);
});

test("PolicyManager: getTransport returns underlying transport", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);
  assert.equal(manager.getTransport(), transport);
});

test("PolicyManager: policy includes updatedAt timestamp", () => {
  const transport = new SharedMemoryPolicyTransport();
  const manager = new PolicyManager(transport);
  const before = Date.now();

  manager.updatePolicy(createTestPolicy());

  const policy = manager.getPolicy();
  assert.ok(policy);
  assert.ok(policy.updatedAt >= before);
  assert.ok(policy.updatedAt <= Date.now());
});

test("PolicyManager: singleton works with default transport", () => {
  // Reset singleton state by creating new transport
  const { policyManager } = require("../src/core/policy-manager");
  assert.ok(policyManager);
  assert.equal(typeof policyManager.updatePolicy, "function");
  assert.equal(typeof policyManager.getPolicy, "function");
  assert.equal(typeof policyManager.isPolicyFresh, "function");
});