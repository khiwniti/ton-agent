/**
 * audit-jetton skill — single-call composition of the security stack.
 *
 * Reasoning: the LLM already has `audit_jetton` as a primitive, but composing
 * "audit and report a structured pass/fail with reasons" is a high-frequency
 * workflow. This skill smooths that out into one structured answer.
 */
import type { SkillManifest } from "../runtime";

export const manifest: SkillManifest = {
    name: "audit-jetton",
    version: "1.0.0",
    description:
        "Run a structured security audit on a TON jetton and return a single richer verdict: renounced status, LP lock, honeypot sandbox result, holder count, and an overall pass/fail with reasons. Composes the audit primitives into one reusable call.",
    requires: {
        tools: ["audit_jetton", "get_jetton_meta", "get_jetton_price"],
    },
    inputSchema: {
        jettonMaster: { type: "string" },
        poolAddress: { type: "string" },
    },
    outputSchema: {
        type: "object",
        properties: {
            verdict: { type: "string", enum: ["PASS", "FAIL"] },
            renounced: { type: "boolean" },
            lpLocked: { type: "boolean" },
            honeypotSafe: { type: "boolean" },
            holders: { type: "number" },
            reasons: { type: "array", items: { type: "string" } },
            priceUsd: { type: ["number", "null"] },
        },
        required: ["verdict", "renounced", "lpLocked", "honeypotSafe", "holders", "reasons"],
    },
    examples: [
        "Audit a jetton before considering a buy: { jettonMaster: 'EQ…', poolAddress: 'EQ…' }",
    ],
} as const;
