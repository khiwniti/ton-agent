/**
 * Maps agent webhook payloads to Supabase table rows.
 * Kept pure + framework-free so it is easy to reason about and test.
 */
import type { IngestKind, WalletTier } from "@/lib/types";
import { newId } from "@ton-agent/shared";

type Payload = Record<string, unknown>;

const num = (v: unknown): number | null =>
  typeof v === "number" && !Number.isNaN(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const bool = (v: unknown): boolean => v === true;

export interface MappedInsert {
  table: string;
  row: Record<string, unknown>;
}

/**
 * Translate an ingest event into the target table + row.
 * Returns null for unknown kinds so the caller can 400.
 *
 * `envelopeId` is the agent-supplied stable key; when present it BOTH:
 *  1. overrides any per-payload id (so retries with the same envelope dedupe),
 *  2. for kinds whose PK is the row `id` directly, it becomes the row id.
 * If absent we fall back to `payload.id`, then mint a fresh `newId(...)`.
 */
export function mapIngest(
  kind: IngestKind,
  walletTier: WalletTier | undefined,
  payload: Payload,
  envelopeId?: string,
): MappedInsert | null {
  switch (kind) {
    case "radar_hit":
      return {
        table: "radar_events",
        row: {
          id: envelopeId ?? str(payload.id) ?? newId("radar"),
          wallet_tier: walletTier ?? null,
          detected_at: num(payload.detectedAt) ?? Date.now(),
          jetton_master: str(payload.jettonMaster) ?? "",
          symbol: str(payload.symbol),
          pool_address: str(payload.poolAddress),
          dex: str(payload.dex),
          initial_liquidity_ton: num(payload.initialLiquidityTon),
          token_age_hours: num(payload.tokenAgeHours),
          renounced: bool(payload.renounced),
          lp_locked: bool(payload.lpLocked),
          honeypot_safe: bool(payload.honeypotSafe),
          ai_score: num(payload.aiScore) ?? 0,
          action: str(payload.action) ?? "SKIP",
          confidence: num(payload.confidence) ?? 0,
          reasoning: str(payload.reasoning) ?? "",
        },
      };

    case "trade_executed":
    case "position_update":
      return {
        table: "positions",
        row: {
          id: envelopeId ?? str(payload.id) ?? newId("pos"),
          wallet_tier: walletTier ?? "low",
          jetton_master: str(payload.jettonMaster) ?? "",
          symbol: str(payload.symbol),
          entry_tx_hash: str(payload.entryTxHash) ?? "",
          entry_price_ton: num(payload.entryPriceTon) ?? 0,
          entry_at: num(payload.entryAt) ?? Date.now(),
          amount_tokens: str(payload.amountTokens) ?? "0",
          cost_basis_ton: num(payload.costBasisTon) ?? 0,
          current_price_ton: num(payload.currentPriceTon),
          pnl_pct: num(payload.pnlPct),
          status: str(payload.status) ?? "OPEN",
          take_profit_t1_tx: str(payload.takeProfitT1Tx),
          close_tx: str(payload.closeTx),
          close_at: num(payload.closeAt),
        },
      };

    case "agent_message":
      return {
        table: "agent_messages",
        row: {
          id: envelopeId ?? str(payload.id) ?? newId("msg"),
          thread_id: str(payload.threadId) ?? "default",
          at: num(payload.at) ?? Date.now(),
          role: str(payload.role) ?? "system",
          content: str(payload.content) ?? "",
          tool_name: str(payload.toolName),
          tool_args: payload.toolArgs ?? null,
          tool_result: payload.toolResult ?? null,
          meta: (payload.meta as Record<string, unknown>) ?? null,
        },
      };

    case "status":
      return {
        table: "agent_status",
        row: {
          tier: walletTier ?? "low",
          status: str(payload.status) ?? "stopped",
          started_at: num(payload.startedAt),
          bankroll_ton: num(payload.bankrollTon),
          open_positions: num(payload.openPositions) ?? 0,
          total_pnl_ton: num(payload.totalPnLTon) ?? 0,
          uptime_sec: num(payload.uptimeSec) ?? 0,
          version: str(payload.version) ?? "unknown",
        },
      };

    case "audit":
      // Audits are advisory context attached to the ReAct timeline.
      return {
        table: "agent_messages",
        row: {
          id: newId("audit"),
          thread_id: str(payload.threadId) ?? "audit",
          at: Date.now(),
          role: "tool",
          content: str(payload.summary) ?? "Security audit",
          tool_name: "security_audit",
          tool_args: { jettonMaster: str(payload.jettonMaster) },
          tool_result: payload,
          meta: { walletTier: walletTier ?? null },
        },
      };

    default:
      return null;
  }
}
