/**
 * manual-override executor — operator-attributable swap with audit trail.
 */
import { log } from "../../logger";
import type { SkillHandler, SkillContext } from "../runtime";
import { manifest } from "./manifest";

type Input = {
    operator: string;
    reason: string;
    jettonMaster: string;
    amountTon: number;
    tier: "low" | "mid" | "high";
    side: "buy" | "sell";
    allowUnsafe?: boolean;
};

type Output = {
    ok: boolean;
    verdict: "EXECUTED" | "DENIED";
    message: string;
};

const execute: SkillHandler<Input, Output>["execute"] = async (input, ctx: SkillContext) => {
    const gate = ctx.tools["check_risk_status"];
    const swap = ctx.tools["execute_swap"];
    const notify = ctx.tools["notify_web"];

    if (!gate || !swap) {
        throw new Error("check_risk_status / execute_swap tools are required");
    }
    if (!input.operator || !input.reason) {
        return { ok: false, verdict: "DENIED", message: "operator and reason are mandatory" };
    }

    // Always record the intent — even when the gate refuses — so the audit
    // trail shows attempted overrides.
    if (notify) {
        await notify({
            kind: "audit",
            payload: {
                source: "manual-override",
                operator: input.operator,
                reason: input.reason,
                jettonMaster: input.jettonMaster,
                amountTon: input.amountTon,
                tier: input.tier,
                side: input.side,
                allowUnsafe: !!input.allowUnsafe,
            },
        });
    }

    if (!input.allowUnsafe) {
        const risk = await gate({ tier: input.tier });
        if (!risk?.ok) {
            log.warn("MANUAL", `DENIED tier=${input.tier} rule=gate reason=${risk?.error ?? "n/a"}`);
            return { ok: false, verdict: "DENIED", message: `gate refused: ${risk?.error ?? "n/a"}` };
        }
    } else {
        log.warn("MANUAL", `ALLOW-UNSAFE operator=${input.operator} reason=${input.reason}`);
    }

    const swapResult = await swap({
        jettonMaster: input.jettonMaster,
        amountTon: input.amountTon,
        side: input.side,
        tier: input.tier,
    });

    return swapResult?.ok
        ? { ok: true, verdict: "EXECUTED", message: "swap submitted" }
        : { ok: false, verdict: "DENIED", message: swapResult?.error ?? "swap failed" };
};

export const handler: SkillHandler<Input, Output> = {
    manifest,
    execute,
};

import { registerSkill } from "../runtime";
registerSkill(handler);
