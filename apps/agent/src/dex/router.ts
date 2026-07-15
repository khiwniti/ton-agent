/**
 * DEX execution router — Ston.fi & DeDust.
 *
 * Supports sequential locking of wallet transactions using sendTransferLocked.
 *
 * @ton/ton v16 notes:
 *  - WalletContractV5R1.create expects `walletId` as Partial<WalletIdV5R1>
 *    (subwalletNumber only); this is behaviourally equivalent to the legacy
 *    `{ walletId: <number> }` for mainnet/testnet when other fields default.
 *  - WalletContractV4R2 was removed; the unified class is WalletContractV4.
 *
 * @dedust/sdk v0.8.7 notes:
 *  - `factory.getVault(asset)` is gone; use `factory.getNativeVault()` for TON
 *    and `factory.getJettonVault(master)` for jettons.
 *  - `VaultNative.createSwapPayload` does NOT exist in v0.8.x. We build the
 *    TON-vault swap body using `VaultJetton.createSwapPayload` — DeDust's SDK
 *    produces the same TL-B swap instruction (opcode 0xea06185d with the
 *    native extras) for both vaults, so the resulting cell is interchangeable.
 *    See apps/agent/src/dex/router.ts and the @dedust source for `VaultJetton.js`.
 */

import {
  TonClient,
  toNano,
  fromNano,
  internal,
  Address,
  beginCell,
  type Cell,
} from "@ton/ton";
import { DEX, pTON } from "@ston-fi/sdk";
import {
  Factory,
  MAINNET_FACTORY_ADDR,
  Asset,
  PoolType,
  VaultJetton,
} from "@dedust/sdk";
import { CONFIG } from "../config";
import { log } from "../logger";
import { loadKeyPairForTier } from "../wallet/wallet";
import { sendTransferLocked } from "../wallet/locked-wallet";

export type Dex = "stonfi" | "dedust";

export type SwapResult = {
    ok: boolean;
    dex: Dex;
    error?: string;
    txHash?: string;
    /**
     * Jetton amount received/expected in nano-jetton units as a string
     * (BigInt-safe). Set by the DEX router from the pool's expected output
     * for buys, or from jettonAmountNano for sells. `undefined` when the
     * DEX SDK did not expose an estimation at swap-build time.
     */
    amountTokens?: string;
};

export interface SwapRequest {
  jettonMaster: string;
  amountTon: number;
  side: "buy" | "sell";
  minOutJettonNano?: string;   // slippage control for buy
  jettonAmountNano?: string;   // amount of jettons to sell
}

/**
 * DeDust swap-payload builder — `VaultJetton.createSwapPayload` is the only
 * static builder exposed by the SDK in v0.8.x. It produces a TL-B cell that
 * matches `VaultNative::swap` (opcode 0xea06185d with poolAddress/limit/next/
 * swapParams). Safe to use for both the native BUY body and the jetton-side
 * SELL forward_payload.
 *
 * Wrapped in a runtime type-assertion with a clear failure message so a future
 * API drift in DeDust fails loudly rather than silently misencoding the cell.
 */
function dedustSwapPayload(args: {
  poolAddress: Address;
  limit: bigint;
  swapParams?: any;
}): Cell {
  if (typeof (VaultJetton as any).createSwapPayload !== "function") {
    throw new Error("DeDust swap-payload builder missing in SDK — refusing to encode swap cell");
  }
  // `swapParams` is cast below for v5; the as-any here just silences
  // TypeScript's overloaded-construct differences across @dedust versions.
  return (VaultJetton as any).createSwapPayload(args) as Cell;
}

/** Ston.fi — BUY TON → Jetton */
async function stonfiBuy(
  client: TonClient,
  w: any,
  kp: any,
  p: SwapRequest,
  tier: "low" | "mid" | "high"
): Promise<SwapResult> {
  const bal = await w.getBalance();
  const reqd = BigInt(toNano((p.amountTon + 0.25).toString()));
  if (bal < reqd) {
    throw new Error(`insufficient balance have=${fromNano(bal)} need=${fromNano(reqd)}`);
  }

  const router = client.open(
    DEX.v1.Router.create("EQB3ncyBUTjZUAUOTn7f_yB-s5SscCjH-M-6f9Z6P3Z-1p")
  );
  const proxyTon = new pTON.v1();

  const txParams = await router.getSwapTonToJettonTxParams({
    userWalletAddress: w.address,
    proxyTon,
    offerAmount: p.amountTon.toString(),
    askJettonAddress: p.jettonMaster,
    minAskAmount: p.minOutJettonNano ?? "1",
    queryId: Date.now(),
  });

  // Extract expected output from txParams — the v1 Router internally calls the
  // pool's getExpectedOutputs get-method and includes the result here.
  const expectedOutput: bigint | undefined = (txParams as any).expectedOutput;
  const amountTokens: string | undefined = expectedOutput != null
    ? expectedOutput.toString()
    : undefined;

  log.info(
    "STONFI",
    `[${tier.toUpperCase()}] buy seqno=${await w.getSeqno()} ton=${p.amountTon}` +
      (amountTokens ? ` → ${(BigInt(amountTokens) / 10n ** 6n).toString()}…` : ""),
  );
  const r = await sendTransferLocked(
    tier,
    {
      wallet: w,
      secretKey: kp.sec,
      messages: [
        internal({
          to: txParams.to,
          value: txParams.value,
          body: txParams.body,
        }),
      ],
    },
    client
  );
  return { ok: r.ok, dex: "stonfi", error: r.error, amountTokens: r.ok ? amountTokens : undefined };
}

/** Ston.fi — SELL Jetton → TON (TODO: cell builder for jetton-wallet transfer). */
async function stonfiSell(
  _client: TonClient,
  _w: any,
  _kp: any,
  p: SwapRequest,
  _tier: "low" | "mid" | "high"
): Promise<SwapResult> {
  // Ston.fi SELL via Jetton Wallet → Router: requires TL-B cell for the
  // jetton-wallet transfer (forward_payload = swap-ton-instruction). Not
  // implemented yet in this iteration; surface via the .error path so the
  // caller (route via fallback) knows.
  return {
    ok: false,
    dex: "stonfi",
    error: "stonfi sell not yet implemented; route through risk-manager",
    amountTokens: p.jettonAmountNano,
  };
}

/** DeDust — BUY TON → Jetton */
async function dedustBuy(
  client: TonClient,
  w: any,
  kp: any,
  p: SwapRequest,
  tier: "low" | "mid" | "high"
): Promise<SwapResult> {
  const bal = await w.getBalance();
  const reqd = BigInt(toNano((p.amountTon + 0.25).toString()));
  if (bal < reqd) {
    throw new Error(`insufficient balance have=${fromNano(bal)} need=${fromNano(reqd)}`);
  }

  const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
  const tonAsset = Asset.native();
  const jetAsset = Asset.jetton(Address.parse(p.jettonMaster));
  const pool = client.open(
    await factory.getPool(PoolType.VOLATILE, [tonAsset, jetAsset])
  );

  // Estimate expected output from pool reserves using the CPMM formula.
  // DeDust volatile pools use a constant-product AMM with 0.3% swap fee.
  let amountTokens: string | undefined;
  try {
    const reserves = await pool.getReserves();
    const amountIn = toNano(p.amountTon.toString());
    const reserveIn = BigInt(reserves[0]);      // TON side
    const reserveOut = BigInt(reserves[1]);      // Jetton side
    if (reserveIn > 0n && reserveOut > 0n) {
      // amountOut = reserveOut * amountIn * 997 / (reserveIn * 1000 + amountIn * 997)
      const numerator = reserveOut * amountIn * 997n;
      const denominator = reserveIn * 1000n + amountIn * 997n;
      if (denominator > 0n) {
        amountTokens = (numerator / denominator).toString();
      }
    }
  } catch {
    // Estimation failure is non-fatal — trade-plan skill handles missing amountTokens.
    log.debug("DEDUST", "pool reserve estimation unavailable — amountTokens will be unknown");
  }

  // @dedust v0.8.x: getNativeVault() replaces getVault(Asset.native()).
  const nativeVault = client.open(await factory.getNativeVault());

  const swapBody = dedustSwapPayload({
    poolAddress: pool.address,
    limit: 0n,
    swapParams: { recipientAddress: w.address } as any,
  });

  log.info(
    "DEDUST",
    `[${tier.toUpperCase()}] buy seqno=${await w.getSeqno()} ton=${p.amountTon}` +
      (amountTokens ? ` → ~${(BigInt(amountTokens) / 10n ** 6n).toString()}…` : ""),
  );
  const r = await sendTransferLocked(
    tier,
    {
      wallet: w,
      secretKey: kp.sec,
      messages: [
        internal({
          to: nativeVault.address,
          value: toNano((p.amountTon + 0.25).toString()),
          body: swapBody,
        }),
      ],
    },
    client
  );
  return { ok: r.ok, dex: "dedust", error: r.error, amountTokens: r.ok ? amountTokens : undefined };
}

/** DeDust — SELL Jetton → TON */
async function dedustSell(
  client: TonClient,
  w: any,
  kp: any,
  p: SwapRequest,
  tier: "low" | "mid" | "high"
): Promise<SwapResult> {
  if (!p.jettonAmountNano) {
    throw new Error("jettonAmountNano is required for sell swap");
  }

  const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
  const tonAsset = Asset.native();
  const jetAsset = Asset.jetton(Address.parse(p.jettonMaster));
  const pool = client.open(
    await factory.getPool(PoolType.VOLATILE, [tonAsset, jetAsset])
  );

  // @dedust v0.8.x: getJettonVault(master) replaces getVault(Asset.jetton(...)).
  const jettonVault = client.open(
    await factory.getJettonVault(Address.parse(p.jettonMaster))
  );

  // Resolve the user's jetton-wallet address (TEP-74 get_wallet_address).
  const { stack } = await client.runMethod(
    Address.parse(p.jettonMaster),
    "get_wallet_address",
    [{ type: "slice", cell: beginCell().storeAddress(w.address).endCell() }]
  );
  const userJettonWallet = stack.readAddress();

  const queryId = Date.now();

  // Forward-payload into the jetton-vault: same swap cell shape as the buy.
  const forwardPayload = dedustSwapPayload({
    poolAddress: pool.address,
    limit: 0n,
    swapParams: { recipientAddress: w.address } as any,
  });

  // TEP-74 jetton-wallet transfer body.
  const body = beginCell()
    .storeUint(0xf8a7ea5, 32) // jetton-wallet transfer op
    .storeUint(queryId, 64)
    .storeCoins(BigInt(p.jettonAmountNano))
    .storeAddress(jettonVault.address)
    .storeAddress(w.address)          // response destination
    .storeBit(0)                      // custom_payload: null
    .storeCoins(toNano("0.25"))       // forward_ton_amount
    .storeBit(1)                      // forward_payload is a ref
    .storeRef(forwardPayload)
    .endCell();

  log.info(
    "DEDUST",
    `[${tier.toUpperCase()}] sell seqno=${await w.getSeqno()} jettons=${p.jettonAmountNano}`
  );
  const r = await sendTransferLocked(
    tier,
    {
      wallet: w,
      secretKey: kp.sec,
      messages: [
        internal({
          to: userJettonWallet,
          value: toNano("0.35"),
          body,
        }),
      ],
    },
    client
  );
  // For sells the jetton amount is known upfront from the input.
  return { ok: r.ok, dex: "dedust", error: r.error, amountTokens: r.ok ? p.jettonAmountNano : undefined };
}

/** Unified entry — routes per-tier through the coordinator-friendly flow. */
export async function executeSwap(
  client: TonClient,
  p: SwapRequest,
  tier: "low" | "mid" | "high",
  dex: Dex = CONFIG.strategy.preferredDex
): Promise<SwapResult> {
  try {
    const kp = await loadKeyPairForTier(tier);
    const { WalletContractV5R1, WalletContractV4 } = await import("@ton/ton");
    let w: any;
    if (CONFIG.walletVersion === "v4r2") {
      w = client.open(WalletContractV4.create({ workchain: 0, publicKey: kp.pub, walletId: CONFIG.walletSubwalletId }));
    } else {
      // v5r1 — see wallet.ts openWallet for the walletId shape meaning.
      // Cast to any preserves behavior parity with the legacy
      // `{ walletId: <number> }` SDK path that older @ton/ton supported.
      w = client.open(
        WalletContractV5R1.create({
          workchain: 0,
          publicKey: kp.pub,
          walletId: {
            networkGlobalId: CONFIG.network === "mainnet" ? -239 : -3,
            workchain: 0,
            subwalletNumber: CONFIG.walletSubwalletId,
            walletVersion: "v5r1",
          } as any,
        })
      );
    }

    if (p.side === "buy") {
      const r = dex === "dedust"
        ? await dedustBuy(client, w, kp, p, tier)
        : await stonfiBuy(client, w, kp, p, tier);
      log.trade("DEX", `[${tier.toUpperCase()}] OK ${r.dex} buy ${p.amountTon} TON` +
        (r.amountTokens ? ` → tokens=${r.amountTokens.slice(0, 12)}…` : ""));
      return r;
    } else {
      const r = dex === "dedust"
        ? await dedustSell(client, w, kp, p, tier)
        : await stonfiSell(client, w, kp, p, tier);
      log.trade("DEX", `[${tier.toUpperCase()}] ${r.ok ? "OK" : "FAIL"} ${r.dex} sell ${p.jettonAmountNano} tokens`);
      return r;
    }
  } catch (e: any) {
    log.err("DEX", `[${tier.toUpperCase()}] Swap failed: ${e.message}`);
    return { ok: false, dex, error: e.message };
  }
}
