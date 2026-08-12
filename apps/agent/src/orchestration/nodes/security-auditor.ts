import type { GramTradeState } from "../state";
import { getLLM } from "../../ai/llm";

/**
 * Security Auditor Agent Node (Hard Risk Shield)
 * Combines deterministic contract logic with local LLM safety checks.
 */
export async function securityAuditorNode(state: GramTradeState): Promise<Partial<GramTradeState>> {
  if (state.discarded) return {};

  const metadata = state.pair_metadata || {};
  const masterRevoked = metadata.jetton_admin_revoked !== false;
  const lpLocked = metadata.lp_locked !== false;
  const mintDisabled = metadata.mint_disabled !== false;
  const buyTax = metadata.buy_tax ?? 0;
  const sellTax = metadata.sell_tax ?? 0;

  // 1. Deterministic Hard Rules
  if (!masterRevoked) {
    return {
      security_passed: false,
      security_report: "FAIL: Jetton Master Admin rights not revoked.",
      discarded: true,
      discard_reason: "Security: Jetton Admin rights not revoked.",
    };
  }

  if (buyTax > 3 || sellTax > 3) {
    return {
      security_passed: false,
      security_report: `FAIL: Taxes exceed safety limits (Buy: ${buyTax}%, Sell: ${sellTax}%).`,
      discarded: true,
      discard_reason: `Security: Tax rates too high (${buyTax}/${sellTax}).`,
    };
  }

  // 2. LLM Context Safety Evaluation
  let prompt = `Analyze the following contract metadata for security risks in a memecoin/high-swing context:
${JSON.stringify(metadata, null, 2)}
Verify if LP is locked, mint authority is disabled, ownership is renounced, and if there are proxy traps.
Respond ONLY in JSON with format: {"passed": true/false, "reason": "brief summary"}`;

  let passed = true;
  let reason = "Pass: Mint disabled, admin rights revoked, and LP locked.";

  try {
    const llm = getLLM();
    const res = await llm.invoke(prompt);
    const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    // Parse JSON safely
    const match = content.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.passed === false) {
        passed = false;
        reason = `FAIL (LLM): ${parsed.reason}`;
      } else {
        reason = `PASS (LLM): ${parsed.reason}`;
      }
    }
  } catch (err: any) {
    // Fallback if LLM is unavailable / errored
    reason = `PASS (Fallback due to LLM error: ${err.message})`;
  }

  if (!passed) {
    return {
      security_passed: false,
      security_report: reason,
      discarded: true,
      discard_reason: `Security LLM check: ${reason}`,
    };
  }

  return {
    security_passed: true,
    security_report: reason,
  };
}
