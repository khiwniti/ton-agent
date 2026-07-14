/**
 * Hot wallet derivation.
 *
 * The mnemonic only ever lives in process memory of this runtime.
 * It is **never** sent to the web app over HTTPS.
 */
import { Address, TonClient, WalletContractV3R2, WalletContractV4R2, WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { CONFIG } from "../config";
import { log } from "../logger";

export function makeClient(): TonClient {
    return new TonClient({ endpoint: CONFIG.rpcEndpoint });
}

export interface KeyPair { pub: Buffer; sec: Buffer }

export async function loadKeyPair(mnemonic = CONFIG.mnemonic): Promise<KeyPair> {
    if (!mnemonic) throw new Error("WALLET_MNEMONIC is empty.");
    const kp = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
    return { pub: kp.publicKey, sec: kp.secretKey };
}

export function openWallet(client: TonClient, kp: KeyPair) {
    const id = CONFIG.walletSubwalletId;
    let w: any;
    if (CONFIG.walletVersion === "v4r2") w = WalletContractV4R2.create({ workchain: 0, publicKey: kp.pub });
    else if (CONFIG.walletVersion === "v3r2") w = WalletContractV3R2.create({ workchain: 0, publicKey: kp.pub });
    else w = WalletContractV5R1.create({ workchain: 0, publicKey: kp.pub, walletId: id });
    return client.open(w);
}
