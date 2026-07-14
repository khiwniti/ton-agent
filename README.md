# 🤖 TON Agent — Autonomous Trading Agent + Owned Web App

> **Status**: pre-alpha, migrated from `ton-sniper-vercel-bot` (Telegram/LINE) into a self-hosted web app + headless agent runtime.
> **Risk**: this software can lose 100% of funds it controls. Use a dedicated hot wallet.

---

## What this is

A monorepo that turns Termux (or any VPS) into an autonomous TON trading agent:

```
ton-agent/
├── apps/
│   ├── web/        # Next.js 15 web app (deploy to Vercel) — UI, control plane
│   └── agent/      # Headless 24/7 agent runtime (runs on Termux)
├── packages/
│   └── shared/     # Zod schemas + types shared between web & agent
└── .env.example    # full env spec
```

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│             OWNED WEB APP — Next.js 15 (Vercel)                  │
│   Trading UI • Agent Chat (ReAct timeline) • Live Radar • Settings│
│   /api/ingest  /api/agent/*  /api/radar/stream  /api/auth/*      │
│                          │  (HTTPS + shared secret)              │
│              Supabase (Postgres + Realtime)Backing               │
└──────────────────────────────┬───────────────────────────────────┘
                               │
┌──────────────────────────────┴───────────────────────────────────┐
│              AGENT RUNTIME — this Termux (or VPS)                │
│                                                                  │
│   LangChain ReAct Brain (LangGraph) — Tavily • NVIDIA NIM •      │
│     Anthropic • OpenAI fallback — writes a PLAN before any trade │
│                                                                  │
│   Tools (MCP-style, LangChain tool calling):                      │
│     • get_wallet_balance • audit_jetton • get_jetton_meta         │
│     • get_jetton_price • execute_swap (Ston.fi / DeDust)         │
│     • watch_position • notify_web                                │
│                                                                  │
│   Loops:  Radar (60s) • Position monitor (10s)                   │
└──────────────────────────────────────────────────────────────────┘
```

### Why we migrated away from Telegram/LINE

- No per-message API costs (LINE charges above free tier; TG rate-limits).
- Full UI control — professional trader charts, hotkeys, multi-account views.
- Server-signed keys — mnemonic never leaves Termux; only tx hashes go upstream.
- ReAct timeline rendered in a proper workspace, not 4096-char chat chunks.

---

## Quickstart

### 1. Configure env

```bash
cp .env.example .env
# Fill in WALLET_MNEMONIC + at least one AI key + PUBLIC_WEBHOOK_URL
```

### 2. Install (monorepo)

```bash
npm install          # uses .npmrc legacy-peer-deps + onnxruntime override
```

### 3. Run agent runtime (Termux)

```bash
npm --workspace apps/agent run dev          # main 24/7 brain
npm --workspace apps/agent run wallet       # one-shot wallet info
npm --workspace apps/agent run audit -- EQ… # one-shot security audit
npm --workspace apps/agent run plan -- "audit and trade …"
```

### 4. Develop the web app (PC, Vercel)

```bash
npm --workspace apps/web run dev
npm --workspace apps/web run deploy      # `vercel deploy --prod`
```

The web app uses Supabase for persistence + realtime streams. See
[`apps/web/README.md`](apps/web/README.md) (to be added).

---

## Branching strategy

- `main` — protected, only reviewed PRs merge here. Treat as the stable backbone.
- `dev` — long-lived dev integration branch on the PC.
- `feat/*`, `fix/*` — short-lived feature branches off `dev`.
- This initial commit lands on `feat/initial-migration-from-sniper-bots`.

---

## License

MIT. Use at your own risk. Cryptocurrency trading is highly volatile. This
software does not guarantee profits.
