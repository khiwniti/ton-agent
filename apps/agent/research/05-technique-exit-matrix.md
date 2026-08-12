# Technique Exit Matrix

> Source: "Intelligent Stop Loss and Take Profit for Swing Trading Crypto" (Claude conversation chain, 2026-08-11 export), aligned onto the TON agent's operator directives.

## Directive recap (2026-08-09, unchanged)

- **NO take-profit target, NO trailing stop.** Winners ride the trend with no fixed profit target and close ONLY on a confirmed significant uptrend → downtrend flip (`trend_exit`, `src/exit/trend-monitor.ts`).
- The **static stop-loss is the hard loss floor** (`stopLossPct`).
- The **ATR band is corroboration-only** — journaled, never a sell trigger (Chandelier/Supertrend trailing-TP from the conversation chain is deliberately NOT adopted).
- Emergencies require a **measured DELTA** (`rugSignal`: liquidity drain, good→bad safety dimension). A static `auditVerdict.ok=false` is NOT an exit.

This matrix assigns each technique its correct class and its own distinct TP/SL rule, and marks which are implemented vs documentation-only.

## Taxonomy table

| Technique | Class | In-scope for exit work? | TP rule | SL rule |
|---|---|---|---|---|
| SWING (hotpath monitor, `position-monitor.ts` + `policy-engine.ts`) | Trend-following structural exit | **In-scope** — the policy-engine path (Phase 4.5 complete) | **NONE** — ride until confirmed `trend_exit` (directive) | Static % floor + structure stop `highWater − mult×ATR` (close-confirmed, `stopConfirmTicks`); SPIKED regime raises trend-exit confirm cost (`trendExitSpikedExtraTicks`) |
| SNIPER (x1000 memepad, `sniper/engine.ts` + `sniper/filters.ts`) | Short-hold, low-liquidity tactical | **In-scope** — extended with hard time-stop + vol-widened SL | **NONE** — `trend_exit` only (directive) | `sniper.stopLossPct` floor + **vol-widened SL** (widens when realized vol is elevated vs entry baseline, loss-side only) + **hard time-stop** (`time_exit` at `maxHoldMs`) |
| Safety gate (LP lock/burn, mint auth, ownership renounce, holders <20%) | Pre-trade risk gate | In-scope as entry filter (already in sniper hard gates) | — | — |
| Fee-optimal routing (router choice / route selection) | Routing concern | **Documentation-only** | — | — |
| Multi-size slippage probing (probe quotes at multiple sizes) | Sizing/execution concern | **Documentation-only** | — | — |
| Bonding-curve→DEX graduation watcher | Entry/monitoring (detects migration event) | **Documentation-only** (entry-side) | — | — |

## Per-technique exit rules

### SWING — structural trend-following (implemented, Phase 4.5)
- **Close trigger**: confirmed significant downtrend flip (`trendSignal.bearish` from `TrendTracker`, consecutive `confirmTicks`). In a SPIKED volatility regime, confirmation cost rises by `trendExitSpikedExtraTicks` (single-tick noise passes a fixed counter faster on volatile days).
- **Loss floor**: static `pnl <= -stopLossPct` always fires (hard line). Plus a structure stop at `highWater close − mult×ATR`, clamped to never sit below the static floor, firing only after `stopConfirmTicks` consecutive closes beyond the level (no wick/intrabar stop).
- **Flash-crash separation**: `rugSignal` → `emergency_exit` measures liquidity drain on RAW ticks (fast layer); the EMA/ATR smoothing sits ONLY on the trend/stop path.

### SNIPER — short-hold tactical (implemented 2026-08-11: time-stop + vol-widened SL)
- **Close trigger**: same confirmed `trend_exit` (directive), with the gas-aware noise floor (`netProceedsTon`): a confirmed flip on a gross winner or a gap-through loser fires; a shallow gross loser above the stop holds when gas dominates the notional.
- **Loss floor**: `sniper.stopLossPct` (default 35). When recent realized vol is elevated vs the entry-window baseline (`realizedVol > 1.5× base`), the floor is WIDENED toward `slVolWidenMaxPct` — re-anchored off post-entry ATR per the conversation's backtest conclusion (a pre-hunt low-vol 3×ATR was too narrow for an 18–20% flash drop). **Loss-side only; never a trailing rule.**
- **Time rule**: hard `time_exit` when `now − entry_at >= maxHoldMs` (0/absent = disabled). The conversation chain's recommendation for low-liquidity short-hold entries — if the thesis hasn't played out within N minutes, exit regardless of pnl. Runs BEFORE the static stop (a benign-pnl position at the deadline closes on time).

### Safety gate (entry filter — already in sniper hard gates)
LP lock/burn, mint authority, ownership renounce, holder concentration. Non-negotiable pre-trade; not an exit rule.

## Integration decision (why the two engines stay separate)

`SWING` and `SNIPER` keep **architecturally separate exit paths** (`evaluateExitPolicy` for SWING, `decideExit` for SNIPER):
- The sniper needs distinct rules the pure engine does not have: hard time-stop, vol-widened SL, and the gas-aware noise floor with feed corroboration (`confirmedByFeeds`).
- Unifying would force config + context + test churn across both paths for zero behavioral gain.
- A `technique` column (`"swing"` / `"sniper"`) records provenance on every position so per-technique reporting and future profile selection can read it back; nothing gates on it yet.

## Journaling note

Both paths journal exit decisions (shared `decision_journal`, append-only). Sniper positions carry `max_hold_ms` / `exit_by_ms` (journaled for the operator; recomputed from `entry_at` at monitor time so config changes take effect live).
