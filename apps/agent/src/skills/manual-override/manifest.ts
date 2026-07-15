/**
 * manual-override skill — operator-driven BUY/sell with explicit reasons.
 *
 *  Bypasses no risk gate; uses the same tools the trade-plan skill uses
 *  but adds a mandatory `operator` + `reason` trail that gets persisted via
 *  notify_web so we always have an audit trail of human-attributable actions.
 */
import type { SkillManifest } from "../runtime";

export const manifest: SkillManifest = {
    name: "manual-override",
    version: "1.0.0",
    description:
        "Operator-attributable swap with explicit reason and (optionally) audit-gate bypass via 'allowUnsafe=true'. Used by the web app's manual override panel when kill switch is engaged.",
    requires: {
        tools: ["check_risk_status", "execute_swap", "record_position", "notify_web"],
    },
    inputSchema: {
        operator: { type: "string" },
        reason: { type: "string" },
        jettonMaster: { type: "string" },
        amountTon: { type: "number" },
        tier: { type: "string", enum: ["low", "mid", "high"], default: "low" },
        side: { type: "string", enum: ["buy", "sell"], default: "buy" },
        allowUnsafe: { type: "boolean", default: false },
    },
    outputSchema: {
        type: "object",
        properties: {
            ok: { type: "boolean" },
            verdict: { type: "string", enum: ["EXECUTED", "DENIED"] },
            message: { type: "string" },
        },
        required: ["ok", "verdict", "message"],
    },
    examples: [
        "Operator-driven sell to close a HIGH-tier position: { operator: 'admin', reason: 'rug-pull detected', jettonMaster: 'EQ…', amountTon: 0.5, tier: 'high', side: 'sell' }",
    ],
} as const;
