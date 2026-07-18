/**
 * In-memory HITL approval store for SafetyCaps tickets.
 * Telegram transport is separate; this module is pure and unit-testable.
 */
import {
  issueAuthorization,
  withHitlApproved,
  type CapCheckResult,
  type TradeTicket,
} from "../safetycaps";

export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout";

export interface PendingApproval {
  id: string;
  cycle_id: string;
  ticket_hash: string;
  cap: CapCheckResult;
  ticket: TradeTicket;
  summary: string;
  status: ApprovalStatus;
  created_at: number;
  resolved_at?: number;
}

const pending = new Map<string, PendingApproval>();

function newId(): string {
  return `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createApproval(input: {
  cycleId: string;
  ticket: TradeTicket;
  cap: CapCheckResult;
  summary?: string;
}): PendingApproval {
  const id = newId();
  const row: PendingApproval = {
    id,
    cycle_id: input.cycleId,
    ticket_hash: input.cap.ticket_hash,
    cap: { ...input.cap, hitl_required: true, hitl_status: "pending" },
    ticket: input.ticket,
    summary:
      input.summary ??
      `${input.ticket.side} ${input.ticket.amount_ton}TON ${input.ticket.jetton_master.slice(0, 12)}…`,
    status: "pending",
    created_at: Date.now(),
  };
  pending.set(id, row);
  return { ...row };
}

export function getApproval(id: string): PendingApproval | undefined {
  const row = pending.get(id);
  return row ? { ...row } : undefined;
}

export function listPending(): PendingApproval[] {
  return [...pending.values()]
    .filter((p) => p.status === "pending")
    .map((p) => ({ ...p }));
}

/**
 * Approve: mark HITL approved and re-issue authorization for execute path.
 */
export function approveApproval(id: string): {
  ok: boolean;
  approval?: PendingApproval;
  cap?: CapCheckResult;
  error?: string;
} {
  const row = pending.get(id);
  if (!row) return { ok: false, error: "approval not found" };
  if (row.status !== "pending") {
    return { ok: false, error: `approval already ${row.status}` };
  }
  const cap = issueAuthorization(withHitlApproved(row.cap));
  row.status = "approved";
  row.resolved_at = Date.now();
  row.cap = cap;
  pending.set(id, row);
  return { ok: true, approval: { ...row }, cap };
}

export function denyApproval(id: string): {
  ok: boolean;
  approval?: PendingApproval;
  error?: string;
} {
  const row = pending.get(id);
  if (!row) return { ok: false, error: "approval not found" };
  if (row.status !== "pending") {
    return { ok: false, error: `approval already ${row.status}` };
  }
  row.status = "denied";
  row.resolved_at = Date.now();
  row.cap = { ...row.cap, hitl_status: "denied", ok: false };
  pending.set(id, row);
  return { ok: true, approval: { ...row } };
}

/** Expire pending approvals older than ttlMs (default 15m). */
export function expireStaleApprovals(ttlMs = 15 * 60_000): number {
  const now = Date.now();
  let n = 0;
  for (const [id, row] of pending) {
    // >= so ttlMs=0 means "expire everything pending now" (useful in tests/ops).
    if (row.status === "pending" && now - row.created_at >= ttlMs) {
      row.status = "timeout";
      row.resolved_at = now;
      row.cap = { ...row.cap, hitl_status: "timeout", ok: false };
      pending.set(id, row);
      n++;
    }
  }
  return n;
}

export function clearApprovals(): void {
  pending.clear();
}
