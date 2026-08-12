/**
 * Postmortem / Journal Agent — summarizes closed trades for Telegram digest.
 *
 * Tools: Journal reader (read-only).
 * Model: cheap/fast.
 * Runs after position closes (win/loss/timeout).
 */
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { CONFIG } from "../../config";
import { log } from "../../logger";
import { decisionJournalStore, type DbJournalEntry } from "../../storage/store";

export interface PostmortemInput {
  cycle_id: string;
  /** Optional: specific entry ID if known */
  entry_id?: number;
}

export interface PostmortemOutput {
  cycle_id: string;
  summary: string;
  /** Formatted for Telegram */
  telegram_message: string;
}

/**
 * Fetch all journal entries for a cycle.
 */
export function getCycleJournal(cycleId: string): DbJournalEntry[] {
  try {
    return decisionJournalStore.listByCycle(cycleId);
  } catch (e: any) {
    log.debug("POSTMORTEM", `getCycleJournal failed: ${e.message}`);
    return [];
  }
}

/**
 * Deterministic summary builder — no LLM.
 * Produces structured digest from journal entries.
 */
export function buildDeterministicSummary(cycleId: string, entries: DbJournalEntry[]): {
  summary: string;
  telegram_message: string;
} {
  if (entries.length === 0) {
    return {
      summary: "No journal entries found for cycle.",
      telegram_message: "📝 <b>Postmortem</b>\nNo journal entries found.",
    };
  }

  // Sort by timestamp
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Extract key events
  const capEntry = sorted.find((e) => e.cap_check_result);
  const execEntry = sorted.find((e) => e.final_action?.startsWith("execute_"));

  let outcome = "UNKNOWN";
  let txHash = "N/A";
  let pnl = "N/A";

  if (execEntry) {
    if (execEntry.final_action === "execute_ok") {
      outcome = "EXECUTED";
      // output is a JSON string in DbJournalEntry
      try {
        const output = JSON.parse(execEntry.output || "{}");
        txHash = output.txHash?.slice(0, 16) ?? "N/A";
      } catch {
        txHash = "N/A";
      }
    } else if (execEntry.final_action === "execute_failed") {
      outcome = "FAILED";
    } else if (execEntry.final_action === "execute_denied_caps") {
      outcome = "DENIED (SafetyCaps)";
    } else if (execEntry.final_action?.startsWith("execute_denied")) {
      outcome = `DENIED (${execEntry.final_action})`;
    }
  }

  const durationMs = last.ts - first.ts;
  const durationMin = Math.round(durationMs / 60000 * 10) / 10;

  const agentSequence = sorted.map((e) => e.agent).join(" → ");

  const summary = `Cycle ${cycleId}: ${outcome} in ${durationMin}min via ${agentSequence}. TX: ${txHash}`;

  // Telegram formatted message
  const emoji = outcome === "EXECUTED" ? "✅" : outcome.startsWith("DENIED") ? "🚫" : outcome === "FAILED" ? "❌" : "❓";
  let riskVerdict = "PASS";
  if (capEntry?.cap_check_result) {
    try {
      const cap = JSON.parse(capEntry.cap_check_result);
      riskVerdict = cap.failures?.length > 0
        ? cap.failures.map((f: any) => f.code).join(", ")
        : "PASS";
    } catch {}
  }

  const telegramMessage =
    `${emoji} <b>Trade Postmortem</b>\n` +
    `<b>Cycle:</b> <code>${cycleId}</code>\n` +
    `<b>Outcome:</b> ${outcome}\n` +
    `<b>TX:</b> <code>${txHash}</code>\n` +
    `<b>Duration:</b> ${durationMin} min\n` +
    `<b>Risk Gate:</b> ${riskVerdict}\n` +
    `<b>Path:</b> ${agentSequence}\n` +
    `<b>Journal:</b> ${sorted.length} entries`;

  return { summary, telegram_message: telegramMessage };
}

/**
 * LLM-enhanced postmortem (optional — for weekly digests).
 * Receives deterministic summary + journal, adds narrative context.
 */
export function makePostmortemAgent() {
  const llm = new ChatOpenAI({
    apiKey: CONFIG.nvidiaApiKey,
    model: CONFIG.nvidiaModel,
    temperature: 0.3,
    configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
  });

  const systemPrompt = `You are a trading analyst writing postmortem summaries for a TON trading agent.
You receive a deterministic summary + full journal. Add 2-3 sentences of actionable insight:
- What worked / didn't (slippage, timing, risk gate)
- Pattern for next time
- One concrete adjustment

Keep it concise. Operator reads this on phone.

Return ONLY JSON:
{
  "enhanced_summary": "Deterministic summary + 2-3 sentences insight.",
  "telegram_message": "HTML formatted for Telegram (use <b>, <code>, <i>)."
}`;

  const agent = createReactAgent({
    llm,
    tools: [], // NO tools — pure reasoning on provided context
    prompt: systemPrompt,
  });

  return agent;
}

/**
 * Main entry for supervisor: build deterministic summary, optionally enhance with LLM.
 */
export async function postmortemNode(
  input: PostmortemInput,
): Promise<PostmortemOutput> {
  const { cycle_id } = input;
  const entries = getCycleJournal(cycle_id);
  const { summary, telegram_message } = buildDeterministicSummary(cycle_id, entries);

  // Optional: LLM enhancement for weekly digests (supervisor controls)
  // For now, return deterministic version
  return { cycle_id, summary, telegram_message };
}