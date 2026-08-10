/**
 * Sniper execution gate (plan §3.3).
 *
 * Before any live sniper send can proceed, ALL of the following must be true:
 *   1. CONFIG.network === "mainnet"
 *   2. CONFIG.observeOnly === false
 *   3. CONFIG.sniper.dryRun === false
 *   4. CONFIG.sniper.liveExecutionEnabled === true  (explicit operator opt-in)
 *   5. The sniper wallet is exclusive (not shared with LOW/MID/HIGH coordinator wallets)
 *   6. A wallet health check passes (balance ≥ gas floor)
 *
 * Any failing gate returns a typed refusal reason so the caller can log,
 * journal, and continue without broadcasting.
 *
 * This module has NO side effects — it only evaluates conditions.
 */

import { CONFIG } from "../config";
import { log } from "../logger";

export type GateRefusalReason =
  | "not_mainnet"
  | "observe_only"
  | "dry_run"
  | "live_execution_disabled"
  | "wallet_unhealthy"
  | "wallet_not_exclusive";

export interface GateResult {
  allowed: boolean;
  reason?: GateRefusalReason;
  detail?: string;
}

/**
 * Evaluate all live-execution gates for the sniper.
 *
 * @param opts.walletBalance  Current wallet balance in TON (or null if unreadable).
 * @param opts.gasFloorTon    Minimum TON required to send a transaction.
 * @param opts.isExclusiveWallet  True when the sniper wallet address is not in
 *   the coordinator's LOW/MID/HIGH wallet set. Callers must verify this.
 */
export function evaluateSniperLiveGate(opts: {
  walletBalance: number | null;
  gasFloorTon: number;
  isExclusiveWallet: boolean;
}): GateResult {
  const s = CONFIG.sniper;

  if (CONFIG.network !== "mainnet") {
    return { allowed: false, reason: "not_mainnet", detail: `network=${CONFIG.network}` };
  }
  if (CONFIG.observeOnly) {
    return { allowed: false, reason: "observe_only" };
  }
  if (s.dryRun) {
    return { allowed: false, reason: "dry_run" };
  }
  if (!s.liveExecutionEnabled) {
    return {
      allowed: false,
      reason: "live_execution_disabled",
      detail: "Set SNIPER_LIVE_EXECUTION_ENABLED=true to enable live sniper sends",
    };
  }
  if (!opts.isExclusiveWallet) {
    return {
      allowed: false,
      reason: "wallet_not_exclusive",
      detail: "Sniper wallet must not be shared with coordinator LOW/MID/HIGH wallets",
    };
  }
  if (opts.walletBalance === null || opts.walletBalance < opts.gasFloorTon) {
    return {
      allowed: false,
      reason: "wallet_unhealthy",
      detail: `balance=${opts.walletBalance ?? "unreadable"} < gasFloor=${opts.gasFloorTon} TON`,
    };
  }

  return { allowed: true };
}

/**
 * Log + return false when any gate fails. Use this in the scan/monitor loops.
 */
export function assertSniperLiveGate(opts: Parameters<typeof evaluateSniperLiveGate>[0]): boolean {
  const result = evaluateSniperLiveGate(opts);
  if (!result.allowed) {
    log.warn(
      "SNIPER_GATE",
      `live execution refused: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`,
    );
  }
  return result.allowed;
}
