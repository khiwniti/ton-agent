/**
 * SafetyCaps types — the authorization boundary between LLM proposals and execution.
 *
 * A TradeTicket is a *proposal* only. It becomes actionable only when paired with
 * CapCheckResult { ok: true } produced by non-LLM code in this package.
 *
 * @see specs/002-gram-orchestration-architecture/architecture.md
 */

export type RiskVerdict = "pass" | "caution" | "reject";
export type Tier = "low" | "mid" | "high";
export type TradeSide = "buy" | "sell";

/** Advisory only — never authorizes a trade by itself. */
export interface RiskAssessment {
  score: number;
  verdict: RiskVerdict;
  checks?: Record<string, boolean>;
  /** Free-text for the journal; not trusted for authorization. */
  rationale_for_journal?: string;
}

/**
 * Strategy / LLM proposal. Must never be treated as permission to sign.
 */
export interface TradeTicket {
  cycle_id: string;
  tier: Tier;
  side: TradeSide;
  jetton_master: string;
  amount_ton: number;
  /** Optional quoted slippage % (expected vs min out). */
  slippage_pct?: number;
  /** Optional pool TVL in TON for liquidity-depth gate. */
  pool_tvl_ton?: number;
  /** Optional AI confidence 0–100; compared to tier minAiScore when present. */
  ai_score?: number;
  risk?: RiskAssessment | null;
}

export interface CapCheckFailure {
  code: string;
  reason: string;
}

/**
 * Authoritative result of deterministic SafetyCaps evaluation.
 * Execution paths must refuse tickets whose hash does not match a greenlit result.
 */
export interface CapCheckResult {
  ok: boolean;
  ticket_hash: string;
  cycle_id: string;
  caps_version: string;
  failures: CapCheckFailure[];
  /** Echo of size used for the check (may be clamped later by caller). */
  amount_ton: number;
  tier: Tier;
  checked_at: number;
}

/**
 * Fully authorized execution envelope — only path that should reach the signer.
 * Authorization is purely deterministic: a bound, ok CapCheckResult is sufficient.
 */
export interface AuthorizedExecution {
  ticket: TradeTicket;
  cap: CapCheckResult;
  idempotency_key: string;
}

/** Runtime snapshot assembled by the coordinator (not LLM-authored). */
export interface CapCheckContext {
  balance_ton: number;
  open_positions: number;
  max_position_ton: number;
  max_open: number;
  min_ai_score: number;
  unlocked: boolean;
  kill_switch_active: boolean;
  kill_switch_reason?: string;
  circuit_breaker_ok: boolean;
  observe_only: boolean;
  daily_pnl_ton: number;
  /** Max portfolio allocation per trade (% of balance). */
  max_portfolio_allocation_pct: number;
  /** Max acceptable slippage %. */
  max_slippage_pct: number;
  /** Max trade size as % of pool TVL. */
  max_trade_pool_tvl_pct: number;
  /** When true, buys without pool_tvl_ton fail closed. */
  require_pool_tvl: boolean;
  gas_cushion_ton: number;
}
