/**
 * DEX execution router — Ston.fi & DeDust.
 *
 * Sells: via Jetton Wallet → swap to pTON/TON. The same router pattern
 * works for both. We only bridge the *buy* directly here; sells follow the
 * `SwapAction.ts` pattern: fetch jetton wallet address, get swap params,
 * forward the jetton wallet transfer to the router with swap payload.
 *
 * ⚠️ Read `brochure /docs/STONE_FI_V1.md` for the v1 router semantics.
 */
import { TonClient, toNano, fromNano, internal, SendMode, Address } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { DEX, pTON } from "@ston-fi/sdk";
import { Factory, MAINNET_FACTORY_ADDR, Asset, VaultNative, PoolType } from "@dedust/sdk";
import { CONFIG } from "../config";
import { log } from "../logger";

export type Dex = "stonfi" | "dedust";

export interface SwapRequest {
    jettonMaster: string;
    amountTon: number;
    side: "buy" | "sell";
    minOutJettonNano?: string;   // slippage control
    jettonAmountNano?: string;   // for sell side
}

export interface SwapResult {
    ok: boolean;
    dex: Dex;
    error?: string;
}

const kpCache: { pub?: Buffer; sec?: Buffer } = {};

async function getKp() {
    if (!kpCache.pub) {
        const m = CONFIG.mnemonic;
        if (!m) throw new Error("WALLET_MNEMONIC is empty.");
        const kp = await mnemonicToPrivateKey(m.trim().split(/\s+/));
        kpCache.pub = kp.publicKey;
        kpCache.sec = kp.secretKey;
    }
    return kpCache;
}

async function getWallet(client: TonClient) {
    const kp = await getKp();
    const { WalletContractV5R1, WalletContractV4R2 } = await import("@ton/ton");
    if (CONFIG.walletVersion === "v4r2") {
        return client.open(WalletContractV4R2.create({ workchain: 0, publicKey: kp.pub! }));
    }
    return client.open(WalletContractV5R1.create({
        workchain: 0,
        publicKey: kp.pub!,
        walletId: CONFIG.walletSubwalletId,
    }));
}

/** Ston.fi — BUY TON → Jetton */
async function stonfiBuy(client: TonClient, w: any, p: SwapRequest): Promise<SwapResult> {
    const bal = await w.getBalance();
    const reqd = BigInt(toNano((p.amountTon + 0.25).toString()));
    if (bal < reqd) throw new Error(`insufficient balance have=${fromNano(bal)} need=${fromNano(reqd)}`);

    const router = client.open(DEX.v1.Router.create(
        "EQB3ncyBUTjZUAUOTn7f_yB-s5SscCjH-M-6f9Z6P3Z-1p"
    ));
    const proxyTon = new pTON.v1();

    const txParams = await router.getSwapTonToJettonTxParams({
        userWalletAddress: w.address,
        proxyTon,
        offerAmount: p.amountTon.toString(),
        askJettonAddress: p.jettonMaster,
        minAskAmount: p.minOutJettonNano ?? "1",
        queryId: Date.now(),
    });

    const seqno = await w.getSeqno();
    log.info("STONFI", `buy seqno=${seqno} ton=${p.amountTon}`);
    await w.sendTransfer({
        seqno,
        secretKey: kpCache.sec!,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to: txParams.to, value: txParams.value, body: txParams.body })],
    });
    return { ok: true, dex: "stonfi" };
}

/** DeDust — BUY TON → Jetton */
async function dedustBuy(client: TonClient, w: any, p: SwapRequest): Promise<SwapResult> {
    const bal = await w.getBalance();
    const reqd = BigInt(toNano((p.amountTon + 0.25).toString()));
    if (bal < reqd) throw new Error(`insufficient balance have=${fromNano(bal)} need=${fromNano(reqd)}`);

    const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
    const tonAsset = Asset.native();
    const jetAsset = Asset.jetton(Address.parse(p.jettonMaster));
    const vault = client.open(await factory.getVault(tonAsset));
    const pool = client.open(await factory.getPool(PoolType.VOLATILE, [tonAsset, jetAsset]));

    const seqno = await w.getSeqno();
    log.info("DEDUST", `buy seqno=${seqno} ton=${p.amountTon}`);
    await w.sendTransfer({
        seqno,
        secretKey: kpCache.sec!,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({
            to: vault.address,
            value: toNano((p.amountTon + 0.25).toString()),
            body: VaultNative.createSwapPayload({
                poolAddress: pool.address,
                limit: 0n,
                swapParams: { recipientAddress: w.address } as any,
            }),
        })],
    });
    return { ok: true, dex: "dedust" };
}

/** Unified entry */
export async function executeSwap(
    client: TonClient,
    p: SwapRequest,
    dex: Dex = CONFIG.strategy.preferredDex,
): Promise<SwapResult> {
    try {
        const w = await getWallet(client);
        if (p.side === "buy") {
            const r = dex === "dedust"
                ? await dedustBuy(client, w, p)
                : await stonfiBuy(client, w, p);
            log.trade("DEX", `OK ${r.dex} buy ${p.amountTon} TON`);
            return r;
        }
        // SELL path is currently a stub
        log.warn("DEX", "sell side not yet implemented; use RiskManager :: closePosition()");
        return { ok: false, dex, error: "sell side not implemented" };
    } catch (e: any) {
        log.err("DEX", e.message);
        return { ok: false, dex, error: e.message };
    }
}
