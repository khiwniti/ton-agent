/**
 * Execution Agent — converts authorized tickets to signed transactions.
 *
 * Tools: @ton/mcp transact tools ONLY (swap, sign, submit).
 * NO text-ingestion tools — containment layer.
 * Model: cheap/fast (nemotron-3-ultra or local) — no reasoning needed, just mechanical execution.
 * Precondition: CapCheckResult.ok === true AND (hitl_required === false OR hitl_status === "approved")
 */
import { TonClient, Address, toNano, fromNano } from "@ton/ton";
import { CONFIG, isTestnet } from "../../config";
import { log } from "../../logger";
import { makeClient, loadKeyPairForTier, openWallet } from "../../wallet/wallet";
import { executeSwap, getSwapQuote, computeMinOut, type Dex, type SwapRequest, type SwapResult } from "../../dex/router";
import { resolvePool, type PoolResolutionResult } from "../../security/pool-resolver";
import { getTierSlippageCeilingBps } from "../../risk/guardrails";
import type { CapCheckResult, TradeTicket, Tier, AuthorizedExecution } from "../../safetycaps";
import { verifyCapBinding, hashTradeTicket } from "../../safetycaps";
import { decisionJournalStore } from "../../storage/store";
import { newId } from "@ton-agent/shared";

export interface ExecutionInput {
  cycle_id: string;
  /** Pre-authorized execution envelope from SafetyCaps + HITL */
  authorized: AuthorizedExecution;
  /** Optional DEX override (normally resolved by pool location) */
  dex_override?: Dex;
}

export interface ExecutionOutput {
  cycle_id: string;
  ok: boolean;
  result: SwapResult | null;
  error?: string;
}

/**
 * Verify authorization is valid and matches ticket.
 * This is the ONLY path that should reach the signer.
 */
function verifyAuthorization(auth: AuthorizedExecution): { allowed: boolean; reason?: string } {
  const { ticket, cap, hitl } = auth;

  // 1. Cap must be ok
  if (!cap.ok) {
    return { allowed: false, reason: "cap check not ok" };
  }

  // 2. Version match
  if (cap.caps_version !== "safetycaps-v1") {
    return { allowed: false, reason: `caps_version mismatch: ${cap.caps_version}` };
  }

  // 3. Ticket hash binding
  const expected = hashTradeTicket(ticket);
  if (cap.ticket_hash !== expected) {
    return {
      allowed: false,
      reason: `ticket_hash mismatch (cap=${cap.ticket_hash} ticket=${expected})`,
    };
  }

  // 4. Cycle ID match
  if (cap.cycle_id !== ticket.cycle_id) {
    return { allowed: false, reason: "cycle_id mismatch" };
  }

  // 5. HITL status
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
 * Mechanical execution — no LLM, no reasoning.
 * All safety checks already passed in SafetyCaps + HITL.
 */
export async function executionNode(
  input: ExecutionInput,
): Promise<ExecutionOutput> {
  const { cycle_id, authorized, dex_override } = input;
  const { ticket, cap, hitl } = authorized;

  // Final verification (defense in depth)
  const verify = verifyAuthorization(authorized);
  if (!verify.allowed) {
    const reason = `Authorization verification failed: ${verify.reason}`;
    log.err("EXEC", `[${cycle_id}] ${reason}`);
    decisionJournalStore.append({
      cycle_id,
      agent: "execution",
      input_hash: cap.ticket_hash,
      cap_check_result: cap,
      hitl_status: hitl,
      final_action: "execute_denied_auth_verify",
      output: { error: reason },
    });
    return { cycle_id, ok: false, result: null, error: reason };
  }

  const tier = ticket.tier;
  const client = makeClient();

  // Load tier wallet
  let kp;
  try {
    kp = await loadKeyPairForTier(tier);
  } catch (e: any) {
    const reason = `Failed to load tier ${tier} keypair: ${e.message}`;
    log.err("EXEC", `[${cycle_id}] ${reason}`);
    return { cycle_id, ok: false, result: null, error: reason };
  }

  const wallet = openWallet(client, kp);
  log.trade("EXEC", `[${cycle_id}] Executing ${ticket.side} ${ticket.amount_ton} TON ${ticket.jetton_master.slice(0, 8)}… via ${tier} wallet`);

  // Resolve pool to correct DEX
  let poolResolved: PoolResolutionResult | null = null;
  try {
    poolResolved = await resolvePool(client, Address.parse(ticket.jetton_master));
  } catch (e: any) {
    log.debug("EXEC", `[${cycle_id}] pool resolve failed: ${e.message}`);
  }

  const execDex: Dex =
    dex_override ??
    (poolResolved && (poolResolved.source === "stonfi" || poolResolved.source === "dedust")
      ? poolResolved.source
      : CONFIG.strategy.preferredDex);

  // Build swap request
  const swapReq: SwapRequest = {
    side: ticket.side,
    jettonMaster: ticket.jetton_master,
    amountTon: ticket.amount_ton,
    jettonAmountNano: ticket.side === "sell" ? undefined : undefined, // Filled by router for sells
    minOutJettonNano: undefined, // Will be set after quote
  };

  // Slippage enforcement (US1) — same logic as coordinator
  const ceilingBps = getTierSlippageCeilingBps(tier);
  if (ceilingBps != null && poolResolved?.poolAddress) {
    try {
      const jettonAmountIn = ticket.side === "buy"
        ? toNano(ticket.amount_ton.toString()).toString()
        : swapReq.jettonAmountNano ?? "";
      if (jettonAmountIn) {
        const quote = await getSwapQuote(
          client,
          { dex: execDex, poolAddress: poolResolved.poolAddress },
          ticket.side,
          jettonAmountIn,
          ticket.jetton_master,
        );
        if (quote && quote.available) {
          const minOut = computeMinOut(quote.expectedOutNano, ceilingBps);
          swapReq.minOutJettonNano = minOut;
          log.info("EXEC", `[${cycle_id}] slippage: quote=${quote.expectedOutNano} ceiling=${ceilingBps}bps minOut=${minOut}`);
        }
      }
    } catch (e: any) {
      log.warn("EXEC", `[${cycle_id}] slippage calc failed: ${e.message}`);
    }
  }

  // Journal: submit attempt
  decisionJournalStore.append({
    cycle_id,
    agent: "execution",
    input_hash: cap.ticket_hash,
    cap_check_result: cap,
    hitl_status: hitl,
    final_action: "execute_submit",
    output: { dex: execDex, side: ticket.side, amountTon: ticket.amount_ton },
  });

  // Execute swap
  const result = await executeSwap(client, swapReq, tier, execDex);

  if (result.ok) {
    log.ok("EXEC", `[${cycle_id}] Swap OK tx=${result.txHash?.slice(0, 16)}… tokens=${result.amountTokens}`);
    decisionJournalStore.append({
      cycle_id,
      agent: "execution",
      input_hash: cap.ticket_hash,
      final_action: "execute_ok",
      output: { txHash: result.txHash, amountTokens: result.amountTokens },
    });
  } else {
    log.err("EXEC", `[${cycle_id}] Swap FAILED: ${result.error}`);
    decisionJournalStore.append({
      cycle_id,
      agent: "execution",
      input_hash: cap.ticket_hash,
      final_action: "execute_failed",
      output: { error: result.error },
    });
  }

  return { cycle_id, ok: result.ok, result, error: result.error };
}

/**
 * Convenience: build AuthorizedExecution from ticket + cap + hitl status.
 * Used by supervisor after HITL resolves.
 */
export function makeAuthorizedExecution(
  ticket: TradeTicket,
  cap: CapCheckResult,
  hitl: CapCheckResult["hitl_status"] | "approved" = cap.hitl_status,
): AuthorizedExecution {
  return {
    ticket,
    cap,
    hitl,
    idempotency_key: `${cap.cycle_id}:${cap.ticket_hash}`,
  };
}