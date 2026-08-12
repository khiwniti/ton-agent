# Aligned TP/SL Design — TON Agent

**Date:** 2026-08-12
**Status:** Approved by operator (2026-08-12). Live-enable decision made: ship features enabled on mainnet; workstream 0 (economic-viability) gate **waived by operator**.
**Deployed:** yes (2026-08-12)

## Provenance

This design aligns the agent's TP/SL behaviour onto the conversation chain
"Intelligent Stop Loss and Take Profit for Swing Trading Crypto"
(`https://claude.ai/chat/a22d6c6d-f334-4f56-9c22-0061314b9f67`), whose full
export is at `~/Downloads/Intelligent Stop Loss and Take Profit for Swing Trading Crypto Aug 11 2026.md`.

It **replaces** the provenance caveat in
`docs/superpowers/specs/2026-08-11-per-technique-exit-policy-design.md`. That
spec was written when the chain's text was unreadable and explicitly stated:
"*If the chain's actual text contradicts anything here, the chain wins and this
document must be revised.*" The chain text is now in hand. This document is that
revision.

**Decisions taken in this revision (operator-confirmed 2026-08-12):**

1. **Winner-close mechanism:** profit-armed peak-giveback trail as the core,
   with an ATR band (Chandelier-style) as a **journal-only corroboration**
   signal — never a hard sell trigger alone.
2. **Deploy posture:** enable live on mainnet now. Workstream 0 (demonstrated
   positive-expectancy round trip before exit tuning) is **waived by the
   operator**. Standing circuit breakers (OBSERVE_ONLY, daily-loss) remain the
   safety net.
3. **Scope:** TP/SL **and** sizing. Fees/routing, MCP tooling, AI-filter
   behaviour are out of scope.

## Problem

The chain's user message states the two production problems this design
addresses:

1. **When/how to close with most profit and least loss** — "close that order as
   soon as trend significantly changes from uptrend to downtrend."
2. **SL must survive swing-down-first sequences** — "some orders swing down to a
   new low first, then swing up to a new high" — so a naive static SL stops out
   trades that would have recovered. SL needs a structure/volatility-aware
   buffer, not a fixed −35% wall.

Current deployed behaviour (probed prod `ton-agent-runtime`, 2026-08-12):

| Feature | Deployed now | Chain intent |
|---|---|---|
| Winner close | No TP; trend-flip close (fast 7 / slow 25 EMA, 3 confirm ticks) | Close on significant uptrend→downtrend change |
| Trail | Off (`SNIPER_GIVEBACK_ENABLED=false`) | Let winners run, don't cap |
| SL | Static −35% (SWING + SNIPER); structure/ATR stop live via policy-engine | SL at/below structure with ATR buffer; vol-adaptive so noise-dips don't stop out |
| Vol-widened SL | Off (`SNIPER_SL_VOL_WIDEN=false`) | SL adapts to volatility regime |
| Time-stop | Off (`SNIPER_MAX_HOLD_MS=0`) | Hard time-stop for sniper module |
| Sizing | `perTradeTon=0.15`, `minViablePositionTon` floor | Min-viable size (gas < 1%), % of pool depth, slippage-probe |

## Design

### 1. Winner-close: giveback trail + ATR corroboration

**Core close — profit-armed peak-giveback trail (already implemented; ship-enabled):**

- Arms only when unrealized PnL ≥ `givebackArmPct` (default **10%**).
- Once armed, exits when price gives back ≥ `givebackDropPct` (default **15%**)
  from the running peak.
- **Clamped to never fire below entry** — the trail can never convert a winner
  into a net loss.
- Rationale (chain-aligned): "let winners run, don't cap." Supporting prod
  evidence (F3): CATBLAST peaked +142.6%, FEELS +336.4% — both would have armed
  the trail.

**Corroboration — ATR band (journal-only, new):**

- A 3× ATR band trails behind the highest high (Chandelier-style), mirroring the
  existing `TREND_EXIT_ATR_MULT=3.0` (already journal-only today).
- **Never a sell trigger alone.** Written to the append-only `decision_journal`
  for post-trade analysis and future tuning.
- This gives the chain's Chandelier/Supertrend signal a seat at the table
  without re-opening the spec's §2.3 rejection (fixed-band TPs truncate the
  power-law right tail; partial exits are gas-hostile).

**Interaction with existing closes (final close priority):** structure-stop,
giveback, and trend-flip are each independently sufficient to close. Vol-widened
SL widens the **stop-loss threshold** (base −35% extends to at most −50% in a
SPIKED regime) — it is not itself a trigger, and it does not delay or suppress
the other triggers. Time-stop closes anything still open at `maxHoldMs`.
Closest to the chain's "SL adapts so noise-dips don't stop you out" while the
three real triggers (structure, giveback, trend-flip) stay authoritative.

### 2. Structure SL + volatility-widened SL

**Structure SL (SWING + SNIPER) — keep as-is.** Live today via
`policy-engine.ts` (`structureStop?: { levelTon; confirmedTicks }`): an
ATR-buffered stop below recent structure, gated by `confirmedTicks` so a single
wick cannot stop it out. This is the chain's structure-based SL.

**Volatility-widened SL (SNIPER) — ship-enabled:**

- `SNIPER_SL_VOL_WIDEN=false` → **`true`**.
- `volatility-regime.ts` (`RegimeClassifier`: CALM / NORMAL / SPIKED, with
  consecutive-tick hysteresis) feeds a widening factor: when the regime is SPIKED
  the static −35% stop widens, capped at `slVolWidenMaxPct` (default **50%**).
- This is the chain's direct answer to the swing-down-first problem: a volatility
  spike that is *market noise* widens the stop so the position survives to the
  structure break, while genuine structure breaks still stop out.

**Sizing guard:** vol-widening raises the *effective* stop distance (worst case
−50% instead of −35%), so the lot must clear the economic floor at that wider
distance. A lot is openable only if
`perTradeTon × (1 − slVolWidenMaxPct/100) ≥ minViablePositionTon` — i.e. the
worst-case SL loss leaves enough capital for the position to clear gas. Enforced
in sizing (see §4).

### 3. Time-stop (SNIPER)

- `SNIPER_MAX_HOLD_MS=0` → **`3600000`** (1 h).
- A sniper position that has not closed by any other signal (no TP ladder,
  trend not flipped, structure not broken) exits at 1 h, realizing whatever PnL
  it has.
- Chain-aligned: the chain's sniper module mandates a hard time-stop. Operator
  confirmed 1 h (long enough to not chop legitimate swings, short enough to
  bound capital).
- SWING: **no time-stop** (2026-08-09 directive; confirmed in open question #2
  of the prior spec).

### 4. Sizing (chain recommendations)

Three changes:

1. **Min-viable floor** — keep. `minViablePositionTon` =
   `gasTon / ((1 − feePct/100) × (1 + targetPct/100 / safetyFactor) − 1)`.
   With gas 0.2 TON / fee 0.6% / TP 150% / safety 1 → floor ≈ **0.1347 TON**
   (cleared by 0.15 lots). Document as the hard floor: any lot below it is
   economically unopenable (gas eats the profit).
2. **%-of-pool-depth cap — new.** `maxPoolDepthSharePct` (default **2%**): caps
   `perTradeTon` at 2% of the pool's depth so a buy cannot move the price more
   than ~2% against itself. Prevents the "I moved the market" slippage spiral
   on thin x1000 memepad pools.
3. **Slippage-probe — new.** Before executing, request the real quote
   (STON.fi `/simulate` or DEX quote). If the projected fill deviates from the
   pool-price assumption beyond a tolerance, either widen the expected-PnL model
   or skip the entry. Prevents buying a fill worse than the model assumes.

### 5. Circuit breakers (standing safety net)

Workstream 0 is waived, so these are the ongoing protection:

- **`OBSERVE_ONLY=true`** — kill-switch: blocks all new entries, keeps exits
  armed. If newly-enabled exits misbehave, this is the immediate brake.
- **Daily-loss circuit breaker** — stops new entries once the configured daily
  loss budget is consumed.

Both pre-exist and are unchanged; they are restated here as the committed safety
net for the waived gate.

### 6. Testing

- Existing suites remain green (29 files): policy-engine, volatility-regime,
  sniper-filters, sticky-close P&L regression.
- **New tests:**
  - Giveback: arm at exactly `armPct`; fire at exactly `dropPct` from peak;
    clamp below entry (never nets a loss); drop-off after re-peak.
  - ATR corroboration: band computed from closes; journal row written; **never**
    closes a position on its own.
  - Vol-widened SL: SPIKED regime widens stop; clamp at `slVolWidenMaxPct`;
    CALM returns to base.
  - Time-stop: position open > 1 h closes with realized PnL.
  - Pool-depth cap: lot reduced when `perTradeTon > depth × maxPoolDepthSharePct`.
  - Slippage-probe: over-tolerance quote → skip; within tolerance → proceed.
  - Sizing guard: `minViablePositionTon` > `spent_ton × slVolWidenMaxPct`
    enforced.

## Deployed-config change summary

| Secret | From | To |
|---|---|---|
| `SNIPER_GIVEBACK_ENABLED` | `false` | `true` |
| `SNIPER_MAX_HOLD_MS` | `0` | `3600000` |
| `SNIPER_SL_VOL_WIDEN` | `false` | `true` |
| `SNIPER_MAX_OPEN_POSITIONS` | `2` | 5 (team memory: v252 raised to 5 at 5/5) |
| `SNIPER_PER_TRADE_TON` | `0.15` | unchanged |
| `STOP_LOSS_PCT` / `SNIPER_STOP_LOSS_PCT` | `35` | unchanged (base; vol-widen extends to 50) |
| `TREND_EXIT_*` | fast 7 / slow 25 / confirm 3 | unchanged |

## Follow-ups (flagged, not in scope)

- **Workstream 0 re-open:** a positive-expectancy round-trip measurement becomes
  the *exit* criterion for tuning (not the entry gate). Once realized P&L is
  being captured (F5 fix), the giveback arm/drop, time-stop, and vol-widen max
  become tuneables against measured round-trip stats.
- **ATR corroboration → hard trigger:** revisit making the Chandelier band a
  hard exit once journal data shows it agrees/disagrees with the giveback trail.
- **Testnet round trip:** optional pre-promotion validation of sizing economics.
