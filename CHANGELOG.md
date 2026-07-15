# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Tiered 3-wallet trading model** — a single master mnemonic derives
  `LOW` / `MID` / `HIGH` sub-wallets, each with independent risk caps,
  stop-loss and take-profit thresholds. `HIGH` tier ships disabled by default
  and unlocks only after a minimum number of closed trades.
- **Sell-side execution** — the agent now closes positions (take-profit tiers
  and stop-loss), not just entries.
- **Nonce lock** — serialized transaction sending per wallet to prevent
  seqno collisions and dropped transactions under concurrency.
- **Circuit breaker** — global guardrails halt trading on daily loss limit
  (`MAX_DAILY_LOSS_TON`) and cap LLM calls per hour.
- **SQLite persistence** — positions, trades, and agent state survive restarts
  via a local database under `DATA_DIR`.
- **Web dashboard** — Next.js app (deployed on Vercel) rendering live
  positions, radar events, and the ReAct agent timeline via signed ingest.
- **Docker packaging** — multi-stage Dockerfile and `docker-compose.yml` for
  the agent runtime, with a bound-to-localhost health server and healthcheck.
- **Observability & governance scaffolding** — health endpoint, structured
  logging, `OBSERVE_ONLY` safe-boot mode, and repo governance files
  (LICENSE, CODEOWNERS, SECURITY, CONTRIBUTING, CI).

## [1.0.0] - 2026-07-14

### Added
- Initial monorepo migration from `ton-sniper-vercel-bot`: agent runtime
  (LangChain ReAct brain, TON wallet signer, Ston.fi/DeDust routing, mempool
  radar) plus shared types package.

[Unreleased]: https://github.com/khiwniti/ton-agent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/khiwniti/ton-agent/releases/tag/v1.0.0
