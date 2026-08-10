/**
 * Slippage floor computation — single source of truth for the minimum
 * acceptable output of a swap (T037/T038). Fail-closed: a quote that is
 * not positive, or a floor that rounds to zero, is rejected rather than
 * silently allowing a trade without slippage protection.
 */

export interface SwapQuote {
  route: { dex: string; poolAddress: string };
  side: "buy" | "sell";
  amountInNano: string;
  expectedOutNano: string;
  resolvedAt: number;
  available: boolean;
}

/**
 * Compute the minimum acceptable output for a swap given a quoted output
 * and a max-slippage ceiling in basis points (e.g. 800 = 8.0%).
 *
 * Floor division on BigInt (truncation, not rounding) so a slightly adverse
 * fill is never masked by rounding up.
 *
 * @throws Error when quotedOutNano is not positive, or when the resulting
 *         floor rounds to zero (trade is too small to protect).
 */
export function computeMinOut(quotedOutNano: string, ceilingBps: number): string {
  const quoted = BigInt(quotedOutNano);
  if (quoted <= 0n) {
    throw new Error("quotedOutNano must be positive");
  }
  const minOut = (quoted * BigInt(10000 - ceilingBps)) / 10000n;
  if (minOut <= 0n) {
    throw new Error("minOut rounds to zero");
  }
  return minOut.toString();
}

/** A slippage constraint derived from a live quote for a specific tier. */
export interface MinOutConstraint {
  tier: string;
  ceilingBps: number;
  quotedOutNano: string;
  minOutNano: string;
}

/** Build the slippage constraint the execute path must enforce. */
export function buildMinOutConstraint(
  quote: SwapQuote,
  tier: string,
  ceilingBps: number,
): MinOutConstraint {
  return {
    tier,
    ceilingBps,
    quotedOutNano: quote.expectedOutNano,
    minOutNano: computeMinOut(quote.expectedOutNano, ceilingBps),
  };
}