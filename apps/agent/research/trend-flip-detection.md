# Trend-Flip Detection for High-Swing Memecoins (2026-08-10)

Research note supporting the 2026-08-09 operator directive: *no take-profit, no
trailing stop; close only on a SIGNIFICANT up-trend → down-trend reversal*.

Signal source: `src/exit/trend-monitor.ts` (live in the exit path).

## 1. Current signal (live, already shipping)

```
bearish = fastEMA(7) < slowEMA(25) AND MACDhist(7,25) < 0
confirmed = bearish persisted for confirmTicks=3 CONSECUTIVE ticks
           AND observations >= minObservations=6 real prices
```

- Fail-closed: non-finite / non-positive / too-short series → never bearish.
- `minObservations` lock (2026-08-09 PAWZ fix): prevents the EMA pair from
  confirming a "flip" against the flat seed baseline with ~3 real ticks.
- Ring buffer seeded with entry price so EMA has a baseline from tick 1.
- Data gaps do NOT reset the confirmation streak (a gap is not a recovery).

## 2. Why EMA-cross + MACD, and its known failure modes on memecoins

| Mode | Behavior on high-swing memecoins | Mitigation |
|---|---|---|
| Whipsaw (single wick through slow EMA) | False flip on one violent candle | `confirmTicks=3` consecutive — deliberate |
| Late signal (lag) | EMA lags the top; exit after big giveback | `minObservations` small (6) + `confirmTicks` short (3) — bias to earlier, noisier exits |
| Dead-cat / pump-and-dump | MACD hist re-crosses zero on the bounce, "confirms" resumption then rolls over again | No mitigation today — the corroboration gate (holder delta + DeDust trade window) is the safety net |
| Gap-fill baseline | Seed-baseline flips with almost no real evidence (PAWZ: trend_exit at −2% after ~59s) | `minObservations` lock (shipped 2026-08-09) |

Trade-off that matters: **confirmTicks=3 at a 10-20s tick cadence ≈ 30-60s of
confirmation delay.** At memecoin swing speeds that is acceptable for the
*exit* (give-back is the cost of avoiding whipsaw), but it is unusable for
*entry*.

## 3. Faster / corroborating signals evaluated (from domain knowledge — no
   public WS feeds, so all candidates must be computable from polled reserves)

1. **Reserve-ratio delta (flow proxy).** Price = `reserve1/reserve0`. A swap
   changes both reserves; net directional reserve movement over a window ≈ net
   buy/sell flow. Buying (base reserve down, quote reserve up) drives price up.
   A persistent flow reversal (2-3 consecutive windows of net selling) leads the
   EMA cross by seconds. **Recommendation: add as a lead indicator fed to the
   same confirmTicks counter, NOT a standalone signal.**
2. **Momentum divergence.** Price makes a higher high while flow/RSI makes a
   lower high → distribution. Cheap to compute from reserves; memecoin tops are
   usually accumulation-and-dump, which shows as reserve divergence.
3. **Donchian-style range break.** High-swing assets tend to put in a visible
   top range; a close below the N-period low (e.g. N=12) with volume is a classic
   exit. Computable from polled prices only. Higher lag than flow delta.
4. **Volatility normalization.** Memecoin variance is regime-dependent; a raw
   EMA-cross at calm-vol is a different statement than at high-vol. Normalizing
   by ATR would make confirmTicks comparable across regimes, but adds a tunable.
   **Deferred** — not needed for v1.
5. **Holder-count inflection (TONAPI `/v2/jettons/{id}/holders`).** Holder
   growth with price decline = distribution to retails. Already used as a
   corroboration gate in `position-monitor.ts`; slow (~minute granularity) so it
   is confirmatory, not predictive.

## 4. Recommended v1.1 evolution (keep the confirmed EMA-cross as the trigger,
   add a lead + a corroboration)

```
per tick (~1-5s, polled):
  price   = reserve1/reserve0
  flow    = net directional reserve delta over window W

  lead    = flow reversal persisted 2 consecutive windows (net selling while
            position is in profit)
  trigger = confirmed EMA-cross (existing, confirmTicks=3)

  close   = trigger AND (lead OR holder-delta corroboration)
```

- The **lead shortens effective exit latency** without abandoning the
  whipsaw filter: the EMA-cross still must confirm, but the lead primes the
  counter and the corroboration gate is relaxed when flow has already flipped.
- Keep the policy engine pure and the corroboration gate **fail-closed**: no
  holder data + no flow data → only the raw EMA-cross decides (current behavior).

## 5. Sanity bounds (numbers to watch on the hot path)

- Poll 1-5s per pool; TON shard blocks ~1s → captures ~every swap.
- `confirmTicks=3` @ 10s cadence = 30s delay; @ 5s = 15s. Re-tune `confirmTicks`
  if poll cadence drops below 10s.
- `historySize=60` @ 10s = 10min of prices for the EMA pair — enough for
  EMA(7)/(25) to settle; @ 5s = 5min, still fine.
- Give-back budget for a memecoin trend_exit: expect 5-15% from the local top
  to the close, by design (this is the accepted cost of the no-TP policy).

## Decisions to record

- **D1:** Keep the confirmed EMA-cross as the only trigger in v1 (it is live
  and shipping).
- **D2:** Add the reserve-flow lead + relaxed corroboration as v1.1, only if
  field data shows trend_exits are materially late.
- **D3:** Do NOT switch to raw price-tick whipsaw-prone triggers (single-bar
  breaks) — the 3-tick confirmation is load-bearing for this asset class.
