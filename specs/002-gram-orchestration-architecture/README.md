# 002 — GRAM Autonomous AI Agent Framework

Implementation-ready architecture for the autonomous TON trading agent framework, **aligned to the GRAM Orchestration Architecture Specification** and the existing `001-ton-agent-orchestration` foundation.

| Doc | Purpose |
|-----|---------|
| [architecture.md](./architecture.md) | Full design: layers, cold/hot path, LangGraph topology, SafetyCaps, custody, Telegram, phases |

## Relationship to 001

| 001 (done / foundation) | 002 (this design) |
|-------------------------|-------------------|
| Budgeting wallet (Tolk) | Orchestration above it |
| 9-step pipeline seeds | Explicit supervisor graph + pure gate nodes |
| Guardrails / kill-switch | SafetyCaps façade + HITL + journal |
| Single ReAct brain | Specialists + cold/hot split |

## Quick mental model

```text
LLM proposes  →  SafetyCaps authorizes  →  Agentic wallet executes
     cold              deterministic              hot path
```

## Next

See architecture §17 (phases) and §22 (recommended first engineering steps).
