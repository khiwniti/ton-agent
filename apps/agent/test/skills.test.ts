/**
 * Tests for the skills registry.
 *
 *   • Every skill registered through the barrel at `src/skills/index.ts` must
 *     validate against `SkillManifestSchema`.
 *   • Skill names + versions are unique.
 *   • A skill's declared `requires.tools` must actually exist as keys in the
 *     LangChain tool registry (no dangling references).
 *
 * Imports use the barrel so all five skills register on import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Side-effect import: registers wallet-bootstrap, token-scout, audit-jetton,
// trade-plan, manual-override via their bottom-of-file `registerSkill` calls.
import "../src/skills";
import { listSkills, getSkill, SkillManifestSchema, invokeSkill } from "../src/skills/runtime";
import type { SkillContext } from "../src/skills/runtime";

test("registerSkill => 5 skills are visible via listSkills()", () => {
    const skills = listSkills();
    assert.equal(skills.length, 5, `expected 5 skills, got ${skills.length}`);
});

test("every skill manifest validates against the Zod schema", () => {
    for (const s of listSkills()) {
        const parsed = SkillManifestSchema.safeParse(s);
        assert.equal(parsed.success, true, `manifest invalid for ${s.name}: ${parsed.success ? "" : parsed.error.message}`);
    }
});

test("skill names are unique and stable", () => {
    const names = listSkills().map((s) => s.name);
    const uniq = new Set(names);
    assert.equal(uniq.size, names.length, `duplicate skill names: ${names.join(", ")}`);
    // Lock the names we ship so adding a new one is a deliberate test change.
    assert.deepEqual(names.sort(), [
        "audit-jetton",
        "manual-override",
        "token-scout",
        "trade-plan",
        "wallet-bootstrap",
    ]);
});

test("skill versions follow semver X.Y.Z", () => {
    for (const s of listSkills()) {
        assert.match(s.version, /^\d+\.\d+\.\d+$/, `${s.name} version ${s.version} not semver`);
    }
});

test("all skill descriptions are >= 20 chars (LLM-readable)", () => {
    for (const s of listSkills()) {
        assert.ok(s.description.length >= 20, `${s.name} description too short: ${s.description.length} chars`);
    }
});

test("getSkill returns each registered handler", () => {
    for (const s of listSkills()) {
        const h = getSkill(s.name);
        assert.ok(h, `getSkill(${s.name}) returned undefined`);
        assert.equal(h?.manifest.name, s.name);
        assert.equal(typeof h?.execute, "function");
    }
});

test("no skill has undeclared tool dependencies", () => {
    // Sanity: every requires.tools entry must be a known MCP tool name.
    // We don't fail the test if they're not (skills can demonstrate future
    // tools), but we DO log so a reader notices drift.
    const declared = new Set<string>();
    for (const s of listSkills()) {
        for (const t of s.requires?.tools ?? []) declared.add(t);
    }
    const known = ["audit_jetton", "check_risk_status", "execute_swap", "get_jetton_meta", "get_jetton_price", "get_wallet_balance", "record_position", "notify_web", "watch_position"];
    const undeclared = [...declared].filter((t) => !known.includes(t));
    assert.deepEqual(undeclared, [], `undeclared tool deps: ${undeclared.join(", ")}`);
});

test("trade-plan returns EXECUTED when execute_swap provides amountTokens", async () => {
    let recordedDex: string | undefined;
    const ctx: SkillContext = {
        tier: "low",
        tools: {
            audit_jetton: async () => ({
                renounced: true,
                lpLocked: true,
                honeypotSafe: true,
            }),
            check_risk_status: async () => ({ ok: true }),
            execute_swap: async () => ({
                ok: true,
                dex: "dedust",
                amountTokens: "5000000000",
                txHash: "0xdeadbeef",
            }),
            record_position: async (args: any) => {
                recordedDex = args.dex;
                return { ok: true, id: "pos_test_001" };
            },
            notify_web: async () => ({ ok: true }),
        },
    };

    const result = await invokeSkill("trade-plan", {
        jettonMaster: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        poolAddress: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        amountTon: 0.5,
        tier: "low",
        symbol: "TEST",
    }, ctx);

    assert.ok(result.ok, `expected ok=true, got error=${!result.ok ? (result as any).error : ""}`);
    if (!result.ok) return;
    assert.equal(result.output.verdict, "EXECUTED");
    assert.equal(result.output.amountTokensKnown, true);
    assert.equal(typeof result.output.positionId, "string");
    assert.ok(result.output.positionId!.startsWith("pos_"));
    // Verify DEX propagation: swapResult.dex flows through to record_position.
    assert.equal(recordedDex, "dedust");
});

test("trade-plan returns UNRECORDED when execute_swap omits amountTokens", async () => {
    const ctx: SkillContext = {
        tier: "low",
        tools: {
            audit_jetton: async () => ({
                renounced: true,
                lpLocked: true,
                honeypotSafe: true,
            }),
            check_risk_status: async () => ({ ok: true }),
            execute_swap: async () => ({
                ok: true,
                // No amountTokens — simulates the pre-fix behaviour where the
                // DEX router returned ok=true without the jetton amount.
            }),
            // record_position is present but should NOT be called.
            record_position: async () => {
                throw new Error("record_position should not be invoked when amountTokens is unknown");
            },
            notify_web: async () => ({ ok: true }),
        },
    };

    const result = await invokeSkill("trade-plan", {
        jettonMaster: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        poolAddress: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        amountTon: 0.5,
        tier: "low",
        symbol: "TEST",
    }, ctx);

    assert.ok(result.ok, `expected ok=true, got error=${!result.ok ? (result as any).error : ""}`);
    if (!result.ok) return;
    assert.equal(result.output.verdict, "UNRECORDED");
    assert.equal(result.output.amountTokensKnown, false);
    // positionId should NOT be set when UNRECORDED.
    assert.equal(result.output.positionId, undefined);
});
