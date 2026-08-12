# Autonomous Execution — Remove HITL/Telegram Approval Gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the human-in-the-loop approval gate entirely so any ticket passing deterministic SafetyCaps executes immediately, including `caution` risk verdicts.

**Architecture:** HITL is currently woven through three layers: the LangGraph topology (`hitl` node + conditional edges), the authorization boundary (`hitl_required`/`hitl_status` on `CapCheckResult` and `AuthorizedExecution`, enforced by `verifyCapBinding`/`verifyAuthorization`), and the persistence/observability layer (`decision_journal.hitl_status` column, MCP tool descriptions). We excise all three, bump `CAPS_VERSION` so no pre-change authorization can replay under looser semantics, and delete the now-unreachable `telegram/` transport modules. `reject` still hard-fails; every other deterministic gate is untouched.

**Tech Stack:** TypeScript (strict), `@langchain/langgraph` `StateGraph`/`Annotation.Root`, `better-sqlite3`, `node:test` + `node:assert/strict`, `tsx`.

## Global Constraints

- **Node 20 is the CI target.** Repo-local Node may be v26; do not use APIs newer than Node 20. Tests run via `scripts/run-tests.sh` (one process per file), not `node --test` directly.
- **`CAPS_VERSION` must be bumped to `"safetycaps-v2"`** in this change. `verifyCapBinding` and `verifyAuthorization` both compare against it; a stale v1 authorization must be rejected rather than silently honored under the new looser rules.
- **`verifyAuthorization` in `nodes/execution.ts:49` hardcodes the literal string `"safetycaps-v1"`** rather than importing `CAPS_VERSION`. It must be changed to import the constant, or the version bump silently breaks all graph execution.
- **Do not weaken any non-HITL gate.** `observe_only`, `kill_switch_active`, `circuit_breaker_ok`, `TIER_CAP`, `BANKROLL`, `MAX_OPEN`, `ALLOCATION`, `SLIPPAGE`, `DEPTH`, `POOL_TVL_REQUIRED`, `AI_SCORE`, and `RISK_REJECT` all keep their exact current semantics.
- **`risk.verdict === "reject"` must still hard-fail** with failure code `RISK_REJECT`. Only `caution` behavior changes.
- **SQLite schema uses `CREATE TABLE IF NOT EXISTS`** (`storage/store.ts:139`). Existing deployed DBs already have the `hitl_status` column; SQLite cannot easily drop columns. The column stays in the physical schema on existing DBs — we only stop *writing* it. New DBs get the new schema. This is intentional and must not be "fixed" with a destructive migration.
- **Commit after each task.** Never bundle tasks into one commit.

## File Structure

**Delete outright:**
- `apps/agent/src/orchestration/nodes/hitl.ts` — graph interrupt node (untracked, never committed)
- `apps/agent/src/telegram/approvals.ts` — in-memory approval store
- `apps/agent/src/telegram/bot.ts` — stub transport (logs only, no real Telegram)
- `apps/agent/src/telegram/commands.ts` — command/callback parsers
- `apps/agent/src/telegram/index.ts` — barrel
- `apps/agent/test/telegram-approvals.test.ts` — tests for the above (4 tests)

**Modify:**
- `apps/agent/src/safetycaps/types.ts` — drop `HitlStatus`; strip `hitl_required`/`hitl_status` from `CapCheckResult`; drop `hitl` from `AuthorizedExecution`; drop `auto_approve_ceiling_pct` from `CapCheckContext`
- `apps/agent/src/safetycaps/check.ts` — bump `CAPS_VERSION`; remove ceiling/caution HITL computation; remove `withHitlApproved`; simplify `verifyCapBinding`
- `apps/agent/src/safetycaps/index.ts` — drop `AUTO_APPROVE_CEILING_PCT` + `autoApproveCeilingPct`; drop `withHitlApproved`/`HitlStatus` re-exports
- `apps/agent/src/orchestration/state.ts` — drop `hitl_status` from `GramTradeState` + `emptyGramState`
- `apps/agent/src/orchestration/graph.ts` — drop `hitl` node, its edges, its routing keys, and the annotation field
- `apps/agent/src/orchestration/index.ts` — drop `hitl` re-exports
- `apps/agent/src/orchestration/nodes/safety-caps.ts` — drop `hitl_status` from returns
- `apps/agent/src/orchestration/nodes/risk-gate.ts` — drop `hitl_status` from return; fix stale comment
- `apps/agent/src/orchestration/nodes/execution.ts` — import `CAPS_VERSION`; drop HITL check from `verifyAuthorization`; drop `hitl` param from `makeAuthorizedExecution`
- `apps/agent/src/core/coordinator.ts` — remove two HITL denial branches (`:492`, `:1020`) and `hitl_status` journal fields
- `apps/agent/src/storage/store.ts` — drop `hitl_status` from new-DB schema, `DbJournalEntry`, `JournalAppendInput`, INSERT
- `apps/agent/src/mcp/tools.ts` — drop `hitl_required` from response; fix tool description
- `apps/agent/src/mcp/server.ts` — fix `riskVerdict` description
- `apps/agent/src/config.ts` — drop `hitlMinAiScore`; make `brainEnabled` independent of `HITL_DISABLE`
- `apps/agent/src/index.ts` — drop the `HITL_DISABLE` boot branch
- `apps/agent/src/ai/brain.ts` — fix prompt text referencing `HITL_DISABLE`
- `apps/agent/test/safetycaps.test.ts` — rewrite 4 HITL tests as autonomous-behavior tests
- `apps/agent/test/orchestration-graph.test.ts` — rewrite `caution` test; drop `auto_approve_ceiling_pct` from `ctx()`
- `apps/agent/test/exit-journal.test.mts` — drop `hitl_status` from the optional-fields test

**Deliberately NOT touched:**
- `apps/agent/src/line.ts` — LINE webhook; only a doc comment mentions HITL. Out of scope.
- `apps/agent/src/skills/wallet-bootstrap/index.ts` — Telegram mention is unrelated (wallet setup notifications).
- `storage/store.ts` first-trade gate (`isFirstTradeExecuted`/`markFirstTradeExecuted`/`resetFirstTradeGate`) — already dead (`index.ts:87` call is commented out) but harmless and referenced by ops docs. Leave it.

---

### Task 1: Make `caution` autonomous in the SafetyCaps core

This is the behavioral heart of the change. `check.ts:219-224` currently computes `hitl_required = ok && (caution || overCeiling)`. Note `overCeiling` is already dead in practice: `AUTO_APPROVE_CEILING_PCT` defaults to `100`, so the test is `amount > balance * 1.0`, which the `BANKROLL` gate (`amount + gas ≤ balance`) already precludes. So `caution` is the only live trigger.

**Files:**
- Modify: `apps/agent/src/safetycaps/check.ts`
- Modify: `apps/agent/src/safetycaps/types.ts`
- Modify: `apps/agent/src/safetycaps/index.ts`
- Test: `apps/agent/test/safetycaps.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `CAPS_VERSION = "safetycaps-v2"` (string const)
  - `CapCheckResult` with fields `{ ok, ticket_hash, cycle_id, caps_version, failures, amount_ton, tier, checked_at }` — **no** `hitl_required`, **no** `hitl_status`
  - `CapCheckContext` — **no** `auto_approve_ceiling_pct`
  - `verifyCapBinding(ticket: TradeTicket, cap: CapCheckResult): { allowed: boolean; reason?: string }` — **two params only**, third HITL param removed
  - `HitlStatus` type no longer exported from `./types` or `./index`
  - `withHitlApproved` no longer exists
  - `AuthorizedExecution` = `{ ticket, cap, idempotency_key }` — **no** `hitl`
  - `BuildCapContextInput` — **no** `autoApproveCeilingPct`
  - `AUTO_APPROVE_CEILING_PCT` no longer exported

- [ ] **Step 1: Write the failing tests**

Replace the four HITL tests in `apps/agent/test/safetycaps.test.ts`. Delete the existing tests named exactly:
- `"happy path: small buy with pass verdict is ok and not HITL"`
- `"caution forces HITL even when otherwise ok"`
- `"auto-approve ceiling forces HITL when size exceeds % of balance"`
- `"verifyCapBinding requires HITL approved when hitl_required"`

Also remove `withHitlApproved` from the import block at the top of the file (line 19).

Add these in their place:

```ts
test("happy path: small buy with pass verdict is ok", () => {
  const r = checkTicket(buyTicket({ risk: { score: 90, verdict: "pass" } }), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 0);
  assert.equal(r.caps_version, "safetycaps-v2");
});

test("caution verdict executes autonomously — no approval gate", () => {
  const r = checkTicket(
    buyTicket({ risk: { score: 55, verdict: "caution" } }),
    ctx(),
  );
  assert.equal(r.ok, true, "caution must not block");
  assert.equal(r.failures.length, 0);
  // The old build exposed hitl_required/hitl_status here. They must be gone.
  assert.equal("hitl_required" in r, false);
  assert.equal("hitl_status" in r, false);
});

test("reject verdict still hard-fails", () => {
  const r = checkTicket(
    buyTicket({ risk: { score: 5, verdict: "reject" } }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === "RISK_REJECT"));
});

test("large caution buy still bounded by tier cap, not by approval", () => {
  // Previously this would have been routed to HITL. Now it must be REJECTED
  // outright by TIER_CAP — proving the deterministic gates carry the load.
  const r = checkTicket(
    buyTicket({ amount_ton: 999, risk: { score: 55, verdict: "caution" } }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === "TIER_CAP"));
});

test("verifyCapBinding allows a bound cap with no approval step", () => {
  const ticket = buyTicket({ risk: { score: 40, verdict: "caution" } });
  const cap = checkTicket(ticket, ctx());
  assert.equal(cap.ok, true);
  assert.equal(verifyCapBinding(ticket, cap).allowed, true);
});

test("verifyCapBinding rejects a stale v1 authorization", () => {
  const ticket = buyTicket({ risk: { score: 90, verdict: "pass" } });
  const cap = checkTicket(ticket, ctx());
  const stale = { ...cap, caps_version: "safetycaps-v1" };
  const res = verifyCapBinding(ticket, stale);
  assert.equal(res.allowed, false);
  assert.ok(res.reason?.includes("caps_version"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent && DATA_DIR="$(mktemp -d)" WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/safetycaps.test.ts`

Expected: FAIL. `caps_version` assertions fail (still `safetycaps-v1`), `"hitl_required" in r` returns `true`, and `withHitlApproved` import is now unresolved.

- [ ] **Step 3: Strip HITL from the types**

In `apps/agent/src/safetycaps/types.ts`:

Delete the entire `HitlStatus` type declaration:
```ts
export type HitlStatus =
  | "not_required"
  | "pending"
  | "approved"
  | "denied"
  | "timeout";
```

In `interface CapCheckResult`, delete these three lines:
```ts
  /** When true, Telegram (or other HITL) must approve before execute. */
  hitl_required: boolean;
  hitl_status: HitlStatus;
```

In `interface AuthorizedExecution`, delete:
```ts
  hitl: HitlStatus;
```

In `interface CapCheckContext`, delete:
```ts
  /** % of sub-wallet balance that may auto-execute without HITL. */
  auto_approve_ceiling_pct: number;
```

Update the `AuthorizedExecution` doc comment to read:
```ts
/**
 * Fully authorized execution envelope — only path that should reach the signer.
 * Authorization is purely deterministic: a bound, ok CapCheckResult is sufficient.
 */
```

- [ ] **Step 4: Update the check logic**

In `apps/agent/src/safetycaps/check.ts`:

Bump the version constant:
```ts
/** Bump when check semantics change so old authorizations cannot be reused. */
export const CAPS_VERSION = "safetycaps-v2";
```

In the **sell** early-return block, delete these two lines:
```ts
      hitl_required: false,
      hitl_status: "not_required",
```

Change the risk-verdict comment from `// Risk verdict — reject never proceeds; caution forces HITL` to:
```ts
  // Risk verdict — reject hard-fails. caution is advisory only and executes.
```

Replace the whole tail of `checkTicket` — from `const ok = failures.length === 0;` through the final `return` — with:

```ts
  const ok = failures.length === 0;

  return {
    ...base,
    ok,
    failures,
  };
```

(This deletes the `ceilingTon` / `overCeiling` / `caution` / `hitl_required` computation entirely.)

Change `verifyCapBinding` to drop the third parameter and the HITL block:

```ts
export function verifyCapBinding(
  ticket: TradeTicket,
  cap: CapCheckResult,
): { allowed: boolean; reason?: string } {
  if (!cap.ok) {
    return { allowed: false, reason: "cap check not ok" };
  }
  if (cap.caps_version !== CAPS_VERSION) {
    return { allowed: false, reason: `caps_version mismatch: ${cap.caps_version}` };
  }
  const expected = hashTradeTicket(ticket);
  if (cap.ticket_hash !== expected) {
    return {
      allowed: false,
      reason: `ticket_hash mismatch (cap=${cap.ticket_hash} ticket=${expected})`,
    };
  }
  if (cap.cycle_id !== ticket.cycle_id) {
    return { allowed: false, reason: "cycle_id mismatch" };
  }
  return { allowed: true };
}
```

Delete the entire `withHitlApproved` function at the end of the file.

- [ ] **Step 5: Update the façade**

In `apps/agent/src/safetycaps/index.ts`:

Change the check re-export line to drop `withHitlApproved`:
```ts
export { CAPS_VERSION, checkTicket, hashTradeTicket, verifyCapBinding } from "./check";
```

In the `export type { ... }` block, delete the `HitlStatus,` line.

Delete the `AUTO_APPROVE_CEILING_PCT` declaration:
```ts
/** Auto-approve ceiling as % of sub-wallet balance. Default 100 = HITL deferred to Phase 3 sizing policy. */
export const AUTO_APPROVE_CEILING_PCT = parseFloat(
  process.env.AUTO_APPROVE_CEILING_PCT || "100",
);
```

In `interface BuildCapContextInput`, delete `autoApproveCeilingPct?: number;`.

In `buildCapContext`'s returned object, delete:
```ts
    auto_approve_ceiling_pct:
      input.autoApproveCeilingPct ?? AUTO_APPROVE_CEILING_PCT,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/agent && DATA_DIR="$(mktemp -d)" WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/safetycaps.test.ts`

Expected: PASS, all tests in the file.

Note: `npx tsc -p apps/agent/tsconfig.json --noEmit` will still report errors in `coordinator.ts`, `execution.ts`, `graph.ts`, etc. — those are fixed in Tasks 2–5. That is expected at this checkpoint.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/safetycaps/ apps/agent/test/safetycaps.test.ts
git commit -m "feat(safetycaps)!: caution executes autonomously; drop HITL from auth boundary

Removes hitl_required/hitl_status from CapCheckResult and the approval
branch from verifyCapBinding. caution is now advisory only; reject still
hard-fails. Bumps CAPS_VERSION to safetycaps-v2 so pre-change
authorizations cannot replay under the looser semantics.

Also drops auto_approve_ceiling_pct, which was dead: it defaulted to 100%
so the ceiling test was unreachable behind the BANKROLL gate."
```

---

### Task 2: Remove the HITL node and edges from the graph

**Files:**
- Delete: `apps/agent/src/orchestration/nodes/hitl.ts`
- Modify: `apps/agent/src/orchestration/graph.ts`
- Modify: `apps/agent/src/orchestration/state.ts`
- Modify: `apps/agent/src/orchestration/index.ts`
- Modify: `apps/agent/src/orchestration/nodes/safety-caps.ts`
- Modify: `apps/agent/src/orchestration/nodes/risk-gate.ts`
- Test: `apps/agent/test/orchestration-graph.test.ts`

**Interfaces:**
- Consumes: `CapCheckResult` without `hitl_*` and `CapCheckContext` without `auto_approve_ceiling_pct` (Task 1).
- Produces:
  - `GramTradeState` — **no** `hitl_status` field
  - `emptyGramState(partial)` — no longer sets `hitl_status`
  - Graph topology: `safety_caps` routes only to `execution` or `END`; no `hitl` node exists
  - `hitlNode`, `resolveHitl`, `expireStaleHitl`, `clearAllHitl`, `HitlInput`, `HitlOutput` no longer exist

- [ ] **Step 1: Write the failing test**

In `apps/agent/test/orchestration-graph.test.ts`, delete `auto_approve_ceiling_pct: 100,` from the `ctx()` helper.

Replace the test named exactly `"caution path is ok but HITL pending"` with:

```ts
test("caution path greenlights autonomously — no pending approval", async () => {
  clearAuthorizationRegistry();
  const state = emptyGramState({
    cycle_id: "c_caution",
    tier: "low",
    risk_assessment: { score: 55, verdict: "caution" },
    proposed_ticket: {
      cycle_id: "c_caution",
      tier: "low",
      side: "buy",
      jetton_master: jetton,
      amount_ton: 0.5,
    },
  });
  const out = await runRiskPipeline(state, ctx());
  assert.equal(out.discarded, false);
  assert.equal(out.cap_check_result?.ok, true);
  assert.equal("hitl_status" in out, false, "state must not carry hitl_status");
  assert.equal(
    "hitl_required" in (out.cap_check_result ?? {}),
    false,
    "cap must not carry hitl_required",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && DATA_DIR="$(mktemp -d)" WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/orchestration-graph.test.ts`

Expected: FAIL — `"hitl_status" in out` is still `true` because `emptyGramState` sets it.

- [ ] **Step 3: Delete the HITL node file**

```bash
git rm --cached apps/agent/src/orchestration/nodes/hitl.ts 2>/dev/null || true
rm -f apps/agent/src/orchestration/nodes/hitl.ts
```

(The file is untracked, so `git rm --cached` is a no-op guarded by `|| true`.)

- [ ] **Step 4: Update state.ts**

In `apps/agent/src/orchestration/state.ts`:

Change the type import block to drop `HitlStatus`:
```ts
import type {
  CapCheckResult,
  RiskAssessment,
  Tier,
  TradeTicket,
} from "../safetycaps";

export type { CapCheckResult, RiskAssessment, Tier, TradeTicket };
```

In `interface GramTradeState`, delete `hitl_status: HitlStatus;` and change the `seed_jetton_master` comment (it references Telegram):
```ts
  /** Optional seed from the scheduler. */
  seed_jetton_master?: string;
```

In `emptyGramState`, delete `hitl_status: "not_required",`.

- [ ] **Step 5: Update the safety-caps and risk-gate nodes**

In `apps/agent/src/orchestration/nodes/safety-caps.ts`, replace the two return blocks at the end of `safetyCapsNode`:

```ts
    if (!cap.ok) {
      return {
        cap_check_result: cap,
        discarded: true,
        discard_reason:
          cap.failures.map((f) => f.reason).join("; ") || "cap denied",
      };
    }

    return {
      cap_check_result: cap,
      discarded: false,
    };
```

In `apps/agent/src/orchestration/nodes/risk-gate.ts`, fix the header comment and drop `hitl_status`:

```ts
/**
 * Deterministic risk gate node — not an LLM step.
 * reject → discard; caution/pass continue (caution is advisory only).
 */
```

and in the reject branch:
```ts
  if (verdict === "reject") {
    return {
      discarded: true,
      discard_reason: "risk verdict reject — auto-discard",
    };
  }
```

- [ ] **Step 6: Update graph.ts**

In `apps/agent/src/orchestration/graph.ts`:

Rewrite the header comment:
```ts
/**
 * GRAM Supervisor Graph — LangGraph Deep Agents topology (Phase 2).
 *
 * Topology:
 * START → Supervisor → Market Scanner → Risk Analyst → Risk Gate → Strategy → SafetyCaps → Execution → Postmortem → END
 *
 * Risk Gate and SafetyCaps are pure TS graph nodes (not LLM tools).
 * Fully autonomous: a ticket with cap.ok === true executes immediately.
 * There is no human approval step — every gate is deterministic.
 * Specialist sub-agents as tools with appropriately scoped tool sets.
 * Cold path (LLM) vs Hot path (native TS) separation.
 */
```

Delete the import line:
```ts
import { hitlNode, resolveHitl } from "./nodes/hitl";
```

In the `import type { ... } from "./state";` block, delete `HitlStatus,`.

In `GramAnnotation`, delete:
```ts
  hitl_status: Annotation<HitlStatus>,
```

Delete the entire `.addNode("hitl", ...)` block (the node and its whole async callback, including the `// HITL — Telegram approval interrupt (pauses graph)` comment).

Change the `execution` node's guard — delete the HITL pre-check and the third `makeAuthorizedExecution` argument:
```ts
    // Execution — mechanical swap (only after SafetyCaps)
    .addNode("execution", async (state: GramTradeState) => {
      if (!state.proposed_ticket || !state.cap_check_result) return {};
      const authorized = makeAuthorizedExecution(
        state.proposed_ticket,
        state.cap_check_result,
      );
      const out = await executionNode({ cycle_id: state.cycle_id, authorized });
      return {
        execution_result: out.ok
          ? { ok: true, txHash: out.result?.txHash, amountTokens: out.result?.amountTokens, dex: out.result?.dex }
          : { ok: false, error: out.error },
        discarded: !out.ok,
        discard_reason: out.error,
      };
    })
```

In the supervisor `addConditionalEdges` route map, delete the `hitl: "hitl",` entry.

Replace the `safety_caps` conditional edges with:
```ts
    .addConditionalEdges(
      "safety_caps",
      (s) => {
        if (s.discarded) return "end";
        if (s.cap_check_result?.ok) return "execution";
        return "end";
      },
      { end: END, execution: "execution" },
    )
```

Delete the entire `.addConditionalEdges("hitl", ...)` block.

- [ ] **Step 7: Update the orchestration barrel**

In `apps/agent/src/orchestration/index.ts`:

Delete the line:
```ts
export { hitlNode, resolveHitl, expireStaleHitl, type HitlInput, type HitlOutput } from "./nodes/hitl";
```

In the `from "./state"` export block, delete `type HitlStatus,`.

- [ ] **Step 8: Run test to verify it passes**

Run: `cd apps/agent && DATA_DIR="$(mktemp -d)" WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/orchestration-graph.test.ts`

Expected: PASS, all 4 tests.

- [ ] **Step 9: Commit**

```bash
git add -A apps/agent/src/orchestration apps/agent/test/orchestration-graph.test.ts
git commit -m "feat(graph)!: remove HITL node and approval edges

safety_caps now routes straight to execution when cap.ok. Drops
hitl_status from GramTradeState and deletes nodes/hitl.ts, which
depended on the telegram approval store."
```

---

### Task 3: Update the signer path in the execution node

`verifyAuthorization` hardcodes `"safetycaps-v1"` at line 49 instead of importing `CAPS_VERSION`. After Task 1's bump this would reject every trade, so it must be fixed here.

**Files:**
- Modify: `apps/agent/src/orchestration/nodes/execution.ts`
- Test: `apps/agent/test/execution-auth.test.ts` (create)

**Interfaces:**
- Consumes: `CAPS_VERSION` (`"safetycaps-v2"`), `AuthorizedExecution` without `hitl` (Task 1).
- Produces:
  - `makeAuthorizedExecution(ticket: TradeTicket, cap: CapCheckResult): AuthorizedExecution` — **two params only**
  - `verifyAuthorization` compares against the imported `CAPS_VERSION`, not a literal

- [ ] **Step 1: Write the failing test**

Create `apps/agent/test/execution-auth.test.ts`. This tests only the pure authorization helpers — it must not touch the network or a signer.

```ts
/**
 * Authorization envelope binding tests — pure, no network, no signer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPS_VERSION, checkTicket, type CapCheckContext, type TradeTicket } from "../src/safetycaps";
import { makeAuthorizedExecution } from "../src/orchestration/nodes/execution";

const jetton = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

function ctx(overrides: Partial<CapCheckContext> = {}): CapCheckContext {
  return {
    balance_ton: 10,
    open_positions: 0,
    max_position_ton: 5,
    max_open: 3,
    min_ai_score: 50,
    unlocked: true,
    kill_switch_active: false,
    circuit_breaker_ok: true,
    observe_only: false,
    daily_pnl_ton: 0,
    max_portfolio_allocation_pct: 50,
    max_slippage_pct: 1.5,
    max_trade_pool_tvl_pct: 5,
    require_pool_tvl: false,
    gas_cushion_ton: 0.3,
    ...overrides,
  };
}

function ticket(overrides: Partial<TradeTicket> = {}): TradeTicket {
  return {
    cycle_id: "c_exec",
    tier: "low",
    side: "buy",
    jetton_master: jetton,
    amount_ton: 0.5,
    risk: { score: 90, verdict: "pass" },
    ...overrides,
  };
}

test("CAPS_VERSION is v2 so v1 authorizations cannot replay", () => {
  assert.equal(CAPS_VERSION, "safetycaps-v2");
});

test("makeAuthorizedExecution binds ticket to cap with no hitl field", () => {
  const t = ticket();
  const cap = checkTicket(t, ctx());
  const auth = makeAuthorizedExecution(t, cap);
  assert.equal(auth.ticket, t);
  assert.equal(auth.cap, cap);
  assert.equal("hitl" in auth, false);
  assert.equal(auth.idempotency_key, `${cap.cycle_id}:${cap.ticket_hash}`);
});

test("caution ticket produces a fully authorized envelope", () => {
  const t = ticket({ risk: { score: 55, verdict: "caution" } });
  const cap = checkTicket(t, ctx());
  assert.equal(cap.ok, true);
  const auth = makeAuthorizedExecution(t, cap);
  assert.equal(auth.cap.caps_version, CAPS_VERSION);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && DATA_DIR="$(mktemp -d)" WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/execution-auth.test.ts`

Expected: FAIL — `makeAuthorizedExecution` still has a `hitl` third parameter and sets `auth.hitl`, so `"hitl" in auth` is `true`.

- [ ] **Step 3: Update the execution node**

In `apps/agent/src/orchestration/nodes/execution.ts`:

Update the header comment's precondition line:
```ts
 * Precondition: CapCheckResult.ok === true (deterministic authorization; no human step)
```

Change the safetycaps import to bring in `CAPS_VERSION`:
```ts
import { verifyCapBinding, hashTradeTicket, CAPS_VERSION } from "../../safetycaps";
```

Replace `verifyAuthorization` — use the constant and drop the HITL check:

```ts
function verifyAuthorization(auth: AuthorizedExecution): { allowed: boolean; reason?: string } {
  const { ticket, cap } = auth;

  // 1. Cap must be ok
  if (!cap.ok) {
    return { allowed: false, reason: "cap check not ok" };
  }

  // 2. Version match — imported, never a literal, so a CAPS_VERSION bump
  //    invalidates stale authorizations instead of silently honoring them.
  if (cap.caps_version !== CAPS_VERSION) {
    return { allowed: false, reason: `caps_version mismatch: ${cap.caps_version}` };
  }

  // 3. Ticket hash binding
  const expected = hashTradeTicket(ticket);
  if (cap.ticket_hash !== expected) {
    return {
      allowed: false,
      reason: `ticket_hash mismatch (cap=${cap.ticket_hash} ticket=${expected})`,
    };
  }

  // 4. Cycle ID match
  if (cap.cycle_id !== ticket.cycle_id) {
    return { allowed: false, reason: "cycle_id mismatch" };
  }

  return { allowed: true };
}
```

In `executionNode`, change the destructure from `const { ticket, cap, hitl } = authorized;` to:
```ts
  const { ticket, cap } = authorized;
```

Remove `hitl_status: hitl,` from **both** `decisionJournalStore.append(...)` calls that carry it (the `execute_denied_auth_verify` call and the `execute_submit` call).

Replace `makeAuthorizedExecution` and its doc comment:
```ts
/**
 * Convenience: build AuthorizedExecution from ticket + cap.
 * Deterministic authorization only — there is no approval step.
 */
export function makeAuthorizedExecution(
  ticket: TradeTicket,
  cap: CapCheckResult,
): AuthorizedExecution {
  return {
    ticket,
    cap,
    idempotency_key: `${cap.cycle_id}:${cap.ticket_hash}`,
  };
}
```

Also remove the now-unused `Tier` from the type import if `tsc` flags it (`noUnusedLocals` may not be on; check before changing).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && DATA_DIR="$(mktemp -d)" WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/execution-auth.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/orchestration/nodes/execution.ts apps/agent/test/execution-auth.test.ts
git commit -m "fix(exec)!: import CAPS_VERSION instead of hardcoding v1; drop HITL gate

verifyAuthorization compared against the literal \"safetycaps-v1\", so the
v2 bump would have rejected every trade. Now imports the constant.
makeAuthorizedExecution drops its hitl parameter."
```

---

### Task 4: Remove HITL denial branches from the coordinator

The live trading path. `coordinator.ts:492` and `:1020` both refuse to execute when `cap.hitl_required && cap.hitl_status !== "approved"`. With Task 1 those fields no longer exist, so these branches must go. Note the comment at `:493` claims `HITL_DISABLE=true` makes the branch unreachable — that was never true (`safetycaps/` never read that env var), so removing it also deletes a misleading comment.

**Files:**
- Modify: `apps/agent/src/core/coordinator.ts`

**Interfaces:**
- Consumes: `CapCheckResult` without `hitl_*` (Task 1).
- Produces: no signature changes — `authorizeForTier`, `executeForTier`, and the pipeline method keep their current signatures.

- [ ] **Step 1: Remove the HITL branch in `executeForTier`**

In `apps/agent/src/core/coordinator.ts`, delete this entire block (around line 492):

```ts
    if (cap.hitl_required && cap.hitl_status !== "approved") {
      // Autopilot: when HITL_DISABLE=true this branch is unreachable because
      // SafetyCaps already short-circuited hitl_required to false. Kept here
      // as the fail-closed guard for manual-flow (HITL gate kept on).
      const reason = `HITL required (status=${cap.hitl_status}) — not auto-executable`;
      log.warn("COORD", `[${tier.toUpperCase()}] ${reason}`);
      decisionJournalStore.append({
        cycle_id: ticket.cycle_id,
        agent: "coordinator",
        input_hash: cap.ticket_hash,
        cap_check_result: cap,
        hitl_status: cap.hitl_status,
        final_action: "execute_denied_hitl",
        output: { error: reason },
      });
      return { ok: false, dex, error: reason, cap, cycle_id: ticket.cycle_id };
    }
```

- [ ] **Step 2: Remove the HITL branch in the pipeline method**

Delete this block (around line 1020):

```ts
    if (cap.hitl_required && cap.hitl_status !== "approved") {
      const reason = `HITL required (status=${cap.hitl_status})`;
      pipeline.step4RiskVerdict = `DENIED: ${reason}`;
      log.warn("PIPELINE", `[${tier.toUpperCase()}] Step 4 FAIL: ${reason}`);
      return { ok: false, error: reason, pipeline };
    }
```

- [ ] **Step 3: Remove `hitl_status` from journal appends**

Three `decisionJournalStore.append({...})` calls in this file still pass `hitl_status: cap.hitl_status,` — in `authorizeForTier` (~line 346), and two in `executeForTier` (~lines 485 and 541). Delete that line from each.

In `authorizeForTier`, also simplify `final_action`, since `hitl_required` no longer exists:
```ts
      final_action: cap.ok ? "cap_ok" : "cap_denied",
```

- [ ] **Step 4: Verify no HITL references remain in the coordinator**

Run: `grep -n -i hitl apps/agent/src/core/coordinator.ts`

Expected: no output (exit code 1).

- [ ] **Step 5: Typecheck the coordinator's callers**

Run: `npx tsc -p apps/agent/tsconfig.json --noEmit`

Expected: errors only in `storage/store.ts`, `mcp/tools.ts`, `mcp/server.ts`, `config.ts`, `index.ts`, `ai/brain.ts`, `telegram/*`, and `test/telegram-approvals.test.ts` / `test/exit-journal.test.mts` — all handled in Tasks 5–6. No errors in `core/`, `orchestration/`, or `safetycaps/`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/core/coordinator.ts
git commit -m "feat(coord)!: remove HITL denial branches from live execute paths

Deletes the two 'HITL required — not auto-executable' guards and the
hitl_status journal fields. Also removes a comment claiming HITL_DISABLE
short-circuited hitl_required in SafetyCaps — it never did; safetycaps/
never read that env var."
```

---

### Task 5: Delete the Telegram transport and drop the journal column

**Files:**
- Delete: `apps/agent/src/telegram/approvals.ts`, `bot.ts`, `commands.ts`, `index.ts`
- Delete: `apps/agent/test/telegram-approvals.test.ts`
- Modify: `apps/agent/src/storage/store.ts`
- Modify: `apps/agent/test/exit-journal.test.mts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `JournalAppendInput` — **no** `hitl_status` field
  - `DbJournalEntry` — **no** `hitl_status` field
  - New-DB `decision_journal` schema has no `hitl_status` column
  - The `apps/agent/src/telegram/` directory no longer exists

- [ ] **Step 1: Confirm nothing outside the deleted set imports telegram**

Run: `grep -rn "telegram" apps/agent/src --include="*.ts" | grep -v "^apps/agent/src/telegram/"`

Expected: only `skills/wallet-bootstrap/index.ts` (unrelated wallet-setup notification) and possibly comment-only hits. If any real `import ... from ".../telegram"` appears outside the deleted set, STOP and report it — the plan assumed there were none.

- [ ] **Step 2: Delete the modules and their test**

```bash
git rm -r apps/agent/src/telegram
git rm apps/agent/test/telegram-approvals.test.ts
```

- [ ] **Step 3: Drop `hitl_status` from the store**

In `apps/agent/src/storage/store.ts`:

In the `CREATE TABLE IF NOT EXISTS decision_journal` DDL, delete the line `    hitl_status TEXT,`.

Add a note directly above that `CREATE TABLE` so the asymmetry is documented:
```sql
  -- NOTE: hitl_status was removed in safetycaps-v2 (autonomous execution).
  -- Existing deployed DBs keep the physical column because SQLite cannot
  -- cheaply drop one; it simply stops being written. Do not add a
  -- destructive migration to "clean" it.
```

In `interface DbJournalEntry`, delete `hitl_status?: string | null;`.

In `interface JournalAppendInput`, delete `hitl_status?: string;`.

In `decisionJournalStore.append`, delete `hitl_status: entry.hitl_status ?? null,` from the `row` object, and remove `hitl_status` from **both** the column list and the `VALUES` list of the INSERT:

```ts
    db.prepare(`
      INSERT INTO decision_journal (
        id, cycle_id, ts, agent, model_used, input_hash,
        tool_calls, output, cap_check_result, final_action
      ) VALUES (
        @id, @cycle_id, @ts, @agent, @model_used, @input_hash,
        @tool_calls, @output, @cap_check_result, @final_action
      )
    `).run(row);
```

- [ ] **Step 4: Update the journal test**

In `apps/agent/test/exit-journal.test.mts`, the test named `"append with optional fields (model_used, hitl_status, etc.)"` writes and asserts `hitl_status`. Rename it and drop that field:

- Change the test name to `"append with optional fields (model_used, cap_check_result, etc.)"`
- Delete the `hitl_status: "operator_approved",` line from the append input (line ~144)
- Delete the `assert.equal(entry.hitl_status, "operator_approved");` assertion (line ~154)

- [ ] **Step 5: Run the affected tests**

Run: `cd apps/agent && DATA_DIR="$(mktemp -d)" WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/exit-journal.test.mts`

Expected: PASS.

Note: a *pre-existing* DB at `DATA_DIR` would still have the old column; the fresh `mktemp -d` avoids that. The INSERT omits `hitl_status`, which is nullable, so it also succeeds against an old DB.

- [ ] **Step 6: Commit**

```bash
git add -A apps/agent/src/telegram apps/agent/src/storage/store.ts apps/agent/test
git commit -m "feat(store)!: delete telegram transport; stop writing hitl_status

Removes approvals/bot/commands/index and their tests — all unreachable
once the approval gate is gone (bot.ts was a stub that never had a real
transport). decision_journal stops writing hitl_status; the physical
column is retained on existing DBs since SQLite cannot cheaply drop it."
```

---

### Task 6: Clean up config, boot, and MCP surface

Removes the last references so no operator-facing text or env var implies an approval gate still exists.

**Files:**
- Modify: `apps/agent/src/config.ts`
- Modify: `apps/agent/src/index.ts`
- Modify: `apps/agent/src/mcp/tools.ts`
- Modify: `apps/agent/src/mcp/server.ts`
- Modify: `apps/agent/src/ai/brain.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `CONFIG.strategy.hitlMinAiScore` no longer exists
  - `CONFIG.brainEnabled` is driven solely by `LLM_BRAIN_ENABLED` (default `false`)
  - `execute_swap` MCP response has no `hitl_required` key

- [ ] **Step 1: Update config.ts**

In `apps/agent/src/config.ts`, delete the `hitlMinAiScore` entry and its comment block:
```ts
    // Spec 006 Phase 8 — HITL gate policy.
    // First live BUY always requires Telegram tap (one-shot per deployment).
    // After that, auto-trade is allowed only when aiScore >= HITL_MIN_AI_SCORE
    // ...
    hitlMinAiScore: num("HITL_MIN_AI_SCORE", 70),
```

Replace the `brainEnabled` line and its comment. It currently derives its default from `HITL_DISABLE`, which no longer means anything. Preserve today's *effective* production default — autopilot ran with `HITL_DISABLE=true`, so the brain was **off**:
```ts
    // LLM trade brain. Off by default: the deterministic audit+score path is
    // the production path. Set LLM_BRAIN_ENABLED=true to run the ReAct planner
    // per radar candidate.
    brainEnabled: bool("LLM_BRAIN_ENABLED", false),
```

- [ ] **Step 2: Update index.ts boot**

In `apps/agent/src/index.ts`, delete the whole `HITL_DISABLE` branch:
```ts
    if (process.env.HITL_DISABLE === "true") {
        // Autopilot: stamp first-trade-executed ONCE so the persistent HITL
        // envelope flip stays off across restarts. The `executeSwapTool`
        // also short-circuits the FIRST-trade branch by reading the live env
        // each call — this pair makes it bullet-proof.
        // markFirstTradeExecuted(); // TODO: Implement first trade gate
        log.warn("HITL", "AUTOPILOT MODE — HITL fully disabled (operator never approves).");
    }
```

Replace it with an unconditional banner, so the autonomy is always visible in logs rather than implied by an env var:
```ts
    log.warn("AUTONOMY", "FULLY AUTONOMOUS — deterministic SafetyCaps is the only execution gate.");
```

- [ ] **Step 3: Update the MCP tool surface**

In `apps/agent/src/mcp/tools.ts`:

Delete `hitl_required: r.cap?.hitl_required,` from the returned object (~line 136).

Fix the `execute_swap` description line (~line 145):
```ts
            "riskVerdict=reject always denies; caution is advisory only and executes. " +
```

Fix the `riskVerdict` schema description (~line 159):
```ts
                .describe("Advisory risk verdict from audit/risk step. reject blocks; caution is advisory only."),
```

In `apps/agent/src/mcp/server.ts` (~line 99), fix the description:
```ts
            riskVerdict: { type: "string", enum: ["pass", "caution", "reject"], description: "Advisory risk verdict; reject blocks; caution is advisory only." },
```

- [ ] **Step 4: Update the brain prompt**

In `apps/agent/src/ai/brain.ts` (~line 108), the prompt text references autopilot via `HITL_DISABLE`. Read the surrounding sentence and rewrite it to describe the standing state without naming the removed env var — e.g. `In autopilot mode, the operator has explicitly` becomes `The agent runs fully autonomously; the operator has explicitly`. Keep the rest of the sentence intact so the prompt's meaning is preserved.

- [ ] **Step 5: Verify no HITL references remain in src**

Run: `grep -rn -i "hitl" apps/agent/src`

Expected: **no output.** If `line.ts` still matches on its doc comment, update that comment too (it describes a LINE webhook as "LINE HITL"; change to "LINE ops webhook").

- [ ] **Step 6: Full typecheck and test suite**

Run: `npx tsc -p apps/agent/tsconfig.json --noEmit`
Expected: clean, exit 0.

Run: `cd apps/agent && npm test`
Expected: `✓ ALL TEST FILES PASSED`. The count drops by one file versus baseline (33 → 33: `telegram-approvals.test.ts` removed, `execution-auth.test.ts` added).

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/src/index.ts apps/agent/src/mcp apps/agent/src/ai/brain.ts
git commit -m "chore!: drop HITL_DISABLE/HITL_MIN_AI_SCORE and approval-gate copy

brainEnabled now reads LLM_BRAIN_ENABLED directly (default false,
matching the effective production default under autopilot). MCP tool
descriptions no longer tell the model that caution awaits approval.
Boot logs autonomy unconditionally instead of behind an env var."
```

---

### Task 7: Verify the deployed environment and document the behavior change

The prior wallet-drain in this repo was caused by an env-var name mismatch between code and the Fly deployment. This task exists so the same class of bug cannot recur silently.

**Files:**
- Modify: `specs/003-ultra-acceleration/plan.md` (append a section)

**Interfaces:**
- Consumes: nothing.
- Produces: no code interfaces.

- [ ] **Step 1: Check which removed env vars are set on the deployment**

Run: `fly secrets list --app <app-name> 2>/dev/null | grep -i -E "hitl|auto_approve" || echo "none set"`

Also check the tracked configs: `grep -rn -i "hitl\|AUTO_APPROVE" fly.toml fly-testnet.toml 2>/dev/null || echo "none in toml"`

Record the result. `HITL_DISABLE`, `HITL_MIN_AI_SCORE`, and `AUTO_APPROVE_CEILING_PCT` are now **ignored** — if any is set, it is dead config that should be unset separately so it cannot mislead a future operator. Do not unset it as part of this task; just report it.

- [ ] **Step 2: Confirm the safety posture that remains**

Run: `grep -n 'fail("' apps/agent/src/safetycaps/check.ts`

Confirm all of these codes are still present: `OBSERVE_ONLY`, `KILL_SWITCH`, `HIGH_LOCKED`, `CIRCUIT_BREAKER`, `BAD_SIZE`, `BAD_JETTON`, `RISK_REJECT`, `TIER_CAP`, `BANKROLL`, `MAX_OPEN`, `ALLOCATION`, `SLIPPAGE`, `POOL_TVL`, `DEPTH`, `POOL_TVL_REQUIRED`, `AI_SCORE`. If any is missing, a gate was lost — STOP and report.

- [ ] **Step 3: Document the change**

Append to `specs/003-ultra-acceleration/plan.md`:

```markdown
## Autonomous Execution (2026-08-12) — HITL removed

`CAPS_VERSION` is now `safetycaps-v2`. Pre-v2 authorizations are rejected by
`verifyCapBinding` and `verifyAuthorization`.

**What changed:** the human approval gate is gone. `hitl_required` /
`hitl_status` were removed from `CapCheckResult` and `AuthorizedExecution`,
the `hitl` graph node and `src/telegram/` were deleted, and
`decision_journal` no longer writes `hitl_status`.

**Behavioral delta:** a `caution` risk verdict now **executes at full size**.
Previously it set `hitl_required=true`, and because nothing ever called
`resolveHitl`, such trades dead-ended at `coordinator.ts` without executing.
So this converts a silent no-trade into a real trade — the single most
important consequence of this change.

**Dead config, now ignored:** `HITL_DISABLE`, `HITL_MIN_AI_SCORE`,
`AUTO_APPROVE_CEILING_PCT`. `AUTO_APPROVE_CEILING_PCT` was already inert: it
defaulted to 100%, making the ceiling test `amount > balance * 1.0`
unreachable behind the `BANKROLL` gate (`amount + gas <= balance`).

**Remaining gates (unchanged, all deterministic):** OBSERVE_ONLY,
KILL_SWITCH, HIGH_LOCKED, CIRCUIT_BREAKER, BAD_SIZE, BAD_JETTON,
RISK_REJECT, TIER_CAP, BANKROLL, MAX_OPEN, ALLOCATION, SLIPPAGE, POOL_TVL,
DEPTH, POOL_TVL_REQUIRED, AI_SCORE.

**Rollback:** revert the commit range for this change. Because
`CAPS_VERSION` moves back to `safetycaps-v1`, in-flight v2 authorizations
are invalidated on rollback rather than honored — fail-closed in both
directions.
```

- [ ] **Step 4: Recommend deploying behind OBSERVE_ONLY first**

Do not deploy this change with live execution enabled on the first push. Confirm `OBSERVE_ONLY=true` is set on the deployment, verify from logs that `caution` candidates now reach `cap_ok` (rather than the old `execute_denied_hitl`), and only then flip `OBSERVE_ONLY=false`. Report the recommendation; do not change deployment state as part of this plan.

- [ ] **Step 5: Commit**

```bash
git add specs/003-ultra-acceleration/plan.md
git commit -m "docs(spec): record autonomous-execution change and dead HITL config"
```

---

## Self-Review

**Spec coverage** — the two decisions from brainstorming, and every reference found by grep:

| Requirement | Task |
|---|---|
| caution → EXECUTE at full size | 1 (core), 2 (graph test), 3 (envelope test) |
| Full excision incl. auth boundary | 1 (types/check), 3 (signer), 4 (coordinator) |
| Bump CAPS_VERSION | 1 |
| Fix hardcoded `"safetycaps-v1"` literal | 3 |
| Remove graph node + edges | 2 |
| Delete telegram modules | 5 |
| Drop journal column | 5 |
| Config/boot/MCP/prompt copy | 6 |
| Verify deploy env, document delta | 7 |

**Gaps accepted deliberately:** `line.ts` doc comment (Task 6 Step 5 catches it if `grep` still hits); `skills/wallet-bootstrap` Telegram reference (unrelated); the `storage/store.ts` first-trade gate helpers (already dead, harmless, left in place). Each is called out in File Structure.

**Placeholder scan:** no TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows literal before/after content. Task 6 Step 4 is the only prose-directed edit — justified because the prompt sentence must be read in context to rewrite, and the required outcome is stated exactly.

**Type consistency verified across tasks:**
- `verifyCapBinding` is 2-param in Task 1 and never called with 3 args afterward.
- `makeAuthorizedExecution` is 2-param in Task 3; Task 2 Step 6 already calls it with exactly 2 args. Consistent.
- `CAPS_VERSION` is `"safetycaps-v2"` in Task 1; asserted in Task 1 Step 1 and Task 3 Step 1; imported (not literal) in Task 3.
- `CapCheckContext` loses `auto_approve_ceiling_pct` in Task 1; the `ctx()` helpers in Task 2 Step 1 and Task 3 Step 1 both omit it. Consistent.
- `GramTradeState` loses `hitl_status` in Task 2; `safety-caps.ts` and `risk-gate.ts` returns are updated in the same task, so no node returns a field the annotation lacks.
- `JournalAppendInput` loses `hitl_status` in Task 5; every producer (`coordinator.ts` Task 4, `execution.ts` Task 3) stops passing it in an *earlier* task, so the field is orphaned before it is removed — no window where a caller passes a nonexistent field.

**Task-ordering hazard checked:** Task 1 breaks the build, and it stays broken until Task 6. That is unavoidable for a type-level excision across an authorization boundary — a strictly green-between-tasks ordering would require temporary optional fields and a second cleanup pass. Each task instead has a *scoped* verification (its own test file passes; specific directories typecheck clean), and Task 4 Step 5 enumerates exactly which files are still expected to error. Full `tsc` + `npm test` green is asserted at Task 6 Step 6.
