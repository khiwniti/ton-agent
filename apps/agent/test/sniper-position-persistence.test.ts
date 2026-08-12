/**
 * Regression tests for the sniper_positions upsert.
 *
 * Context (2026-08-11): every CLOSED sniper position in production had NULL
 * `current_price_ton` and `pnl_pct`, while both OPEN positions had them
 * populated. Cause: `sellToken()` omits those two fields from its upsert, so
 * `positionRow()` defaults them to NULL, and the store's ON CONFLICT clause
 * wrote that NULL over the last repriced values using a bare `excluded.*`.
 * Every other field in the same clause used COALESCE and was sticky.
 *
 * Consequence: the exit price and PnL of every closed sniper trade were
 * silently discarded, making exit-quality analysis impossible. These tests pin
 * the sticky behaviour so the two lines cannot silently revert.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The store resolves its DB path from DATA_DIR at module load, so this must be
// set before store is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sniper-store-test-"));
process.env.DATA_DIR = tmpDir;

import { sniperPositionStore } from "../src/storage/store.js";

/** A full row, mirroring engine.ts's positionRow() defaults. */
function row(overrides: Record<string, unknown> & { id: string }) {
  return {
    asset: "asset-" + overrides.id,
    master: "master-" + overrides.id,
    symbol: "TEST",
    status: "OPEN",
    entry_tx_hash: null,
    entry_at: 1_700_000_000_000,
    spent_ton_nano: "100000000",
    amount_tokens_nano: "1000000",
    entry_price_ton: 0.0001,
    peak_price_ton: 0.0001,
    current_price_ton: null,
    pnl_pct: null,
    tp1_hit: 0,
    tp1_tx_hash: null,
    close_tx_hash: null,
    close_reason: null,
    close_at: null,
    migrated: 0,
    curve_pct_at_entry: null,
    notes: null,
    max_hold_ms: null,
    exit_by_ms: null,
    technique: "sniper",
    ...overrides,
  } as never;
}

test("close path preserves the last repriced current_price_ton and pnl_pct", () => {
  const id = "pos-close-preserves";

  // 1. Open, as buyToken() does: price and pnl are set explicitly.
  sniperPositionStore.upsert(row({ id, current_price_ton: 0.0001, pnl_pct: 0 }));

  // 2. Monitor tick reprices downward, as monitorTick() does.
  sniperPositionStore.upsert(row({ id, current_price_ton: 0.00002, pnl_pct: -80 }));
  assert.equal(sniperPositionStore.get(id)?.pnl_pct, -80);

  // 3. Close, as sellToken() does: BOTH fields omitted -> NULL in the row.
  //    Before the fix this nulled the stored values; now they must survive.
  sniperPositionStore.upsert(
    row({
      id,
      status: "CLOSED",
      close_reason: "stop_loss: pnl -80.0% <= -35.0%",
      close_at: 1_700_000_100_000,
    }),
  );

  const closed = sniperPositionStore.get(id);
  assert.equal(closed?.status, "CLOSED", "position should be CLOSED");
  assert.equal(
    closed?.current_price_ton,
    0.00002,
    "exit price must survive the close upsert, not be nulled",
  );
  assert.equal(
    closed?.pnl_pct,
    -80,
    "realized pnl must survive the close upsert, not be nulled",
  );
});

test("a real reprice still overwrites a previously stored value", () => {
  // COALESCE must not make the column write-once: non-NULL always wins.
  const id = "pos-reprice-wins";
  sniperPositionStore.upsert(row({ id, current_price_ton: 0.0001, pnl_pct: 0 }));
  sniperPositionStore.upsert(row({ id, current_price_ton: 0.0005, pnl_pct: 400 }));

  const p = sniperPositionStore.get(id);
  assert.equal(p?.current_price_ton, 0.0005, "fresh price must overwrite");
  assert.equal(p?.pnl_pct, 400, "fresh pnl must overwrite");
});

test("pnl_pct of exactly 0 is stored, not treated as absent", () => {
  // Guards a COALESCE-adjacent trap: 0 is falsy in JS but NOT NULL in SQL, so
  // a breakeven position must persist 0 rather than fall through to the old
  // value. Regression risk if anyone rewrites this with `||` instead.
  const id = "pos-zero-pnl";
  sniperPositionStore.upsert(row({ id, current_price_ton: 0.0009, pnl_pct: 50 }));
  sniperPositionStore.upsert(row({ id, current_price_ton: 0.0001, pnl_pct: 0 }));

  assert.equal(sniperPositionStore.get(id)?.pnl_pct, 0, "0 must persist, not fall back to 50");
});

test("peak_price_ton ratchets independently of the close path", () => {
  // Documents the behaviour F3 was misread from: peak is carried through the
  // close explicitly by sellToken(), so a position that only ever fell keeps
  // peak == entry, and one that ran keeps its high-water mark after closing.
  const id = "pos-peak-carry";
  sniperPositionStore.upsert(
    row({ id, entry_price_ton: 0.0001, peak_price_ton: 0.0001, current_price_ton: 0.0001, pnl_pct: 0 }),
  );
  // Ran to +142%, mirroring CATBLAST.
  sniperPositionStore.upsert(
    row({ id, entry_price_ton: 0.0001, peak_price_ton: 0.000242, current_price_ton: 0.000242, pnl_pct: 142 }),
  );
  // Trend-flip close carries the peak forward.
  sniperPositionStore.upsert(
    row({
      id,
      status: "CLOSED",
      entry_price_ton: 0.0001,
      peak_price_ton: 0.000242,
      close_reason: "trend_exit: trend flipped to downtrend",
      close_at: 1_700_000_100_000,
    }),
  );

  const p = sniperPositionStore.get(id);
  assert.equal(p?.peak_price_ton, 0.000242, "peak must survive close");
  const peakGainPct = (p!.peak_price_ton / p!.entry_price_ton - 1) * 100;
  assert.ok(peakGainPct > 140, `peak gain should be recoverable (got ${peakGainPct})`);
});

test("handoffMasters() excludes CLOSED handoff masters from the scan feed", () => {
  // Regression (2026-08-12): the scan buy path upserts on id = x1000-0:<master>,
  // so a CLOSED manual_handoff row got silently re-opened and re-bought —
  // the engine took over CROAK positions the operator was trading by hand.
  // handoffMasters() is the store side of the guard that makes handoff rows
  // permanently off-limits to the scan, and only for the reason that means
  // "operator owns this coin".
  const id = "pos-handoff-guard";
  const master = "master-" + id;

  // An operator handoff closes the row.
  sniperPositionStore.upsert(row({ id, master, status: "CLOSED", close_reason: "manual_handoff", close_at: 1_700_000_100_000 }));
  assert.equal(sniperPositionStore.handoffMasters().has(master), true);

  // A loss/stop close must NOT put the coin in the guard set — those coins
  // remain tradeable once a fresh setup appears.
  const lossId = "pos-loss-guard";
  const lossMaster = "master-" + lossId;
  sniperPositionStore.upsert(row({ id: lossId, master: lossMaster, status: "CLOSED", close_reason: "stop_loss: pnl -80.0% <= -35.0%" }));
  assert.equal(sniperPositionStore.handoffMasters().has(lossMaster), false);

  // An OPEN row (already re-resurrected in prod) still guards: even if a
  // handoff row is stuck OPEN, the engine must not double-dip on it.
  const stuckId = "pos-stuck-open";
  const stuckMaster = "master-" + stuckId;
  sniperPositionStore.upsert(row({ id: stuckId, master: stuckMaster, status: "OPEN", close_reason: "manual_handoff" }));
  assert.equal(sniperPositionStore.handoffMasters().has(stuckMaster), true);
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
