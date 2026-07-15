/**
 * wallet-bootstrap skill — mirrors wallet.ton.org's onboarding UX.
 *
 *   1. Generate (or read) a 24-word BIP39 mnemonic
 *   2. Derive a tier sub-wallet via BIP44 m/44'/607'/0'/0/{1,2,3}
 *   3. Compute the v5r1 wallet address (default version; matches wallet.ton.org)
 *   4. Print user-friendly representations (bounceable + non-bounceable + raw)
 *   5. If testnet and teleton enabled, emit the @testgiver_ton_bot deep-link
 *   6. Optionally check the address deploy state via TonAPI
 *
 * NEVER logs the mnemonic outside an explicit --release-mnemonic flag.
 */
import type { SkillManifest } from "../runtime";

export const manifest: SkillManifest = {
    name: "wallet-bootstrap",
    version: "1.0.0",
    description:
        "Bootstrap a per-tier TON hot wallet from the master mnemonic. Computes the v5r1 address, prints user-friendly representations (bounceable + non-bounceable + raw hex) and optionally links to the @testgiver_ton_bot testnet faucet. Mirrors wallet.ton.org's onboarding UX. When the master-mnemonic env var is unset, the executor REFUSES to mint a throwaway wallet and throws \u2014 pass input.mintIfEmpty=true to opt-in to fresh-mnemonic minting (intended for the CLI onboarding flow only).",
    requires: {
        env: ["WALLET_MASTER_MNEMONIC"],
        tools: [],
    },
    inputSchema: {
        type: "object",
        properties: {
            tier: { type: "string", enum: ["low", "mid", "high"], default: "low" },
            network: { type: "string", enum: ["mainnet", "testnet"], default: "mainnet" },
            releaseMnemonic: { type: "boolean", default: false },
            verifyDeploy: { type: "boolean", default: true },
            mintIfEmpty: {
                type: "boolean",
                default: false,
                description: "Explicit opt-in to mint a fresh 24-word BIP39 mnemonic when WALLET_MASTER_MNEMONIC is unset. Defaults to FALSE so the runtime refuses to generate throwaway wallets that hold zero funds. Only the CLI onboarding flow should set this to TRUE.",
            },
        },
    },
    outputSchema: {
        type: "object",
        properties: {
            tier: { type: "string", enum: ["low", "mid", "high"] },
            network: { type: "string", enum: ["mainnet", "testnet"] },
            walletVersion: { type: "string" },
            subwalletId: { type: "number" },
            bounceable: { type: "string" },
            nonBounceable: { type: "string" },
            raw: { type: "string" },
            deployStatus: { type: "string", enum: ["uninit", "active", "nonexist", "unknown"] },
            faucetHint: { type: "string" },
            mnemonicReleased: { type: "string", description: "Only present when input.releaseMnemonic=true. Never populated otherwise." },
        },
        required: ["tier", "network", "walletVersion", "subwalletId", "bounceable", "nonBounceable", "raw", "deployStatus", "faucetHint"],
    },
    examples: [
        "Bootstrap a LOW wallet on mainnet: { tier: 'low', network: 'mainnet' }",
        "Bootstrap a HIGH wallet on testnet and verify deploy: { tier: 'high', network: 'testnet', verifyDeploy: true }",
    ],
} as const;
