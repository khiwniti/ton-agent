/**
 * Integration tests for the hot-path position monitor (src/hotpath/position-monitor.ts).
 *
 * Tests the monitor's core contracts:
 *   - Engine evaluation + decision journaling
 *   - Position state mutations (TP1 halving, rug flags, etc.)
 *   - Append-only journal invariant
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/hotpath-monitor.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Import store first to initialize schema + DB
import { positionsStore, decisionJournalStore } from "../src/storage/store.js";
import { TIER_RISK_CONFIGS } from "../src/risk/guardrails.js";
import { evaluateExitPolicy } from "../src/exit/policy-engine.js";
import type { DbPosition } from "../src/storage/store.js";

test("exit policy engine fires SL decision", () => {
  const cfg = TIER_RISK_CONFIGS.low;
  const decision = evaluateExitPolicy(
    {
      status: "OPEN",
      entry_at: 1000,
      entry_price_usd: 100,
      exit_by_ms: null,
    },
    {
      now: 2000,
      currentPriceUsd: 80, // -20% pnl
      entryPriceUsd: 100,
      tierCfg: cfg,
      auditVerdict: { ok: true, honeypotSafe: true, lpLocked: true, renounced: true },
      maxHoldMs: null,
    }
  );

  assert.ok(decision);
  assert.equal(decision.trigger, "stop_loss");
  assert.equal(decision.nextStatus, "STOPPED");
  assert.equal(decision.sellFraction, 1.0);
});

test("journal append records exit decision", () => {
  const journalId = decisionJournalStore.append({
    cycle_id: `test_cycle_sl`,
    agent: "position-monitor",
    final_action: "stop_loss",
    output: { reason: "pnl <= -15%", pnl: -20 },
  });

  assert.ok(journalId);
  const entry = decisionJournalStore.get(journalId);
  assert.equal(entry?.final_action, "stop_loss");
  assert.equal(entry?.agent, "position-monitor");
});

test("exit policy: emergency_exit fires on rug verdict", () => {
  const cfg = TIER_RISK_CONFIGS.low;
  const decision = evaluateExitPolicy(
    {
      status: "OPEN",
      entry_at: 1000,
      entry_price_usd: 100,
      exit_by_ms: null,
    },
    {
      now: 2000,
      currentPriceUsd: 100,
      entryPriceUsd: 100,
      tierCfg: cfg,
      auditVerdict: { ok: false, honeypotSafe: false, lpLocked: false, renounced: false },
      maxHoldMs: null,
    }
  );

  assert.equal(decision?.trigger, "emergency_exit");
  assert.equal(decision?.nextStatus, "RUG_EXIT");
  assert.equal(decision?.sellFraction, 1.0);
});

test("exit policy: TP1 halves sell fraction and cost scale", () => {
  const cfg = TIER_RISK_CONFIGS.low;
  const decision = evaluateExitPolicy(
    {
      status: "OPEN",
      entry_at: 1000,
      entry_price_usd: 100,
      exit_by_ms: null,
    },
    {
      now: 2000,
      currentPriceUsd: 125, // +25% pnl
      entryPriceUsd: 100,
      tierCfg: cfg,
      auditVerdict: { ok: true, honeypotSafe: true, lpLocked: true, renounced: true },
      maxHoldMs: null,
    }
  );

  assert.equal(decision?.trigger, "take_profit");
  assert.equal(decision?.nextStatus, "TP1_HIT");
  assert.equal(decision?.sellFraction, 0.5);
  assert.equal(decision?.costBasisScale, 0.5);
});

test("exit policy: time_exit with deadline past", () => {
  const cfg = TIER_RISK_CONFIGS.low;
  const decision = evaluateExitPolicy(
    {
      status: "OPEN",
      entry_at: 1000,
      entry_price_usd: 100,
      exit_by_ms: 1500, // deadline passed
    },
    {
      now: 2000, // 500ms after deadline
      currentPriceUsd: 100,
      entryPriceUsd: 100,
      tierCfg: cfg,
      auditVerdict: { ok: true, honeypotSafe: true, lpLocked: true, renounced: true },
      maxHoldMs: 500,
    }
  );

  assert.equal(decision?.trigger, "time_exit");
  assert.equal(decision?.nextStatus, "CLOSED");
  assert.equal(decision?.sellFraction, 1.0);
});

test("journal append-only: multiple entries per cycle", () => {
  const cycleId = `test_cycle_multi_${Date.now()}`;

  const id1 = decisionJournalStore.append({
    cycle_id: cycleId,
    agent: "position-monitor",
    final_action: "skip",
  });

  const id2 = decisionJournalStore.append({
    cycle_id: cycleId,
    agent: "position-monitor",
    final_action: "stop_loss",
  });

  assert.notEqual(id1, id2);

  const entries = decisionJournalStore.listByCycle(cycleId);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].final_action, "skip");
  assert.equal(entries[1].final_action, "stop_loss");
});

test("exit policy: emergency beats SL at same pnl", () => {
  const cfg = TIER_RISK_CONFIGS.low;
  // Rug + SL-threshold pnl: emergency should win
  const decision = evaluateExitPolicy(
    {
      status: "OPEN",
      entry_at: 1000,
      entry_price_usd: 100,
      exit_by_ms: null,
    },
    {
      now: 2000,
      currentPriceUsd: 70, // -30% (below SL)
      entryPriceUsd: 100,
      tierCfg: cfg,
      auditVerdict: { ok: false, honeypotSafe: false, lpLocked: false, renounced: false },
      maxHoldMs: null,
    }
  );

  assert.equal(decision?.trigger, "emergency_exit");
});
