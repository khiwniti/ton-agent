# eve-dev (Claude Code plugin)

Agents for building **Eve** apps — the filesystem-first durable agent framework documented at [eve.dev/docs/introduction](https://eve.dev/docs/introduction).

## Agents

| Agent | Color | Role |
|-------|--------|------|
| `eve-builder` | green | Scaffold, tools, run, HTTP verify, grow slots |
| `eve-subagent-designer` | cyan | Skills vs subagents, isolation, parallel delegation |

## Install / load

### Project-local (this repo)

Agents are also mirrored under `.claude/agents/` for automatic project discovery.

### As a plugin

Point Claude Code at this directory (or copy into your marketplace):

```text
.claude/plugins/eve-dev/
├── .claude-plugin/plugin.json
├── agents/
│   ├── eve-builder.md
│   └── eve-subagent-designer.md
└── README.md
```

## When to use which

- **New Eve app / first tool / `eve dev` smoke test** → `eve-builder`
- **Specialists under `agent/subagents/`** → `eve-subagent-designer`

## Eve mental model (short)

- Path is identity (`tools/get_weather.ts` → tool `get_weather`)
- Start with `agent/instructions.md` + `agent/agent.ts`
- Add `tools/`, `skills/`, `channels/`, `connections/`, `subagents/` only as needed
- Sessions are durable (Workflow SDK under the hood)
- Prefer skills over subagents when the root identity can stay the same

## Docs

- [Introduction](https://eve.dev/docs/introduction)
- [Getting started](https://eve.dev/docs/getting-started)
- [Project layout](https://eve.dev/docs/reference/project-layout)
- [Tools](https://eve.dev/docs/tools)
- [Subagents](https://eve.dev/docs/subagents)
- [llms.txt](https://eve.dev/llms.txt)
