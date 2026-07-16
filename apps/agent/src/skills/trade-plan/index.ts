/**
 * trade-plan executor — enforces audit → risk → execute → record.
 *
 * v2 fix: when the DEX router returns `ok=true` but does NOT include the
 * jetton amount received, we DO NOT record a placeholder `amountTokens="0"`
 * row. Such rows are broken data: the position monitor's TP1 sell would noop
 * (BigInt("0") / 2n = 0n → DEX forwards zero → no TP1 ever). Instead the
 * skill returns `verdict: "UNRECORDED"` and emits a loud warning so the
 * operator can manually reconcile.
 *
 * v3: computes a confidence score (0-100) for every trade and persists it
 * alongside the position. The score is derived from audit results, holder
 * count, token age, pool liquidity, and tier alignment.
 */
import { newId } from "@ton-agent/shared";
import { log } from "../../logger";
import { computeConfidenceScore } from "../../risk/scoring";
import { TIER_RISK_CONFIGS } from "../../risk/guardrails";
import type { SkillHandler, SkillContext } from "../runtime";
import { manifest } from "./manifest";

type Input = {
    jettonMaster: string;
    poolAddress: string;
    symbol?: string;
    amountTon: number;
    tier: "low" | "mid" | "high";
    reasoning?: string;
};

type Output = {
    ok: boolean;
    verdict: "EXECUTED" | "DENIED" | "AUDIT_FAILED" | "UNRECORDED";
    positionId?: string;
    amountTokensKnown?: boolean;
    error?: string;
};

const execute: SkillHandler<Input, Output>["execute"] = async (input, ctx: SkillContext) => {
    const audit = ctx.tools["audit_jetton"];
    const gate = ctx.tools["check_risk_status"];
    const swap = ctx.tools["execute_swap"];

    if (!audit || !gate || !swap) {
        throw new Error("audit_jetton / check_risk_status / execute_swap tools are required");
    }

    // 1. Audit
    const auditResult = await audit({ jettonMaster: input.jettonMaster, poolAddress: input.poolAddress });
    if (!auditResult.renounced || !auditResult.lpLocked || !auditResult.honeypotSafe) {
        log.warn("TRADE-PLAN", `AUDIT_FAILED jetton=${input.jettonMaster}`);
        return { ok: false, verdict: "AUDIT_FAILED", error: "audit gates failed (renounce/lp/honeypot)" };
    }

    // 1b. Compute confidence score from audit + metadata.
    const confidenceScore = computeConfidenceScore({
        renounced: auditResult.renounced,
        lpLocked: auditResult.lpLocked,
        honeypotSafe: auditResult.honeypotSafe,
        holders: Number(auditResult.holders ?? 0),
        ageHours: Number(auditResult.ageHours ?? 0),
        liquidityTon: null,  // trade-plan doesn't fetch pool liquidity directly
        poolAvailable: !!input.poolAddress,
        tier: input.tier,
        minAiScore: TIER_RISK_CONFIGS[input.tier].minAiScore,
    });
    log.info("TRADE-PLAN", `confidence_score=${confidenceScore.total} (audit=${confidenceScore.audit} holders=${confidenceScore.holders} age=${confidenceScore.age} liq=${confidenceScore.liquidity} bonus=${confidenceScore.tierBonus})`);

    // 2. Risk gate
    const risk = await gate({ tier: input.tier });
    if (!risk?.ok) {
        log.warn("TRADE-PLAN", `DENIED tier=${input.tier} reason=${risk?.error ?? "n/a"}`);
        return { ok: false, verdict: "DENIED", error: risk?.error ?? "risk gate returned not ok" };
    }

    // 3. Execute
    const swapResult = await swap({
        jettonMaster: input.jettonMaster,
        amountTon: input.amountTon,
        side: "buy",
        tier: input.tier,
    });

    if (!swapResult?.ok) {
        return { ok: false, verdict: "DENIED", error: swapResult?.error ?? "swap failed" };
    }

    // 4. Record position — only if we know the jetton amount received.
    const amountTokens: string | undefined = typeof swapResult.amountTokens === "string"
        ? swapResult.amountTokens
        : undefined;
    const record = ctx.tools["record_position"];
    const costBasisTon = input.amountTon + 0.25; // include gas headroom

    if (!record) {
        // No recorder available — note it but don't fabricate data.
        log.warn("TRADE-PLAN", "executed but record_position tool missing — position NOT persisted");
        return { ok: true, verdict: "UNRECORDED", amountTokensKnown: false, error: "record_position tool not registered" };
    }

    if (!amountTokens || amountTokens === "0") {
        log.err("TRADE-PLAN",
            `UNRECORDED: swap succeeded but router returned no jetton amount. ` +
            `jettonMaster=${input.jettonMaster} tier=${input.tier} cost=${costBasisTon}TON. ` +
            `Manual reconciliation required — do NOT retry (position already open).`,
        );
        // Notify the operator loud-and-clear.
        const notify = ctx.tools["notify_web"];
        if (notify) {
            await notify({
                kind: "audit",
                payload: {
                    source: "trade-plan",
                    severity: "warning",
                    issue: "amountTokens unknown — position not recorded",
                    jettonMaster: input.jettonMaster,
                    tier: input.tier,
                    txHash: swapResult.txHash ?? "unknown",
                    costBasisTon,
                },
            });
        }
        return { ok: true, verdict: "UNRECORDED", amountTokensKnown: false, error: "swap returned no jetton amount" };
    }

    const positionId = newId("pos");
    await record({
        walletTier: input.tier,
        jettonMaster: input.jettonMaster,
        symbol: input.symbol,
        dex: swapResult.dex ?? "stonfi",
        entryTxHash: swapResult.txHash ?? "unknown",
        entryPriceTon: costBasisTon / Math.max(input.amountTon, 0.000001),
        entryPriceUsd: undefined,
        amountTokens,
        costBasisTon,
        confidenceScore: confidenceScore.total,
    });

    // 5. Notify
    const notify = ctx.tools["notify_web"];
    if (notify) {
        await notify({
            kind: "trade_executed",
            payload: {
                tier: input.tier,
                jettonMaster: input.jettonMaster,
                amountTon: input.amountTon,
                amountTokens,
                positionId,
                confidenceScore: confidenceScore.total,
                scoreBreakdown: confidenceScore,
                reasoning: input.reasoning ?? "trade-plan skill",
            },
        });
    }

    return { ok: true, verdict: "EXECUTED", positionId, amountTokensKnown: true };
};

export const handler: SkillHandler<Input, Output> = {
    manifest,
    execute,
};

import { registerSkill } from "../runtime";
registerSkill(handler);
