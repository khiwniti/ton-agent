/**
 * audit-jetton executor — single-call structured verdict.
 */
import type { SkillHandler, SkillContext } from "../runtime";
import { manifest } from "./manifest";

type Input = { jettonMaster: string; poolAddress: string };
type Output = {
    verdict: "PASS" | "FAIL";
    renounced: boolean;
    lpLocked: boolean;
    honeypotSafe: boolean;
    holders: number;
    reasons: string[];
    priceUsd: number | null;
};

const execute: SkillHandler<Input, Output>["execute"] = async (input, ctx: SkillContext) => {
    const auditFn = ctx.tools["audit_jetton"];
    const metaFn = ctx.tools["get_jetton_meta"];
    const priceFn = ctx.tools["get_jetton_price"];

    if (!auditFn) throw new Error("audit_jetton tool is not registered in this context");

    const auditResult = await auditFn({ jettonMaster: input.jettonMaster, poolAddress: input.poolAddress });
    const meta = metaFn ? await metaFn({ jettonMaster: input.jettonMaster }) : null;
    const price = priceFn ? await priceFn({ jettonMaster: input.jettonMaster }) : null;

    const reasons: string[] = [];
    if (!auditResult.renounced) reasons.push("ownership not renounced");
    if (!auditResult.lpLocked) reasons.push("liquidity not locked");
    if (!auditResult.honeypotSafe) reasons.push("honeypot sandbox failed");

    return {
        verdict: reasons.length === 0 ? "PASS" : "FAIL",
        renounced: !!auditResult.renounced,
        lpLocked: !!auditResult.lpLocked,
        honeypotSafe: !!auditResult.honeypotSafe,
        holders: Number(auditResult.holders ?? meta?.holders_count ?? 0),
        reasons,
        priceUsd: price?.priceUsd ?? null,
    };
};

export const handler: SkillHandler<Input, Output> = {
    manifest,
    execute,
};

import { registerSkill } from "../runtime";
registerSkill(handler);
