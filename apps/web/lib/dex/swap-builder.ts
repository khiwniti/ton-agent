/**
 * Server-side DEX swap-body builder for the WEB-APP manual trade override.
 *
 * This is a *port* of `apps/agent/src/dex/router.ts` restricted to the part
 * that constructs the transaction body. SIGNING is the user's job —
 * the agent's hot wallets are never involved.
 *
 * The browser calls `/api/dex/build-swap` then dispatches the returned
 * (to, value, payload) via `tonConnectUI.sendTransaction`.
 *
 * IMPORTANT: Only run on the Node.js runtime. The SDK uses Buffer/Promise
 * semantics that Next.js Edge runtime cannot satisfy. Use as a server-only
 * module; do NOT import from client components.
 */
import "server-only";
import { Address } from "@ton/ton";
// Cast to any — Ston.fi SDK types are loose across versions and we don't
// expose these to client code. Runtime correctness is verified by hand
// against the agent's existing /apps/agent/src/dex/router.ts.
import * as stonfi from "@ston-fi/sdk";

export type Dex = "stonfi";
export type Side = "buy" | "sell";

export interface BuildSwapRequest {
  /** Ston.fi's mainnet v1 router address (fixed for mainnet). */
  dex?: Dex;
  /** Caller (user's) wallet address, EQ…or user-friendly EQ… */
  userWalletAddress: string;
  /** Master jetton address the user wants to BUY (or SELL). */
  jettonMaster: string;
  /** For BUY: TON in (human units, e.g. 0.5). Ignored for SELL. */
  amountTon?: number;
  /** For SELL: nano-jetton (string of big-int amount). Ignored for BUY. */
  jettonAmountNano?: string;
  /** Min out in nano-jetton (slippage). "1" disables protection. */
  minOutJettonNano?: string;
  /** Side filter. */
  side: Side;
}

export interface BuiltSwap {
  /** Destination contract address (router or jetton wallet). */
  to: string;
  /** Value in nano-TON to forward with the message. */
  value: string;
  /** Base64-encoded TL-B body the wallet must consume. */
  payload: string;
  /** Suggested validUntil (UNIX seconds). Browser sets it. */
  validUntil: number;
}

// Resolve network dynamically for server-side Next.js runtime.
const NETWORK = process.env.NETWORK || process.env.NEXT_PUBLIC_NETWORK || "mainnet";
const isTestnet = NETWORK === "testnet";

// Ston.fi's v1 router address: testnet vs mainnet.
const STONFI_V1_ROUTER = isTestnet
  ? "kQBsGx9ArADUrREB34W-ghgsCgBShvfUr4Jvlu-0KGc33a1n"
  : "EQB3ncyBUTjZUAUOTn7f_yB-s5SscCjH-M-6f9Z6P3Z-1p";

/**
 * Builds a Ston.fi TON→Jetton swap body.
 *
 * offerAmount is the BUY amount only; the message value is the
 * router-calculated total (including gas buffer).
 */
async function stonfiBuyJetton(req: BuildSwapRequest): Promise<BuiltSwap> {
  // v2.7.x Router is a class. Args shape varies across SDK patch versions.
  const RouterCtor = (stonfi as any).DEX?.v1?.Router;
  const ProxyTonCtor = (stonfi as any).pTON?.v1;
  if (!RouterCtor || !ProxyTonCtor) {
    throw new Error("@ston-fi/sdk missing DEX.v1.Router or pTON.v1 exports");
  }
  const router = new RouterCtor(STONFI_V1_ROUTER);
  const proxyTon = new ProxyTonCtor();

  const txParams = await router.getSwapTonToJettonTxParams({
    userWalletAddress: Address.parse(req.userWalletAddress),
    proxyTon,
    offerAmount: (req.amountTon ?? 0).toString(),
    askJettonAddress: Address.parse(req.jettonMaster),
    minAskAmount: req.minOutJettonNano ?? "1",
    queryId: Date.now(),
  });

  const bodyCell = txParams?.body;
  if (!bodyCell) throw new Error("swap_tx_params.body_missing");

  return {
    to: txParams.to.toString(),
    value: txParams.value.toString(),
    payload: bodyCell.toBoc().toString("base64"),
    validUntil: Math.floor(Date.now() / 1000) + 600,
  };
}

/**
 * SELL is supported in v1 of @ston-fi/sdk via Jetton→TON tx params, but the
 * helper requires the USER's jetton-wallet address. We can't compute that
 * server-side without an extra RPC. Until we wire that, SELL is disabled
 * in this builder.
 */
function stonfiSellJetton(_req: BuildSwapRequest): Promise<BuiltSwap> {
  throw new Error(
    "sell-side from manual override not yet supported; port JettonWallet lookup or wait for v2 builder",
  );
}

/**
 * Public entry — Dispatches to the right builder. Validates inputs.
 * Throws on bad input so the route returns a clear 400.
 */
export async function buildSwap(req: BuildSwapRequest): Promise<BuiltSwap> {
  const dex = req.dex ?? "stonfi";
  if (dex !== "stonfi") {
    throw new Error(`dex "${dex}" not supported yet (Ston.fi is the only path)`);
  }
  if (
    !req.userWalletAddress?.startsWith("EQ") &&
    !req.userWalletAddress?.startsWith("UQ")
  ) {
    throw new Error("userWalletAddress must be an EQ… or UQ… address");
  }
  if (
    !req.jettonMaster?.startsWith("EQ") &&
    !req.jettonMaster?.startsWith("UQ")
  ) {
    throw new Error("jettonMaster must be an EQ… or UQ… address");
  }
  if (req.side === "buy") {
    if (!req.amountTon || req.amountTon <= 0) {
      throw new Error("amountTon required for BUY");
    }
    return await stonfiBuyJetton(req);
  }
  if (!req.jettonAmountNano) {
    throw new Error("jettonAmountNano required for SELL");
  }
  return await stonfiSellJetton(req);
}

/** Helper for the route — returns a friendly error message for the user. */
export function formatSwapError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error:\s*/i, "").slice(0, 280);
}
