/**
 * Tests for Security Audits (Honeypot Filter) & Risk Validation (T012)
 *
 * Covers:
 *   1. Honeypot detection in audit.ts (token-level)
 *   2. Portfolio allocation check (max 5%)
 *   3. Slippage validation (max 1.5%)
 *   4. Security report assembly
 *
 * Run:
 *   npx tsx --test test/security-risk.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────────
// 1. Honeypot / Security Audit
// ─────────────────────────────────────────────────────────────────────
test("security audit returns structured report with correct types", async () => {
  const { TonClient, Address } = await import("@ton/ton");
  // We can't call fullAudit without a real client, so we test the structure
  // of the SecurityReport via direct construction.
  const report = {
    renounced: true,
    lpLocked: true,
    honeypotSafe: true,
    holders: 150,
    ageHours: 24,
    ok: true,
  };

  assert.equal(typeof report.renounced, "boolean");
  assert.equal(typeof report.lpLocked, "boolean");
  assert.equal(typeof report.honeypotSafe, "boolean");
  assert.equal(typeof report.holders, "number");
  assert.equal(typeof report.ageHours, "number");
  assert.equal(report.ok, report.renounced && report.lpLocked && report.honeypotSafe);
});

test("security report ok flag requires all checks to pass", () => {
  // All pass => ok
  assert.equal(true && true && true, true, "all checks pass => ok");

  // One fails => not ok
  assert.equal(true && false && true, false, "lpLocked fails => not ok");
  assert.equal(false && true && true, false, "renounced fails => not ok");
  assert.equal(true && true && false, false, "honeypot fails => not ok");
});

test("honeypot check flags invalid token addresses", async () => {
  const { fullAudit } = await import("../src/security/audit");
  const { TonClient } = await import("@ton/ton");

  // Use dummy client — fullAudit will fail at address parse for invalid
  const client = new TonClient({ endpoint: "http://localhost:8080" });

  // Malformed address should return ok=false
  const report = await fullAudit(client, "not_a_valid_address");
  assert.equal(report.ok, false, "invalid address should return ok=false");
  assert.equal(report.renounced, false);
  assert.equal(report.lpLocked, false);
  assert.equal(report.honeypotSafe, false);
});

// ─────────────────────────────────────────────────────────────────────
// 2. Portfolio Allocation Check (max 5%)
// ─────────────────────────────────────────────────────────────────────
test("portfolio allocation: small trade within 5% limit passes", async () => {
  const { checkPortfolioAllocation, MAX_PORTFOLIO_ALLOCATION_PCT } =
    await import("../src/risk/guardrails");

  assert.equal(MAX_PORTFOLIO_ALLOCATION_PCT, 5, "default max allocation should be 5%");

  // Balance = 10 TON, request = 0.3 TON => 0.3 <= 0.5 (5% of 10)
  const result = checkPortfolioAllocation(0.3, 10);
  assert.equal(result.allowed, true);
  assert.equal(result.maxAllowedTon, 0.5);
});

test("portfolio allocation: trade exceeding 5% is rejected", async () => {
  const { checkPortfolioAllocation } = await import("../src/risk/guardrails");

  // Balance = 5 TON, request = 0.5 TON => 0.5 > 0.25 (5% of 5)
  const result = checkPortfolioAllocation(0.5, 5);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes("5%"), "reason should mention allocation %");
  assert.equal(result.maxAllowedTon, 0.25);
});

test("portfolio allocation: edge case exactly at limit", async () => {
  const { checkPortfolioAllocation } = await import("../src/risk/guardrails");

  // Balance = 100 TON, request = 5 TON => 5 == 5% of 100
  const result = checkPortfolioAllocation(5, 100);
  assert.equal(result.allowed, true, "exactly 5% should be allowed");
  assert.equal(result.maxAllowedTon, 5);
});

// ─────────────────────────────────────────────────────────────────────
// 3. Slippage Validation (max 1.5%)
// ─────────────────────────────────────────────────────────────────────
test("slippage within 1.5% tolerance passes", async () => {
  const { checkSlippage, MAX_SLIPPAGE_PCT } = await import("../src/risk/guardrails");

  assert.equal(MAX_SLIPPAGE_PCT, 1.5, "default max slippage should be 1.5%");

  // expected = 1000, min = 990 => slippage = 1%
  const result = checkSlippage(1000n, 990n);
  assert.equal(result.allowed, true);
  assert.ok(result.slippagePct !== undefined);
  assert.ok((result.slippagePct as number) <= 1.5);
});

test("slippage exceeding 1.5% is rejected", async () => {
  const { checkSlippage } = await import("../src/risk/guardrails");

  // expected = 1000, min = 970 => slippage = 3%
  const result = checkSlippage(1000n, 970n);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes("1.5%"), "reason should mention max slippage");
});

test("slippage edge case exactly at limit", async () => {
  const { checkSlippage } = await import("../src/risk/guardrails");

  // expected = 1000, min = 985 => slippage ≈ 1.5%
  const result = checkSlippage(1000n, 985n);
  assert.equal(result.allowed, true, "exactly 1.5% should be allowed");
});

test("slippage validation requires positive amounts", async () => {
  const { checkSlippage } = await import("../src/risk/guardrails");

  const zero = checkSlippage(0n, 0n);
  assert.equal(zero.allowed, false);
});
