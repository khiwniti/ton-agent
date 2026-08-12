/**
 * Audit gate tests (src/security/audit.ts computeAuditOk).
 *
 * The radar passes a resolved DEX pool address into fullAudit; the LP-lock
 * and honeypot checks then run and `ok` is computed from the three hard
 * dimensions — with `renounced` gated by AUDIT_REQUIRE_RENOUNCE (default
 * true). These tests pin the pass/fail decision without network I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAuditOk } from "../src/security/audit";

// The user-visible contract: a renounced token with a real (locked) pool and
// no honeypot passes the radar audit under the default (strict) config.
test("renounced + pooled candidate passes the radar audit", () => {
  assert.equal(computeAuditOk(true, true, true, true), true);
});

test("renounce hard-gate still blocks non-renounced candidates when required", () => {
  assert.equal(computeAuditOk(false, true, true, true), false);
});

test("AUDIT_REQUIRE_RENOUNCE=false admits a non-renounced pooled candidate", () => {
  // Renounce becomes advisory; LP-lock + honeypot remain the hard gates.
  assert.equal(computeAuditOk(false, true, true, false), true);
});

test("missing pool (lpLocked=false) fails even for a renounced token", () => {
  // With no pool address the LP-lock check is skipped and fails closed —
  // this was the radar's pre-Fix-A behavior ("no pool provided").
  assert.equal(computeAuditOk(true, false, true, true), false);
  assert.equal(computeAuditOk(true, false, true, false), false);
});

test("honeypot failure fails the audit regardless of renounce setting", () => {
  assert.equal(computeAuditOk(true, true, false, true), false);
  assert.equal(computeAuditOk(true, true, false, false), false);
});
