# Technical Research: TON Autonomous AI Agent Orchestration Framework (TAOF)

This document addresses technical questions, choices, and designs for the Autonomous AI Agent Orchestration Framework (TAOF) for the TON ecosystem.

---

## 1. Tolk Smart Contract Syntax and TVM Execution

### Background
Tolk is the modern, TypeScript-like compiler for TON smart contracts, replacing FunC. It compiles directly down to TVM bytecode.

### Design Choices
- **Signature Verification**: We use the native `check_signature(message_hash, signature, agent_public_key)` function. The signature is 512 bits (64 bytes), and the message hash is 256 bits (32 bytes).
- **Daily Budget Accumulation**:
  - Daily spend accumulator reset is checked using `now() - last_reset_timestamp > 86400`.
  - The limit check enforces: `daily_spent_accumulated + transfer_amount <= daily_spent_limit`.
- **Tolk Features**:
  - `recv_internal` processes incoming messages. Bounced flag check is done via `flags & 1` which correctly ignores bounces.
  - Storage is handled via `get_data()` and `set_data()`.

---

## 2. Integration Layer via `@ton/mcp`

### Protocol Implementation
- Rather than invoking raw HTTP JSON-RPC calls, the off-chain runtime is equipped with tools conforming to the Model Context Protocol (MCP).
- Key `@ton/mcp` tools required:
  - `get_balance`: Fetches TON or Jetton balances.
  - `simulate_swap`: Calls DEX routing endpoints (Ston.fi / DeDust) to return path, fee estimation, and expected output.
  - `execute_swap`: Signs and dispatches the payload to the network.

---

## 3. Asynchronous Pipeline and Locking Mechanism

### Context
Due to TON's asynchronous transaction execution model, trades are non-blocking. A transaction is dispatched, and execution returns immediately. The state of the trade remains "Pending".

### Storage-based Locking
- To prevent race conditions, the SQLite database acts as a localized transaction lock.
- **Rules**:
  - The agent is blocked from initiating subsequent trades if a lock is active.
  - The lock is cleared when the transaction trace is indexed or after a 5-minute timeout.
- **Trace Indexing**:
  - Use TON API or indexers to fetch transaction status.

---

## 4. Kill-Switch and Circuit Breaker Design

### Failure Logic
- The coordinator polls the kill-switch endpoint every 30 seconds.
- To prevent a network outage or DNS spoofing from disabling the kill-switch, we use a fail-safe grace window of **3 consecutive misses** (90 seconds).
- Remote HTTP endpoints are blocked to prevent transmission of `AGENT_SHARED_SECRET` in cleartext. Localhost is allowed.
