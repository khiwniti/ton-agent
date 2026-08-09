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
 *  - `VaultNative.createSwapPayload` does NOT exist in v0.8.x — only
 *    `sendSwap` (which broadcasts). The native BUY body is built manually by
 *    `dedustNativeSwapPayload` below, mirroring `VaultNative.sendSwap`.
 *  - The vaults are NOT interchangeable: the native vault dispatches on
 *    opcode `0xea06185d` with a `queryId(64) + amount(coins)` body head,
 *    while the jetton vault dispatches on `0xe3a0d482` with a body that
 *    starts at the pool address. Sending a jetton body to the native vault
 *    bounces (exit 65535) — every DeDust buy did exactly this until the
 *    native builder landed (see git history / prod tx 734fe94c…).
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
  VaultNative,
  type SwapParams,
} from "@dedust/sdk";
import { CONFIG, isTestnet } from "../config";
import { log } from "../logger";
import { loadKeyPair, loadKeyPairForTier } from "../wallet/wallet";
import { sendTransferLocked } from "../wallet/locked-wallet";

export interface SwapQuote {
  route: { dex: Dex; poolAddress: string };
  side: "buy" | "sell";
  amountInNano: string;
  expectedOutNano: string;
  resolvedAt: number;
  available: boolean;
}

// ── Network-aware DEX contract addresses ──────────────────────────
// Ston.fi v1 router: mainnet vs testnet.
// v1 mainnet router address — single source of truth from the @ston-fi/sdk
// bundle's constants. The prior hard-coded string was NOT a real contract
// address, causing Address.parse to throw "Unknown address type" inside
// getSwapQuote and abort every swap at the quote step.
//
// Note: Ston.fi v1 SDK's getSwapTonToJettonTxParams returns SenderArguments
// {to, value, body} without expectedOutput field. We must use pool's
// getExpectedOutputs for quote estimation.
const STONFI_ROUTER_ADDR = isTestnet()
  ? "kQBsGx9ArADUrREB34W-ghgsCgBShvfUr4Jvlu-0KGc33a1n"
  : "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";

// DeDust has no public testnet factory; on testnet we fall back to Ston.fi.
// Keep the mainnet DeDust factory import for mainnet use.
const DEDUST_FACTORY_ADDR = (() => {
  if (isTestnet()) return null; // No DeDust on testnet
  return MAINNET_FACTORY_ADDR;
})();

export type Dex = "stonfi" | "dedust";

export type SwapExecutionStatus =
  | "confirmed"
  | "signing_failed"
  | "broadcast_failed"
  | "broadcast_unknown"
  | "blocked";

export type SwapResult = {
    ok: boolean;
    dex: Dex;
    status?: SwapExecutionStatus;
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

export function parsePositiveNano(value: string | undefined, field: string): bigint {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a positive integer in nano units`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error(`${field} must be greater than zero`);
  }
  return parsed;
}

export async function readWithRetries<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export function requireExecutableQuote(
  minOutJettonNano: string | undefined,
  quoteRequest: string
): bigint {
  if (!minOutJettonNano) {
    throw new Error(`No executable quote available for ${quoteRequest} — swap blocked`);
  }
  return parsePositiveNano(minOutJettonNano, "minOutJettonNano");
}

export function classifyTransferResult(result: {
  success: boolean;
  error?: string;
}): SwapExecutionStatus {
  if (result.success) return "confirmed";
  if (result.error?.includes("sign")) return "signing_failed";
  if (result.error?.includes("broadcast")) return "broadcast_failed";
  return "broadcast_unknown";
}

export { computeMinOut } from "./minout";

export interface SwapRequest {
  jettonMaster: string;
  amountTon: number;
  side: "buy" | "sell";
  minOutJettonNano?: string;      // slippage control — set by coordinator when quote available
  jettonAmountNano?: string;      // amount of jettons to sell
  /** TODO(future): Route the swap through the budgeting wallet contract
   *  using the agent's ephemeral key and signed transfer serializer.
   *  The budgeting contract validates signature + daily spend limits
   *  before forwarding the swap payload to the DEX.
   *
   *  Currently reserved — executeSwap does not check these fields yet.
   *  To enable, wire executeSwap to call executeSwapViaBudgetingWallet
   *  from agentic-wallet.ts when useBudgetingWallet=true. */
  useBudgetingWallet?: boolean;
  /** Address of the deployed budgeting contract. Required when
   *  useBudgetingWallet is true. */
  budgetingAddress?: string;
}

import {
  evaluateBuyGasGuard,
  evaluateSellGasGuard,
} from "./swap-gas-guard";

// ── Worst-case exit reserve ───────────────────────────────────────────
//
// Why we reserve TON for swaps even on the buy path:
//   In a worst-case scenario (every open position rug-pulls / dumps),
//   we MUST still be able to call exit (sell → TON). Ston.fi sells forward
//   ~0.25 TON + ~0.05 gas; DeDust sells reserve 0.35 TON explicitly. A sell
//   the wallet can't AFFORD will be dropped by the broadcaster at send-time,
//   leaving the position stuck OPEN, and the SL/TP exit will keep firing
//   forever against the same dead wallet. This floor guarantees that even
//   when every position burns zero, there is enough TON left to:
//     (a) pay gas for the next sell, and
//     (b) keep the bank's exit door open until an operator tops up.
//
// NOTE: this is checked on BOTH sides:
//   - BUY gate: refuse a buy when balance <  requested_size + exit_reserve.
//   - SELL gate: refuse a sell when balance <  exit_reserve (covers the
//                send + forward + gas fees for THIS sell).
//
// Implementation: see swap-gas-guard.ts (pure functions, unit-tested).

/**
 * DeDust JETTON-vault swap-payload builder — `VaultJetton.createSwapPayload`
 * (opcode `0xe3a0d482`). This is the ONLY vault this body is valid for: the
 * jetton vault dispatches on `0xe3a0d482` and expects a body that starts at
 * the pool address (no queryId/amount head). It is used as the `forward_payload`
 * of the SELL path's jetton-wallet transfer into the jetton vault.
 *
 * ⚠️ Do NOT reuse this for the native (TON) BUY vault — the native vault
 * dispatches on `0xea06185d` with a `queryId(64) + amount(coins)` head. Use
 * `dedustNativeSwapPayload` instead. (Before that builder existed, every
 * DeDust buy bounced with exit 65535.)
 *
 * Strictly typed against the v0.8.7 d.ts file:
 *   - `limit: bigint` (optional in upstream, we always pass `0n` to mean
 *     unlimited, which is the correct setting for the trade sizes we use)
 *   - `next: SwapStep` (optional, we always omit)
 *   - `swapParams: SwapParams` (optional; recipientAddress is `Address | null`
 *     in the type so we wrap it in an exact-shape object)
 *
 * Runtime sanity check verifies the returned Cell is non-empty so any future
 * DeDust API drift surfaces loudly rather than silently misencoding the cell.
 */
export function dedustSwapPayload(args: {
  poolAddress: Address;
  limit: bigint;
  swapParams?: SwapParams;
}): Cell {
  // Runtime presence check: a missing function is the first signal of an
  // API drift on DeDust's side. Throw with a clear, operator-actionable
  // message instead of letting the resulting `undefined is not a function`
  // bubble out.
  const builder = (VaultJetton as unknown as {
    createSwapPayload?: typeof VaultJetton.createSwapPayload;
  }).createSwapPayload;
  if (typeof builder !== "function") {
    throw new Error(
      "DeDust swap-payload builder missing in @dedust/sdk @0.8.x — refuse to encode swap cell",
    );
  }
  const cell = builder.call(VaultJetton, args) as Cell;
  // Defense-in-depth: if the SDK ships a future version that returns an
  // empty/invalid cell, fail loud instead of silently broadcasting garbage.
  if (!cell || typeof cell.toBoc !== "function") {
    throw new Error(
      `DeDust createSwapPayload returned an invalid cell (${typeof cell}) — refusing to encode swap cell`,
    );
  }
  return cell;
}

/**
 * `Vault.packSwapParams` is `protected` in @dedust/sdk v0.8.x, so it cannot
 * be reached from here. Replicated inline with the exact layout from
 * `node_modules/@dedust/sdk/dist/contracts/dex/vault/Vault.js`:
 * `deadline(32) + recipientAddress + referralAddress + maybeRef(fulfillPayload)
 * + maybeRef(rejectPayload)`.
 */
function packSwapParams(p: SwapParams): Cell {
  return beginCell()
    .storeUint(p.deadline ?? 0, 32)
    .storeAddress(p.recipientAddress ?? null)
    .storeAddress(p.referralAddress ?? null)
    .storeMaybeRef(p.fulfillPayload ?? null)
    .storeMaybeRef(p.rejectPayload ?? null)
    .endCell();
}

/**
 * DeDust NATIVE-vault swap-payload builder (BUY: TON → Jetton).
 *
 * The native vault dispatches ONLY on `0xea06185d` (`VaultNative.SWAP`) and
 * expects a body head of `op(32) + queryId(64) + amount(coins)` — a different
 * layout from the jetton vault's `0xe3a0d482` body (which omits queryId/amount
 * and starts at the pool address). The SDK v0.8.x exposes no static
 * `createSwapPayload` for the native vault (only `sendSwap`, which broadcasts),
 * so we build the cell here, mirroring `VaultNative.sendSwap` exactly:
 *
 *   op(0xea06185d, 32) + queryId(64) + amount(coins) + poolAddress +
 *   reserved(1) + limit(coins) + maybeRef(next) + ref(swapParams)
 */
export function dedustNativeSwapPayload(args: {
  poolAddress: Address;
  amount: bigint;
  queryId?: bigint | number;
  limit?: bigint;
  swapParams?: SwapParams;
}): Cell {
  return beginCell()
    .storeUint(VaultNative.SWAP, 32)
    .storeUint(BigInt(args.queryId ?? 0), 64)
    .storeCoins(args.amount)
    .storeAddress(args.poolAddress)
    .storeUint(0, 1) // reserved bit (matches VaultNative.sendSwap)
    .storeCoins(args.limit ?? 0n)
    .storeMaybeRef(null) // next step — none for a direct single-leg swap
    .storeRef(packSwapParams(args.swapParams ?? {}))
    .endCell();
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
  // Refuses the buy when wallet can't afford position + forward + exit-reserve.
  // See swap-gas-guard.ts — the worst-case sell must still be payable after
  // this buy settles.
  const guard = evaluateBuyGasGuard(Number(fromNano(bal)), p.amountTon);
  if (!guard.ok) {
    throw new Error(guard.error);
  }

  const router = client.open(
    DEX.v1.Router.create(STONFI_ROUTER_ADDR)
  );
  const proxyTon = new pTON.v1();
  const pTONAddress = pTON.v1.address;
  const jettonMasterAddr = Address.parse(p.jettonMaster);

  // Get expected output from pool using on-chain estimation.
  // Ston.fi SDK's getSwapTonToJettonTxParams does NOT include expectedOutput,
  // so we must call getExpectedOutputs on the pool directly.
  let amountTokens: string | undefined;
  try {
    const poolAddress = await router.getPoolAddress({
      token0: pTONAddress,
      token1: jettonMasterAddr,
    });
    const pool = client.open(DEX.v1.Pool.create(poolAddress));

    // Use pool.getPoolData() to obtain jetton wallet address directly from
    // the pool — avoids importing the unexported JettonMinter class which
    // fails in production (SDK has restricted `exports`).
    const poolData = await pool.getPoolData();
    // For TON→Jetton buy: jettonWallet must be token1WalletAddress (the
    // pool's wallet holding the jetton on the swap-out side).
    const jettonWalletAddress = poolData.token1WalletAddress;

    const result = await pool.getExpectedOutputs({
      amount: p.amountTon.toString(),
      jettonWallet: jettonWalletAddress,
    });
    amountTokens = result.jettonToReceive.toString();
  } catch (e: any) {
    log.warn("STONFI", `pool estimate unavailable: ${e.message}`);
  }

  const txParams = await router.getSwapTonToJettonTxParams({
    userWalletAddress: w.address,
    proxyTon,
    offerAmount: p.amountTon.toString(),
    askJettonAddress: p.jettonMaster,
    minAskAmount: p.minOutJettonNano ?? "1", // fallback to 1 nanojetton if not set
    queryId: Date.now(),
  });

  log.info(
    "STONFI",
    `[${tier.toUpperCase()}] buy seqno=${await w.getSeqno()} ton=${p.amountTon}` +
      (amountTokens ? ` → ${(BigInt(amountTokens) / 10n ** 6n).toString()}…` : ""),
  );
  // Pre-broadcast jetton balance — the delivered INCREMENT (after − before)
  // is the position size, not the cumulative balance (see verifyBuyDelivered).
  const buyBalanceBefore = await readUserJettonBalance(
    client,
    Address.parse(p.jettonMaster),
    w.address,
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

  // Post-broadcast verification: use the ACTUAL delivered balance, not the
  // pool estimate — same rationale as dedustBuy (see verifyBuyDelivered).
  if (r.ok) {
    const delivered = await verifyBuyDelivered({
      client,
      master: p.jettonMaster,
      walletAddress: w.address,
      expectedNano: amountTokens ? BigInt(amountTokens) : 0n,
      balanceBefore: buyBalanceBefore,
    });
    if (!delivered.ok) {
      log.err("STONFI", `[${tier.toUpperCase()}] ${delivered.error}`);
      return { ok: false, dex: "stonfi", error: delivered.error };
    }
    log.info(
      "STONFI",
      `[${tier.toUpperCase()}] buy verified: delivered=${delivered.actualBalance} (estimate=${amountTokens ?? "n/a"})`,
    );
    amountTokens = delivered.actualBalance.toString();
  }
  return { ok: r.ok, dex: "stonfi", error: r.error, amountTokens: r.ok ? amountTokens : undefined };
}

/** Ston.fi — SELL Jetton → TON */
async function stonfiSell(
  client: TonClient,
  w: any,
  kp: any,
  p: SwapRequest,
  tier: "low" | "mid" | "high"
): Promise<SwapResult> {
  if (!p.jettonAmountNano) {
    throw new Error("jettonAmountNano is required for sell swap");
  }

  // Worst-case exit-reserve preflight: refuse to broadcast when the wallet
  // cannot pay sell gas (txParams.value≈0.25 forward + ≈0.05 sender gas).
  // Returning here is cheaper than letting the broadcaster drop the tx and
  // re-fire every monitor tick forever.
  const bal = await w.getBalance();
  const sellGuard = evaluateSellGasGuard(Number(fromNano(bal)));
  if (!sellGuard.ok) {
    log.err("STONFI", `[${tier.toUpperCase()}] sell REFUSED: ${sellGuard.error}`);
    return { ok: false, dex: "stonfi", error: sellGuard.error };
  }

  const router = client.open(DEX.v1.Router.create(STONFI_ROUTER_ADDR));
  const proxyTon = new pTON.v1();

  // Get swap params from the Ston.fi router (returns the tx to execute).
  // The SDK internally builds the jetton-wallet transfer + forward payload.
  const txParams = await router.getSwapJettonToTonTxParams({
    userWalletAddress: w.address,
    offerJettonAddress: p.jettonMaster,
    offerAmount: p.jettonAmountNano,
    proxyTon,
    minAskAmount: p.minOutJettonNano ?? "1", // fallback to 1 nanoTON if not set
    queryId: Date.now(),
  });

  log.info(
    "STONFI",
    `[${tier.toUpperCase()}] sell seqno=${await w.getSeqno()} jettons=${p.jettonAmountNano}`,
  );
  // Baseline jetton balance BEFORE broadcast (see dedustSell — same
  // post-broadcast delta proof, same requirement that the baseline be
  // captured before signing).
  const sellBalanceBefore = await readUserJettonBalance(
    client,
    Address.parse(p.jettonMaster),
    w.address,
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

  // Post-broadcast verification: the outer wallet tx may have landed while
  // the inner swap bounced. Only report ok when the jettons actually left.
  if (r.ok) {
    const verified = await verifySellExecuted({
      client,
      master: p.jettonMaster,
      walletAddress: w.address,
      soldNano: BigInt(p.jettonAmountNano),
      balanceBefore: sellBalanceBefore,
    });
    if (!verified.ok) {
      log.err("STONFI", `[${tier.toUpperCase()}] ${verified.error}`);
      return { ok: false, dex: "stonfi", error: verified.error };
    }
    log.info(
      "STONFI",
      `[${tier.toUpperCase()}] sell verified: jetton balance ${verified.balanceBefore} → ${verified.balanceAfter}`,
    );
  }

  return {
    ok: r.ok,
    dex: "stonfi",
    error: r.error,
    amountTokens: r.ok ? p.jettonAmountNano : undefined,
  };
}

/**
 * Pure buy-delivered increment — exported for unit tests
 * (test/sell-verify.test.ts).
 *
 * The delivered amount is `after − before`. When the pre-broadcast baseline
 * is unreadable (`null`) we fall back to the cumulative `after` balance
 * (fresh buys start at 0; a re-buy with a dead baseline over-records, but
 * failing the buy on an RPC hiccup would orphan delivered tokens).
 */
export function computeDeliveredIncrement(args: {
  balanceBefore: bigint | null;
  balanceAfter: bigint | null;
}): bigint | null {
  if (args.balanceAfter === null) return null;
  if (args.balanceBefore === null) return args.balanceAfter;
  return args.balanceAfter - args.balanceBefore;
}

/**
 * Post-broadcast BUY verification: read the ACTUAL jetton balance the wallet
 * now holds and use the DELIVERED INCREMENT (after − before) as the position's
 * token amount — never the pool-reserve estimate (which can be off by orders
 * of magnitude on thin memepad curves — prod NOTINU: estimate 437T, actual
 * delivered ~19.9M; the subsequent sell of the phantom 437T bounced with
 * exit 706).
 *
 * The pre-broadcast baseline distinguishes "this buy delivered X" from
 * "the wallet already held X" on re-buys: without it, re-buying a jetton
 * already held would record the CUMULATIVE balance as the position size,
 * over-stating the holding and later bouncing sells exactly like the phantom.
 *
 * Returns `{ ok, error, actualBalance }` where actualBalance is the delivered
 * increment (null when unverifiable — callers must NOT trust the estimate).
 */
async function verifyBuyDelivered(args: {
  client: TonClient;
  master: string;
  walletAddress: Address;
  expectedNano: bigint;
  /** Pre-broadcast jetton balance; null = unreadable (fall back to after). */
  balanceBefore: bigint | null;
}): Promise<{ ok: boolean; error: string; actualBalance: bigint | null }> {
  const masterAddr = Address.parse(args.master);
  // Give the index a couple of blocks to reflect the mint.
  const ATTEMPTS = 5;
  const DELAY_MS = 2_000;
  let actual: bigint | null = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    actual = await readUserJettonBalance(
      args.client,
      masterAddr,
      args.walletAddress,
    );
    const gained = computeDeliveredIncrement({
      balanceBefore: args.balanceBefore,
      balanceAfter: actual,
    });
    if (gained !== null && gained > 0n) break;
  }
  if (actual === null) {
    return {
      ok: false,
      error: "buy unverifiable: could not read post-buy jetton balance — refusing to trust the estimate",
      actualBalance: null,
    };
  }
  const gained = computeDeliveredIncrement({
    balanceBefore: args.balanceBefore,
    balanceAfter: actual,
  });
  if (gained <= 0n) {
    return {
      ok: false,
      error: `buy BOUNCED: no new jettons delivered (before=${args.balanceBefore ?? "unread"} after=${actual}, expected ~${args.expectedNano}) — swap child tx did not deliver`,
      actualBalance: gained,
    };
  }
  return { ok: true, error: "", actualBalance: gained };
}

/** DeDust — BUY TON → Jetton */
async function dedustBuy(
  client: TonClient,
  w: any,
  kp: any,
  p: SwapRequest,
  tier: "low" | "mid" | "high"
): Promise<SwapResult> {
  if (isTestnet()) {
    return { ok: false, dex: "dedust", error: "DeDust not available on testnet (no public factory) — use stonfi" };
  }
  const bal = await w.getBalance();
  // Mirror of stonfiBuy — same worst-case exit reservation floor.
  // See swap-gas-guard.ts (effectiveBuyReserveTon = max(EXIT_RESERVE,
  // BANKROLL_FLOOR)) so the stricter floor always wins.
  const guard = evaluateBuyGasGuard(Number(fromNano(bal)), p.amountTon);
  if (!guard.ok) {
    throw new Error(guard.error);
  }

  const factory = client.open(Factory.createFromAddress(DEDUST_FACTORY_ADDR!));
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

  // Native vault body: op 0xea06185d + queryId(64) + amount(coins) head.
  // The jetton-vault body (dedustSwapPayload, op 0xe3a0d482) is rejected by
  // the native vault (exit 65535) — every buy bounced until this was fixed.
  const swapBody = dedustNativeSwapPayload({
    poolAddress: pool.address,
    amount: toNano(p.amountTon.toString()),
    limit: 0n,
    swapParams: { recipientAddress: w.address },
  });

  log.info(
    "DEDUST",
    `[${tier.toUpperCase()}] buy seqno=${await w.getSeqno()} ton=${p.amountTon}` +
      (amountTokens ? ` → ~${(BigInt(amountTokens) / 10n ** 6n).toString()}…` : ""),
  );
  // Pre-broadcast jetton balance — the delivered INCREMENT (after − before)
  // is the position size, not the cumulative balance (see verifyBuyDelivered).
  const buyBalanceBefore = await readUserJettonBalance(
    client,
    Address.parse(p.jettonMaster),
    w.address,
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

  // Post-broadcast verification: record the ACTUAL delivered balance, not the
  // reserve estimate. The estimate can be wildly wrong on thin curves (prod
  // NOTINU: estimated 437T, delivered ~19.9M), and selling the phantom amount
  // later bounces with exit 706 while the books claim a closed position.
  if (r.ok) {
    const delivered = await verifyBuyDelivered({
      client,
      master: p.jettonMaster,
      walletAddress: w.address,
      expectedNano: amountTokens ? BigInt(amountTokens) : 0n,
      balanceBefore: buyBalanceBefore,
    });
    if (!delivered.ok) {
      log.err("DEDUST", `[${tier.toUpperCase()}] ${delivered.error}`);
      return { ok: false, dex: "dedust", error: delivered.error };
    }
    log.info(
      "DEDUST",
      `[${tier.toUpperCase()}] buy verified: delivered=${delivered.actualBalance} (estimate=${amountTokens ?? "n/a"})`,
    );
    // The truth, not the estimate.
    amountTokens = delivered.actualBalance.toString();
  }
  return { ok: r.ok, dex: "dedust", error: r.error, amountTokens: r.ok ? amountTokens : undefined };
}

/**
 * Read the user's jetton-wallet balance for a master on-chain (TEP-74
 * get_wallet_address), returned in raw jetton units.
 *
 * Reuses the exact same call shape as `dedustSell`/`stonfiSell` resolve the
 * user jetton wallet. `null` on any RPC failure — callers must treat a null
 * read as "unverifiable" (fail closed for post-broadcast verification).
 */
export async function readUserJettonBalance(
  client: TonClient,
  masterAddr: Address,
  userWalletAddr: Address,
): Promise<bigint | null> {
  try {
    const { stack } = await client.runMethod(
      masterAddr,
      "get_wallet_address",
      [{ type: "slice", cell: beginCell().storeAddress(userWalletAddr).endCell() }],
    );
    const jettonWallet = stack.readAddress();
    // TEP-74 `get_wallet_data` — first stack item is the jetton balance.
    // NOT `client.getBalance()`: that returns the jetton-wallet contract's
    // nanoton balance (~0.0199 TON of storage rent), which made every sell
    // read the same ~19.9M regardless of the token and left `spent` at 0, so
    // verifySellDelta reported BOUNCED forever and the monitor retried each
    // tick. Same read as recovery/position-recovery.ts:72.
    const data = await client.runMethod(jettonWallet, "get_wallet_data");
    return data.stack.readBigNumber();
  } catch (e: any) {
    log.warn("DEX", `jetton balance read failed: ${e.message}`);
    return null;
  }
}

/**
 * Pure sell-delta verdict — exported for unit tests (test/sell-verify.test.ts).
 *
 * Returns ok ONLY when the jettons actually left the wallet:
 *  - `balanceBefore <= 0` with `soldNano > 0` means the tokens were ALREADY
 *    gone before this broadcast (a previous sell landed but verification
 *    false-failed). The desired end-state is achieved, so this counts as
 *    executed — otherwise the retry loop would bounce forever.
 *  - `spent <= 0` after a broadcast = the transfer bounced (e.g. DeDust vault
 *    exit 706 when the requested amount exceeds the balance held).
 *  - partial moves (< 99% of soldNano) = the swap did not complete cleanly.
 */
export function verifySellDelta(args: {
  balanceBefore: bigint;
  balanceAfter: bigint;
  soldNano: bigint;
}): { ok: boolean; error: string } {
  const { balanceBefore, balanceAfter, soldNano } = args;
  if (balanceBefore <= 0n) {
    return { ok: true, error: "" };
  }
  const spent = balanceBefore - balanceAfter;
  if (spent <= 0n) {
    return {
      ok: false,
      error: `sell BOUNCED: jetton balance did not decrease after broadcast (before=${balanceBefore} after=${balanceAfter}) — swap child tx failed, tokens never left the wallet`,
    };
  }
  // Tolerate the pool taking fees/rounding: require at least 99% of the
  // requested amount to have left. (If the requested amount exceeded the
  // balance, the transfer itself bounces — caught by spent<=0 above.)
  const movedEnough = spent >= (soldNano * 99n) / 100n;
  if (!movedEnough) {
    return {
      ok: false,
      error: `sell PARTIAL/BOUNCED: only ${spent} of ${soldNano} jetton left the wallet — swap child tx did not complete cleanly`,
    };
  }
  return { ok: true, error: "" };
}

/**
 * Post-broadcast SELL verification.
 *
 * WHY THIS EXISTS — prod tx `eb09fbc5…` (2026-08-08): the wallet signed and
 * broadcast a DeDust jetton transfer, the wallet seqno incremented, and
 * `dedustSell` returned `ok:true` — but the CHILD swap transaction bounced
 * (jetton wallet exit 706: transfer amount exceeded the balance the wallet
 * actually held). The monitor then booked the position CLOSED with a
 * realized −0.3456 TON loss while the jettons never left the wallet. The
 * wallet was never actually sold; the books claimed a loss that never
 * happened, and the tokens were orphaned (no open position tracked them).
 *
 * `sendTransferLocked` only proves the OUTER wallet tx was included. On TON
 * the actual swap is a separate child transaction that can fail
 * independently — and the parent wallet tx reports `success:true` even when
 * the child bounces (that is exactly what prod tx `eb09fbc5…` showed:
 * wallet ok=true, jetton wallet aborted exit 706). The ONLY reliable signal
 * is the jetton-balance delta measured across the broadcast, so the caller
 * MUST capture the pre-transfer baseline (`balanceBefore`) BEFORE signing.
 *
 * Fail closed: any unverifiable read (baseline or post-check) returns
 * ok:false so the caller leaves the position OPEN and retries instead of
 * booking a phantom loss.
 */
async function verifySellExecuted(args: {
  client: TonClient;
  master: string;
  walletAddress: Address;
  soldNano: bigint;
  /** Jetton balance read BEFORE the transfer was broadcast (pre-transfer baseline). */
  balanceBefore: bigint | null;
}): Promise<{
  ok: boolean;
  error: string;
  balanceBefore: bigint | null;
  balanceAfter: bigint | null;
}> {
  const masterAddr = Address.parse(args.master);

  // We could not read the pre-transfer baseline — cannot verify. Fail closed:
  // a sell we cannot prove happened must not be booked as happened.
  if (args.balanceBefore === null) {
    return {
      ok: false,
      error: "sell unverifiable: could not read pre-transfer jetton balance — not booking as executed",
      balanceBefore: null,
      balanceAfter: null,
    };
  }

  // Give the index a few blocks to reflect the transfer. The wallet seqno
  // already incremented (transfer broadcast), so the child settle should be
  // visible within a few seconds on a healthy index.
  const ATTEMPTS = 5;
  const DELAY_MS = 2_000;
  let after: bigint | null = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    after = await readUserJettonBalance(args.client, masterAddr, args.walletAddress);
    if (after !== null) break;
  }

  if (after === null) {
    return {
      ok: false,
      error: "sell unverifiable: post-transfer jetton balance read failed — not booking as executed",
      balanceBefore: args.balanceBefore,
      balanceAfter: null,
    };
  }

  const verdict = verifySellDelta({
    balanceBefore: args.balanceBefore,
    balanceAfter: after,
    soldNano: args.soldNano,
  });
  return {
    ok: verdict.ok,
    error: verdict.error,
    balanceBefore: args.balanceBefore,
    balanceAfter: after,
  };
}

/** DeDust — SELL Jetton → TON */
async function dedustSell(
  client: TonClient,
  w: any,
  kp: any,
  p: SwapRequest,
  tier: "low" | "mid" | "high"
): Promise<SwapResult> {
  if (isTestnet()) {
    return { ok: false, dex: "dedust", error: "DeDust not available on testnet (no public factory) — use stonfi" };
  }
  if (!p.jettonAmountNano) {
    throw new Error("jettonAmountNano is required for sell swap");
  }

  // Worst-case exit-reserve preflight (mirror of stonfiSell above).
  // DeDust sends 0.35 TON explicitly per sell; we check that floor
  // instead of letting `sendTransferLocked` fail downstream at broadcast.
  const sellBal = await w.getBalance();
  const sellGuard2 = evaluateSellGasGuard(Number(fromNano(sellBal)));
  if (!sellGuard2.ok) {
    log.err("DEDUST", `[${tier.toUpperCase()}] sell REFUSED: ${sellGuard2.error}`);
    return { ok: false, dex: "dedust", error: sellGuard2.error };
  }

  const factory = client.open(Factory.createFromAddress(DEDUST_FACTORY_ADDR!));
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

  // Forward-payload into the JETTON vault: op 0xe3a0d482 body (jetton vault
  // dispatches on this opcode). NOT the native body — the jetton vault would
  // reject a 0xea06185d body.
  const forwardPayload = dedustSwapPayload({
    poolAddress: pool.address,
    limit: 0n,
    swapParams: { recipientAddress: w.address },
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

  // Baseline jetton balance BEFORE broadcast — the post-broadcast delta is
  // the proof the swap actually executed. prod tx `eb09fbc5…`: the wallet
  // seqno incremented but the child swap bounced (exit 706) and the sell
  // was wrongly booked as executed. The baseline must be read BEFORE the
  // transfer is sent, or a fast-settling index reads it already spent and
  // reports a phantom bounce. Reuses the userJettonWallet resolved above
  // (no second get_wallet_address round-trip).
  let sellBalanceBefore: bigint | null = null;
  try {
    sellBalanceBefore = await client.getBalance(userJettonWallet);
  } catch (e: any) {
    log.warn("DEX", `jetton balance read failed: ${e.message}`);
  }

  // Post-broadcast verification — only report ok when the jettons actually
  // left the wallet.
  if (r.ok) {
    const verified = await verifySellExecuted({
      client,
      master: p.jettonMaster,
      walletAddress: w.address,
      soldNano: BigInt(p.jettonAmountNano),
      balanceBefore: sellBalanceBefore,
    });
    if (!verified.ok) {
      log.err("DEDUST", `[${tier.toUpperCase()}] ${verified.error}`);
      return { ok: false, dex: "dedust", error: verified.error };
    }
    log.info(
      "DEDUST",
      `[${tier.toUpperCase()}] sell verified: jetton balance ${verified.balanceBefore} → ${verified.balanceAfter}`,
    );
  }

  // For sells the jetton amount is known upfront from the input.
  return { ok: r.ok, dex: "dedust", error: r.error, amountTokens: r.ok ? p.jettonAmountNano : undefined };
}

async function checkPoolMinimum(
  client: TonClient,
  p: SwapRequest,
  dex: Dex
): Promise<{ ok: boolean; reason?: string }> {
  if (p.side !== "buy") return { ok: true };
  const totalTon = p.amountTon + 0.25; // gas cushion
  if (totalTon < CONFIG.strategy.poolMinimumTon) {
    return {
      ok: false,
      reason: `below-pool-minimum: ${totalTon.toFixed(4)} TON < ${CONFIG.strategy.poolMinimumTon} TON`,
    };
  }

  // Best-effort reserve check for DeDust; Ston.fi getExpectedOutputs will reject
  // on tiny inputs naturally, so we rely on the configured floor above.
  if (dex === "dedust" && !isTestnet()) {
    try {
      const factory = client.open(Factory.createFromAddress(DEDUST_FACTORY_ADDR!));
      const tonAsset = Asset.native();
      const jetAsset = Asset.jetton(Address.parse(p.jettonMaster));
      const pool = await factory.getPool(PoolType.VOLATILE, [tonAsset, jetAsset]);
      if (pool) {
        const reserves = await client.open(pool).getReserves();
        const reserveIn = Number(reserves[0]) / 1e9;
        // Require trade (with gas) to be at least 1% of reserve to be economic.
        // Below this amount the impact is negligible and most routers will fail.
        const effectiveMinimum = Math.min(CONFIG.strategy.poolMinimumTon, reserveIn * 0.01);
        if (totalTon < effectiveMinimum) {
          return {
            ok: false,
            reason: `below-pool-minimum: ${totalTon.toFixed(4)} TON < effective ${effectiveMinimum.toFixed(4)} TON (reserve=${reserveIn.toFixed(2)} TON)`,
          };
        }
      }
    } catch {
      /* pool reserve query is best-effort; fall through to configured floor */
    }
  }

  return { ok: true };
}

// ── SwapQuote (US1) ────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Dead pool cache — short-lived TTL cache of pool addresses that have
// recently returned a fail-closed quote. When the radar/coordinator
// keeps retrying the same dead-address pool, we suppress the RPC call
// (and the LLM cycle that depends on it) until the TTL expires.
//
// Why: pools surfaced by the radar may be valid addresses that do not
// implement the PoolV1 get-methods dispatcher (exit_code -13 "method
// not found"). Repeatedly hitting them wastes RPC budget AND burns
// LLM ticks on radar hits that can never resolve to a trade.
//
// TTL is short (default 5 min) so newly-deployed pools that come
// online after a radar miss still get a second chance at the next tick.
// ─────────────────────────────────────────────────────────────────────
const deadPoolCache = new Map<string, number>(); // poolAddress → expiresAt ms

// Default TTL constant for the dead-pool cache (resolved from CONFIG at
// module init so it picks up env overrides). 5 min matches
// AUDIT_CACHE_TTL_MS — short enough to retry newly-deployed pools within
// one radar tick cycle, long enough to skip truly-dead addresses for many
// radar bursts in a row.
const DEAD_POOL_TTL_MS = (CONFIG as any).strategy?.deadPoolCacheTtlMs ?? 300000;

/** Returns true if the pool address is currently cached as dead. */
function isPoolDead(poolAddress: string): boolean {
  const expiresAt = deadPoolCache.get(poolAddress);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    deadPoolCache.delete(poolAddress);
    return false;
  }
  return true;
}

/** Mark a pool address as dead until `now + ttl`. */
function markPoolDead(poolAddress: string, ttl: number): void {
  deadPoolCache.set(poolAddress, Date.now() + ttl);
}

/**
 * Fetch a price quote for the given route/side/amount.
 * Uses the DEX SDK's existing estimation (getExpectedOutputs or pool reserves).
 *
 * Returns null when the pool is unreachable (fail-closed), or a SwapQuote
 * with available=false when the estimation itself failed.
 *
 * Caller must provide the pool address (pre-resolved) and jetton master address.
 */
export async function getSwapQuote(
  client: TonClient,
  route: { dex: Dex; poolAddress: string },
  side: "buy" | "sell",
  amountInNano: string,
  jettonMaster: string,
): Promise<SwapQuote | null> {
  const now = Date.now();

  // Short-circuit: if this pool has been failing recently, skip the RPC
  // entirely. The radar can keep firing; the coordinator/LLM won't.
  if ((route.dex === "stonfi" || route.dex === "dedust") && route.poolAddress && isPoolDead(route.poolAddress)) {
    return {
      route, side, amountInNano,
      expectedOutNano: "0", resolvedAt: now, available: false,
    };
  }

  try {
    if (route.dex === "stonfi") {
      const router = client.open(DEX.v1.Router.create(STONFI_ROUTER_ADDR));

      // Get the pool and compute expected output using on-chain estimation.
      // Ston.fi v1 Router.getPool takes (token0, token1) as JettonMinter addresses.
      // For TON token, we use pTON.v1.address as the representative.
      const pTONAddress = pTON.v1.address;
      const jettonMasterAddr = Address.parse(jettonMaster);

      // Get the pool from the router using getPoolAddress (avoids the
      // undefined-return issue seen with router.getPool in production).
      let pool: any;
      let poolAddress: Address | null = null;
      try {
        poolAddress = await router.getPoolAddress({
          token0: pTONAddress,
          token1: jettonMasterAddr,
        });
        pool = client.open(DEX.v1.Pool.create(poolAddress));
      } catch (e: any) {
        log.warn("DEX", `getSwapQuote: failed to get Ston.fi pool: ${e.message}`);
        if (route.poolAddress) markPoolDead(route.poolAddress, DEAD_POOL_TTL_MS);
        return {
          route, side, amountInNano,
          expectedOutNano: "0", resolvedAt: now, available: false,
        };
      }

      // Use pool.getPoolData() to get jetton wallet addresses directly from
      // the pool contract itself. Avoids importing the unexported JettonMinter
      // class from the SDK (which fails in production builds because the SDK
      // has restricted exports and `dist/contracts/core/JettonMinter`
      // subpath is not accessible).
      let jettonWalletForGetExpectedOutputs: Address;
      try {
        const poolData = await pool.getPoolData();
        // For TON→Jetton buy: jettonWallet is token1WalletAddress (jetton side).
        // For Jetton→TON sell: jettonWallet is token0WalletAddress (pTON side).
        jettonWalletForGetExpectedOutputs = side === "buy"
          ? poolData.token1WalletAddress
          : poolData.token0WalletAddress;
      } catch (e: any) {
        log.warn("DEX", `getSwapQuote: getPoolData failed: ${e.message}`);
        // exit_code -13 = method not found in contract — pool address is
        // not a real PoolV1 with the get-methods dispatcher. Cache it.
        if (route.poolAddress) markPoolDead(route.poolAddress, DEAD_POOL_TTL_MS);
        return {
          route, side, amountInNano,
          expectedOutNano: "0", resolvedAt: now, available: false,
        };
      }

      // Use the pool's getExpectedOutputs for accurate on-chain estimation.
      let expectedOutNano: string;
      try {
        const result = await pool.getExpectedOutputs({
          amount: amountInNano,
          jettonWallet: jettonWalletForGetExpectedOutputs,
        });
        expectedOutNano = result.jettonToReceive.toString();
      } catch (e: any) {
        log.warn("DEX", `getSwapQuote: getExpectedOutputs failed: ${e.message}`);
        if (route.poolAddress) markPoolDead(route.poolAddress, DEAD_POOL_TTL_MS);
        return {
          route, side, amountInNano,
          expectedOutNano: "0", resolvedAt: now, available: false,
        };
      }

      const avail = BigInt(expectedOutNano) > 0n;
      return {
        route, side, amountInNano,
        expectedOutNano, resolvedAt: now, available: avail,
      };
    }

    if (route.dex === "dedust") {
      if (isTestnet()) {
        return { route, side, amountInNano, expectedOutNano: "0", resolvedAt: now, available: false };
      }
      const factory = client.open(Factory.createFromAddress(DEDUST_FACTORY_ADDR!));
      const tonAsset = Asset.native();
      const jetAsset = Asset.jetton(Address.parse(jettonMaster));
      const pool = client.open(await factory.getPool(PoolType.VOLATILE, [tonAsset, jetAsset]));
      const reserves = await pool.getReserves();
      if (!reserves || reserves.length < 2) {
        // Previously a silent available:false. A memepad curve drained to dust
        // leaves the VOLATILE pool deployed but empty; the operator must SEE
        // this and the pool must be dead-marked so the next radar tick skips
        // re-quoting it.
        log.warn("DEX", `getSwapQuote: dedust ${side} degenerate pool — getReserves returned ${reserves?.length ?? "empty"} entries (${jettonMaster.slice(0, 8)}…)`);
        if (route.poolAddress) markPoolDead(route.poolAddress, DEAD_POOL_TTL_MS);
        return { route, side, amountInNano, expectedOutNano: "0", resolvedAt: now, available: false };
      }

      const reserveTon = BigInt(reserves[0]);
      const reserveJetton = BigInt(reserves[1]);
      if (reserveTon <= 0n || reserveJetton <= 0n) {
        log.warn("DEX", `getSwapQuote dedust ${side} ${jettonMaster.slice(0, 8)}… drained pool: reserveTon=${reserveTon} reserveJetton=${reserveJetton}`);
        if (route.poolAddress) markPoolDead(route.poolAddress, DEAD_POOL_TTL_MS);
        return { route, side, amountInNano, expectedOutNano: "0", resolvedAt: now, available: false };
      }

      const amountIn = BigInt(amountInNano);
      let expectedOutNano: string;
      if (side === "buy") {
        // TON→Jetton: amountIn is TON, reserveIn = TON, reserveOut = Jetton
        const numerator = reserveJetton * amountIn * 997n;
        const denominator = reserveTon * 1000n + amountIn * 997n;
        expectedOutNano = denominator > 0n ? (numerator / denominator).toString() : "0";
      } else {
        // Jetton→TON: amountIn is Jetton, reserveIn = Jetton (reserveJetton), reserveOut = TON (reserveTon)
        const numerator = reserveTon * amountIn * 997n;
        const denominator = reserveJetton * 1000n + amountIn * 997n;
        expectedOutNano = denominator > 0n ? (numerator / denominator).toString() : "0";
      }

      const avail = BigInt(expectedOutNano) > 0n;
      if (!avail) {
        // The pool passed the reserves sanity check but the constant-product
        // math still yields zero output for this size — the memepad curve has
        // a TON-side residue with an empty jetton side. Surface it loudly:
        // previously this returned available:false with NO log line at all.
        log.warn("DEX", `getSwapQuote dedust ${side} ${jettonMaster.slice(0, 8)}… zero output: reserveTon=${reserveTon} reserveJetton=${reserveJetton} amountIn=${amountIn} expectedOut=0`);
        if (route.poolAddress) markPoolDead(route.poolAddress, DEAD_POOL_TTL_MS);
      }
      return {
        route, side, amountInNano,
        expectedOutNano, resolvedAt: now, available: avail,
      };
    }

    // Unknown DEX
    return null;
  } catch (e: any) {
    log.warn("DEX", `getSwapQuote failed: ${route.dex} ${side} amount=${amountInNano} — ${e.message}`);
    if (route.dex === "stonfi" && route.poolAddress) markPoolDead(route.poolAddress, DEAD_POOL_TTL_MS);
    return null;
  }
}

/** Unified entry — routes per-tier through the coordinator-friendly flow. */
export async function executeSwap(
  client: TonClient,
  p: SwapRequest,
  tier: "low" | "mid" | "high",
  dex: Dex = CONFIG.strategy.preferredDex
): Promise<SwapResult> {
  try {
    // LOW tier uses the legacy (non-HD) mnemonic path — must match the coordinator.
    // MID/HIGH use HD derivation with per-tier indices.
    const kp = tier === "low" ? await loadKeyPair() : await loadKeyPairForTier(tier);
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

    // On testnet, DeDust is unavailable — silently fall back to Ston.fi.
    const effectiveDex: Dex = isTestnet() && dex === "dedust" ? "stonfi" : dex;
    if (effectiveDex !== dex) {
      log.info("DEX", `[${tier.toUpperCase()}] ${dex} not available on testnet — falling back to stonfi`);
    }

    const poolMinimumCheck = await checkPoolMinimum(client, p, effectiveDex);
    if (!poolMinimumCheck.ok) {
      log.warn("DEX", `[${tier.toUpperCase()}] ${poolMinimumCheck.reason}`);
      return { ok: false, dex: effectiveDex, error: poolMinimumCheck.reason };
    }

    if (p.side === "buy") {
      const r = effectiveDex === "dedust"
        ? await dedustBuy(client, w, kp, p, tier)
        : await stonfiBuy(client, w, kp, p, tier);
      log.trade("DEX", `[${tier.toUpperCase()}] OK ${r.dex} buy ${p.amountTon} TON` +
        (r.amountTokens ? ` → tokens=${r.amountTokens.slice(0, 12)}…` : ""));
      return r;
    } else {
      const r = effectiveDex === "dedust"
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
