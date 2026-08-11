# Per-Technique Exit Policy — Design

**Date:** 2026-08-11
**Status:** Approved, not yet implemented
**Supersedes/extends:** `apps/agent/research/05-technique-exit-matrix.md`

## Provenance and its limits

This design aligns the agent's exit behaviour onto the conversation chain
"Intelligent Stop Loss and Take Profit for Swing Trading Crypto"
(`https://claude.ai/share/3ae43bc7-99b7-4d22-8e29-83a7db402c90`).

**The chain's text was NOT readable during this design session.** The share URL is
Cloudflare-gated and returned no content. This design therefore rests on two
sources:

1. `research/05-technique-exit-matrix.md`, written by a prior session that did
   have the chain's 2026-08-11 export. It is a *second-hand, filtered* record —
   it states it deliberately rejected the chain's Chandelier/Supertrend
   trailing-TP recommendation.
2. The repo's own backtest data (`apps/agent/out/backtest-trend-exit/`) and
   trading reasoning about liquidity and payoff shape.

**If the chain's actual text contradicts anything here, the chain wins and this
document must be revised.** The single most valuable follow-up is to paste or
export the chain and re-check §2 against it.

## Problem

The agent runs two distinct trading techniques under one exit doctrine.

The 2026-08-09 operator directive — *no take-profit, no trailing stop, ride
until a confirmed trend flip* — was formed for **swing trading**, where the
governing assumption is that **you can always sell later**. That assumption
holds for liquid pairs. It does not hold for x1000 memepad pools, where exit
liquidity decays and can vanish.

Applying one doctrine to both techniques is the category error this design
corrects.

### The evidence

From `apps/agent/out/backtest-trend-exit/summary.json`, PROD config
(`confirm3/minObs6`), 1,524 TON memecoin pools sampled 2026-01-27 → 2026-08-07:

```
flips:       1105  (19.2%)   position closed on a confirmed trend flip
noClose:     4648  (80.8%)   position NEVER received a close signal
heldByFloor:  212            gas noise floor suppressed the close
noiseFlips:    53  (4.8%)    premature/spurious flips
```

**Four in five sampled entries never produced a confirmed downtrend flip.** For
a strategy whose only exit is the flip, most positions do not exit — they sit
until the pool goes quiet.

**This number is unverified and must not be trusted until workstream A
completes.** An unknown share of the 4,648 is dataset-edge artifact: the window
ends 2026-08-07, so late entries cannot resolve within it. Separating genuine
pool-death from window-truncation is a precondition for every parameter in this
design.

### PRODUCTION EVIDENCE (2026-08-11) — reorders this entire design

Read live from `ton-agent-runtime:/app/data/agent.db` (136MB; 125 positions,
84 trade transactions, 11 sniper positions, 235,611 journal rows).

| Status | n | Realized PnL | Gas | Spent | Best |
|---|---|---|---|---|---|
| CLOSED | 82 | **−9.0128 TON** | 8.75 | 8.10 | **−1.9%** |
| RUG_EXIT | 26 | −0.0164 | 0 | 2.60 | −0.1% |
| STOPPED | 2 | −0.1714 | 0 | 0.20 | −85.7% |
| OPEN | 15 | — | — | 1.50 | +14.4% |

`daily_pnl_log`: `2026-08-08 = −0.5405`, `2026-08-09 = −8.6607 TON`.

Three findings, each of which invalidates part of what precedes it:

**F1 — No position has ever closed profitably.** Best closed PnL across all 82
CLOSED positions is **−1.9%**. Every status has a negative `best_pct`.

**F2 — Gas is 8.75 TON against 8.10 TON deployed: 108% of notional.** More was
paid in gas than was traded. This is why `worst_pct` reaches −201.5% — losses
exceeding 100% of position value are only reachable when gas exceeds notional.
**The round trip is negative-expectancy before any price movement.** No TP/SL
policy can repair this; it is a cost-structure defect, not an exit defect.

**F3 — The giveback trail has no data to be swept on.** All 11 sniper positions
record `peak_gain_pct = 0.0` — `peak_price_ton` never exceeded entry on any
position. A profit-armed trail would have armed zero times. §2.5's sweep
**cannot** produce values from production data as it stands.

Two further signals from `decision_journal.final_action`:

- `time_exit` **25,938** vs `trend_exit` **4,571** — the deployed configuration
  differs from the checked-out defaults, which have time-stops at `0`. Deployed
  config must be reconciled before any parameter is trusted.
- `cannot-enforce-slippage:no-quote` **20,873** and `unquotable` **165** — the
  zero-exit-liquidity case of §4E is not hypothetical. It has occurred ~21,000
  times in production.

**Consequence: the SNIPER exit work in §2.2 is premature.** Exit policy governs
*when* to close a position. It cannot make a trade profitable whose round-trip
cost exceeds its notional, and it cannot arm a profit trail on positions that
are never in profit. Gas economics and the entry/pricing path are upstream and
must be resolved first. See §4.0.

### Secondary problem: the differentiation is nominal

The rules that would distinguish SNIPER from SWING are already written and all
ship disabled:

| Key | File:line | Default | Effect |
|---|---|---|---|
| `SNIPER_MAX_HOLD_MS` | `config.ts:265` | `0` | time-stop off |
| `SNIPER_SL_VOL_WIDEN` | `config.ts:266` | `false` | vol-widening off |
| `LOW_MAX_HOLD_MS` (etc.) | `mcp/tools.ts:36` | unset → `0` | swing time-stop off |

Today, tagging a position `"swing"` vs `"sniper"` changes its exit behaviour by
nothing. Both use a 35% static stop and a trend-flip close.

## Goals

1. Categorize every technique and state which carry exit rules.
2. Give SWING and SNIPER **distinct, principled** exit policies derived from
   their liquidity and payoff shape.
3. Validate against the historical dataset rather than judgement.
4. Close the test gaps that make the current suite unsafe — above all
   `rug-detector.ts`, which has zero tests.

## Non-goals

- No change to entry logic, filters, sizing, or routing.
- No change to SWING's exit behaviour (documentation only).
- No fixed take-profit ladder for either technique (see §2.3).
- No partial exits.

---

## 1. Technique taxonomy

Classification axis: **liquidity × payoff shape**, because that pair determines
whether "ride the trend" is safe.

| Technique | Implementation | Class | Exit-bearing |
|---|---|---|---|
| **SWING** | `hotpath/position-monitor.ts` + `exit/policy-engine.ts` | Trend-following structural | **Yes** |
| **SNIPER** | `sniper/engine.ts` + `sniper/filters.ts` | Short-hold illiquid tactical | **Yes** |
| Safety gate | `sniper/filters.ts` hard gates | Pre-trade risk gate | No — entry filter |
| Fee-optimal routing | — | Execution/routing | No — documentation only |
| Multi-size slippage probing | — | Sizing/execution | No — documentation only |
| Bonding-curve → DEX graduation watcher | — | Entry detection | No — documentation only |

Unchanged from the existing matrix. The `technique` column already records
provenance correctly on both paths — `"swing"` written at `mcp/tools.ts:461`,
`'sniper'` as the column default at `store.ts:776`. **No schema or write-path
change required.**

---

## 2. Per-technique exit policy

### 2.1 SWING — no code changes

```
SWING   liquid pairs · trend payoff · time is not the risk
  TP     none                        (directive holds)
  SL     static % floor (STOP_LOSS_PCT, per-tier)
         + ATR structure stop: highWater − k×ATR, close-confirmed
           (STOP_CONFIRM_TICKS consecutive closes, clamped never below floor)
  TIME   none                        (LOW_MAX_HOLD_MS etc. stay 0)
  EMERG  rugSignal → emergency_exit  (measured delta, not static verdict)
  TREND  confirmed flip; +TREND_EXIT_SPIKED_EXTRA_TICKS in SPIKED regime
```

Rationale: on liquid pairs the risk is structural, not temporal. A time-stop on
a trend follower cuts precisely the long winners that pay for the losers.

Precedence (`evaluateExitPolicy`, `policy-engine.ts`) is unchanged:
`emergency → trend → time → stop_loss → structure_stop`.

The `time` branch stays in place and reachable (`max_hold_ms` *is* populated at
open via `tierMaxHoldMs`, `tools.ts:467`) but remains inert because the tier env
keys default to 0. This is intentional and stays that way.

### 2.2 SNIPER — three layers, all opt-in

```
SNIPER  illiquid pools · power-law payoff · exit liquidity decays
  TP     no fixed target
         + peak-giveback trail       ← NEW, profit-armed, full exit
  SL     static % floor (SNIPER_STOP_LOSS_PCT)
         + vol-widened                ← ENABLE (currently false)
  TIME   hard time-stop               ← ENABLE (currently 0)
  TREND  confirmed flip + gas noise floor (netProceedsTon)
```

New precedence in `decideExit` (`sniper/filters.ts:299`):

```
trend → giveback → time → stop
```

The trail slots **after** trend because a confirmed flip is stronger evidence,
and **before** time because a giveback exit carries a real reason that
`time_exit` would otherwise mask in the journal.

### 2.3 Why a giveback trail and not a fixed TP ladder

The dead config keys at `config.ts:237-247` (`SNIPER_TAKE_PROFIT_T1_PCT=100`,
`T2=250`, `TP1_SELL_FRACTION=0.5`, `TRAILING_PCT=0`) imply a fixed ladder.
**Rejected, for two reasons:**

1. **A fixed TP truncates the right tail.** This is an x1000 memepad sniper —
   expectancy is power-law. Capping at +100% turns a 40x into a 2x, and that
   40x is what funds the ~80% that die.
2. **Partial exits are gas-hostile.** Gas historically ran ~73% of trade cost
   (the reason `netProceedsTon` exists). Two sells on a small lot is two gas
   hits.

**A giveback trail is not a trailing stop in the sense the directive forbids.**
A trailing *stop* is a loss-side ratchet. A giveback trail arms only in profit
and never tightens below the static floor — it can only ever exit at a gain. It
does not cap upside, so a 50x runs to 50x and then leaves. It only refuses to
let a realized 20x round-trip to zero.

### 2.4 Trail invariants

Non-negotiable; each becomes a test:

1. **Profit-armed** — below `SNIPER_GIVEBACK_ARM_PCT` the trail does not exist.
2. **Never loss-side** — it cannot fire at a loss, and cannot lower or
   substitute for the static floor. **Enforced by an explicit floor, not
   implied** — see the clamp below.
3. **Full exit only** — never partial, never fractional.
4. **Monotonic peak** — reads `peak_price_ton`, which ratchets upward only.
5. **Disabled by default** — `SNIPER_GIVEBACK_ENABLED=false` ships
   behaviour-neutral.

**The clamp, and why it is required.** A naive percentage-of-peak giveback
violates invariant 2. Arm at +10%, drop 30% of peak: the level is
`1.10 × 0.70 = 0.77 × entry` — a 23% **loss**. Any `drop_pct` large relative to
`arm_pct` crosses below entry. Therefore:

```
giveback_level = max(
    peak_price × (1 − drop_pct/100),      # the giveback level
    entry_price × (1 + gas_breakeven_pct) # hard floor: never below net breakeven
)
```

The floor uses **net** breakeven, not raw entry: exiting at exactly entry price
still loses the round-trip gas. `netProceedsTon` already computes this and must
be reused rather than reimplemented. Below that floor the trail is silent and
the static stop is the only loss-side rule — which is invariant 2 made
mechanical.

### 2.5 New configuration

```
SNIPER_GIVEBACK_ENABLED   = false   # ships OFF
SNIPER_GIVEBACK_ARM_PCT   = TBD     # from sweep (workstream C)
SNIPER_GIVEBACK_DROP_PCT  = TBD     # from sweep (workstream C)
```

Values are deliberately unset. They are chosen from the sweep curve in
workstream C, then enabled explicitly by the operator — matching how
`maxHoldMs` and `slVolWidenEnabled` already shipped.

`SNIPER_MAX_HOLD_MS` and `SNIPER_SL_VOL_WIDEN` keep their current defaults
(`0` / `false`) until the sweep produces values. **This design changes no live
behaviour on merge.**

### 2.6 No state migration needed

`peak_price_ton` is already `NOT NULL` (`store.ts:758`), updated on every upsert
(`store.ts:855`), and re-anchored upward-only by `mergeFill`. The trail reads
existing state.

### 2.7 Known defect to resolve during the sweep

`effectiveStopPct` (`filters.ts:276`) interpolates `base * excess` where
`excess = realizedVol / baseRealizedVol` is **unbounded on the input side**. At
10× baseline vol it computes 350% before clamping to `slVolWidenMaxPct` (50).
The clamp does all the work and the interpolation is decorative in exactly the
conditions it was written for. The sweep must characterize the `excess`
distribution and either bound the input or reshape the curve.

---

## 3. Architecture — why the engines stay separate

`evaluateExitPolicy` (SWING) and `decideExit` (SNIPER) remain architecturally
separate, as the existing matrix concluded:

- SNIPER needs rules SWING does not have: hard time-stop, vol-widened stop,
  giveback trail, and the gas-aware noise floor with feed corroboration.
- SWING needs rules SNIPER does not have: ATR structure stop, SPIKED-regime
  confirm escalation, rug-driven `emergency_exit`.
- Unifying forces config, context, and test churn across both for no behavioural
  gain.

Both remain **pure functions over an injected state struct** — no DB, no
network, and `now` passed in rather than read from the clock. This is what makes
workstream B cheap, and it must be preserved.

Both continue to journal every decision to the shared append-only
`decision_journal`.

---

## 4. Test & validation strategy

Current state: **108 unit tests, all synthetic hand-written series.** One real
dataset exercising `TrendTracker` **only**. `rug-detector.ts` has **zero tests**.

Six workstreams, in dependency order. **§4.0 blocks everything else.**

### 0. Economic viability (BLOCKING — added 2026-08-11 from production data)

Nothing below matters until the round trip can be profitable. Three questions,
each answerable from the production DB:

**0a. Gas-to-notional.** Gas ran 108% of deployed capital (F2). Establish the
**minimum viable position size** at which round-trip gas is an acceptable
fraction of notional, and gate entry on it. A trade that cannot clear its own
gas must not be opened. Cross-check `trade_transactions.gas_fees` against
`input_amount` per trade to get the real distribution rather than the aggregate.

**0b. Why no position ever closes green (F1).** 82 closes, zero winners, best
−1.9%. A distribution that one-sided points at entry selection or price
reading, not exit timing. Specifically re-verify the jetton balance read
(`get_wallet_data` vs. storage-rent, the 2026-08-08 class of bug) and whether
`entry_price_ton` and `current_price_ton` are denominated consistently.

**0c. The 21k no-quote events.** `cannot-enforce-slippage:no-quote` ×20,873.
Determine whether these are retry storms against dead pools (the 7→<2 TON drain
signature) or benign scanner noise, and bound the retry accordingly.

**Exit criterion:** a demonstrated positive-expectancy round trip at a stated
minimum position size, or an explicit decision to stop trading the technique.

**Until 0a–0c are answered, do not tune exit parameters.** Tuning an exit on a
negative-expectancy round trip optimizes the rate of loss.

### A. Port + verify the dataset (blocking for C, not for 0)

`backtest-trend-exit.ts` exists only on `feat/live-monitor-trend-exit`; the
27MB output is on this branch but the script that produced it is not. Port it.

Then **split the 4,648 noClose into pool-died vs window-truncated.** A pool
whose last trade is well before 2026-08-07 died; one still trading at the window
edge was truncated. Every parameter in workstreams C and E depends on this.

Exit criterion: a defensible noClose figure with the artifact removed.

### B. Full-engine replay harness

Extend replay past `TrendTracker` to drive `decideExit` and
`evaluateExitPolicy` end-to-end, so it validates the **exit system** rather than
one component. Cheap because both are pure with injected `now`.

Exit criterion: a historical price series can be replayed through either engine
and produce the full action sequence.

### C. Parameter sweep

Grid `arm_pct × drop_pct × maxHoldMs` across the 1,524 pools.

**Report right-tail preservation, not average return.** The question is *did we
keep the 40x*, not *did mean PnL improve*. A configuration that lifts the mean
by clipping the tail is a failure. Report the full realized-PnL distribution and
the largest-winner outcome per config.

Also characterize the `excess` vol distribution for §2.7.

**Constrain the grid by the §2.4 clamp.** Combinations where `drop_pct` is large
relative to `arm_pct` are clamped to the breakeven floor, so they collapse onto
identical behaviour and waste sweep budget. Either restrict the grid to
`arm_pct > drop_pct` (uncapped region) or report which cells were clamped, so a
"best" cell is not an artifact of the floor.

Exit criterion: defensible defaults for all three keys, chosen from a curve.

### D. Rug-detector tests (highest severity, independent)

`detectLiquidityDrain` and `detectAuditDegradation` are untested and are the
only thing between the wallet and a liquidity drain. Cover: clean drain,
gradual drain, drain vs. normal volatility, static-verdict-only (must **not**
fire — this caused 26 false RUG_EXITs), audit good→bad transition, non-finite
and missing inputs (fail closed).

This is worth doing regardless of the rest of this design.

### E. Uncovered real-life cases

As unit tests against both engines:

| Case | Why it matters |
|---|---|
| **Zero exit liquidity (no bid)** | **Invalidates every rule below** — see note |
| Multi-tick stale feed | Only single-NaN is covered today |
| Partial fill | Engines assume atomic fills |
| Flash-crash wick vs. close-confirmed | The structure stop's core promise |
| Slow bleed | Natural memecoin decay; no flip may ever confirm |
| Pump-and-dump | The case the giveback trail exists for |
| Sideways chop | Whipsaw reset correctness |
| Gap-through stop | Covered for SNIPER; verify SWING |
| Regime transition mid-position | Hysteresis under a live position |
| Gas-dominant tiny position | Noise floor; partially covered |
| Time-stop expiry vs. noise-floor hold | Interaction, currently untested |
| Giveback armed vs. unarmed boundary | New — §2.4 invariants |
| **Giveback clamp: low arm + high drop** | Must NOT fire at a loss — §2.4 clamp |
| Giveback vs. trend_exit on the same tick | Precedence: trend wins |
| Giveback vs. time_exit on the same tick | Precedence: giveback wins |

**Zero exit liquidity is the case that invalidates the doctrine.** Every rule
here — `trend_exit`, giveback, `time_exit`, `stop_loss` — assumes the sell
fills. In a pool with no bid, all four emit an action that silently fails, and
the resulting retry loop is what drained 7 → <2 TON in production. This test is
not about the exit rule; it is about what the engine does when its only lever is
disconnected. It must assert bounded retry and a terminal state, not an action.

---

## 5. Rollout

1. Merge with **every new key disabled**. Zero live behaviour change.
2. **Workstream 0 → economic viability. BLOCKING.** No exit tuning before this.
3. Workstream D → rug-detector covered (independent, parallelisable with 0).
4. Workstream A → verified noClose figure.
5. Workstream B → replay harness.
6. Workstream C → swept defaults — **only if 0 establishes positive expectancy
   and F3 is resolved** (a giveback trail cannot be swept on positions that are
   never in profit).
7. Workstream E → real-life cases.
8. Operator enables keys explicitly, one technique at a time, observing.

`OBSERVE_ONLY=true` remains the outer safety net throughout. Given F1/F2 it
should stay set until workstream 0 closes.

## 6. Success criteria

- **Workstream 0 closed: a positive-expectancy round trip is demonstrated at a
  stated minimum position size** — or the technique is explicitly retired. This
  supersedes every criterion below; none of them are meaningful without it.
- Each technique's TP/SL/time policy is explicit, distinct, and traceable to a
  liquidity/payoff rationale.
- No live behaviour change on merge.
- Every parameter is swept, not guessed.
- `rug-detector.ts` has coverage.
- All §4E cases have tests, with zero-exit-liquidity asserting bounded retry.
- Right-tail preservation is demonstrated, not assumed.

## 7. Open questions

0. **Is the SNIPER technique economically viable at all?** F1/F2 say the round
   trip has never been profitable and gas exceeds notional. If workstream 0
   cannot establish a viable minimum size, §2.2 should be withdrawn rather than
   tuned. This outranks every question below.
1. **Unresolved: the chain's actual text.** §2 was designed without it. Paste or
   export it and re-verify.
2. **Deployed config vs. repo defaults diverge — now diagnosed.** Runtime env
   read from `ton-agent-runtime` on 2026-08-11 shows `LOW_MAX_HOLD_MS=3600000`
   (1 hour) against a repo default of `0`. This is the source of the 25,938
   `time_exit` events. **§2.1's claim that SWING has no time-stop describes the
   repo, not production.** Decide which is correct and align them.
3. **Duplicate daily-loss keys, different values.** Both
   `DAILY_LOSS_LIMIT_TON=10.0` and `MAX_DAILY_LOSS_TON=8` are deployed. Per the
   2026-08-09 incident the code reads `DAILY_LOSS_LIMIT_TON`; the other name was
   the original secret. Adding the correct key without removing the wrong one
   leaves an ambiguity rather than a fix — the circuit breaker's true threshold
   is not readable from the config. Collapse to one key.
4. **§4.0a's 108% gas ratio may describe a retired configuration.** Production
   runs `SNIPER_PER_TRADE_TON=1.62`, but the 125 historical positions average
   ~0.065 TON spend (8.10 TON total). The 108% aggregate came from those much
   smaller positions. **0a must compute the gas ratio per trade from
   `trade_transactions.gas_fees / input_amount`, not from the aggregate**, and
   segment by date — the current sizing may already have resolved it.
5. **`SNIPER_ENABLED=true` and `SNIPER_DRY_RUN=false`; only `OBSERVE_ONLY=true`
   prevents live trading.** The sniper is armed behind a single flag. Confirm
   that is the intended safety posture while workstream 0 is open.
2. Does the verified noClose figure still justify the time-stop, or does it
   collapse toward the dataset edge?
3. Should the `excess` input in `effectiveStopPct` be bounded, or the curve
   reshaped? Sweep decides.
4. Does SWING deserve a giveback trail too, once the sniper sweep has data? Not
   in scope here; revisit with evidence.
