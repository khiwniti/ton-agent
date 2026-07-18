# Feature Specification: Autonomous AI Agent Orchestration Framework (TAOF) for the TON Ecosystem

**Feature Branch**: `001-ton-agent-orchestration`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Autonomous AI Agent Orchestration Framework (TAOF) for the TON Ecosystem"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Budget-Delegated Autonomous Trading (Priority: P1)

As a TON wallet owner, I want to deploy a budgeting smart contract and delegate ephemeral trading keys to an off-chain AI agent, so that the agent can trade autonomously on STON.fi and DeDust.io within strict daily bounds without exposing my master keys.


**Why this priority**: Core value proposition of TAOF is secure delegation (non-custodial agentic wallets) resolving the safety issue of giving LLMs access to funds.

**Independent Test**:
1. Deploy the budgeting contract on-chain (or simulated local TVM) with a 2 TON daily limit.
2. Delegate an ephemeral public key to the agent.
3. Sign and dispatch a trade transaction of 0.5 TON signed by the ephemeral key, validating successful completion.
4. Try to sign and dispatch a trade transaction of 2.5 TON, validating that the contract rejects it with exit code 102.

**Acceptance Scenarios**:

1. **Given** a deployed budgeting contract with a daily limit of 2 TON and agent public key authorized, **When** the agent submits a signed swap message of 0.5 TON, **Then** the contract verifies the signature, accumulates the spend, and routes the trade successfully.
2. **Given** a daily accumulated spend of 1.8 TON under a 2.0 TON daily limit, **When** the agent submits a signed swap message of 0.5 TON, **Then** the contract rejects the message with exit code 102 (Limit Exceeded) and keeps daily spent unchanged.
3. **Given** a daily accumulated spend of 1.5 TON, **When** the timestamp progresses past 86400 seconds (24 hours) since the last reset, **Then** the contract resets accumulated spend to 0 and allows new swaps.

---

### User Story 2 - Real-Time Trend Trading Pipeline (Priority: P2)

As a trader, I want the agent to scan real-time market data, check tokens for honey-pots, run risk validation, simulate transactions, and execute swaps, so that it can capture market opportunities with low slippage and high security.

**Why this priority**: This ensures the agent behaves as a profitable, trend-following system with automated safety logic.

**Independent Test**:
1. Inject a hot token event (e.g. pool created with $15,000 liquidity).
2. Verify that the agent checks if the token contract is verified, checks the budget, checks slippage limits, simulates execution, and then triggers a trade.

**Acceptance Scenarios**:

1. **Given** a new token pool is detected on STON.fi, **When** the token contract is unverified or has locked-mint permissions, **Then** the agent's Honeypot Filter flags it as unsafe and skips the trade.
2. **Given** a verified token pool, **When** the target trade size exceeds 5% of the agent's available wallet balance, **Then** the Local Risk Agent restricts the trade size to exactly 5% of the balance before plan generation.
3. **Given** a validated trade plan, **When** the simulated swap returns slippage higher than 1.5%, **Then** the transaction generator halts execution and logs a slippage rejection.

---

### User Story 3 - Emergency Kill-Switch & Fail-Safe Halting (Priority: P2)

As a system operator, I want the agent to poll a central kill-switch endpoint, so that all trading activity immediately stops if the kill-switch is active or if the connection is lost/unreachable.

**Why this priority**: Essential operational safeguard to prevent runaway trading or host compromise from draining assets.

**Independent Test**:
1. Trigger the remote kill-switch endpoint.
2. Verify that the agent transitions to a halted state within 30 seconds and rejects any trading signals.
3. Simulate network failures to the kill-switch endpoint.
4. Verify that after 3 consecutive failures, the agent trips its own circuit breaker and enters a halted state.

**Acceptance Scenarios**:

1. **Given** an active trading loop, **When** the kill-switch URL returns `active: true` or a status indicating a stop, **Then** the agent sets the circuit breaker to inactive, cancels all pending executions, and yields.
2. **Given** the agent is trading normally, **When** the kill-switch URL becomes unreachable for 3 consecutive polls, **Then** the coordinator auto-trips the circuit breaker, logs the miss reason, and transitions to safe halted state.
3. **Given** an auto-tripped kill-switch due to network failure, **When** the endpoint becomes reachable again and returns `active: false`, **Then** the coordinator lifts the halt and resumes trading.

---

### Edge Cases

- **Asynchronous trace timeouts**: A transaction is dispatched but never returns execution finality due to a TON validator delay. The agent must release the local lock after a maximum timeout (e.g., 5 minutes) and log the trade as failed/expired.
- **Bounced messages on-chain**: If a swap fails on-chain, TON contracts send a bounced message. The budgeting contract must detect and ignore bounced messages (checking the bounce flag) to prevent state corruption.
- **Double-spend race condition**: If two trade proposals are generated concurrently, the agent must serialize transactions using a storage-level transaction lock (e.g. key in DB) to prevent double-spending or exceeding the daily budget limit off-chain before the chain state updates.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (On-Chain Guardrail Contract)**: The framework MUST include a Tolk budgeting smart contract that validates signatures against the delegated ephemeral agent public key.
- **FR-002 (On-Chain Budget Limits)**: The Tolk contract MUST reject any transactions exceeding the daily spent limit (exit code 102) and automatically reset the limit after 86400 seconds.
- **FR-003 (Deterministic 9-Step Pipeline)**: The agent orchestrator MUST execute trades through a rigid 9-step pipeline:
  1. Fetch Market Data (low-latency updates)
  2. Load Memory (load short-term/long-term context)
  3. LLM Analysis (evaluate trade signal)
  4. Validate Risk (local TypeScript/Python validation check)
  5. Plan Trade (formulate size, path, slippage limit)
  6. Simulate TX (simulate transaction trace)
  7. Execute Swap (dispatch signed transaction to TON RPC)
  8. Log Results (store outcomes and fees)
  9. Sync State (update dual-memory and release locks)
- **FR-004 (Local Risk Guardrails)**: The Local Risk Agent MUST enforce hard-coded typescript validation rules: max 5% portfolio allocation per trade, max 1.5% slippage, and stop-loss/take-profit check.
- **FR-005 (State Synchronization & Locking)**: The system MUST maintain a transaction-level lock in the SQLite/LibSQL database to block concurrent trading actions while a transaction trace is pending or before state sync completes.
- **FR-006 (Fail-Safe Kill-Switch)**: The coordinator MUST poll the kill-switch URL every 30 seconds. If the URL is `active: true` OR fails to respond for 3 consecutive attempts, the coordinator MUST trip the circuit breaker and halt all agent execution.
- **FR-007 (Secure Communications)**: The agent MUST validate that the kill-switch URL is secure (HTTPS or localhost/127.0.0.1) before transmitting the agent secret, and refuse remote HTTP endpoints.
- **FR-008 (DEX Router Integration)**: The agent MUST fetch optimal routing and swap simulation data from STON.fi and DeDust.io APIs.

### Key Entities

- **AgenticWallet**: Represents the delegated on-chain smart contract. Has attributes: contract address, daily limit, accumulated spend, last reset timestamp, and delegated agent public key.
- **TradeTransaction**: Represents an executed or pending swap. Has attributes: transaction hash, source token, target token, input amount, output amount, status (Pending, Success, Failed, Bounced), gas fees, timestamp.
- **MarketPoolState**: Represents real-time liquidity pools tracked from Bitquery or DEX APIs. Has attributes: pool address, token pair, reserve amounts, volume, and last transaction timestamp.
- **KillSwitchStatus**: Represents the status of the emergency stop mechanism. Has attributes: active (boolean), consecutive misses, last poll timestamp, auto-tripped status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of dispatched transactions are verified on-chain to not exceed the daily budget limit configured on the Tolk contract.
- **SC-002**: Under simulated network partition or API crash of the kill-switch server, the agent halts all trades within 90 seconds (3 consecutive 30-second poll misses).
- **SC-003**: The trade simulator detects and rejects swaps with slippage > 1.5% with 100% accuracy before message dispatch.
- **SC-004**: The local database maintains zero orphan locks (any lock outstanding for > 5 minutes is resolved automatically as a timeout).

## Assumptions

- **A-001**: The user has deployed the budgeting Tolk contract on-chain and funded it before starting the agent.
- **A-002**: Low-latency data is available via Bitquery GraphQL or DEX APIs.
- **A-003**: The central kill-switch server is standard HTTP/HTTPS API.
- **A-004**: The agent's ephemeral key is generated and stored securely in local environment or Termux environment.
- **A-005**: Gas fees are paid in TON and are within normal bounds for simple Jetton transfers (usually < 0.1 TON per trade).
