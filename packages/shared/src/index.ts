/**
 * Shared types + Zod schemas between web app and agent runtime.
 * The web app consumes these to render events posted by the agent.
 */
import { z } from "zod";

// ───────────────────────────────────────────────────────────────────
// Trade actions
// ───────────────────────────────────────────────────────────────────
export const ActionSchema = z.enum(["BUY", "SELL", "SKIP", "HOLD"]);
export type Action = z.infer<typeof ActionSchema>;

// ───────────────────────────────────────────────────────────────────
// Position (live update from agent → UI)
// ───────────────────────────────────────────────────────────────────
export const PositionSchema = z.object({
  id: z.string(),
  jettonMaster: z.string(),
  symbol: z.string().optional(),
  entryTxHash: z.string(),
  entryPriceTon: z.number(),
  entryAt: z.number(), // ms
  amountTokens: z.string(),        // bigint as string
  costBasisTon: z.number(),
  currentPriceTon: z.number().nullable(),
  pnlPct: z.number().nullable(),
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
  jettonMaster: z.string(),
  symbol: z.string().optional(),
  poolAddress: z.string().optional(),
  dex: z.enum(["stonfi", "dedust"]).optional(),
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
  ageHours: z.number(),
  marketCapTon: z.number().optional(),
  ok: z.boolean(),
});
export type SecurityReport = z.infer<typeof SecurityReportSchema>;

// ───────────────────────────────────────────────────────────────────
// Agent run status
// ───────────────────────────────────────────────────────────────────
export const AgentStatusSchema = z.object({
  status: z.enum(["running", "paused", "stopped", "error"]),
  startedAt: z.number().optional(),
  bankrollTon: z.number().nullable(),
  openPositions: z.number(),
  totalPnLTon: z.number(),
  uptimeSec: z.number(),
  version: z.string(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// ───────────────────────────────────────────────────────────────────
// Convenience helpers
// ───────────────────────────────────────────────────────────────────
export function newId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
