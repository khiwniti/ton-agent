/**
 * POST /api/dex/build-swap
 *
 * Authenticated route. The browser sends:
 *   { userWalletAddress, jettonMaster, side, amountTon?, jettonAmountNano?, dex?, minOutJettonNano? }
 *
 * We forward to the server-side `buildSwap()` and return:
 *   { to, value, payload (base64 BOC), validUntil }
 *
 * The browser hands that to `tonConnectUI.sendTransaction({ validUntil,
 * from: userWalletAddress, messages: [{ address: to, amount: value,
 * payload }] })` so the connected wallet (Tonkeeper, OpenMask, etc.)
 * signs and broadcasts.
 *
 * This route is intentionally NOT used by the agent's hot wallets — the
 * agent has its own internal signer (locked-wallet.ts). Surgical separation
 * of concerns: the web app is for HUMAN-in-the-loop emergency exits.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  buildSwap,
  formatSwapError,
  type BuildSwapRequest,
} from "@/lib/dex/swap-builder";

// Ston.fi SDK requires Node Buffer + BigInt semantics.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: BuildSwapRequest;
  try {
    body = (await req.json()) as BuildSwapRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const built = await buildSwap(body);
    return NextResponse.json(built);
  } catch (e) {
    const msg = formatSwapError(e);
    // Most builder errors are 400 (bad input); treat all as 400 for now.
    return NextResponse.json(
      { error: msg || "swap body build failed" },
      { status: 400 },
    );
  }
}
