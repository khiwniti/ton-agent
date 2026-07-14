# Pull Request — TON Agent

## Summary
<!-- What does this PR change and why? One paragraph max. -->

## Risk surface
<!-- Does this touch:
  - [ ] Trading execution (dex/router.ts, position-manager.ts)
  - [ ] Wallet secret handling (wallet/wallet.ts)
  - [ ] AI/LLM prompts (ai/brain.ts)
  - [ ] External integrations (stonfi, dedust, tonapi, nvidia)
  - [ ] CI / repo config
If any ticked, explain how this was tested.
-->

## Checklist
- [ ] `npm install` works (no new platform-specific deps)
- [ ] `.env` not committed (only `.env.example`)
- [ ] `npm --workspace apps/agent run wallet` runs without error
- [ ] No hardcoded mnemonics / API keys anywhere in this diff
- [ ] Trade brain sanity-checked offline (no real tx broadcast)

## Testing
<!-- Commands run + outputs trimmed to relevant lines. -->

## Notes for reviewer
<!-- Anything non-obvious. -->
