/**
 * x1000 settlement adapter (plan §3.3).
 *
 * x1000/memepad uses a different settlement proof from the standard DeDust
 * DEX path. The standard path proves sells via jetton-wallet balance delta
 * (verifySellDelta). x1000 fills are proven via the trace API
 * (getTraceStatus), but that only proves the router received the tx — not
 * that the token balance actually moved.
 *
 * This adapter adds an explicit balance-delta proof on top of the trace
 * confirmation:
 *   BUY  settlement: post-trace token balance INCREASED by ≥ 99% of expected.
 *   SELL settlement: pre/post token balance DECREASED by ≥ 99% of requested.
 *
 * A trace timeout, aborted trace, compute failure, wrong asset/direction,
 * or balance-proof failure leaves the position pending/reconcilable —
 * NOT falsely OPEN or CLOSED.
 *
 * Trade state lifecycle (plan §3.3):
 *   prepared → broadcasted → trace_confirmed → settled
 *                                           ↓ (on any proof failure)
 *                                        pending_reconcile
 *
 * This module is import-side-effect free and fully unit-testable.
 */

export type SettlementStatus =
  | "prepared"
  | "broadcasted"
  | "trace_confirmed"
  | "settled"
  | "pending_reconcile";

export type SettlementFailureReason =
  | "trace_timeout"
  | "trace_aborted"
  | "trace_compute_failure"
  | "wrong_asset"
  | "wrong_direction"
  | "balance_proof_failed"
  | "balance_unreadable";

export interface SettlementResult {
  status: SettlementStatus;
  failure?: SettlementFailureReason;
  detail?: string;
  /** Actual balance delta (absolute, in nano-jetton units). */
  actualDeltaNano?: bigint;
}

/** 99% threshold — tolerance for fees and rounding. */
const DELTA_THRESHOLD_NUMERATOR = 99n;
const DELTA_THRESHOLD_DENOMINATOR = 100n;

/**
 * Verify a BUY settlement: post-trace token balance must have INCREASED
 * by at least 99% of the expected output.
 *
 * @param expectedOutNano  Expected token output from the quote (nano-jetton).
 * @param balanceBefore    Token balance before the buy was broadcast (null = unreadable).
 * @param balanceAfter     Token balance after the trace confirms (null = unreadable).
 */
export function verifyBuySettlement(args: {
  expectedOutNano: bigint;
  balanceBefore: bigint | null;
  balanceAfter: bigint | null;
}): SettlementResult {
  if (args.balanceAfter === null) {
    return {
      status: "pending_reconcile",
      failure: "balance_unreadable",
      detail: "post-buy balance unreadable — cannot prove token delivery",
    };
  }

  const gained =
    args.balanceBefore !== null
      ? args.balanceAfter - args.balanceBefore
      : args.balanceAfter; // fall back to absolute for fresh wallets

  if (gained <= 0n) {
    return {
      status: "pending_reconcile",
      failure: "balance_proof_failed",
      detail: `buy balance did not increase: before=${args.balanceBefore ?? "n/a"} after=${args.balanceAfter}`,
      actualDeltaNano: gained,
    };
  }

  if (args.expectedOutNano > 0n) {
    const required = (args.expectedOutNano * DELTA_THRESHOLD_NUMERATOR) / DELTA_THRESHOLD_DENOMINATOR;
    if (gained < required) {
      return {
        status: "pending_reconcile",
        failure: "balance_proof_failed",
        detail: `buy partial: gained=${gained} < required=${required} (99% of expected=${args.expectedOutNano})`,
        actualDeltaNano: gained,
      };
    }
  }

  return { status: "settled", actualDeltaNano: gained };
}

/**
 * Verify a SELL settlement: pre/post token balance must have DECREASED
 * by at least 99% of the requested sell amount.
 *
 * @param requestedSellNano  Token amount we requested to sell (nano-jetton).
 * @param balanceBefore      Token balance BEFORE the sell was broadcast (null = unreadable).
 * @param balanceAfter       Token balance AFTER the trace confirms (null = unreadable).
 */
export function verifySellSettlement(args: {
  requestedSellNano: bigint;
  balanceBefore: bigint | null;
  balanceAfter: bigint | null;
}): SettlementResult {
  if (args.balanceBefore === null) {
    return {
      status: "pending_reconcile",
      failure: "balance_unreadable",
      detail: "pre-sell baseline unreadable — cannot prove tokens left the wallet",
    };
  }

  if (args.balanceAfter === null) {
    return {
      status: "pending_reconcile",
      failure: "balance_unreadable",
      detail: "post-sell balance unreadable — cannot prove sell completed",
    };
  }

  const spent = args.balanceBefore - args.balanceAfter;
  if (spent <= 0n) {
    return {
      status: "pending_reconcile",
      failure: "balance_proof_failed",
      detail: `sell bounced: balance did not decrease (before=${args.balanceBefore} after=${args.balanceAfter})`,
      actualDeltaNano: spent,
    };
  }

  const required = (args.requestedSellNano * DELTA_THRESHOLD_NUMERATOR) / DELTA_THRESHOLD_DENOMINATOR;
  if (spent < required) {
    return {
      status: "pending_reconcile",
      failure: "balance_proof_failed",
      detail: `sell partial: spent=${spent} < required=${required} (99% of requested=${args.requestedSellNano})`,
      actualDeltaNano: spent,
    };
  }

  return { status: "settled", actualDeltaNano: spent };
}

/**
 * Map a trace API status string to a settlement lifecycle step.
 * Returns "pending_reconcile" with a typed failure for any non-success state.
 */
export function classifyTraceStatus(
  traceStatus: string | null | undefined,
): { ok: boolean; failure?: SettlementFailureReason; detail?: string } {
  if (!traceStatus) {
    return { ok: false, failure: "trace_timeout", detail: "trace status missing or null" };
  }
  const s = traceStatus.toLowerCase();
  if (s === "complete" || s === "found" || s === "success") {
    return { ok: true };
  }
  if (s.includes("abort")) {
    return { ok: false, failure: "trace_aborted", detail: `trace aborted: ${traceStatus}` };
  }
  if (s.includes("compute") || s.includes("fail")) {
    return { ok: false, failure: "trace_compute_failure", detail: `trace compute failure: ${traceStatus}` };
  }
  if (s.includes("timeout") || s.includes("pending")) {
    return { ok: false, failure: "trace_timeout", detail: `trace timeout/pending: ${traceStatus}` };
  }
  return { ok: false, failure: "trace_compute_failure", detail: `unrecognised trace status: ${traceStatus}` };
}
