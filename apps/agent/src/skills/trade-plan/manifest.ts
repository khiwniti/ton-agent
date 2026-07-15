/**
 * trade-plan skill — the canonical BUY pipeline.
 *
 *   1. Audit (via audit-jetton)
 *   2. check_risk_status(tier) — kill-switch / circuit-breaker / bankroll
 *   3. execute_swap (buy) via the coordinator
 *   4. record_position
 *   5. notify_web(trade_executed)
 *
 * The skill enforces "no buy without prior audit + risk check". The LLM
 * normally delegates here once it has decided a buy is justified.
 */
import type { SkillManifest } from "../runtime";

export const manifest: SkillManifest = {
    name: "trade-plan",
    version: "1.0.0",
    description:
        "Execute a TON BUY through the tier coordinator — enforces audit-first, risk-status check, and post-buy position recording. The canonical pipeline the brain must call whenever it decides to buy.",
    requires: {
        tools: [
            "audit_jetton",
            "check_risk_status",
            "get_wallet_balance",
            "execute_swap",
            "record_position",
            "notify_web",
        ],
    },
    inputSchema: {
        jettonMaster: { type: "string" },
        poolAddress: { type: "string" },
        symbol: { type: "string" },
        amountTon: { type: "number", minimum: 0, maximum: 50 },
        tier: { type: "string", enum: ["low", "mid", "high"], default: "low" },
        reasoning: { type: "string" },
    },
    outputSchema: {
        type: "object",
        properties: {
            ok: { type: "boolean" },
            verdict: { type: "string", enum: ["EXECUTED", "DENIED", "AUDIT_FAILED", "UNRECORDED"] },
            positionId: { type: "string" },
            error: { type: "string" },
            amountTokensKnown: { type: "boolean", description: "false when the skill executed the buy but the router did not return jetton amount; the position was NOT recorded to avoid creating rows with amountTokens='0'." },
        },
        required: ["ok", "verdict"],
    },
    examples: [
        "Buy 0.5 TON of a jetton on the LOW tier: { jettonMaster, poolAddress, amountTon: 0.5, tier: 'low' }",
    ],
    allowsTiers: ["low", "mid", "high"],
} as const;
