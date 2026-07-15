/**
 * token-scout skill — radar pipeline.
 *
 *   1. Pull recent jettons via TONAPI (or use the configured WATCHLIST)
 *   2. Audit each candidate (renounce + LP lock + honeypot sandbox)
 *   3. Push a `radar_hit` webhook for ones that pass the audit
 *   4. Always tracks candidates so the LLM can plan later
 *
 * Radar cadence (60s) is owned by `radar/scanner.ts`. This skill exposes
 * the same pipeline as a one-shot composable for the brain + manual triggers.
 */
import type { SkillManifest } from "../runtime";

export const manifest: SkillManifest = {
    name: "token-scout",
    version: "1.0.0",
    description:
        "Run a one-shot token radar pass — fetch recent TON jettons, audit each one (renounce + LP-lock + honeypot), and push radar_hit webhooks for candidates that pass. Honours WATCHLIST env and the radar audit rules.",
    requires: {
        env: ["TONAPI_BASE"],
        tools: ["get_jetton_meta", "notify_web"],
    },
    inputSchema: {
        limit: { type: "number", default: 30, maximum: 100 },
        onlyFresh: { type: "boolean", default: true },
        includeWatchlist: { type: "boolean", default: true },
    },
    outputSchema: {
        type: "object",
        properties: {
            scanned: { type: "number" },
            audited: { type: "number" },
            hits: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        master: { type: "string" },
                        symbol: { type: "string" },
                        renounced: { type: "boolean" },
                        lpLocked: { type: "boolean" },
                        honeypotSafe: { type: "boolean" },
                    },
                    required: ["master", "renounced", "lpLocked", "honeypotSafe"],
                },
            },
        },
        required: ["scanned", "audited", "hits"],
    },
    examples: [
        "Run the radar with default watchlist: { }",
        "Audit the top 50 jettons: { limit: 50 }",
        "Skip the watchlist and only scan fresh: { includeWatchlist: false, onlyFresh: true }",
    ],
} as const;
