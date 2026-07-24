/**
 * Worst-case exit-reserve guard for BUY and SELL swaps.
 *
 * Two related ideas both live here so the wallet is preserved even in the
 * worst case (every open position rug-pulls, the agent misses a config refuel,
 * the operator is offline):
 *
 *   1. EXIT_RESERVE_TON — after any successful BUY, the wallet must still
 *      hold at least this many TON, so the next sell can always broadcast.
 *      Enforced inside evaluateBuyGasGuard.
 *   2. SELL_GAS_FLOOR_TON — before any SELL is signed, the wallet must
 *      already have this many TON; below it the chain will reject the tx.
 *      Enforced inside evaluateSellGasGuard.
 *
 * There's also BANKROLL_FLOOR_TON — the operator-configured minimum balance
 * the wallet must NEVER go below (separate from the gas cushion). The buy
 * guard uses max(EXIT_RESERVE_TON, BANKROLL_FLOOR_TON) so the strictest of
 * the two floors always wins.
 *
 * All checks live here as pure functions so they're:
 *   - unit-testable without a TonClient
 *   - the same constant everywhere (router.ts, executor, gate.ts, tests)
 *   - documented once in one place
 *
 * The values are intentionally conservative: a single 0.01 TON wallet can
 * still attempt several sells before being halted outright, instead of trying
 * to sign a tx that the chain will reject.
 */

// Read once at module-load. Env override is allowed for test/local dev.
function floorFromEnv(name: string, fallback: number): number {
  const raw = (typeof process !== "undefined" ? process.env?.[name] : undefined);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Floor that MUST remain balance after a BUY executes, so the worst-case
 * scenario (every position rug-pulls / dumps to zero) still leaves TON for
 * the next sell(s).
 *
 * Conservative: covers one Ston.fi sell (gas + forward ≈ 0.3 TON) plus a
 * small safety margin. With this floor in place the wallet is *never* sold
 * out, even after a buy that nearly zero-spends the balance.
 */
export const EXIT_RESERVE_TON = floorFromEnv("DEX_EXIT_RESERVE_TON", 0.4);

/**
 * Floor that a wallet MUST already hold before a SELL is allowed to broadcast.
 * Below this value the sell tx will be rejected by the chain/router, so we
 * refuse locally first.
 */
export const SELL_GAS_FLOOR_TON = floorFromEnv("DEX_SELL_GAS_FLOOR_TON", 0.35);

/**
 * Operator-configurable per-wallet bankroll floor. After ANY successful buy
 * the wallet holds more than this; below it every new buy is refused until
 * an operator tops up.
 *
 * Defaults to 1 TON — matches CONFIG.minBankrollTon. If you set
 * BANKROLL_FLOOR_TON env var higher, you must refactor the operator's
 * minimum deployment funding to match.
 */
export const BANKROLL_FLOOR_TON = floorFromEnv("DEX_BANKROLL_FLOOR_TON", 1.0);

/**
 * Effective "must remain" floor = the stricter of the two: sell-gas floor
 * (so we can always exit a position) or the operator's bankroll floor
 * (so the wallet is never drawn into a state where the operator would
 * consider it unfunded).
 *
 * Returns the strictest maximum of the two so that the buy always leaves
 * enough for BOTH constraints to remain satisfied.
 */
export function effectiveBuyReserveTon(): number {
  return Math.max(EXIT_RESERVE_TON, BANKROLL_FLOOR_TON);
}

/** Side discriminator, exported for typed guards. */
export type SwapSide = "buy" | "sell";

export interface GasGuardResult {
  /** True when the balance is sufficient (no exception). */
  ok: boolean;
  /** Pre-formatted error string for logging / SwapResult. Empty when ok. */
  error: string;
  /** Balance in TON, normalized. */
  haveTon: number;
  /** Required TON (position+reserve for buy, just floor for sell). */
  needTon: number;
}

/**
 * Check whether a single sell is allowed given the on-chain TON balance.
 * Pure function: callers pass the wallet balance in TON. No I/O.
 */
export function evaluateSellGasGuard(balanceTon: number): GasGuardResult {
  const haveTon = Number.isFinite(balanceTon) ? Math.max(0, balanceTon) : 0;
  if (haveTon < SELL_GAS_FLOOR_TON) {
    return {
      ok: false,
      error: `[sell] insufficient balance: have=${haveTon.toFixed(3)} TON, need>${SELL_GAS_FLOOR_TON.toFixed(3)} TON for sell (worst-case exit reserve must stay intact)`,
      haveTon,
      needTon: SELL_GAS_FLOOR_TON,
    };
  }
  return { ok: true, error: "", haveTon, needTon: SELL_GAS_FLOOR_TON };
}

/**
 * Check whether a BUY of `requestedTon` is allowed given balance, while
 * keeping the stricter of EXIT_RESERVE_TON vs BANKROLL_FLOOR_TON untouched
 * for any future sell (worst-case).
 *
 * The "must remain" floor for buys is:
 *   max(EXIT_RESERVE_TON, BANKROLL_FLOOR_TON)
 * so that BOTH invariants hold after the buy settles:
 *   (a) at least EXIT_RESERVE_TON remains to pay the next sell's gas, and
 *   (b) at least BANKROLL_FLOOR_TON remains so the operator's per-wallet
 *       floor is not violated.
 *
 * `requestedTon` + `0.25` forward cushion + effective floor = the minimum
 * balance this wallet must already have before the buy is signable.
 */
export function evaluateBuyGasGuard(
  balanceTon: number,
  requestedTon: number,
): GasGuardResult {
  const forwardCushion = 0.25;
  const reserveFloor = effectiveBuyReserveTon();
  const haveTon = Number.isFinite(balanceTon) ? Math.max(0, balanceTon) : 0;
  // NaN/non-finite requested → treat as 0 need; the floor still applies via
  // reserveFloor, so we never silently approve an uninspectable buy.
  const safeRequested = Number.isFinite(requestedTon) ? Math.max(0, requestedTon) : 0;
  const needTon = safeRequested + forwardCushion + reserveFloor;
  if (!Number.isFinite(needTon) || haveTon < needTon) {
    return {
      ok: false,
      error: `[buy] insufficient balance: have=${haveTon.toFixed(3)} TON, need>${needTon.toFixed(3)} TON (position + ${forwardCushion} forward + ${reserveFloor} reserve-floor)`,
      haveTon,
      needTon: Number.isFinite(needTon) ? needTon : 0,
    };
  }
  return { ok: true, error: "", haveTon, needTon };
}
