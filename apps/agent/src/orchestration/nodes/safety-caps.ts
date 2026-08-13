/**
 * Deterministic SafetyCaps node — greenlights or rejects a TradeTicket.
 * Never calls the LLM. CapCheckContext must be supplied by the caller/runtime.
 */
import {
  authorizeTicket,
  type CapCheckContext,
} from "../../safetycaps";
import type { GramTradeState } from "../state";

export type CapContextFactory = (state: GramTradeState) => CapCheckContext;

/**
 * Build a pure node function bound to a context factory (live coordinator or test mock).
 */
export function makeSafetyCapsNode(getContext: CapContextFactory) {
  return function safetyCapsNode(state: GramTradeState): Partial<GramTradeState> {
    if (state.discarded) return {};

    const ticket = state.proposed_ticket;
    if (!ticket) {
      return {
        discarded: true,
        discard_reason: "no proposed_ticket for SafetyCaps",
      };
    }

    const ctx = getContext(state);
    const cap = authorizeTicket(ticket, ctx);

    if (!cap.ok) {
      return {
        cap_check_result: cap,
        discarded: true,
        discard_reason:
          cap.failures.map((f) => f.reason).join("; ") || "cap denied",
      };
    }

    return {
      cap_check_result: cap,
      discarded: false,
    };
  };
}
