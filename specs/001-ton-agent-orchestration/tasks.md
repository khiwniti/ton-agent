# Tasks: Autonomous AI Agent Orchestration Framework (TAOF) for the TON Ecosystem

**Input**: Design documents from `/specs/001-ton-agent-orchestration/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test tasks are included as requested by the test-first design principle.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structures for Tolk smart contract development

- [X] T001 Configure contract directory and link compiler build scripts in package.json
- [X] T002 Configure local compilation options for `contracts/budgeting-wallet.tolk` in typescript configurations

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database schema tables and core layout required before implementing user stories

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Setup SQLite schema migrations for `agentic_wallets`, `trade_transactions`, and `locks` tables in `apps/agent/src/storage/store.ts`
- [X] T004 Implement model repository interfaces and methods for database tables in `apps/agent/src/storage/store.ts`
- [X] T005 [P] Setup compiler and testing environment for Tolk using `@ton/sandbox` in `apps/agent/test/contract.test.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Budget-Delegated Autonomous Trading (Priority: P1) 🎯 MVP

**Goal**: Deploy and trade via budgeting wallet contract using ephemeral agent keys

**Independent Test**: Verify that trades under limit succeed while trades over limit or with wrong key fail in sandbox TVM.

### Tests for User Story 1

- [X] T006 [P] [US1] Write unit tests for Tolk contract verifying signature check (code 101) and daily budget limit (code 102) in `apps/agent/test/budgeting-wallet.test.ts`
- [X] T007 [P] [US1] Write integration tests for key delegation and contract instantiation in `apps/agent/test/wallet-delegation.test.ts`

### Implementation for User Story 1

- [X] T008 [US1] Implement key delegation and contract address calculation helpers in `apps/agent/src/wallet/agentic-wallet.ts`
- [X] T009 [US1] Implement contract deployment and remote state fetching wrapper in `apps/agent/src/wallet/agentic-wallet.ts`
- [X] T010 [US1] Implement signed transfer serialization builder (wrapping signatures) in `apps/agent/src/wallet/agentic-wallet.ts`
- [X] T011 [US1] Modify transaction sender in `apps/agent/src/dex/router.ts` to optionally route swaps through the budgeting wallet contract using the signed transfer serializer

**Checkpoint**: User Story 1 is functional. Ephemeral keys can execute swaps within daily spending limits.

---

## Phase 4: User Story 2 - Real-Time Trend Trading Pipeline (Priority: P2)

**Goal**: Implement the deterministic 9-step trade pipeline, including honeypot auditing and risk validation

**Independent Test**: Scan for fake tokens, verify they are blocked, verify trade sizes are capped at 5%, and ensure database locks serialize trades.

### Tests for User Story 2

- [X] T012 [P] [US2] Write tests for honeypot token audits and portfolio size validation in `apps/agent/test/security-risk.test.ts`
- [X] T013 [P] [US2] Write tests for 9-step orchestrator loop and transaction serialization in `apps/agent/test/coordinator-pipeline.test.ts`

### Implementation for User Story 2

- [X] T014 [US2] Implement token contract verification and permission checks (Honeypot Filter) in `apps/agent/src/security/audit.ts`
- [X] T015 [US2] Implement risk checks for max 5% portfolio allocation and max 1.5% slippage in `apps/agent/src/risk/guardrails.ts`
- [X] T016 [US2] Implement sqlite-based transaction locking/serialisation in `apps/agent/src/storage/store.ts`
- [X] T017 [US2] Implement the deterministic 9-step orchestrator loop inside `apps/agent/src/core/coordinator.ts`

**Checkpoint**: User Story 2 is functional. Trades are automatically audited, risk-checked, and safely serialized.

---

## Phase 5: User Story 3 - Emergency Kill-Switch & Fail-Safe Halting (Priority: P2)

**Goal**: Implement central kill-switch polling with fail-safe grace window of 3 misses and URL schema enforcement

**Independent Test**: Trigger kill-switch and confirm instant halt; drop connections and verify halt after 3 consecutive failures.

### Tests for User Story 3

- [X] T018 [P] [US3] Write tests for secure URL verification and consecutive failure count in `apps/agent/test/killswitch-failsafe.test.ts`

### Implementation for User Story 3

- [X] T019 [US3] Implement secure URL verification (reject remote http:// URLs) in `apps/agent/src/core/coordinator.ts`
- [X] T020 [US3] Implement consecutive miss counter and auto-trip logic in `apps/agent/src/core/coordinator.ts`

**Checkpoint**: User Story 3 is functional. The agent has a secure, fail-safe circuit breaker.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, final integration checks, and cleanup

- [X] T021 Code cleanup and refactoring in `apps/agent/src/`
- [X] T022 Run `quickstart.md` validation scenarios end-to-end to verify functionality
- [X] T023 Update README.md and documentation with WDS details

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Can start immediately
- **Foundational (Phase 2)**: Depends on Setup (Phase 1) completion
- **User Story 1 (Phase 3)**: Depends on Foundational (Phase 2) completion
- **User Story 2 (Phase 4)**: Depends on User Story 1 (Phase 3) completion (as it extends trading)
- **User Story 3 (Phase 5)**: Can start after Foundational (Phase 2) completion
- **Polish (Phase 6)**: Depends on all User Stories completion

### Parallel Opportunities

- Foundational database schemas (T003, T004) can run in parallel with sandbox test setup (T005)
- User Story 1 tests (T006, T007) can be written in parallel
- Security & risk filters (T014, T015) can be developed in parallel

---

## Parallel Example: User Story 1

```bash
# Run unit tests and integration tests for US1 in parallel
npm run test apps/agent/test/budgeting-wallet.test.ts &
npm run test apps/agent/test/wallet-delegation.test.ts &
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Setup project compilation configuration (T001-T002)
2. Setup database schemas and sandbox environment (T003-T005)
3. Implement budgeting contract and off-chain wrapper (T006-T010)
4. Integrate contract with routing layer (T011)
5. Validate Story 1 (deploy and execute single delegated swap under daily limit)
