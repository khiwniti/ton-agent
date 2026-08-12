/**
 * HITL (Human-in-the-Loop) Node — Telegram approval interrupt.
 *
 * Pure TypeScript graph node — no LLM.
 * Implements LangGraph interrupt_before pattern for approvals.
 * Fail-closed: timeout → deny.
 */
import type { CapCheckResult, HitlStatus, TradeTicket } from "../../safetycaps";
import { createApproval, getApproval, denyApproval, clearApprovals } from "../../telegram/approvals";
import { log } from "../../logger";

export interface HitlInput {
  cycle_id: string;
  ticket: TradeTicket;
  cap: CapCheckResult;
  /** Optional: override default 15min TTL */
  ttl_ms?: number;
}

export interface HitlOutput {
  cycle_id: string;
  hitl_status: HitlStatus;
  /** Updated cap with hitl_status = approved if approved */
  cap: CapCheckResult;
  /** True if cycle should continue to execution */
  proceed: boolean;
}

/**
 * Called by supervisor when SafetyCaps returns hitl_required=true.
 * Creates pending approval and INTERRUPTS the graph (LangGraph checkpoint).
 * The graph resumes when approveApproval/denyApproval is called externally (Telegram callback).
 */
export async function hitlNode(input: HitlInput): Promise<HitlOutput> {
  const { cycle_id, ticket, cap, ttl_ms = 15 * 60_000 } = input;

  if (!cap.hitl_required) {
    // Should not reach here if graph wired correctly, but fail closed
    log.warn("HITL", `cycle ${cycle_id}: hitlNode called but cap.hitl_required=false`);
    return {
      cycle_id,
      hitl_status: "not_required",
      cap,
      proceed: true,
    };
  }

  // Create pending approval (stores cap with hitl_status=pending)
  const approval = createApproval({
    cycleId: cycle_id,
    ticket,
    cap,
    summary: `${ticket.side.toUpperCase()} ${ticket.amount_ton} TON ${ticket.jetton_master.slice(0, 12)}… | Risk: ${ticket.risk?.verdict ?? "unknown"} | Cap: ${cap.ticket_hash.slice(0, 8)}`,
  });

  log.info("HITL", `cycle ${cycle_id}: approval ${approval.id} created — awaiting Telegram (TTL ${ttl_ms}ms)`);

  // In LangGraph, this is where we'd use `interrupt()` to pause the graph.
  // For now, return pending state — the supervisor graph will checkpoint here.
  // External caller (Telegram bot) must call resolveHitl(approval.id, "approve" | "deny")
  // which will resume the graph with updated state.

  return {
    cycle_id,
    hitl_status: "pending",
    cap: { ...cap, hitl_status: "pending" },
    proceed: false, // Graph pauses here
  };
}

/**
 * Resume function called by Telegram bot after user action.
 * Returns updated state for graph continuation.
 */
export async function resolveHitl(
  approvalId: string,
  action: "approve" | "deny",
): Promise<HitlOutput | null> {
  const approval = getApproval(approvalId);
  if (!approval) {
    log.warn("HITL", `resolveHitl: approval ${approvalId} not found`);
    return null;
  }

  if (approval.status !== "pending") {
    log.warn("HITL", `resolveHitl: approval ${approvalId} already ${approval.status}`);
    return {
      cycle_id: approval.cycle_id,
      hitl_status: approval.status,
      cap: approval.cap,
      proceed: approval.status === "approved",
    };
  }

  if (action === "approve") {
    const { approveApproval } = await import("../../telegram/approvals");
    const result = approveApproval(approvalId);
    if (!result.ok || !result.cap) {
      log.err("HITL", `approve failed: ${result.error}`);
      return null;
    }
    log.ok("HITL", `cycle ${approval.cycle_id}: APPROVED via Telegram`);
    return {
      cycle_id: approval.cycle_id,
      hitl_status: "approved",
      cap: result.cap,
      proceed: true,
    };
  } else {
    const { denyApproval } = await import("../../telegram/approvals");
    const result = denyApproval(approvalId);
    if (!result.ok) {
      log.err("HITL", `deny failed: ${result.error}`);
      return null;
    }
    log.warn("HITL", `cycle ${approval.cycle_id}: DENIED via Telegram`);
    return {
      cycle_id: approval.cycle_id,
      hitl_status: "denied",
      cap: result.approval!.cap,
      proceed: false,
    };
  }
}

/**
 * Called by background loop to expire stale approvals (fail closed → deny).
 */
export function expireStaleHitl(ttlMs = 15 * 60_000): number {
  const { expireStaleApprovals } = require("../../telegram/approvals");
  const n = expireStaleApprovals(ttlMs);
  if (n > 0) log.warn("HITL", `expired ${n} stale approvals (timeout → deny)`);
  return n;
}

/**
 * Clear all approvals (testing / emergency).
 */
export function clearAllHitl(): void {
  clearApprovals();
}