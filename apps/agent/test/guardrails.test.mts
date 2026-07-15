/**
 * Unit tests for the risk/guardrails module: circuit breaker and HIGH-tier promotion.
 *
 * These exercise the LIVE functions because their semantics revolve around
 * the SQLite `positions` and `daily_pnl_log` tables. We sandbox each run with
 * `process.env.DATA_DIR` pointing at a fresh tmp directory so the real store
 * never sees our test data.
 *
 * Prereq: `better-sqlite3` must be installed (the agent's runtime dep).
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx ts-node --transpile-only --test test/guardrails.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Sandbox the SQLite path BEFORE we import anything that touches the store.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ton-agent-test-"));
process.env.DATA_DIR = tmpRoot;

// Now safe to import — store.ts will create its own db here.
const { db, positionsStore, dailyPnlStore } = await import("../src/storage/store");
const { checkCircuitBreaker, isHighTierUnlocked, DAILY_LOSS_LIMIT_TON } =
  await import("../src/risk/guardrails");

// Helper: stamp a row into positions matching the schema.
function insertPosition(opts: {
  tier: "low" | "mid" | "high";
  status: string;
  pnlPct?: number;
  realizedPnlTon?: number;
}) {
  const id = `pos_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO positions (
       id, wallet_tier, jetton_master, entry_tx_hash,
       entry_price_ton, entry_at, amount_tokens, cost_basis_ton,
       status, pnl_pct, realized_pnl_ton
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.tier,
    "EQfake_master_" + id,
    "fake_tx_hash",
    1.0,
    now,
    "1000000000",
    1.0,
    opts.status,
    opts.pnlPct ?? 0,
    opts.realizedPnlTon ?? 0,
  );
  return id;
}

// Clean up our scratch DB between tests.
function wipeTables() {
  db.exec(`
    DELETE FROM positions;
    DELETE FROM daily_pnl_log;
    DELETE FROM tier_status;
  `);
}

// ─────────────────────────────────────────────────────────────────────
// 1. Circuit breaker semantics
// ─────────────────────────────────────────────────────────────────────
test("circuit breaker: empty log → ok", () => {
  wipeTables();
  assert.equal(checkCircuitBreaker(), true);
});

test("circuit breaker: today PnL just above negative threshold → ok", () => {
  wipeTables();
  // If the limit is 2.0, today pnl = -1.999 is fine.
  dailyPnlStore.addPnl(-(DAILY_LOSS_LIMIT_TON - 0.001));
  assert.equal(checkCircuitBreaker(), true);
});

test("circuit breaker: today PnL at -limit (≤ rule) trips the breaker", () => {
  wipeTables();
  dailyPnlStore.addPnl(-DAILY_LOSS_LIMIT_TON);
  assert.equal(checkCircuitBreaker(), false);
});

test("circuit breaker: today PnL worse than -limit trip", () => {
  wipeTables();
  dailyPnlStore.addPnl(-(DAILY_LOSS_LIMIT_TON + 1));
  assert.equal(checkCircuitBreaker(), false);
});

test("circuit breaker: aggregates multiple addPnl calls in same day", () => {
  wipeTables();
  dailyPnlStore.addPnl(-1.0);
  dailyPnlStore.addPnl(-1.5);
  // total = -2.5 ≤ -limit (2.0)  → trip
  assert.equal(checkCircuitBreaker(), false);
});

// ─────────────────────────────────────────────────────────────────────
// 2. HIGH tier promotion unlock criteria
// ─────────────────────────────────────────────────────────────────────
test("HIGH tier: locked when there are zero closed low/mid trades", () => {
  wipeTables();
  assert.equal(isHighTierUnlocked(), false);
});

test("HIGH tier: locked when count >= 5 but cumulative PnL <= 0", () => {
  wipeTables();
  for (let i = 0; i < 5; i++) {
    insertPosition({ tier: i % 2 ? "low" : "mid", status: "CLOSED", realizedPnlTon: -0.1 });
  }
  assert.equal(isHighTierUnlocked(), false);
});

test("HIGH tier: locked when count < 5 even with positive PnL", () => {
  wipeTables();
  for (let i = 0; i < 4; i++) {
    insertPosition({ tier: "low", status: "CLOSED", realizedPnlTon: 0.2 });
  }
  assert.equal(isHighTierUnlocked(), false);
});

test("HIGH tier: UNLOCKS when count >= 5 AND cumulative PnL > 0", () => {
  wipeTables();
  for (let i = 0; i < 5; i++) {
    insertPosition({ tier: i % 2 ? "low" : "mid", status: "CLOSED", realizedPnlTon: 0.1 });
  }
  assert.equal(isHighTierUnlocked(), true);
});

test("HIGH tier: counts both CLOSED and STOPPED statuses", () => {
  wipeTables();
  for (let i = 0; i < 3; i++) {
    insertPosition({ tier: "low", status: "CLOSED", realizedPnlTon: 0.2 });
  }
  for (let i = 0; i < 2; i++) {
    insertPosition({ tier: "mid", status: "STOPPED", realizedPnlTon: 0.2 });
  }
  assert.equal(isHighTierUnlocked(), true);
});

test("HIGH tier: does NOT count trades that are still OPEN", () => {
  wipeTables();
  // 5 OPEN positions should not satisfy the criterion
  for (let i = 0; i < 5; i++) {
    insertPosition({ tier: "low", status: "OPEN", realizedPnlTon: 1.0 });
  }
  assert.equal(isHighTierUnlocked(), false);
});

test("HIGH tier: HIGH-tier trades themselves are excluded from count", () => {
  wipeTables();
  // 5 wins — but all on the HIGH tier. Only low+mid count.
  for (let i = 0; i < 5; i++) {
    insertPosition({ tier: "high", status: "CLOSED", realizedPnlTon: 1.0 });
  }
  assert.equal(isHighTierUnlocked(), false);

  // Now add a single low-tier winner — the count goes from 0 → 1 with positive PnL, still locked.
  insertPosition({ tier: "low", status: "CLOSED", realizedPnlTon: 0.1 });
  assert.equal(isHighTierUnlocked(), false);
});
