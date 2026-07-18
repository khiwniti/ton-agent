<!--
====================================================================
SYNC IMPACT REPORT
====================================================================
Constitution sync invoked: 2026-07-17
Source input: "GRAM Autonomous Trading Framework — Agent Orchestration
Architecture Specification" (Draft v1.0, 2026-07-16)

Version bump: 0.0.0 (empty template) → 1.0.0
Bump type: MAJOR — first ratification; all placeholder tokens replaced.

Derived values:
- PROJECT_NAME: TON Agent
- Principles (P1–P6 from §5 of the source spec, mapped into the 5-slot
  template + merged into Section 2 "Security & Operational Standards"):
    I.   Deterministic Risk Core
    II.  Least-Privilege Custody
    III. Containment Over Filtering (Prompt Injection)
    IV.  HITL Scales With Capital
    V.   Fail Closed
  (Everything-journaled → Section 2 as "Decision Journal" standard.)
- Section 2: Security & Operational Standards
- Section 3: Development Workflow & Promotion Gates
- Governance: amendment policy, supersedes prior practices, complexity
  justification requirement.

Templates reviewed for propagation consistency:
- .specify/templates/plan-template.md
    Contains "Constitution Check" gate referenced from plan.md.
    No edit needed — the gate text is generic ("Gates determined based on
    constitution file") and will be populated per-feature by /speckit-plan.
- .specify/templates/spec-template.md
    No constitution references. No edit needed.
- .specify/templates/tasks-template.md
    No constitution references. No edit needed.
- .specify/templates/checklist-template.md
    No constitution references. No edit needed.

Existing artifacts needing amendment (flagged for follow-up, not edited
in this sync — outside the constitution-sync scope):
- specs/001-ton-agent-orchestration/plan.md
    Constitution Check section currently lists 3 ad-hoc gates
    ("Safe-by-default", "Test-first design", "Fail-secure") which do not
    map 1:1 to the ratified principles I–V. RECOMMENDED: when
    /speckit-plan next runs on that spec, regenerate the Constitution
    Check block against the v1.0.0 principles below.
- CLAUDE.md
    No constitution references; no edit needed.

Hooks: No `before_constitution` or `after_constitution` hooks are
registered in .specify/extensions.yml (only after_specify and after_plan
for speckit.agent-context.update). Nothing to execute.
====================================================================
-->

# TON Agent Constitution

## Core Principles

### I. Deterministic Risk Core, Probabilistic Reasoning Shell

LLM agents may plan, research, and score, but they never hold a signing
key, never call a DEX router directly, and never bypass the deterministic
SafetyCaps core. A live LLM may sit in the reasoning loop for market
judgment (rug screening nuance, narrative risk, entry timing), but it is
architecturally incapable of being the last step before a signature. Every
path to a signed transaction must pass through non-LLM code that enforces
position sizing, exposure limits, circuit breakers, and exit policy.

### II. Least-Privilege Custody via Agentic Wallets

Each strategy or agent gets a dedicated, non-custodial, balance-scoped
on-chain wallet funded by the operator's main wallet — never a shared hot
wallet, never a private-key handoff to the agent process. A compromised or
misbehaving strategy can drain at most its allocated sub-wallet balance,
never the treasury. Sub-wallets are topped up manually or via
operator-approved scheduled transfers; agents never refill themselves.

### III. Containment Over Filtering (Prompt Injection)

Prompt injection is treated as unsolved at the model layer. Every tool an
agent can call must be scoped to the minimum privilege it needs, every
high-impact action must require a non-LLM check, and a multi-layer
sanitization pipeline reduces — but is not solely relied upon to reduce —
the chance an injection lands. The containment boundary is the SafetyCaps
core; no agent output crosses it without passing through deterministic
code.

### IV. Human-in-the-Loop Scales With Capital, Not Complexity

HITL intensity scales with the capital at risk in a proposed action, not
with the perceived complexity of the system. Low-value scan-and-log
actions need no approval; any trade above the auto-approve ceiling always
requires an explicit operator approval (e.g., a Telegram tap), regardless
of how confident the agent is. Raising a SafetyCaps cap always requires
operator approval — never an agent proposal.

### V. Fail Closed

Timeouts, missing RPC data, ambiguous rug scores, unhandled exceptions,
kill-switch poll misses, and any unresolved risk signal resolve to *do
not trade* or *exit if already in position* — never to a default "proceed."
The system's default posture is inert; activity requires positive,
verifiable authorization at every gate.

## Security & Operational Standards

### Decision Journal (Auditability)

Every LLM call, every tool call, every cap check, every rejection, and
every fill is written to an append-only decision journal before the next
step proceeds. If it is not journaled, it did not happen, as far as the
system is concerned for post-mortems. The journal is the source of truth
for reconstruction of any past decision and must be readable independently
of the live orchestration process.

### On-Chain Guardrails

The framework includes a Tolk budgeting smart contract (the Agentic
Wallet) that validates signatures against a delegated ephemeral agent
public key, enforces a daily spent limit (rejecting over-budget messages
with exit code 102), and resets the accumulated spend every 86,400
seconds. Bounced messages must be detected and ignored by the contract to
prevent state corruption.

### Local Risk Guardrails

The Local Risk Agent enforces hard-coded, non-LLM TypeScript validation:
maximum 5% portfolio allocation per trade, maximum 1.5% slippage,
stop-loss / take-profit checks. Trade simulation must reject swaps whose
simulated slippage exceeds the cap before message dispatch.

### Kill-Switch & Circuit Breaker

The coordinator polls the kill-switch endpoint every 30 seconds. If the
endpoint returns an active stop state, or fails to respond for 3
consecutive polls, the coordinator must trip the circuit breaker, cancel
pending executions, and enter a safe halted state. Halt resumes only when
the endpoint becomes reachable again and explicitly returns inactive.

### Secure Communications

The agent must validate that the kill-switch URL is secure (HTTPS, or
localhost / 127.0.0.1) before transmitting any agent secret, and must
refuse remote HTTP endpoints. Ephemeral signing keys are held in memory
only and never exposed to the frontend or off-chain database.

### State Locking

A transaction-level lock in the local database (SQLite / LibSQL) prevents
concurrent trading actions while a transaction trace is pending or before
state sync completes. Any lock outstanding for more than 5 minutes resolves
automatically as a timeout (zero orphan locks).

## Development Workflow & Promotion Gates

### Test-First (Non-Negotiable)

Tests must be written for both the Tolk budgeting contract and the
TypeScript pipeline components before the corresponding implementation is
considered complete. The test pyramid includes unit tests, integration
tests, contract tests against TVM simulators / sandbox, and adversarial /
red-team tests for prompt-injection and rug-detection paths.

### Promotion Path

Features move through staged environments in order:
1. **Testnet + paper trading** — full pipeline, no real value.
2. **Mainnet-live-capped** — real funds, sub-wallets capped at operator-set
   minimum, all trades HITL-approved.
3. **Mainnet-live-full** — only after a clean run of the previous stage
   for a period defined by the operator.

### Monorepo Structure

- `apps/agent/` — headless 24/7 runtime (coordinator, kill-switch, circuit
  breaker, DEX integrations, risk guardrails, wallet interfaces).
- `apps/web/` — Next.js dashboard (control plane, radar, ReAct timeline).
- `packages/shared/` — Zod schemas and types shared across apps.
- `contracts/` — Tolk on-chain smart contracts (e.g.
  `budgeting-wallet.tolk`).

### Observability & Tracing

Every orchestration cycle emits structured traces linking the LLM calls,
tool calls, cap-check decisions, journal entries, and on-chain
transactions that participated in it. Traces must be reconstructable from
the journal alone.

## Governance

This constitution supersedes all prior practices and ad-hoc rules in the
repository. Any architectural decision, PR, or review that conflicts with
Principles I–V or the standards above must be justified in writing with:
(a) the specific principle or standard being violated, (b) why the
violation is necessary, and (c) the simpler alternative that was rejected
and why.

Amendments require: (1) a written proposal linked from this file's git
history, (2) explicit operator approval, (3) a migration plan for any
existing code or spec that relied on the prior text, and (4) a version
bump following semantic versioning — MAJOR for principle or standard
changes, MINOR for clarifications that do not weaken guarantees, PATCH for
editorial fixes.

Use `CLAUDE.md` and the plan files under `specs/[###-feature]/plan.md` for
runtime development guidance; this file is the authoritative source for
the principles that bound what those documents may propose.

**Version**: 1.0.0 | **Ratified**: 2026-07-16 | **Last Amended**: 2026-07-17
