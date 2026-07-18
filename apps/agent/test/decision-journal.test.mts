/**
 * Append-only decision journal store tests.
 *
 * Run via scripts/run-tests.sh (isolated DATA_DIR per file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ton-agent-jrn-"));
process.env.DATA_DIR = tmpRoot;

const { decisionJournalStore } = await import("../src/storage/store");

test("append creates rows and never mutates prior entries", () => {
  const id1 = decisionJournalStore.append({
    cycle_id: "c1",
    agent: "safetycaps",
    final_action: "cap_ok",
    input_hash: "abc",
    cap_check_result: { ok: true, ticket_hash: "abc" },
  });
  const id2 = decisionJournalStore.append({
    cycle_id: "c1",
    agent: "coordinator",
    final_action: "execute_submit",
    input_hash: "abc",
  });
  assert.notEqual(id1, id2);
  const rows = decisionJournalStore.listByCycle("c1");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].final_action, "cap_ok");
  assert.equal(rows[1].final_action, "execute_submit");
  assert.ok(rows[0].cap_check_result?.includes("ticket_hash"));
});

test("get by id and count", () => {
  const before = decisionJournalStore.count();
  const id = decisionJournalStore.append({
    cycle_id: "c2",
    agent: "test",
    final_action: "unit",
  });
  const row = decisionJournalStore.get(id);
  assert.ok(row);
  assert.equal(row!.cycle_id, "c2");
  assert.equal(decisionJournalStore.count(), before + 1);
});

test("append does not update existing id (insert-only)", () => {
  const id = decisionJournalStore.append({
    id: "fixed_jrn_id_1",
    cycle_id: "c3",
    agent: "a",
    final_action: "first",
  });
  assert.equal(id, "fixed_jrn_id_1");
  assert.throws(() => {
    decisionJournalStore.append({
      id: "fixed_jrn_id_1",
      cycle_id: "c3",
      agent: "a",
      final_action: "second",
    });
  });
  const row = decisionJournalStore.get("fixed_jrn_id_1");
  assert.equal(row?.final_action, "first");
});
