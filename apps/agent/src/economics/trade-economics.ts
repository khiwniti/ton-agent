/**
 * Trade economics — the arithmetic that decides whether a trade CAN profit.
 *
 * This module exists because the agent spent its entire bankroll on trades that
 * were mathematically incapable of profit, and the books could not show it.
 *
 * Post-mortem of the 2026-08-08 drain (33 positions, 3.3 TON cost basis,
 * all three tier wallets at 0.000000 TON while `SUM(realized_pnl_ton)` read
 * only -0.188 TON):
 *
 *   1. Every position was 0.1 TON. Round-trip DEX gas on TON is FLAT (~0.2 TON,
 *      independent of size), so break-even required +202% while the LOW tier's
 *      take-profit target was +25%. Every trade was a guaranteed loss before it
 *      was even placed.
 *   2. `realizedPnl = (pnl / 100) * cost_basis_ton` never subtracted gas, so the
 *      loss was invisible. `DAILY_LOSS_LIMIT_TON=2.0` read -0.188 and never
 *      tripped — the circuit breaker drained the wallet to zero while showing
 *      9% of its budget used. It was blind by construction.
 *
 * Both failures are addressed here, deliberately in ONE module: the gas constant
 * that the accounting subtracts is the SAME constant that the viability floor is
 * computed from. If they lived apart they would drift, and a drifted floor is
 * how you get guaranteed-loss trades back.
 *
 * All functions are pure (no I/O, no DB, no TonClient) so the arithmetic is
 * unit-testable and identical everywhere it is enforced.
 *
 * ── The core identity ────────────────────────────────────────────────────────
 * For a position of `S` TON, flat round-trip gas `G` TON, and round-trip
 * fee/spread fraction `f`, closing at gross return `r` nets:
 *
 *     net = S(1 + r)(1 - f) - S - G
 *
 * Break-even (net = 0) therefore requires:
 *
 *     r = (S + G) / (S(1 - f)) - 1
 *
 * Because `G` is flat, `r` explodes as `S` shrinks. This is the whole story:
 *
 *     S = 0.1 TON  ->  +202%   (what actually ran)
 *     S = 0.5 TON  ->  +41%
 *     S = 1.0 TON  ->  +21%
 *     S = 2.0 TON  ->  +10.6%
 */

/**
 * Read a non-negative number from env once at module load. Mirrors the pattern
 * in dex/swap-gas-guard.ts so every economic floor is tuned the same way, and
 * so this module stays free of a `config.ts` import (keeping it pure and cheap
 * to unit-test).
 */
function numFromEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * TON actually CONSUMED by the buy leg (not the amount attached).
 *
 * The router attaches `amountTon + 0.25` on a DeDust buy; the excess is
 * refunded by the chain, so the attached figure overstates the true cost. The
 * default below is the consumed estimate and matches the flat-gas model already
 * documented in `config.ts` ("Router gas is a flat 0.2 TON round trip") and
 * encoded by `sniper/x1000-client.ts` as `ROUND_TRIP_GAS_TON`.
 *
 * CALIBRATE THIS FROM PRODUCTION. Every close now records the gas it charged
 * (positions.gas_ton + the decision journal), so the true figure is measurable
 * from real balance deltas. The viability floor is highly sensitive to it: at
 * G=0.05 a 0.5 TON position breaks even at +10.7%, but at G=0.2 it needs +41%.
 */
export const ENTRY_GAS_TON = numFromEnv("DEX_ENTRY_GAS_TON", 0.1);

/** TON actually consumed by one sell leg. A TP1 partial pays this in full. */
export const EXIT_GAS_TON = numFromEnv("DEX_EXIT_GAS_TON", 0.1);

/** Flat cost of a complete buy + sell cycle. Size-independent — that is the trap. */
export const ROUND_TRIP_GAS_TON = ENTRY_GAS_TON + EXIT_GAS_TON;

/**
 * Round-trip fee + spread, as a PERCENT of notional.
 *
 * Empirically measured, not guessed: 26 closed positions across nine unrelated
 * pools (BURN, Teleclaw, APC, HYDRA, DOGS, BEAR, GOMINING, SQD, COCOON) all
 * settled within 0.0005% of -0.601%. Nine independent pools cannot agree that
 * precisely on a price MOVE — that tight a cluster is a CONSTANT. It is
 * DeDust's ~0.25%/swap fee doubled for the round trip, plus a hair of impact.
 */
export const ROUND_TRIP_FEE_PCT = numFromEnv("DEX_ROUND_TRIP_FEE_PCT", 0.6);

/**
 * How much better than break-even a position must be at its take-profit target.
 *
 * A position sized so that break-even EQUALS the take-profit target earns
 * exactly nothing on a perfect win — the trade is pointless. Factor 2 requires
 * break-even at half the target, so a TP hit books real profit. With G=0.2,
 * f=0.6%, TP=25% this floors LOW at ~1.7 TON.
 */
export const VIABILITY_SAFETY_FACTOR = Math.max(
  1,
  numFromEnv("POSITION_VIABILITY_SAFETY_FACTOR", 2),
);

/**
 * Target position size as a percent of wallet balance (the operator's ask).
 *
 * NOTE: this is a TARGET, whereas `MAX_PORTFOLIO_ALLOCATION_PCT` is a CAP. The
 * cap always wins, so setting this above the cap silently does nothing —
 * `sizePosition` reports when the cap binds so that is never a surprise.
 */
export const POSITION_SIZE_PCT = numFromEnv("POSITION_SIZE_PCT", 10);

/**
 * Absolute ceiling on round-trip cost as a percent of the position notional.
 *
 * A tier-INDEPENDENT backstop for SafetyCaps: whatever the tier's take-profit
 * target, a position whose fixed costs consume more than this share of its own
 * notional cannot plausibly profit. At the 0.1 TON size that drained the
 * wallet the figure was 202%, so this single gate rejects every one of those
 * 33 trades without needing any per-tier context.
 *
 * The scanner applies a stricter, per-tier floor (`minViablePositionTon`);
 * this exists so a sub-viable trade cannot reach a signer by some other path.
 */
export const MAX_ROUND_TRIP_COST_PCT = numFromEnv("MAX_ROUND_TRIP_COST_PCT", 25);

/**
 * Multiple of the round-trip cost that a stop-loss must clear to be meaningful.
 *
 * A stop tighter than the round-trip cost fires on the spread itself — i.e. on
 * noise the position can never escape. See `effectiveStopLossPct`.
 */
export const STOP_SPREAD_MULTIPLE = Math.max(
  1,
  numFromEnv("STOP_LOSS_SPREAD_MULTIPLE", 1.5),
);

/**
 * Total round-trip cost as a PERCENT of the position notional.
 *
 * This is the hurdle every trade must clear before a single basis point of
 * profit exists. It is also the noise floor for stop placement.
 */
export function roundTripCostPct(args: {
  positionTon: number;
  gasTon?: number;
  feePct?: number;
}): number {
  const gasTon = args.gasTon ?? ROUND_TRIP_GAS_TON;
  const feePct = args.feePct ?? ROUND_TRIP_FEE_PCT;
  if (!Number.isFinite(args.positionTon) || args.positionTon <= 0) return Infinity;
  return (gasTon / args.positionTon) * 100 + feePct;
}

/**
 * Gross return (PERCENT) required for this position to break even.
 *
 * `r = (S + G) / (S(1 - f)) - 1`
 */
export function breakEvenPct(args: {
  positionTon: number;
  gasTon?: number;
  feePct?: number;
}): number {
  const gasTon = args.gasTon ?? ROUND_TRIP_GAS_TON;
  const feePct = args.feePct ?? ROUND_TRIP_FEE_PCT;
  const S = args.positionTon;
  if (!Number.isFinite(S) || S <= 0) return Infinity;
  const keep = 1 - feePct / 100;
  // A fee of >=100% means nothing survives the round trip at any size.
  if (keep <= 0) return Infinity;
  return ((S + gasTon) / (S * keep) - 1) * 100;
}

/**
 * Smallest position (TON) whose break-even sits at or below `targetPct`.
 *
 * Inverting the break-even identity for S:
 *   S + G = S(1 - f)(1 + t)   =>   S = G / [(1 - f)(1 + t) - 1]
 *
 * Returns `Infinity` when NO size can clear the target (fees alone eat the
 * target), which callers must treat as "do not trade".
 */
export function minViablePositionTon(args: {
  targetPct: number;
  gasTon?: number;
  feePct?: number;
  safetyFactor?: number;
}): number {
  const gasTon = args.gasTon ?? ROUND_TRIP_GAS_TON;
  const feePct = args.feePct ?? ROUND_TRIP_FEE_PCT;
  const safetyFactor = Math.max(1, args.safetyFactor ?? VIABILITY_SAFETY_FACTOR);

  if (!Number.isFinite(args.targetPct) || args.targetPct <= 0) return Infinity;
  if (gasTon <= 0) return 0; // no flat cost => any size clears the target

  // Require break-even at a FRACTION of the target so a win actually pays.
  const t = args.targetPct / 100 / safetyFactor;
  const keep = 1 - feePct / 100;
  if (keep <= 0) return Infinity;

  const denom = keep * (1 + t) - 1;
  if (denom <= 0) return Infinity;
  return gasTon / denom;
}

/**
 * Gas charged when closing a position, split by leg so it is never double-booked.
 *
 * The entry leg was NEVER accounted for at buy time (that is the accounting bug),
 * so the first exit must absorb it. A position that already took a TP1 partial
 * has therefore already paid the entry leg, and its final close owes only the
 * remaining sell leg.
 */
export function exitGasTon(args: { entryGasAlreadyBooked: boolean }): number {
  return args.entryGasAlreadyBooked
    ? EXIT_GAS_TON
    : ENTRY_GAS_TON + EXIT_GAS_TON;
}

/**
 * The truth: realized PnL in TON, gas included.
 *
 * `grossOutTon` is the TON the sell actually returns (fees/spread already baked
 * in, because it comes from a real DEX quote). Subtracting the cost basis gives
 * the gross result; subtracting gas gives what the wallet actually feels.
 *
 * The old formula `(pnl / 100) * cost_basis_ton` is algebraically
 * `grossOutTon - costBasisTon` — correct on spread, but silently omitting `gasTon`,
 * which is exactly the term that emptied the wallet.
 */
export function computeRealizedPnlTon(args: {
  grossOutTon: number;
  costBasisTon: number;
  gasTon: number;
}): number {
  const gross = Number.isFinite(args.grossOutTon) ? args.grossOutTon : 0;
  const basis = Number.isFinite(args.costBasisTon) ? args.costBasisTon : 0;
  const gas = Number.isFinite(args.gasTon) ? args.gasTon : 0;
  return gross - basis - gas;
}

/**
 * A stop-loss that is actually reachable given the position's own economics.
 *
 * Two failure modes this prevents:
 *   - Stop TIGHTER than the round-trip cost: fires on the spread itself. The
 *     LOW tier's 15% stop on a position whose round-trip cost is 10.6% is only
 *     4.4% of real room — it triggers on noise.
 *   - Stop unreachable at all: on a 0.1 TON position the round-trip cost is
 *     202%, so a 15% stop can never be honoured. (The two -85.7% closes are
 *     this: the position gapped straight past an unenforceable stop.)
 *
 * Widening to `max(configured, roundTripCost x multiple)` makes the stop
 * self-consistent at any size. It does NOT rescue an unviably small position —
 * that is `minViablePositionTon`'s job, upstream.
 */
export function effectiveStopLossPct(args: {
  configuredStopPct: number;
  positionTon: number;
  gasTon?: number;
  feePct?: number;
  multiple?: number;
}): number {
  const configured = Number.isFinite(args.configuredStopPct)
    ? Math.abs(args.configuredStopPct)
    : 0;
  const multiple = Math.max(1, args.multiple ?? STOP_SPREAD_MULTIPLE);
  const cost = roundTripCostPct({
    positionTon: args.positionTon,
    gasTon: args.gasTon,
    feePct: args.feePct,
  });
  // Unmeasurable/degenerate cost => keep the operator's configured stop rather
  // than widening to Infinity (which would disable the stop entirely).
  if (!Number.isFinite(cost)) return configured;
  return Math.max(configured, cost * multiple);
}

export interface SizingInput {
  /** Live wallet balance in TON. */
  balanceTon: number;
  /** Target percent of balance to deploy per position. */
  sizePct: number;
  /** Absolute per-tier ceiling (TIER_RISK_CONFIGS[tier].maxPositionTon). */
  tierCapTon: number;
  /** Hard portfolio-allocation ceiling, percent (MAX_PORTFOLIO_ALLOCATION_PCT). */
  allocCapPct: number;
  /** Floor below which the trade cannot profit (minViablePositionTon). */
  minViableTon: number;
}

export interface SizingDecision {
  /** False => STAND DOWN. Do not trade. Never scale into a losing size. */
  ok: boolean;
  sizeTon: number;
  reason: string;
}

/**
 * Percentage-of-wallet sizing with a hard viability floor beneath it.
 *
 * THE CRITICAL RULE: when the wallet cannot fund a viable position we STAND
 * DOWN. We do not scale down to fit, because a sub-viable position is a
 * guaranteed loss — scaling down does not reduce risk, it converts a
 * skipped trade into a certain one. That single distinction is what turned a
 * 3.3 TON bankroll into 0.000000 TON across 33 trades.
 *
 * Nor do we scale UP to reach the floor: that would silently exceed the
 * operator's intended risk per trade.
 */
export function sizePosition(input: SizingInput): SizingDecision {
  const { balanceTon, sizePct, tierCapTon, allocCapPct, minViableTon } = input;

  if (!Number.isFinite(balanceTon) || balanceTon <= 0) {
    return { ok: false, sizeTon: 0, reason: `wallet balance is ${balanceTon} TON` };
  }
  if (!Number.isFinite(sizePct) || sizePct <= 0) {
    return { ok: false, sizeTon: 0, reason: `POSITION_SIZE_PCT is ${sizePct}` };
  }

  // Calculate target trade size
  const target = balanceTon * (sizePct / 100);
  const allocCap = balanceTon * (allocCapPct / 100);
  
  // Calculate effective position size. Never scale UP to reach the floor: that would silently
  // exceed the operator's intended risk per trade. Caps bind in order: target, tier, allocation.
  let sizeTon = Math.min(target, tierCapTon, allocCap);

  // If strict minViable check is disabled or bypassed via ALLOW_LOW_BALANCE_TRADING
  const allowLowBalance = process.env.ALLOW_LOW_BALANCE_TRADING === "true" || process.env.ALLOW_LOW_BALANCE_TRADING === "1";
  
  const effectiveMinViable = allowLowBalance ? 0.05 : minViableTon;

  if (sizeTon < effectiveMinViable) {
    // If allowLowBalance is enabled, attempt using whatever available spendable balance exists above gas
    if (allowLowBalance && balanceTon > 0.15) {
      sizeTon = Math.min(balanceTon - 0.1, tierCapTon);
    } else {
      const binding =
        sizeTon === allocCap && allocCap < target
          ? `MAX_PORTFOLIO_ALLOCATION_PCT=${allocCapPct}% caps it at ${allocCap.toFixed(4)} TON`
          : sizeTon === tierCapTon && tierCapTon < target
            ? `tier cap ${tierCapTon} TON`
            : `POSITION_SIZE_PCT=${sizePct}% of ${balanceTon.toFixed(4)} TON`;
      const needBalance = minViableTon / (sizePct / 100);
      return {
        ok: false,
        sizeTon: 0,
        reason:
          `STAND DOWN: size ${sizeTon.toFixed(4)} TON < min viable ${minViableTon.toFixed(4)} TON ` +
          `(no position size can profit: break-even ${breakEvenPct({ positionTon: sizeTon }).toFixed(1)}% is unreachable). ` +
          `Binding constraint: ${binding}. ` +
          `Fund >= ${needBalance.toFixed(2)} TON to trade at ${sizePct}%, or set ALLOW_LOW_BALANCE_TRADING=true.`,
      };
    }
  }

  return {
    ok: true,
    sizeTon,
    reason:
      `size ${sizeTon.toFixed(4)} TON (${sizePct}% of ${balanceTon.toFixed(4)}), ` +
      `break-even ${breakEvenPct({ positionTon: sizeTon }).toFixed(1)}%`,
  };
}
