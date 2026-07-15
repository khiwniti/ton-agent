/**
 * wallet-bootstrap executor.
 *
 * Implements the wallet.ton.org onboarding flow inside the agent runtime:
 *   mnemonic → BIP44 derivation → v5r1 contract → user-friendly addresses.
 *
 * Mnemonic safety: the master's mnemonic is NEVER logged unless the caller
 * explicitly sets releaseMnemonic=true. Even then it is printed once, to
 * stdout, with a banner warning.
 */
import { Address, type TonClient } from "@ton/ton";
import { mnemonicNew } from "@ton/crypto";
import { CONFIG } from "../../config";
import { log } from "../../logger";
import { tonapiGet } from "../../http/tonapi";
import {
  loadKeyPairForTier,
  makeClient,
  openWallet,
} from "../../wallet/wallet";
import type { SkillHandler, SkillContext } from "../runtime";
import { manifest } from "./manifest";

type Input = {
    tier: "low" | "mid" | "high";
    network: "mainnet" | "testnet";
    releaseMnemonic?: boolean;
    verifyDeploy?: boolean;
    /**
     * Explicit opt-in for the CLI onboarding flow. When true AND the master
     * mnemonic env var is unset, the skill mints a fresh 24-word BIP39
     * mnemonic and uses it. Defaults to FALSE — runtime and tests MUST supply
     * an explicit mnemonic so empty-env operators don't silently generate
     * throwaway wallets that hold zero funds.
     */
    mintIfEmpty?: boolean;
};

type Output = {
    tier: "low" | "mid" | "high";
    network: "mainnet" | "testnet";
    walletVersion: string;
    subwalletId: number;
    bounceable: string;
    nonBounceable: string;
    raw: string;
    deployStatus: "uninit" | "active" | "nonexist" | "unknown";
    faucetHint: string;
    /** Only ever populated when releaseMnemonic=true. Otherwise undefined. */
    mnemonicReleased?: string;
};

async function checkDeployStatus(
    client: TonClient,
    address: Address,
    network: "mainnet" | "testnet",
): Promise<Output["deployStatus"]> {
    try {
        const r = await client.getContractState(address);
        // TonClient.getContractState returns { state: 'active' | 'uninitialized' | 'nonexist' }.
        const s = (r as any)?.state;
        if (s === "active") return "active";
        if (s === "uninitialized") return "uninit";
        if (s === "nonexist") return "nonexist";
        return "unknown";
    } catch {
        // Fallback to TONAPI on failure (network may be different liteserver).
        try {
            const r = await tonapiGet(`/accounts/${address.toString()}`, { timeoutMs: 5000 });
            const status = r.data?.status as string | undefined;
            if (status === "active") return "active";
            if (status === "uninit") return "uninit";
            if (status === "nonexist") return "nonexist";
            return "unknown";
        } catch (e: any) {
            log.warn("WALLET-BOOT", `deploy status probe failed: ${e.message}`);
            return "unknown";
        }
    }
}

/**
 * Print the user-friendly addresses ONCE. Holds no internal references so
 * the mnemonic can be garbage-collected after the function returns.
 */
const execute: SkillHandler<Input, Output>["execute"] = async (input, _ctx: SkillContext) => {
    const tier = input.tier ?? "low";
    const network = input.network ?? CONFIG.network;
    const releaseMnemonic = Boolean(input.releaseMnemonic);
    const verifyDeploy = input.verifyDeploy !== false; // default true

    // 1. Mnemonic — use env or mint fresh. NEVER log the env-sourced one.
    let mnemonic: string;
    if (CONFIG.mnemonic && CONFIG.mnemonic.trim().split(/\s+/).length >= 12) {
        mnemonic = CONFIG.mnemonic.trim();
        log.info("WALLET-BOOT", `using existing WALLET_MASTER_MNEMONIC (length=${mnemonic.split(/\s+/).length})`);
    } else if (input.mintIfEmpty === true) {
        // CLI onboarding flow ONLY. Allows the operator to bootstrap a fresh
        // wallet without a pre-existing mnemonic. Refuses by default so that
        // an empty-env runtime does NOT silently mint throwaway words.
        const fresh: string[] = await mnemonicNew(24);
        mnemonic = fresh.join(" ");
        log.warn("WALLET-BOOT", "⚠️  WALLET_MASTER_MNEMONIC unset — minted a one-off 24-word mnemonic (LOST ON RESTART)");
    } else {
        throw new Error(
            "WALLET_MNEMONIC (or WALLET_MASTER_MNEMONIC) is empty — refusing to mint a throwaway mnemonic that would hold zero funds. " +
            "Set the env var, or call this skill with input.mintIfEmpty=true (CLI onboarding flow only)."
        );
    }

    // 2. Derive the tier keypair.
    const kp = await loadKeyPairForTier(tier, mnemonic);
    const client = makeClient();
    const w = openWallet(client, kp);
    const address = w.address;

    // 3. Address formatting — match wallet.ton.org's three representations.
    // mainnet uses bounceable=EQ..., non-bounceable=UQ... (base64 url-safe).
    // testnet uses the same prefix forms but with testOnly flag marking
    // them as testnet addresses per TON user-friendly format spec.
    const testOnly = network === "testnet";
    const bounceable = address.toString({ bounceable: true, testOnly, urlSafe: true });
    const nonBounceable = address.toString({ bounceable: false, testOnly, urlSafe: true });
    const raw = address.toRawString();

    // 4. Deploy check.
    const deployStatus = verifyDeploy
        ? await checkDeployStatus(client, address, network)
        : "unknown" as const;

    // 5. Faucet hint.
    const faucetHint = testOnly
        ? `Send '/start ${nonBounceable}' to @testgiver_ton_bot on Telegram to receive 2 testnet TON.`
        : `Send any TON amount to ${nonBounceable} to activate the wallet contract.`;

    // 6. Print a banner (no mnemonic unless explicitly released).
    log.banner("WALLET-BOOT", `${tier.toUpperCase()} • ${network.toUpperCase()} • v${CONFIG.walletVersion} • subwallet=${CONFIG.walletSubwalletId}`);
    log.ok("WALLET-BOOT", `bounceable     ${bounceable}`);
    log.ok("WALLET-BOOT", `non-bounceable ${nonBounceable}`);
    log.ok("WALLET-BOOT", `raw hex        ${raw}`);
    log.info("WALLET-BOOT", `deploy status  ${deployStatus}`);
    log.info("WALLET-BOOT", faucetHint);

    const out: Output = {
        tier,
        network,
        walletVersion: CONFIG.walletVersion,
        subwalletId: CONFIG.walletSubwalletId,
        bounceable,
        nonBounceable,
        raw,
        deployStatus,
        faucetHint,
    };

    // Explicit release path — gated behind a flag because re-printing a
    // mnemonic to a non-interactive log destination is catastrophic.
    if (releaseMnemonic) {
        out.mnemonicReleased = mnemonic;
        log.warn("WALLET-BOOT", "⚠️  MNEMONIC RELEASE FLAG ON — printing once to LOG and stdout below.");
        // eslint-disable-next-line no-console
        console.log(mnemonic);
    }

    // Wipe the local string from memory before returning to minimise the
    // window a memory dump could leak it. JS doesn't guarantee memset, but
    // clearing it surfaces no useful data in console.log of closure scopes.
    mnemonic = "";
    return out;
};

export const handler: SkillHandler<Input, Output> = {
    manifest,
    execute,
};

import { registerSkill } from "../runtime";
registerSkill(handler);
