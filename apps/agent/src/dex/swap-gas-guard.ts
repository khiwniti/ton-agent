/**
 * Worst-case exit-reserve guard for BUY and SELL swaps.
 *
 * The sell side of every swap requires a few hundred nanoTON of gas plus the
 * DEX-specified forward value (~0.25 TON on Ston.fi, 0.35 TON on DeDust). If a
 * wallet has insufficient TON to cover that, the broadcaster drops the tx and
 * the position sits stuck OPEN forever, even when SL/TP is firing.
 *
 * The fix: pre-flight at the entry of every sell and add a buy-side reserve
 * floor. Both checks live here as pure functions, so they're:
 *   - unit-testable without a TonClient
 *   - the same constant everywhere (router.ts, executor, tests)
 *   - documented once in one place (see module-level comment below).
 *
 * The values are intentionally conservative: a single 0.01 TON wallet can
 * still attempt several sells before being halted outright, instead of trying
 * to sign a tx that the chain will reject.
 */

/**
 * Floor that MUST remain balance after a BUY executes, so the worst-case
 * scenario (every position rug-pulls / dumps to zero) still leaves TON for
 * the next sell(s).
 *
 * Conservative: covers one Ston.fi sell (gas + forward ≈ 0.3 TON) plus a
 * small safety margin. With this floor in place the wallet is *never* sold
 * out, even after a buy that nearly zero-spends the balance.
 */
export const EXIT_RESERVE_TON = 0.4;

/**
 * Floor that a wallet MUST already hold before a SELL is allowed to broadcast.
 * Below this value the sell tx will be rejected by the chain/router, so we
 * refuse locally first.
 */
export const SELL_GAS_FLOOR_TON = 0.35;

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
 * keeping `EXIT_RESERVE_TON` untouched for any future sell (worst-case).
 *
 * `requestedTon` + `0.25` forward cushion + `EXIT_RESERVE_TON` = the minimum
 * balance this wallet must already have before the buy is signable.
 */
export function evaluateBuyGasGuard(
  balanceTon: number,
  requestedTon: number,
): GasGuardResult {
  const forwardCushion = 0.25;
  const haveTon = Number.isFinite(balanceTon) ? Math.max(0, balanceTon) : 0;
  // NaN/non-finite requested → treat as 0 need; the floor still applies via
  // EXIT_RESERVE_TON, so we never silently approve an uninspectable buy.
  const safeRequested = Number.isFinite(requestedTon) ? Math.max(0, requestedTon) : 0;
  const needTon = safeRequested + forwardCushion + EXIT_RESERVE_TON;
  if (!Number.isFinite(needTon) || haveTon < needTon) {
    return {
      ok: false,
      error: `[buy] insufficient balance: have=${haveTon.toFixed(3)} TON, need>${needTon.toFixed(3)} TON (position + ${forwardCushion} forward + ${EXIT_RESERVE_TON} exit-reserve)`,
      haveTon,
      needTon: Number.isFinite(needTon) ? needTon : 0,
    };
  }
  return { ok: true, error: "", haveTon, needTon };
}
