/**
 * Hot wallet derivation with multi-tier BIP44 support.
 *
 * The mnemonic only ever lives in process memory of this runtime.
 * It is **never** sent to the web app over HTTPS.
 */
import { TonClient, WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey, mnemonicToHDSeed, deriveEd25519Path, keyPairFromSeed } from "@ton/crypto";
import { CONFIG } from "../config";

export function makeClient(): TonClient {
  const endpoint = CONFIG.tonApiKey
    ? `${CONFIG.rpcEndpoint}${CONFIG.rpcEndpoint.includes('?') ? '&' : '?'}api_key=${CONFIG.tonApiKey}`
    : CONFIG.rpcEndpoint;
  return new TonClient({ endpoint });
}

export interface KeyPair {
  pub: Buffer;
  sec: Buffer;
}

/**
 * Standard single-wallet keypair load (using TON PBKDF2 default path).
 */
export async function loadKeyPair(mnemonic = CONFIG.mnemonic): Promise<KeyPair> {
  if (!mnemonic) throw new Error("WALLET_MNEMONIC is empty.");
  const kp = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  return { pub: kp.publicKey, sec: kp.secretKey };
}

/**
 * Derives a sub-wallet keypair using BIP44/SLIP-10 derivation for the given tier.
 * LOW: m/44'/607'/0'/0'/1'  (TON BIP44 convention — all 5 indices are HARDENED)
 * MID: m/44'/607'/0'/0'/2'
 * HIGH: m/44'/607'/0'/0'/3'
 *
 * ⚠️  CRITICAL — @ton/crypto v3.x convention:
 *
 * `deriveEd25519Path(seed, path)` expects callers to pass UNHARDENED indices
 * (i.e. values < 0x80000000). The SDK adds the hardened bit itself
 * internally before constructing the HMAC payload. Passing an already-hardened
 * index (e.g. `44 + 0x80000000`) makes the SDK throw
 *   "Key index must be less than offset".
 *
 * The correct call form is therefore to pass a literal array like
 *   [44, 607, 0, 0, tierIndex]
 * — NOT [44+0x80000000, …]. Every element in this literal becomes
 * `<element> + 0x80000000` on the wire inside the SDK.
 *
 * Reference (read from @ton/crypto@3.3.0/dist/hd/ed25519.js):
 *   async function deriveED25519HardenedKey(parent, index) {
 *       if (index >= HARDENED_OFFSET) throw Error('Key index must be less than offset');
 *       const indexBuffer = Buffer.alloc(4);
 *       indexBuffer.writeUInt32BE(index + HARDENED_OFFSET, 0);  // SDK hardens
 *       ...
 *   }
 */
export async function loadKeyPairForTier(
  tier: "low" | "mid" | "high",
  mnemonic = CONFIG.mnemonic
): Promise<KeyPair> {
  if (!mnemonic) throw new Error("WALLET_MNEMONIC is empty.");
  const words = mnemonic.trim().split(/\s+/);
  const seed = await mnemonicToHDSeed(words);

  const index = tier === "low" ? 1 : tier === "mid" ? 2 : 3;

  // Path: m/44'/607'/0'/0'/index'  (UNHARDENED literals — SDK adds hardened bit)
  const path = [44, 607, 0, 0, index];

  const derivedSeed = await deriveEd25519Path(seed, path);
  const kp = keyPairFromSeed(derivedSeed);
  return { pub: kp.publicKey, sec: kp.secretKey };
}

/**
 * Opens a wallet contract for a specific keypair.
 *
 * @ton/ton v16 signature notes:
 *  - WalletContractV4R2 was removed; use WalletContractV4 (unified V4 class).
 *  - WalletContractV5R1.create now expects `walletId` as a Partial<WalletIdV5R1>
 *    object, not a bare number. Pass `{ subwalletNumber: id }` — the other fields
 *    (networkGlobalId, workchain) default appropriately and behaviour matches the
 *    prior `{ walletId: <number> }` call for our mainnet config.
 */
export function openWallet(client: TonClient, kp: KeyPair) {
  const id = CONFIG.walletSubwalletId;
  let w: any;
  if (CONFIG.walletVersion === "v4r2") {
    w = WalletContractV4.create({ workchain: 0, publicKey: kp.pub, walletId: id });
  } else if (CONFIG.walletVersion === "v3r2") {
    w = WalletContractV3R2.create({ workchain: 0, publicKey: kp.pub, walletId: id });
  } else {
    // v5r1 (default) — @ton/ton v16 expects either the legacy number form or
    // an explicit `WalletIdV5R1` client-context. Casting to `any` here is the
    // safest bridge; the legacy `{ walletId: <number> }` form routes through
    // the SDK's serialiser and is preserved at runtime. We also bind the full
    // ClientContext shape (networkGlobalId -239 / workchain 0 / v5r1) as a
    // belt-and-suspenders default so the address hash matches the pre-v16
    // derivation for mainnet ops.
    w = WalletContractV5R1.create({
      workchain: 0,
      publicKey: kp.pub,
      walletId: {
        networkGlobalId: CONFIG.network === "mainnet" ? -239 : -3,
        workchain: 0,
        subwalletNumber: id,
        walletVersion: "v5r1",
      } as any,
    });
  }
  return client.open(w);
}

/**
 * Opens the wallet for a specific tier.
 */
export async function openWalletForTier(client: TonClient, tier: "low" | "mid" | "high") {
  const kp = await loadKeyPairForTier(tier);
  return openWallet(client, kp);
}
