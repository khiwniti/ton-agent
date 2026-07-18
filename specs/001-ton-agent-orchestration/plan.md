# Implementation Plan: Autonomous AI Agent Orchestration Framework (TAOF) for the TON Ecosystem

**Branch**: `001-ton-agent-orchestration` | **Date**: 2026-07-16 | **Spec**: [spec.md](file:///Users/admin/ton-agent/specs/001-ton-agent-orchestration/spec.md)

**Input**: Feature specification from `/specs/001-ton-agent-orchestration/spec.md`

## Summary

This feature implements the Autonomous AI Agent Orchestration Framework (TAOF) for the TON blockchain ecosystem. It enhances the existing project by:
1. Creating an on-chain Tolk budgeting wallet contract (representing the Agentic Wallet) that constrains spending limits and validates signatures using delegated ephemeral agent keys.
2. Formulating a deterministic 9-step trade pipeline: Fetch Market Data -> Load Memory -> LLM Analysis -> Validate Risk -> Plan Trade -> Simulate TX -> Execute Swap -> Log Results -> Sync State.
3. Establishing local TypeScript risk/safety validation rules (max 5% portfolio allocation, stop-loss check, and slippage calculations).
4. Wiring up an emergency kill-switch polling mechanism with a fail-safe grace window (halts execution after 3 consecutive failures or if active).

## Technical Context

**Language/Version**: TypeScript (Node 20+), Tolk (TON 2026 Smart Contract language)

**Primary Dependencies**: `@ton/ton` (v16), `@ton/core`, `@ton/crypto`, `@ton-community/sandbox` or standard compilation packages, `better-sqlite3` or `libsql` for local storage, `axios` for polling.

**Storage**: SQLite / LibSQL for local transaction history, locks, and dual-memory state.

**Testing**: Jest for TypeScript components, Sandbox / TVM simulators for Tolk contracts.

**Target Platform**: Node.js runtime, TON Virtual Machine (TVM).

**Project Type**: Monorepo with `apps/agent` (asynchronous daemon/runtime) and `apps/web` (nextjs dashboard).

**Performance Goals**:
- Real-time market scanning and trend detection in < 5 seconds.
- Local risk checks executing in < 50 milliseconds.
- Circuit breaker halting all trades within 30 seconds of a kill-switch poll change or network partition.

**Constraints**:
- TON's asynchronous actor model requires tracking multi-hop transaction trace finality instead of atomic EVM-style call blocks.
- Ephemeral signing keys must be handled in memory and never exposed to the frontend or off-chain database.

**Scale/Scope**:
- Supporting Ston.fi and DeDust.io DEX routing.
- Limiting daily transactions on-chain via the Tolk contract to protect user bankroll (e.g. 2 TON total capacity).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.0.0 (ratified 2026-07-16, amended 2026-07-17).*

### Principle Gates (Constitution §Core Principles)

- **I. Deterministic Risk Core**: LLM agents cannot bypass SafetyCaps; every signed transaction flows through the Tolk budgeting contract (`contracts/budgeting-wallet.tolk`) and the local TypeScript 9-step pipeline, with cap checks in non-LLM code. **Checked: YES** — `apps/agent/src/core/coordinator.ts` + `apps/agent/src/risk/guardrails.ts` enforce caps deterministically; no agent tool path bypasses them.
- **II. Least-Privilege Custody**: Each agent uses a dedicated, balance-scoped agentic wallet funded by the operator; ephemeral keys are delegated on-chain and never handed to the agent process as raw signing authority beyond the contract's daily limit. **Checked: YES** — `apps/agent/src/wallet/agentic-wallet.ts` implements key delegation + daily-limit enforcement on-chain.
- **III. Containment Over Filtering**: Every tool an agent can call is scoped to minimum privilege (`contracts/mcp-tools.md`); high-impact actions require a non-LLM check (the contract's signature + limit check before any swap is dispatched). **Checked: YES** — execution path requires on-chain signature verification (exit 101) and limit check (exit 102) before funds move.
- **IV. HITL Scales With Capital**: Auto-approve vs. operator-approval threshold is a deterministic cap, not an LLM judgment; cap raises require explicit operator approval. **Checked: PARTIAL** — auto-approve ceiling is configured in `apps/agent/src/risk/guardrails.ts`; Telegram approval plumbing is deferred to a follow-up spec. **Complexity Tracking entry added below**.
- **V. Fail Closed**: Timeouts, kill-switch misses, ambiguous risk signals, and over-limit trades resolve to *no trade* / *exit if in position*. **Checked: YES** — coordinator trips circuit breaker after 3 misses; risk guardrails reject on slippage > 1.5%; SQLite lock timeout (>5 min) resolves to `FAILED`.

### Standards Gates (Constitution §2–3)

- **Decision Journal**: Every cap check, rejection, and fill is written to the SQLite store before the next step proceeds. **Checked: YES** — `apps/agent/src/storage/store.ts` persists `trade_transactions` and `locks` with full status transitions.
- **On-Chain Guardrails**: Tolk contract validates signatures, enforces daily limit (exit 102), resets every 86400 s, ignores bounced messages. **Checked: YES** — `contracts/budgeting-wallet.tolk` and `apps/agent/test/budgeting-wallet.test.ts` verify codes 101/102 and reset.
- **Local Risk Guardrails**: Max 5% portfolio allocation, max 1.5% slippage, stop-loss/take-profit checks enforced in TS. **Checked: YES** — `apps/agent/src/risk/guardrails.ts` + `apps/agent/test/security-risk.test.ts`.
- **Kill-Switch & Circuit Breaker**: Poll every 30 s; trip after 3 consecutive misses or `active: true`; resume only on explicit inactive. **Checked: YES** — `apps/agent/src/core/coordinator.ts` + `apps/agent/test/killswitch-failsafe.test.ts`.
- **Secure Communications**: HTTPS or localhost/127.0.0.1 only; refuse remote HTTP for kill-switch URL. **Checked: YES** — `apps/agent/src/core/coordinator.ts` URL validator.
- **State Locking**: SQLite transaction-level lock; 5-minute timeout auto-resolves to `FAILED`. **Checked: YES** — `apps/agent/src/storage/store.ts` `locks` table + `apps/agent/test/coordinator-pipeline.test.ts`.
- **Test-First (Non-Negotiable)**: Tests for both Tolk contract and TS pipeline exist and pass. **Checked: YES** — `apps/agent/test/budgeting-wallet.test.ts`, `contract.test.ts`, `security-risk.test.ts`, `coordinator-pipeline.test.ts`, `killswitch-failsafe.test.ts`, `wallet-delegation.test.ts`.
- **Promotion Path**: Testnet-paper → mainnet-capped → mainnet-full. **Checked: PARTIAL** — pipeline supports `OBSERVE_ONLY=true` dry-run (see `quickstart.md` §3); full mainnet-capped staging env is deferred to ops setup. **Complexity Tracking entry added below**.
- **Observability**: Structured traces link LLM calls, tool calls, cap checks, journal entries, on-chain txs per cycle. **Checked: PARTIAL** — coordinator emits structured `HEARTBEAT`/`COORD` logs and persists state to SQLite; full distributed-tracing export is deferred. **Complexity Tracking entry added below**.

## Complexity Tracking

> Justification entries for PARTIAL gates above. These are deferrals to future specs, not violations of principles.

| Item | Why PARTIAL | Simpler Alternative Rejected Because | Resolved By |
|---|---|---|---|
| HITL Telegram approval (Principle IV) | Auto-approve ceiling is enforced deterministically in `guardrails.ts`, but the Telegram approval surface for over-ceiling trades is not yet wired. A pure local prompt fallback was rejected because it defeats the "operable from a phone" goal. | Local CLI prompt would require SSH access during normal operation, violating Constitution §3 "Operable by one person from a phone". | Follow-up spec (proposed: `002-hitl-telegram-approval`). |
| Mainnet-capped staging env (§3 Promotion Path) | `OBSERVE_ONLY` paper-trading works; real-value capped staging requires operator-funded sub-wallets on testnet/mainnet with HITL gates. | Testnet-only is insufficient for slippage/finality validation; mainnet-full is unsafe without a capped intermediate stage. | Operator ops checklist (outside codebase). |
| Distributed tracing export (§3 Observability) | Coordinator logs and SQLite journal exist end-to-end; export to a tracing backend (OTel/Tempo) is deferred until a single-operator deploy makes the overhead worthwhile. | Console + SQLite journal is sufficient for post-mortems on a single-host deploy; full OTel adds infra burden prematurely. | Follow-up spec (proposed: `003-observability-export`). |

## Project Structure

### Documentation (this feature)

```text
specs/001-ton-agent-orchestration/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
apps/agent/
├── src/
│   ├── ai/              # Cognitive / LLM brain integration
│   ├── core/            # Coordinator, kill-switch, circuit breaker
│   ├── dex/             # Ston.fi and DeDust integrations
│   ├── mcp/             # MCP tools and server interface
│   ├── risk/            # TypeScript safety guardrails
│   └── wallet/          # Wallet handling, on-chain contract interfaces
└── test/                # Unit and integration tests
contracts/
└── budgeting-wallet.tolk # On-chain budgeting wallet in Tolk
```

**Structure Decision**: monorepo. Source code for contracts will reside in a new `contracts/` directory in the repo root. Agent logic resides under `apps/agent/src/`.
