# Security Policy

## ⚠️ Hot-wallet risk warning

This project is an **autonomous trading agent that signs on-chain
transactions with a live TON wallet**. By running it you accept that:

- The agent holds a **hot wallet** — its signing key is loaded in memory on
  the agent host for as long as the process runs. A compromised host means a
  compromised wallet.
- Only fund the master mnemonic with **capital you can afford to lose
  entirely**. Bugs, market conditions, malicious tokens (honeypots, rug
  pulls), or a host breach can drain funds.
- The `HIGH` risk tier ships **disabled by default** and should stay off
  until you have reviewed the strategy and accept the amplified downside.

### Key handling guarantee

The **master mnemonic never leaves the agent host**. It is read from the
local environment (`.env` / process env), used only to derive signing keys
in-process, and is **never** transmitted to the web dashboard, logged, sent
to any LLM provider, or included in events posted to `PUBLIC_WEBHOOK_URL`.
Only non-sensitive telemetry (positions, radar events, PnL) crosses the wire,
authenticated with `AGENT_SHARED_SECRET`.

## Supported versions

Security fixes are applied to the latest minor release only. This is
pre-1.0-maturity software under active development.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a vulnerability

Please report security issues **privately** — do **not** open a public
GitHub issue for anything that could be exploited.

- **Email:** `security@example.com`  *(placeholder — replace with a real
  monitored inbox before going public)*
- Include: a description, reproduction steps, affected component
  (`dex` / `wallet` / `risk` / `web` / infra), and impact assessment.
- If you can, encrypt sensitive details or share a way to exchange a key.

**Response targets (best-effort):**

- Acknowledgement within **72 hours**.
- Triage and severity assessment within **7 days**.
- Coordinated disclosure once a fix is available.

## No bug bounty (yet)

There is currently **no paid bug bounty program**. Responsible disclosure is
deeply appreciated and reporters will be credited (with consent) in the
CHANGELOG once a fix ships.

## Hardening checklist for operators

- Never commit `.env`; copy from `.env.example` only.
- Run the agent on a dedicated, patched host with a firewall — the health
  server (`HEALTH_PORT`, default `9090`) is bound to `127.0.0.1` only.
- Start with `OBSERVE_ONLY=true` to smoke-test without trading.
- Set conservative `MAX_DAILY_LOSS_TON` and per-tier caps.
- Rotate `AGENT_SHARED_SECRET` and the master mnemonic if a host is ever
  suspected of compromise.
