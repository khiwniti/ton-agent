/**
 * Shared types + Zod schemas between web app and agent runtime.
 * The web app consumes these to render events posted by the agent.
 *
 * This is the SINGLE contract between apps/web and apps/agent. Any
 * change here must keep both sides compiling. Additive changes are
 * safe; renames/removals are breaking.
 */
import { z } from "zod";

// ───────────────────────────────────────────────────────────────────
// Risk tiers — the 3-wallet model
// ───────────────────────────────────────────────────────────────────
// LOW  — capital preservation: audited blue-chip jettons, small size, tight SL.
// MID  — balanced: top-liquidity jettons with valid audit, moderate size.
// HIGH — accelerator: mempool/snipe signals, larger cap, wide SL. Starts
//        DISABLED and only unlocks once LOW+MID have proven positive PnL.
export const RiskTierSchema = z.enum(["low", "mid", "high"]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const TierStatusSchema = z.enum([
  "active",        // trading enabled
  "disabled",      // operator turned it off
  "locked",        // gated: awaiting promotion criteria (HIGH before LOW/MID prove out)
  "circuit_open",  // circuit breaker tripped (daily loss / error rate)
  "observe_only",  // boots, scans, but never signs
]);
export type TierStatus = z.infer<typeof TierStatusSchema>;

// ───────────────────────────────────────────────────────────────────
// Trade actions
// ───────────────────────────────────────────────────────────────────
export const ActionSchema = z.enum(["BUY", "SELL", "SKIP", "HOLD"]);
export type Action = z.infer<typeof ActionSchema>;

export const DexSchema = z.enum(["stonfi", "dedust"]);
export type Dex = z.infer<typeof DexSchema>;

// ───────────────────────────────────────────────────────────────────
// Position (live update from agent → UI)
// ───────────────────────────────────────────────────────────────────
export const PositionSchema = z.object({
  id: z.string(),
  walletTier: RiskTierSchema.default("low"),
  jettonMaster: z.string(),
  symbol: z.string().optional(),
  dex: DexSchema.optional(),
  entryTxHash: z.string(),
  entryPriceTon: z.number(),
  entryPriceUsd: z.number().nullable().optional(),
  entryAt: z.number(), // ms
  amountTokens: z.string(),        // bigint as string
  costBasisTon: z.number(),
  currentPriceTon: z.number().nullable(),
  pnlPct: z.number().nullable(),
  realizedPnlTon: z.number().nullable().optional(),
  status: z.enum(["OPEN", "TP1_HIT", "CLOSED", "STOPPED"]),
  takeProfitT1Tx: z.string().optional(),
  closeTx: z.string().optional(),
  closeAt: z.number().optional(),
});
export type Position = z.infer<typeof PositionSchema>;

// ───────────────────────────────────────────────────────────────────
// Radar event
// ───────────────────────────────────────────────────────────────────
export const RadarEventSchema = z.object({
  id: z.string(),
  detectedAt: z.number(),
  walletTier: RiskTierSchema.optional(),
  jettonMaster: z.string(),
  symbol: z.string().optional(),
  poolAddress: z.string().optional(),
  dex: DexSchema.optional(),
  initialLiquidityTon: z.number().nullable(),
  tokenAgeHours: z.number().nullable(),
  renounced: z.boolean(),
  lpLocked: z.boolean(),
  honeypotSafe: z.boolean(),
  aiScore: z.number().min(0).max(100),
  action: ActionSchema,
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
});
export type RadarEvent = z.infer<typeof RadarEventSchema>;

// ───────────────────────────────────────────────────────────────────
// Agent chat messages (ReAct timeline)
// ───────────────────────────────────────────────────────────────────
export const AgentMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  walletTier: RiskTierSchema.optional(),
  at: z.number(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  content: z.string(),
  toolName: z.string().optional(),
  toolArgs: z.any().optional(),
  toolResult: z.any().optional(),
  meta: z.record(z.any()).optional(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// ───────────────────────────────────────────────────────────────────
// Audit
// ───────────────────────────────────────────────────────────────────
export const SecurityReportSchema = z.object({
  renounced: z.boolean(),
  lpLocked: z.boolean(),
  honeypotSafe: z.boolean(),
  hasHolders: z.boolean(),
  holders: z.number().optional(),
  ageHours: z.number(),
  marketCapTon: z.number().optional(),
  ok: z.boolean(),
});
export type SecurityReport = z.infer<typeof SecurityReportSchema>;

// ───────────────────────────────────────────────────────────────────
// Per-tier agent run status
// ───────────────────────────────────────────────────────────────────
export const AgentStatusSchema = z.object({
  tier: RiskTierSchema.default("low"),
  status: TierStatusSchema,
  walletAddress: z.string().optional(),
  startedAt: z.number().optional(),
  bankrollTon: z.number().nullable(),
  openPositions: z.number(),
  closedTrades: z.number().default(0),
  totalPnLTon: z.number(),
  realizedPnLTon: z.number().default(0),
  dailyPnLTon: z.number().default(0),
  uptimeSec: z.number(),
  version: z.string(),
  updatedAt: z.number().optional(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// ───────────────────────────────────────────────────────────────────
// Kill switch (web → agent). Agent polls this via webhook echo / DB.
// ───────────────────────────────────────────────────────────────────
export const KillSwitchSchema = z.object({
  engaged: z.boolean(),
  at: z.number(),
  by: z.string().optional(),
  scope: z.union([z.literal("all"), RiskTierSchema]).default("all"),
});
export type KillSwitch = z.infer<typeof KillSwitchSchema>;

// ───────────────────────────────────────────────────────────────────
// Webhook envelope — the ONE payload shape agent → web.
// `id` is the idempotency key; the web app must upsert on it.
// ───────────────────────────────────────────────────────────────────
export const WebhookKindSchema = z.enum([
  "radar_hit",
  "trade_executed",
  "audit",
  "agent_message",
  "status",
  "position_update",
]);
export type WebhookKind = z.infer<typeof WebhookKindSchema>;

export const WebhookEnvelopeSchema = z.object({
  id: z.string(),                       // idempotency key
  kind: WebhookKindSchema,
  walletTier: RiskTierSchema.optional(),
  at: z.number(),
  payload: z.record(z.any()),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

// ───────────────────────────────────────────────────────────────────
// Convenience helpers
// ───────────────────────────────────────────────────────────────────
export function newId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** All three tiers in bootstrap order (LOW builds the port first). */
export const TIER_ORDER: RiskTier[] = ["low", "mid", "high"];
