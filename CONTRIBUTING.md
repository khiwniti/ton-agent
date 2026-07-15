# Contributing

Thanks for helping build the TON trading agent. This is money-touching
software — please read the whole guide before opening a PR.

## Branch strategy

```
main         ← protected, always deployable. No direct pushes.
 └── dev     ← integration branch. Feature branches merge here first.
      └── feat/<short-name>   ← your work branches off dev
          fix/<short-name>
          chore/<short-name>
```

- **`main`** is protected: merges only via reviewed PR, CI green.
- Cut feature branches from **`dev`**, not `main`:
  `git switch dev && git pull && git switch -c feat/my-thing`
- Keep branches focused and rebase on `dev` before opening the PR.

## Pull request checklist

Before requesting review, confirm:

- [ ] Branched off `dev` (or targeted correctly for a hotfix).
- [ ] `npm install --legacy-peer-deps` succeeds cleanly.
- [ ] Agent typechecks: `npx --workspace apps/agent tsc -p apps/agent/tsconfig.json --noEmit`
- [ ] Web typechecks: `npm --workspace apps/web run typecheck` (if touched).
- [ ] Tests pass: `npm test --if-present --workspaces`.
- [ ] Agent builds: `npm --workspace apps/agent run build`.
- [ ] **No secrets committed** — see below.
- [ ] Changes to `apps/agent/src/{dex,wallet,risk}/` are called out
      explicitly (these require owner review — see `CODEOWNERS`).
- [ ] `CHANGELOG.md` `[Unreleased]` updated for user-facing changes.

## Never commit `.env`

`.env` holds a **live wallet mnemonic** and API keys. It is gitignored — keep
it that way.

- Copy the template: `cp .env.example .env`, then fill it in locally.
- Add new config **only** to `.env.example` (with a safe placeholder and a
  comment), never to `.env` in a commit.
- If you ever commit a secret: rotate it immediately (new mnemonic, new keys,
  new `AGENT_SHARED_SECRET`) — history rewriting alone is not enough.

## Running locally

### Prerequisites
- Node.js **>= 20**
- `npm install --legacy-peer-deps` at the repo root (workspaces).

### Agent runtime (`apps/agent`)
```bash
cp .env.example .env      # fill in mnemonic + keys
npm --workspace apps/agent run dev        # ts-node, hot path
# or built:
npm --workspace apps/agent run build && npm --workspace apps/agent start
```
Smoke-test safely without trading by setting `OBSERVE_ONLY=true` in `.env`.

Docker (agent only):
```bash
docker compose up --build          # health at http://127.0.0.1:9090/healthz
```

### Web dashboard (`apps/web`)
```bash
npm --workspace apps/web run dev          # Next.js, http://localhost:3000
```
The web app is deployed to **Vercel** (see `vercel.json`); it is not part of
the agent Docker image.

## Code style

- `.editorconfig` is authoritative: 4-space indent for TS, 2 for JSON/YAML,
  LF line endings, final newline, trimmed trailing whitespace.
- Keep shared types in `packages/shared` — both apps import them.
