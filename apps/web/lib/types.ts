/**
 * Web-app domain types. Re-exports the shared agent contract and adds the
 * tier + persistence-shaped types the web app renders.
 */
export type {
  Action,
  Position,
  RadarEvent,
  AgentMessage,
  SecurityReport,
  AgentStatus,
} from "@ton-agent/shared";

export { newId } from "@ton-agent/shared";

/** Risk tier — one wallet per tier. */
export type WalletTier = "low" | "mid" | "high";

export const TIERS: WalletTier[] = ["low", "mid", "high"];

export const TIER_LABEL: Record<WalletTier, string> = {
  low: "LOW",
  mid: "MID",
  high: "HIGH",
};

/** Tailwind-friendly accent classes per tier (see globals.css tokens). */
export const TIER_ACCENT: Record<WalletTier, string> = {
  low: "tier-low",
  mid: "tier-mid",
  high: "tier-high",
};

export type TierStatus = "active" | "disabled" | "circuit-broken";

/** Row shape of the `wallets` table. */
export interface WalletRow {
  tier: WalletTier;
  address: string;
  balance_ton: number;
  status: TierStatus;
  open_positions: number;
  total_pnl_ton: number;
  updated_at: string;
}

/** Row shape of the `agent_status` table (mirrors AgentStatus + tier). */
export interface AgentStatusRow {
  tier: WalletTier;
  status: "running" | "paused" | "stopped" | "error";
  started_at: number | null;
  bankroll_ton: number | null;
  open_positions: number;
  total_pnl_ton: number;
  uptime_sec: number;
  version: string;
  updated_at: string;
}

/** Row shape of the `positions` table (mirrors Position + wallet_tier). */
export interface PositionRow {
  id: string;
  wallet_tier: WalletTier;
  jetton_master: string;
  symbol: string | null;
  entry_tx_hash: string;
  entry_price_ton: number;
  entry_at: number;
  amount_tokens: string;
  cost_basis_ton: number;
  current_price_ton: number | null;
  pnl_pct: number | null;
  status: "OPEN" | "TP1_HIT" | "CLOSED" | "STOPPED";
  take_profit_t1_tx: string | null;
  close_tx: string | null;
  close_at: number | null;
  created_at: string;
}

/** Row shape of the `radar_events` table (mirrors RadarEvent + wallet_tier). */
export interface RadarEventRow {
  id: string;
  wallet_tier: WalletTier | null;
  detected_at: number;
  jetton_master: string;
  symbol: string | null;
  pool_address: string | null;
  dex: "stonfi" | "dedust" | null;
  initial_liquidity_ton: number | null;
  token_age_hours: number | null;
  renounced: boolean;
  lp_locked: boolean;
  honeypot_safe: boolean;
  ai_score: number;
  action: "BUY" | "SELL" | "SKIP" | "HOLD";
  confidence: number;
  reasoning: string;
  created_at: string;
}

/** Row shape of the `agent_messages` table (mirrors AgentMessage). */
export interface AgentMessageRow {
  id: string;
  thread_id: string;
  at: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_name: string | null;
  tool_args: unknown | null;
  tool_result: unknown | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

/** Row shape of the `kill_switch` table. */
export interface KillSwitchRow {
  id: number;
  engaged: boolean;
  at: number;
  by: string | null;
  updated_at: string;
}

/** Ingest webhook body contract (matches the agent's push shape). */
export type IngestKind =
  | "radar_hit"
  | "trade_executed"
  | "audit"
  | "agent_message"
  | "status"
  | "position_update";

/**
 * The agent posts a wrapper envelope with a stable `id` so the ingest route
 * can upsert on a deterministic primary key. Older pushes without `id` remain
 * supported (we fall back to `payload.id` or mint a new row id).
 */
export interface IngestBody {
  /** Idempotency key — when present, becomes the row id for the target table. */
  id?: string;
  kind: IngestKind;
  walletTier?: WalletTier;
  /** Optional event timestamp from the agent. */
  at?: number;
  payload: Record<string, unknown>;
}
