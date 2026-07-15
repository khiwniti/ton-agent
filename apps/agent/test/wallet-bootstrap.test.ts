/**
 * Tests for the wallet-bootstrap skill.
 *
 *   • Address derivation is deterministic for the same (mnemonic, tier,
 *     network, subwalletId, walletVersion).
 *   • The mnemonic NEVER appears on stdout/stderr unless releaseMnemonic
 *     is true (we test the false path explicitly).
 *
 * `wallet-bootstrap` runs fullKey derivation + address formatting — pure,
 * deterministic, no network. Safe to call directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Sandbox the SQLite path BEFORE importing the runtime (storage init).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ton-agent-wb-test-"));
process.env.DATA_DIR = tmpRoot;

// Set a small but real mnemonic so the skill uses the "existing env" branch
// (rather than minting fresh words). The mnemonic is fixed-test data; not
// derived from any real funds.
process.env.WALLET_MASTER_MNEMONIC = "test test test test test test test test test test test junk";

// These tests intentionally do NOT log the mnemonic. We assert no leak
// by capturing stdout/stderr around the call.
import "../src/skills"; // registers wallet-bootstrap
import { invokeSkill } from "../src/skills/runtime";
import { Address } from "@ton/ton";
import { CONFIG } from "../src/config";

function captureStdio<T>(fn: () => Promise<T>): { out: string; err: string; result: T } {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let out = "", err = "";
    (process.stdout.write as any) = (chunk: any): boolean => { out += String(chunk); return true; };
    (process.stderr.write as any) = (chunk: any): boolean => { err += String(chunk); return true; };
    return (async () => {
        try {
            const result = await fn();
            return { out, err, result };
        } finally {
            (process.stdout.write as any) = origOut;
            (process.stderr.write as any) = origErr;
        }
    })() as any;
}

test("wallet-bootstrap: emits three stable address formats", async () => {
    const r = await invokeSkill("wallet-bootstrap", {
        tier: "low",
        network: "mainnet",
        verifyDeploy: false, // skip on-chain probe
        releaseMnemonic: false,
    }, { tools: {}, tier: "low" });

    assert.equal(r.ok, true, JSON.stringify(r));
    const out = r.output as any;
    // Raw is always the same hex (parseable).
    assert.ok(typeof out.raw === "string" && out.raw.length > 0);
    Address.parseRaw(out.raw); // throws if invalid
    // Bounceable + non-bounceable are both user-friendly + url-safe base64.
    // Cover both mainnet (E/U prefix) and testnet (k/0 prefix) per the
    // TON user-friendly address spec — wallet.ton.org convention.
    assert.match(out.bounceable, /^[EUk0][QC]/);
    assert.match(out.nonBounceable, /^[EUk0][QC]/);
    // echo version + subwallet + tier correctly.
    assert.ok(["low", "mid", "high"].includes(out.tier));
    assert.equal(typeof out.walletVersion, "string");
    assert.equal(typeof out.subwalletId, "number");
});

test("wallet-bootstrap: same input => same address (deterministic)", async () => {
    const a = await invokeSkill("wallet-bootstrap", { tier: "mid", network: "mainnet", verifyDeploy: false }, { tools: {}, tier: "mid" });
    const b = await invokeSkill("wallet-bootstrap", { tier: "mid", network: "mainnet", verifyDeploy: false }, { tools: {}, tier: "mid" });
    assert.equal((a as any).output.raw, (b as any).output.raw);
    assert.equal((a as any).output.bounceable, (b as any).output.bounceable);
});

test("wallet-bootstrap: different tiers => different addresses", async () => {
    const lo = await invokeSkill("wallet-bootstrap", { tier: "low", network: "mainnet", verifyDeploy: false }, { tools: {}, tier: "low" });
    const md = await invokeSkill("wallet-bootstrap", { tier: "mid", network: "mainnet", verifyDeploy: false }, { tools: {}, tier: "mid" });
    const hi = await invokeSkill("wallet-bootstrap", { tier: "high", network: "mainnet", verifyDeploy: false }, { tools: {}, tier: "high" });
    const los = (lo as any).output.bounceable as string;
    const mds = (md as any).output.bounceable as string;
    const his = (hi as any).output.bounceable as string;
    assert.ok(los !== mds, "low == mid");
    assert.ok(mds !== his, "mid == high");
    assert.ok(los !== his, "low == high");
});

test("wallet-bootstrap: testnet addresses start with k/0 (per TON user-friendly spec)", async () => {
    const r = await invokeSkill("wallet-bootstrap", {
        tier: "low",
        network: "testnet",
        verifyDeploy: false,
    }, { tools: {}, tier: "low" });
    assert.equal(r.ok, true);
    const out = (r as any).output;
    // Per the TON user-friendly spec, testnet addresses use the same
    // `0:/k:` tag prefixes but the leading byte of the bounceable form is
    // 0x11 which base64-encodes to `kQ...` (vs `EQ...` on mainnet).
    assert.match(out.bounceable, /^kQ/, "testnet bounceable should start with kQ");
    assert.match(out.nonBounceable, /^0Q/, "testnet non-bounceable should start with 0Q");
});

test("wallet-bootstrap: with releaseMnemonic=true, mnemonic is printed ONCE", async () => {
    const captured = await captureStdio(() => invokeSkill("wallet-bootstrap", {
        tier: "low",
        network: "mainnet",
        verifyDeploy: false,
        releaseMnemonic: true,
    }, { tools: {}, tier: "low" }) as any);

    assert.equal(captured.result.ok, true);
    assert.ok(typeof (captured.result as any).output.mnemonicReleased === "string");
    // The mnemonic surfaced ONLY via the structured `mnemonicReleased` field
    // AND one console.log line. Capture verifies it printed at least once.
    assert.match(captured.out, /test test test test test test test test test test test junk/);
});

test("wallet-bootstrap: with releaseMnemonic=false, mnemonic is NEVER printed", async () => {
    const captured = await captureStdio(() => invokeSkill("wallet-bootstrap", {
        tier: "low",
        network: "mainnet",
        verifyDeploy: false,
        releaseMnemonic: false,
    }, { tools: {}, tier: "low" }) as any);

    assert.equal(captured.result.ok, true);
    assert.equal(typeof (captured.result as any).output.mnemonicReleased, "undefined");
    // The mnemonic must not leak to stdout/stderr.
    assert.ok(!/test test test test test test test test test test test junk/.test(captured.out));
    assert.ok(!/test test test test test test test test test test test junk/.test(captured.err));
});

test("wallet-bootstrap: throws when mnemonic missing and mintIfEmpty=false (no silent fresh-mint)", async () => {
    // CONFIG is a module-level singleton evaluated once; mutating its
    // `mnemonic` property simulates empty-env runtime without spawning a
    // child process. The executor reads CONFIG.mnemonic at execution time
    // per call (not at module load), so this faithfully exercises the throw
    // path. We restore the env-sourced mnemonic in `finally` so sibling
    // tests are unaffected.
    const originalMnemonic = CONFIG.mnemonic;
    CONFIG.mnemonic = "";
    try {
        const r = await invokeSkill("wallet-bootstrap", {
            tier: "low",
            network: "mainnet",
            verifyDeploy: false,
        }, { tools: {}, tier: "low" }) as any;
        // The skill catches the throw and returns ok=false with the
        // descriptive refusal message.
        assert.equal(r.ok, false, "skill should refuse to mint; instead returned ok=true");
        assert.match(r.error, /WALLET_MNEMONIC|WALLET_MASTER_MNEMONIC/);
        assert.match(r.error, /refusing to mint/);
        // Error MUST NOT contain the test mnemonic (real env-sourced
        // phrase); that would mean the executor leaked it via the throw.
        assert.ok(
            !/test test test test test test test test test test test junk/.test(r.error),
            "throw error mentions the test mnemonic — possible env-var leak in error path",
        );

        // mintIfEmpty=true should opt back into minting a fresh mnemonic.
        const r2 = await invokeSkill("wallet-bootstrap", {
            tier: "low",
            network: "mainnet",
            verifyDeploy: false,
            releaseMnemonic: false,
            mintIfEmpty: true,
        }, { tools: {}, tier: "low" }) as any;
        assert.equal(r2.ok, true, `mintIfEmpty=true should mint-then-succeed; got ${JSON.stringify(r2)}`);
        // The output should NOT contain the test mnemonic (a freshly minted
        // 24-word was used).
        assert.equal(typeof r2.output.mnemonicReleased, "undefined");
        // Output bounceable should look like a normal wallet address.
        assert.match(r2.output.bounceable, /^[EUk0][QC]/);
    } finally {
        CONFIG.mnemonic = originalMnemonic;
    }
});
