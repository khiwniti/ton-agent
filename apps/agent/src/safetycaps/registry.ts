/**
 * In-process registry of issued CapCheckResults.
 *
 * Only results produced via issueAuthorization() can be consumed by the
 * execute path when a caller presents a ticket_hash. This prevents an LLM
 * from fabricating a CapCheckResult JSON blob with ok:true.
 */
import type { CapCheckResult } from "./types";

const issued = new Map<string, CapCheckResult>();

/** TTL for unused authorizations (ms). Default 15 minutes. */
const AUTH_TTL_MS = Number(process.env.SAFETYCAPS_AUTH_TTL_MS || 15 * 60_000);

export function issueAuthorization(cap: CapCheckResult): CapCheckResult {
  if (cap.ok) {
    issued.set(cap.ticket_hash, { ...cap });
  }
  return cap;
}

export function peekAuthorization(ticketHash: string): CapCheckResult | undefined {
  prune();
  return issued.get(ticketHash);
}

/**
 * Single-use consume. Returns a copy if present and still within TTL.
 */
export function consumeAuthorization(ticketHash: string): CapCheckResult | undefined {
  prune();
  const cap = issued.get(ticketHash);
  if (!cap) return undefined;
  issued.delete(ticketHash);
  return { ...cap };
}

export function clearAuthorizationRegistry(): void {
  issued.clear();
}

function prune(): void {
  const now = Date.now();
  for (const [k, v] of issued) {
    if (now - v.checked_at > AUTH_TTL_MS) {
      issued.delete(k);
    }
  }
}

/** Test helper — count live authorizations. */
export function authorizationRegistrySize(): number {
  prune();
  return issued.size;
}
