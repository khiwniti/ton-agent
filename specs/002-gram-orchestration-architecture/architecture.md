# GRAM Autonomous AI Agent Framework — Architecture Design

| | |
|---|---|
| **Document type** | Design specification (implementation-ready) |
| **System** | GRAM / TAOF — Autonomous TON Trading Agent Framework |
| **Chain** | The Open Network (TON); native asset GRAM (rebranded from Toncoin, 2026-06-15) |
| **Status** | Design v1.0 — aligned to GRAM Orchestration Spec Draft v1.0 + existing `apps/agent` |
| **Builds on** | `001-ton-agent-orchestration` (budgeting wallet, 9-step pipeline seeds, SafetyCaps, kill-switch) |
| **Date** | 2026-07-18 |
| **Codebase** | TypeScript monorepo (`apps/agent`, `apps/web`, `contracts/budgeting-wallet.tolk`) |

---

## 1. Executive Summary

This document designs the **autonomous AI agent framework** for TON jetton trading as a **separation-of-authority system**:

1. **LLM agents reason, research, and propose** — never authorize, never hold signing authority as the last step.
2. **Deterministic SafetyCaps code authorizes** — position caps, circuit breaker, rug gates, exit policy, HITL.
3. **Agentic / budgeting wallets execute** — balance-scoped on-chain custody; blast radius = one sub-wallet allocation.
4. **Telegram is the single-operator surface** — approvals, halt/resume, digests.

It **aligns the pasted GRAM Orchestration Architecture Spec** with what already exists in this repo, resolves Python-vs-TypeScript and LangGraph-vs-ReAct choices into a concrete target topology, and adds a **cold-path / hot-path** split so LLM latency never sits on the execution critical path.

**Central bet (unchanged from the source spec):** prompt injection is unsolved at the model layer and must be *contained*. The containment boundary is SafetyCaps. No agent output crosses it without non-LLM code.

---

## 2. Alignment With Pasted Spec

| Pasted principle | Design stance in this repo |
|---|---|
| P1 Deterministic risk core, probabilistic shell | SafetyCaps = `risk/guardrails.ts` + `core/gate.ts` + `security/audit.ts` + exit policy; LLM never bypasses |
| P2 Least-privilege Agentic Wallets | `contracts/budgeting-wallet.tolk` + `wallet/agentic-wallet.ts` + LOW/MID/HIGH tiers |
| P3 Containment over filtering | Tool allow-lists per specialist; structured I/O; no transact tools on text-ingesting agents |
| P4 HITL scales with capital | Auto-approve ceiling + Telegram interrupt; `caution` always HITL |
| P5 Everything journaled | Append-only decision journal (extend SQLite beyond current trade rows) |
| P6 Fail closed | Timeouts, missing RPC, ambiguous rug → no trade / exit if in position |

| Pasted layer | Maps to today | Target |
|---|---|---|
| Interface (Telegram) | Web dashboard + webhooks | `apps/agent` Telegram bot (aiogram-equivalent: grammY / telegraf) |
| Orchestration (Deep Agents) | Single ReAct `ai/brain.ts` | LangGraph supervisor + specialist subgraphs-as-tools |
| SafetyCaps | `guardrails`, `gate`, `audit`, coordinator gates | Explicit nodes + pure functions; never inside LLM tools that can be “argued past” |
| TON integration | `dex/router`, tonapi, MCP tool wrappers | Same + RPC pool + optional `@ton/mcp` pin |
| Data & observability | SQLite + structured logs | Decision journal + traces + Telegram alerts |

---

## 3. Goals & Non-Goals

### Goals (priority order)

1. Capital cannot be lost faster than a human can intervene.
2. No single LLM call can move funds.
3. Every decision is reconstructable from an append-only journal.
4. Fail closed on missing data, timeouts, ambiguous risk.
5. Operable by one person from a phone (Telegram).

### Non-goals

- Multi-tenant / consumer wallet product.
- Market-making or MEV extraction.
- Full host-compromise defense (assume OS/container hardening).
- Re-implementing internals of existing audit/guardrails math (interfaces only).

---

## 4. System Context

```text
 Operator ⇄ Telegram ⇄ Orchestration (LangGraph Supervisor)
                              │
                              ▼
                     SafetyCaps (deterministic TS)
                              │
                              ▼
              Agentic / Budgeting Wallet + DEX Router
                              │
              Toncenter / Orbs / GetBlock  →  TON
                              │
              STON.fi / DeDust / Omniston
```

**Actors**

| Actor | Role |
|---|---|
| Operator | Sole principal; funds sub-wallets; approves high-tier trades; `/halt` `/resume` |
| Telegram | HITL + notifications |
| Supervisor + specialists | Plan / research / propose |
| SafetyCaps | Only path that greenlights a signed ticket |
| Execution path | DEX router + agentic wallet + RPC |
| Journal | Append-only truth for post-mortems |

---

## 5. Five-Layer Architecture

| Layer | Responsibility | Trust | Primary packages (target) |
|---|---|---|---|
| **L1 Interface** | Commands, approvals, digests | Untrusted input — always sanitized | `apps/agent/src/telegram/` |
| **L2 Orchestration** | Supervisor + specialists | Reasoning only | `apps/agent/src/orchestration/` |
| **L3 SafetyCaps** | Authorize, throttle, halt, exit | Ground truth | `apps/agent/src/risk/`, `core/gate.ts`, `security/`, `exit/` |
| **L4 TON Integration** | Quote, sign, submit, confirm | Mechanical | `wallet/`, `dex/`, `http/`, RPC pool |
| **L5 Data & Observability** | Journal, metrics, traces | Write-mostly | `storage/`, logger, optional OTel |

---

## 6. Cold Path / Hot Path (Acceleration)

The pasted acceleration notes are adopted as a **first-class split**, not an optional optimization.

```text
┌─────────────────────────────────────────────────────────┐
│ COLD PATH — Intelligence (LLM, 500ms–2s+)                 │
│  Market Scanner · Rug/Risk Analyst · Strategy · Supervisor│
│  Output: TradingPolicy + TradeTicket (proposals only)     │
│  Writes: journal · shared policy store (SQLite/Redis)     │
└───────────────────────────┬─────────────────────────────┘
                            │ publish policy / authorized ticket
                            ▼
┌─────────────────────────────────────────────────────────┐
│ HOT PATH — Execution (native TS, <50ms risk checks)       │
│  Position Monitor · Exit Policy · SafetyCaps re-check     │
│  DEX submit · kill-switch · circuit breaker               │
│  NO LLM in the loop for TP/SL/trailing/time-exit          │
└─────────────────────────────────────────────────────────┘
```

| Path | May call LLM? | May sign? | Latency budget |
|---|---|---|---|
| Cold | Yes | No | Seconds OK |
| Hot (monitor/exit) | No (except emergency rug re-score) | Only after SafetyCaps | &lt; 50ms local checks; RPC-bound submit |
| Hot (entry execute) | No | Only authorized ticket | Cap check &lt; 50ms; then chain |

**Rules**

- LLM never evaluates every market tick.
- Exit TP/SL/trailing/time are pure arithmetic on hot path.
- Emergency rug re-score may briefly re-enter cold path; still cannot bypass caps.
- Optional later: pre-cached BOC templates, lite-client, same-shard wallet mining — Phase 4+.

---

## 7. Orchestration Topology (LangGraph Deep Agents Pattern)

### 7.1 Framework choice

| Option | Verdict |
|---|---|
| **LangGraph + specialist subgraphs-as-tools** | **Selected** — matches pasted spec; repo already uses `@langchain/langgraph` ReAct in `ai/brain.ts` |
| Single mega ReAct agent | **Demote** — current baseline; insufficient isolation for risk gates |
| CrewAI / AutoGen | Rejected for production graph control |
| Eve (eve.dev) filesystem agents | Optional **channel host** later; not the risk core |

Evolve `ai/brain.ts` from one ReAct loop into a **compiled supervisor graph** with explicit non-LLM nodes for risk gate, SafetyCaps, and HITL.

### 7.2 Graph topology

```text
START (scheduler tick | Telegram cmd)
  → Supervisor
      → Market Scanner (read-only)
      → Rug / Risk Analyst (read-only) → RiskAssessment
  → Risk Gate (deterministic: reject if verdict=reject)
      → Strategy Agent → TradeTicket (proposal)
  → SafetyCaps Check (deterministic CapCheckResult)
      → fail → journal & discard
      → pass + below auto → Execution Agent
      → pass + above auto / caution → HITL interrupt (Telegram)
           → approved → Execution
           → denied | timeout → journal & discard (fail closed)
  → Execution Agent → DEX + Agentic Wallet
  → Position Monitor (hot loop)
      → Exit Policy Engine → Execution (exit only)
```

Risk Gate and SafetyCaps are **graph nodes of plain TypeScript**, not LLM tools. They cannot be reasoned around.

### 7.3 Agent roster

| Agent | Tools allowed | Model tier | Authorize trade? |
|---|---|---|---|
| **Supervisor** | Sub-agents as tools, journal writer, todo plan | Frontier | No |
| **Market Scanner** | Market data / indexer read | Cheap/fast | No |
| **Rug / Risk Analyst** | `audit_jetton`, chain read, scoring helpers | Frontier | No — advisory only |
| **Strategy Agent** | Sizing calculators, exit-policy config **read** | Frontier | No — emits `TradeTicket` |
| **Execution Agent** | Swap/submit tools **only after** `CapCheckResult.ok` | Cheap/fast | Executes authorized tickets only |
| **Position Monitor** | Price/chain read (mostly non-LLM) | Cheap or none | No |
| **Postmortem / Journal** | Journal read → Telegram digest | Cheap | No |

**Hard rule:** Scanner and Risk Analyst have **zero** transact tools (containment layer 3).

### 7.4 State schema (TypeScript)

```ts
// apps/agent/src/orchestration/state.ts
export type HitlStatus =
  | "not_required" | "pending" | "approved" | "denied" | "timeout";

export interface GramTradeState {
  cycle_id: string;
  candidate: JettonCandidate | null;
  risk_assessment: RiskAssessment | null;   // advisory
  proposed_ticket: TradeTicket | null;      // proposal only
  cap_check_result: CapCheckResult | null;  // authoritative
  hitl_status: HitlStatus;
  execution_result: ExecutionResult | null;
  open_positions: Position[];
  todo_plan: TodoItem[];
  journal_ref: string;
  tier: "low" | "mid" | "high";
  environment: "testnet-paper" | "mainnet-live-capped" | "mainnet-live-full";
}
```

**Type separation is load-bearing**

- `TradeTicket` ≠ authorization.
- Actionable only when paired with `CapCheckResult { ok: true, ticket_hash, caps_version }`.
- Execution Agent refuses any ticket whose hash is not the last greenlit cap result.

### 7.5 HITL interrupts

LangGraph checkpoint + interrupt **only** at:

1. Before Execution when size ≥ auto-approve ceiling **or** risk verdict = `caution`.
2. Before any SafetyCaps **configuration change** (never agent-initiated silently).

Timeout → **deny** (P6). Resume hours later via Telegram is supported by checkpointed state.

---

## 8. SafetyCaps Contract

SafetyCaps is the **only** greenlight path. Implemented as pure, unit-tested TS (existing modules + thin façade).

### 8.1 Position & exposure (hard gates, not scores)

| Parameter | Default (env-overridable) | Source today |
|---|---|---|
| Max portfolio allocation / trade | 5% | `MAX_PORTFOLIO_ALLOCATION_PCT` |
| Max slippage | 1.5% | `MAX_SLIPPAGE_PCT` |
| Max position by tier | LOW/MID/HIGH configs | `TIER_RISK_CONFIGS` |
| Max concurrent opens | per tier | `maxOpen` |
| Daily loss circuit breaker | 2.0 TON | `DAILY_LOSS_LIMIT_TON` |
| Min liquidity-depth ratio | trade ≤ X% pool TVL | **new** explicit check |
| Auto-approve ceiling | % of sub-wallet | **new** config |

Any failure → reject. No weighted average override by model confidence.

### 8.2 Circuit breaker states

```text
Active ⇄ Throttled → Halted → (explicit /resume only) → Active
                ↘ EmergencyExit (open positions only; never blocked by halt)
```

| Trigger | Effect |
|---|---|
| Daily loss &gt; warn | Throttled (half size, lower auto-ceiling) |
| Daily loss &gt; hard / kill-switch / 3 poll misses | Halted — no new opens |
| Rug critical on open position | EmergencyExit path |
| `/halt` | Halted |
| `/resume` + confirm | Active |

Halted state is **not** reachable from LLM-authored actions.

### 8.3 Rug / honeypot

Wrap existing `security/audit.ts` + scoring into `RiskAssessment`:

```ts
type RiskVerdict = "pass" | "caution" | "reject";

interface RiskAssessment {
  score: number;
  verdict: RiskVerdict;
  checks: {
    lpLock: boolean;
    holderConcentrationOk: boolean;
    mintBlacklistOk: boolean;
    verified: boolean;
    sellSimOk: boolean;
    creatorHistoryOk: boolean;
    gramTickerCollisionOk: boolean; // TON→GRAM rebrand phishing
  };
  rationale_for_journal: string; // not trusted for auth
}
```

| Verdict | Next step |
|---|---|
| `pass` | Strategy may run; size may auto-exec if under ceiling |
| `caution` | Always HITL |
| `reject` | Discard; never show as approvable trade |

### 8.4 Prompt-injection containment (5 layers)

1. Input filtering (strip ZW chars, blocklist patterns) on all external text.
2. Instruction delimiting (`<external_data>…</external_data>`).
3. Tool allow-lists (no transact on scanner/risk).
4. Structured output schemas (Zod) for assessments and tickets.
5. Architectural backstop: SafetyCaps + HITL.

### 8.5 Exit policy (hot path)

Per position state machine: Monitoring → TakeProfit | StopLoss | Trailing* | TimeExit | EmergencyExit → Exited.

Evaluated by Position Monitor without LLM except EmergencyExit re-score.

---

## 9. Custody & TON Integration

### 9.1 Custody model

| Wallet | Contract / pattern | Who controls |
|---|---|---|
| Master / treasury | Multisig / cold | Operator only — never orchestration |
| Strategy sub-wallets | Budgeting Tolk + tier keys | Ephemeral / delegated within daily limit |
| Batch exit (optional) | Highload v3 | Ops / halt sweeps |

Existing: `contracts/budgeting-wallet.tolk` (sig check 101, daily limit 102, 86400 reset), `wallet/agentic-wallet.ts`, tier wallets in coordinator.

### 9.2 Execution ticket

```ts
interface AuthorizedExecution {
  ticket: TradeTicket;
  cap: CapCheckResult;       // ok: true
  hitl: HitlStatus;          // not_required | approved
  idempotency_key: string;   // cycle_id + ticket_hash
}
```

DEX: STON.fi + DeDust quote comparison; slippage + depth gates independent of venue.

### 9.3 RPC pool

| Tier | Provider |
|---|---|
| Primary | Toncenter v2 |
| Fallback | Orbs TON Access |
| Paid | GetBlock / OnFinality (Phase 3+) |

Read: health-checked failover. Write: primary-first, idempotent retry by tx identity.

### 9.4 MCP surface

Keep **LLM coupling only** via allow-listed tools (current `mcp/tools.ts` pattern):

- Read: balance, meta, price, audit, risk status.
- Write/execute: only callable from Execution Agent path after `AuthorizedExecution`.
- Today `executeSwapTool` already routes through coordinator — **preserve and harden** so raw tool cannot skip cap hash binding.

Pin external `@ton/mcp` if adopted; changelog gate before bump.

---

## 10. Skills vs Graph Specialists

Existing Claude-style skills (`token-scout`, `audit-jetton`, `trade-plan`, `wallet-bootstrap`, `manual-override`) remain **reusable packs**. Mapping:

| Skill | Graph role |
|---|---|
| `token-scout` | Market Scanner toolkit |
| `audit-jetton` | Rug/Risk Analyst toolkit |
| `trade-plan` | Strategy Agent toolkit (proposal only) |
| `wallet-bootstrap` | Ops / operator, not autonomous trading cycle |
| `manual-override` | Operator HITL path only |

Skills must not become a backdoor that skips SafetyCaps.

---

## 11. Telegram Interface

| Command | Effect |
|---|---|
| `/status` | CB state, PnL, positions |
| `/positions` | Open vs exit policy |
| `/halt` | Immediate Halted |
| `/resume` | Confirm → Active |
| `/caps` | Read caps |
| `/setcap` | Propose change + confirm |
| `/digest` | Postmortem summary |
| Inline Approve / Deny | HITL for tickets |

Approval UX shows: jetton, size % sub-wallet, risk verdict, cap check summary, link to journal `cycle_id`. Timeout → deny.

---

## 12. Decision Journal

Append-only entries before each state transition:

```ts
interface JournalEntry {
  cycle_id: string;
  ts: string;
  agent: string;
  model_used?: string;
  input_hash: string;
  tool_calls: unknown[];
  output: unknown;
  cap_check_result?: CapCheckResult;
  hitl_status?: HitlStatus;
  final_action: string;
}
```

Rule: **if it is not journaled, it did not happen** for post-mortems.

Extend SQLite (`storage/store.ts`) with `decision_journal` table; never update rows in place.

---

## 13. Target Package Layout

```text
apps/agent/src/
├── orchestration/           # NEW — LangGraph supervisor graph
│   ├── graph.ts
│   ├── state.ts
│   ├── nodes/
│   │   ├── supervisor.ts
│   │   ├── market-scanner.ts
│   │   ├── risk-analyst.ts
│   │   ├── risk-gate.ts       # pure TS
│   │   ├── strategy.ts
│   │   ├── safety-caps.ts     # pure TS
│   │   ├── hitl.ts
│   │   ├── execution.ts
│   │   └── postmortem.ts
│   └── checkpointer.ts
├── safetycaps/              # NEW façade re-exporting risk/gate/audit/exit
│   ├── index.ts
│   ├── types.ts
│   └── policy-store.ts      # cold→hot shared policy
├── exit/                    # NEW or extract from position-manager
│   └── policy-engine.ts
├── telegram/                # NEW
│   ├── bot.ts
│   └── approvals.ts
├── hotpath/                 # NEW — monitor loop without LLM
│   └── position-monitor.ts
├── risk/                    # EXISTING
├── security/                # EXISTING
├── core/coordinator.ts      # EXISTING — kill-switch, tiers, executeForTier
├── wallet/                  # EXISTING
├── dex/                     # EXISTING
├── skills/                  # EXISTING packs
├── mcp/tools.ts             # tighten allow-lists per agent
├── ai/brain.ts              # DEPRECATE into orchestration/
└── storage/                 # + decision_journal
```

---

## 14. Pipeline Mapping (9-step ↔ graph)

| FR-003 step | Layer | Node |
|---|---|---|
| 1 Fetch market data | Cold | Market Scanner |
| 2 Load memory | Cold | Supervisor / journal |
| 3 LLM analysis | Cold | Risk + Strategy |
| 4 Validate risk | **SafetyCaps** | Risk Gate + Caps |
| 5 Plan trade | Cold | Strategy → ticket |
| 6 Simulate TX | Hot/L4 | Router sim before submit |
| 7 Execute swap | Hot/L4 | Execution + wallet |
| 8 Log results | L5 | Journal |
| 9 Sync state | L5 | Store + unlock |

---

## 15. Environments & Promotion

| Stage | Behavior |
|---|---|
| `testnet-paper` / `OBSERVE_ONLY` | Full graph; no mainnet value |
| `mainnet-live-capped` | Real value; tight caps; elevated HITL |
| `mainnet-live-full` | Operator-raised caps only after soak |

Promotion requires: adversarial tests green, journal review of soak, explicit operator sign-off on auto-approve ceiling.

---

## 16. Threat Model (summary)

| Threat | Mitigation |
|---|---|
| Rug / honeypot | Audit + sell sim + caps |
| GRAM ticker collision | Master-address allow/deny rules; no “migrate/claim” contracts |
| Prompt injection | 5-layer + no transact tools on text agents |
| RPC compromise | Multi-provider pool |
| Sub-wallet key leak | Budgeting limit + tier isolation |
| Model overconfidence | Caps ignore confidence language |
| Sandwich / thin pool | Slippage + depth ratio |
| CB bypass via chat | Halt/resume only explicit commands |

---

## 17. Implementation Phases

| Phase | Scope | Depends on |
|---|---|---|
| **0** | Existing SafetyCaps, coordinator, audit, budgeting wallet, skills, tests | **Done** (`001`) |
| **1** | Types + SafetyCaps façade + decision journal + split execute path (cap-hash binding) | **Done** — `apps/agent/src/safetycaps/`, `decision_journal`, `executeForTier` binding, tests |
| **2** | LangGraph supervisor topology; specialist nodes; tool allow-lists; deprecate mega-ReAct as sole path | **Partial** — risk graph skeleton `orchestration/` (risk_gate → safety_caps); brain.ts still production entry |
| **3** | Telegram HITL + `/halt` `/resume` + approval UX | **Partial** — pure approvals + command parsers + bot stub (no live transport) |
| **4** | Hot-path Position Monitor + Exit Policy engine (no LLM) | Phase 1–2 |
| **5** | RPC pool, liquidity-depth gate, promotion checklist | Phase 3–4 |
| **6** | Optional: BOC cache, lite-client, highload batch exit, `@ton/mcp` pin | Phase 5 |

---

## 18. Open Operator Decisions

1. **Auto-approve ceiling** (% of sub-wallet) — primary autonomy lever.
2. **Model tiers** per agent (frontier vs cheap) — cost vs quality.
3. **One vs multiple strategy sub-wallets** (aggressive/conservative).
4. **Paid RPC** in Phase 1 or defer.
5. **Backtest dataset** for Phase 2 validation.
6. **`@ton/mcp` adoption** vs current in-process tools only.

---

## 19. Traceability — Pasted Spec → Repo

| Architecture component | Existing module | Gap |
|---|---|---|
| Position & exposure caps | `risk/guardrails.ts` | Auto-approve ceiling; depth ratio |
| Circuit breaker / kill-switch | `guardrails` + `coordinator` | Throttled state; Telegram control |
| Rug / honeypot | `security/audit.ts` | Structured `RiskAssessment` + GRAM collision |
| Prompt sanitization | Partial via Zod tools | Explicit 5-layer pipeline module |
| Exit policy | Partial position manager | Full state machine hot loop |
| Orchestration graph | `ai/brain.ts` ReAct | Supervisor + specialists + pure gate nodes |
| `@ton/mcp` / tools | `mcp/tools.ts` | Cap-hash binding on execute |
| Decision journal | Trade rows / logs | Append-only `decision_journal` |
| Telegram HITL | Deferred in plan.md | Phase 3 |
| Cold/hot split | Implicit | Explicit `hotpath/` + policy store |

---

## 20. Success Criteria

- **SC-A:** 100% of signed submits pass SafetyCaps + (if required) HITL; unit tests prove LLM text cannot force execute.
- **SC-B:** Kill-switch / 3 misses halt new opens within 90s.
- **SC-C:** Slippage &gt; 1.5% never dispatches.
- **SC-D:** Journal reconstructs any cycle: seen → reasoned → authorized → executed.
- **SC-E:** Hot-path exit evaluation runs without LLM for TP/SL/trailing/time.
- **SC-F:** `caution` and over-ceiling tickets never auto-execute.

---

## 21. What This Design Is Not

- Not a rewrite of the Tolk budgeting contract (keep; integrate).
- Not replacing coordinator kill-switch (compose under SafetyCaps).
- Not putting LangGraph on the tick-level monitor loop.
- Not multi-tenant.

---

## 22. Recommended Next Engineering Step

1. Land **Phase 1** types + `safetycaps/` façade + journal table + bind `executeForTier` to `CapCheckResult`.
2. Land **Phase 2** graph skeleton with pure `risk-gate` / `safety-caps` nodes and allow-listed tools.
3. Land **Phase 3** Telegram approvals (closes Constitution Principle IV PARTIAL).

---

*End of design. Source alignment: GRAM Agent Orchestration Architecture Specification Draft v1.0 (2026-07-16), plus cold/hot acceleration notes; codebase: `apps/agent` on branch `feat/initial-migration-from-sniper-bots`.*
