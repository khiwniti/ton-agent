/**
 * Pure SafetyCaps evaluation — no DB, no network, no LLM.
 *
 * Every buy that reaches a signer must pass through checkTicket (directly or
 * via a previously issued CapCheckResult whose ticket_hash still matches).
 */
import { createHash } from "node:crypto";
import type {
  CapCheckContext,
  CapCheckFailure,
  CapCheckResult,
  TradeTicket,
} from "./types";

/** Bump when check semantics change so old authorizations cannot be reused. */
export const CAPS_VERSION = "safetycaps-v1";

/**
 * Stable hash of the ticket fields that define the economic intent.
 * CapCheckResult.ticket_hash must equal this for the same ticket.
 */
export function hashTradeTicket(ticket: TradeTicket): string {
  const payload = [
    ticket.cycle_id,
    ticket.tier,
    ticket.side,
    ticket.jetton_master.trim(),
    // fixed precision avoids float noise across processes
    Number(ticket.amount_ton).toFixed(9),
    ticket.slippage_pct === undefined ? "" : Number(ticket.slippage_pct).toFixed(4),
    ticket.pool_tvl_ton === undefined ? "" : Number(ticket.pool_tvl_ton).toFixed(6),
    ticket.ai_score === undefined ? "" : String(ticket.ai_score),
    ticket.risk?.verdict ?? "",
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function fail(
  code: string,
  reason: string,
): CapCheckFailure {
  return { code, reason };
}

/**
 * Deterministic hard gates. Failures are not weighted or averaged — any fail rejects.
 */
export function checkTicket(
  ticket: TradeTicket,
  ctx: CapCheckContext,
): CapCheckResult {
  const failures: CapCheckFailure[] = [];
  const ticket_hash = hashTradeTicket(ticket);
  const checked_at = Date.now();

  const base = {
    ticket_hash,
    cycle_id: ticket.cycle_id,
    caps_version: CAPS_VERSION,
    amount_ton: ticket.amount_ton,
    tier: ticket.tier,
    checked_at,
  };

  // ── Sells: only infra halt gates (closing must stay possible under CB) ──
  if (ticket.side === "sell") {
    if (ctx.observe_only) {
      failures.push(fail("OBSERVE_ONLY", "observe-only mode — all trades blocked"));
    }
    if (ctx.kill_switch_active) {
      failures.push(
        fail(
          "KILL_SWITCH",
          `kill-switch active: ${ctx.kill_switch_reason ?? "n/a"}`,
        ),
      );
    }
    if (!(ticket.amount_ton > 0) || !Number.isFinite(ticket.amount_ton)) {
      failures.push(fail("BAD_SIZE", "amount_ton must be a positive finite number"));
    }
    if (!ticket.jetton_master || ticket.jetton_master.length < 10) {
      failures.push(fail("BAD_JETTON", "jetton_master is required"));
    }
    const ok = failures.length === 0;
    return {
      ...base,
      ok,
      hitl_required: false,
      hitl_status: "not_required",
      failures,
    };
  }

  // ── Buys: full SafetyCaps ──
  if (ctx.observe_only) {
    failures.push(fail("OBSERVE_ONLY", "observe-only mode — all trades blocked"));
  }
  if (ctx.kill_switch_active) {
    failures.push(
      fail("KILL_SWITCH", `kill-switch active: ${ctx.kill_switch_reason ?? "n/a"}`),
    );
  }
  if (ticket.tier === "high" && !ctx.unlocked) {
    failures.push(fail("HIGH_LOCKED", "HIGH tier locked — promotion not satisfied"));
  }
  if (!ctx.circuit_breaker_ok) {
    failures.push(
      fail("CIRCUIT_BREAKER", "circuit breaker tripped (daily loss limit)"),
    );
  }
  if (!(ticket.amount_ton > 0) || !Number.isFinite(ticket.amount_ton)) {
    failures.push(fail("BAD_SIZE", "amount_ton must be a positive finite number"));
  }
  if (!ticket.jetton_master || ticket.jetton_master.length < 10) {
    failures.push(fail("BAD_JETTON", "jetton_master is required"));
  }

  // Risk verdict — reject never proceeds; caution forces HITL
  const verdict = ticket.risk?.verdict;
  if (verdict === "reject") {
    failures.push(fail("RISK_REJECT", "risk verdict is reject — auto-discard"));
  }

  // Tier absolute cap
  if (ticket.amount_ton > ctx.max_position_ton) {
    failures.push(
      fail(
        "TIER_CAP",
        `requested ${ticket.amount_ton} > tier cap ${ctx.max_position_ton}`,
      ),
    );
  }

  // Bankroll + gas cushion
  const needTon = ticket.amount_ton + ctx.gas_cushion_ton;
  if (ctx.balance_ton < needTon) {
    failures.push(
      fail(
        "BANKROLL",
        `insufficient balance ${ctx.balance_ton} < ${needTon}`,
      ),
    );
  }

  // Max open positions
  if (ctx.open_positions >= ctx.max_open) {
    failures.push(
      fail(
        "MAX_OPEN",
        `max open positions ${ctx.open_positions}/${ctx.max_open}`,
      ),
    );
  }

  // Portfolio allocation %
  const maxAlloc =
    ctx.balance_ton * (ctx.max_portfolio_allocation_pct / 100);
  if (ticket.amount_ton > maxAlloc) {
    failures.push(
      fail(
        "ALLOCATION",
        `trade ${ticket.amount_ton}TON exceeds ${ctx.max_portfolio_allocation_pct}% allocation (max ${maxAlloc.toFixed(4)}TON)`,
      ),
    );
  }

  // Slippage (when provided)
  if (
    ticket.slippage_pct !== undefined &&
    Number.isFinite(ticket.slippage_pct) &&
    ticket.slippage_pct > ctx.max_slippage_pct
  ) {
    failures.push(
      fail(
        "SLIPPAGE",
        `slippage ${ticket.slippage_pct.toFixed(2)}% exceeds max ${ctx.max_slippage_pct}%`,
      ),
    );
  }

  // Liquidity depth
  if (ticket.pool_tvl_ton !== undefined && Number.isFinite(ticket.pool_tvl_ton)) {
    if (ticket.pool_tvl_ton <= 0) {
      failures.push(fail("POOL_TVL", "pool_tvl_ton must be positive when provided"));
    } else {
      const maxByDepth =
        ticket.pool_tvl_ton * (ctx.max_trade_pool_tvl_pct / 100);
      if (ticket.amount_ton > maxByDepth) {
        failures.push(
          fail(
            "DEPTH",
            `trade ${ticket.amount_ton}TON exceeds ${ctx.max_trade_pool_tvl_pct}% of pool TVL (max ${maxByDepth.toFixed(4)}TON)`,
          ),
        );
      }
    }
  } else if (ctx.require_pool_tvl) {
    failures.push(
      fail("POOL_TVL_REQUIRED", "pool_tvl_ton required but missing — fail closed"),
    );
  }

  // Optional AI score floor
  if (
    ticket.ai_score !== undefined &&
    Number.isFinite(ticket.ai_score) &&
    ticket.ai_score < ctx.min_ai_score
  ) {
    failures.push(
      fail(
        "AI_SCORE",
        `ai_score ${ticket.ai_score} < tier min ${ctx.min_ai_score}`,
      ),
    );
  }

  const ok = failures.length === 0;

  // HITL: caution always; size above auto-approve ceiling of sub-wallet
  const ceilingTon =
    ctx.balance_ton * (ctx.auto_approve_ceiling_pct / 100);
  const overCeiling = ticket.amount_ton > ceilingTon;
  const caution = verdict === "caution";
  const hitl_required = ok && (caution || overCeiling);

  return {
    ...base,
    ok,
    hitl_required,
    hitl_status: hitl_required ? "pending" : "not_required",
    failures,
  };
}

/**
 * Verify a CapCheckResult still matches the ticket and is executable.
 * Does not re-run economic gates — caller must issue fresh checks for stale caps.
 */
export function verifyCapBinding(
  ticket: TradeTicket,
  cap: CapCheckResult,
  hitl: CapCheckResult["hitl_status"] | "approved" | "not_required" = cap.hitl_status,
): { allowed: boolean; reason?: string } {
  if (!cap.ok) {
    return { allowed: false, reason: "cap check not ok" };
  }
  if (cap.caps_version !== CAPS_VERSION) {
    return { allowed: false, reason: `caps_version mismatch: ${cap.caps_version}` };
  }
  const expected = hashTradeTicket(ticket);
  if (cap.ticket_hash !== expected) {
    return {
      allowed: false,
      reason: `ticket_hash mismatch (cap=${cap.ticket_hash} ticket=${expected})`,
    };
  }
  if (cap.cycle_id !== ticket.cycle_id) {
    return { allowed: false, reason: "cycle_id mismatch" };
  }
  if (cap.hitl_required) {
    if (hitl !== "approved" && cap.hitl_status !== "approved") {
      return {
        allowed: false,
        reason: `HITL required but status=${hitl ?? cap.hitl_status}`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Mark HITL approved on a prior CapCheckResult (immutable copy).
 */
export function withHitlApproved(cap: CapCheckResult): CapCheckResult {
  return {
    ...cap,
    hitl_status: "approved",
  };
}
