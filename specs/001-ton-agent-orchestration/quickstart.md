# Quickstart Validation Guide: TON Autonomous AI Agent Orchestration Framework (TAOF)

This guide outlines the step-by-step instructions to validate that the Autonomous AI Agent Orchestration Framework works correctly.

---

## 1. Prerequisites

- Node.js >= 20.0.0 installed.
- Access to the TON Testnet RPC or mainnet node (defined in `.env`).
- Local SQLite database initialized.

---

## 2. Compilation and Test Execution

### Tolk Smart Contract Tests
To verify that the on-chain Tolk budgeting contract compiles and validates limits correctly:
```bash
# Compile and run TVM unit tests
npm run test:contracts
```
Expected output:
- Verify that `load_data()` and `save_data()` execute.
- Verify that signature check fails for wrong key (asserts with exit code 101).
- Verify that daily limit check triggers assert with exit code 102 when limit is exceeded.

### TypeScript Off-Chain Pipeline Tests
To run the typescript test suites:
```bash
# Run the agent daemon tests
npm run test:agent
```
Expected output:
- Verify 9-step pipeline execution traces mock state updates successfully.
- Verify risk validation rejects trades with slippage > 1.5%.
- Verify that consecutive kill-switch poll failures (3 misses) trip the circuit breaker and halt trades.

---

## 3. Manual Smoke Test (Sandbox/Dry Run)

You can run the agent in observe-only dry-run mode using:
```bash
OBSERVE_ONLY=true npm run dev:agent
```
Verify logs:
- `HEARTBEAT` outputs correct status.
- `COORD` logs successful checks to the kill-switch URL.
- Risk validation intercepts simulated trade signals and prints warnings when limits are exceeded.
