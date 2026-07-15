/**
 * CLI: bootstrap a per-tier TON wallet from the master mnemonic.
 *
 *   Usage:
 *     npx ts-node src/cli/wallet-bootstrap.ts --tier low --network mainnet
 *     npx ts-node src/cli/wallet-bootstrap.ts --tier mid --network testnet --release-mnemonic
 *
 *   --tier              low | mid | high   (default 'low')
 *   --network           mainnet | testnet  (default = CONFIG.network)
 *   --release-mnemonic  prints the mnemonic to stdout ONCE (with banner warning)
 *   --no-verify         skip the on-chain deploy check
 *
 * The CLI invokes the registered `wallet-bootstrap` skill so the *same* code
 * powers both automated skill calls and the interactive MXI bootstrap.
 */
import "dotenv/config";
import { log } from "../logger";
import { listSkills, invokeSkill, type SkillContext } from "../skills/runtime";

function parseArgs(argv: string[]): { tier: "low" | "mid" | "high"; network: "mainnet" | "testnet"; releaseMnemonic: boolean; verifyDeploy: boolean } {
    const out = {
        tier: "low" as "low" | "mid" | "high",
        network: ((process.env.NETWORK ?? "mainnet") as "mainnet" | "testnet"),
        releaseMnemonic: false,
        verifyDeploy: true,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--tier") out.tier = argv[++i] as any;
        else if (a === "--network") out.network = argv[++i] as any;
        else if (a === "--release-mnemonic") out.releaseMnemonic = true;
        else if (a === "--no-verify") out.verifyDeploy = false;
    }
    return out;
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (!["low", "mid", "high"].includes(args.tier)) {
        console.error(`Invalid --tier: ${args.tier} (low|mid|high)`);
        process.exit(2);
    }
    if (!["mainnet", "testnet"].includes(args.network)) {
        console.error(`Invalid --network: ${args.network} (mainnet|testnet)`);
        process.exit(2);
    }

    log.banner("WALLET BOOTSTRAP CLI", args.releaseMnemonic ? "RELEASE-MNEMONIC ON" : "address-only");

    // Sanity: the skill is loaded at import time. List to confirm.
    const skills = listSkills().map((s) => s.name);
    if (!skills.includes("wallet-bootstrap")) {
        console.error("FATAL: wallet-bootstrap skill is not registered. Did the import order change?");
        process.exit(3);
    }

    // Skill context is not required by wallet-bootstrap (it derives the
    // address directly), but the runtime still expects one. Pass an empty
    // stub so the call typechecks.
    const ctx: SkillContext = { tools: {}, tier: args.tier };
    // Pass mintIfEmpty=true so first-time operators without an env-set
    // mnemonic can still bootstrap a fresh wallet via this CLI. The runtime
    // and tests default to FALSE which forces an explicit mnemonic env var.
    const r = await invokeSkill("wallet-bootstrap", { ...args, mintIfEmpty: true }, ctx);
    if (!r.ok) {
        // Cast to the discriminated-union false branch so `error` is reachable.
        const err = r as Extract<typeof r, { ok: false }>;
        console.error(`FAIL: ${err.error}`);
        process.exit(1);
    }

    // r.ok is now narrowed to true; cast the output to the shape wallet-bootstrap emits.
    type WbOutput = {
        tier: string;
        network: string;
        walletVersion: string;
        subwalletId: number;
        bounceable: string;
        nonBounceable: string;
        raw: string;
        deployStatus: "uninit" | "active" | "nonexist" | "unknown";
        faucetHint: string;
        mnemonicReleased?: string;
    };
    const out = r.output as unknown as WbOutput;
    log.ok("CLI", `${out.tier.toUpperCase()} ${out.network} v${out.walletVersion} subwallet=${out.subwalletId}`);
    log.ok("CLI", `deploy=${out.deployStatus}`);
    log.ok("CLI", `addr=${out.bounceable}`);

    if (args.releaseMnemonic && typeof out.mnemonicReleased === "string") {
        // The skill already printed to stdout with a banner. We simply exit.
        process.exit(0);
    }

    process.exit(0);
})();
