/**
 * Position Recovery — Spec 006 Phase 3 (FR-012).
 *
 * Reconciles open positions against on-chain jetton balances at boot.
 *
 * The DB is a cache of what the chain holds, and the two drift: a sell that
 * broadcast but whose row never got written leaves a phantom OPEN position the
 * exit engine keeps trying to sell, and a buy recorded once but filled several
 * times understates the real holding. Boot is the one moment we can cheaply
 * ask the chain who is right.
 *
 * Fails CLOSED in both directions:
 *   • Chain unreachable / malformed response → position stays OPEN. Never
 *     close a position on an RPC hiccup; a wrongly-closed row means the token
 *     is held with nothing left watching it.
 *   • Balance exactly 0 → the tokens are provably gone, so close the row.
 *   • Any balance > 0 → retain, even when it disagrees with `amount_tokens`.
 *     A quantity mismatch is logged for the operator, not auto-corrected:
 *     rewriting cost basis from a balance we cannot attribute to fills would
 *     corrupt PnL.
 */
import { Address, beginCell, type TonClient } from "@ton/ton";
import { log } from "../logger";
import { makeClient, openWallet, loadKeyPairForTier } from "../wallet/wallet";
import { positionsStore, type DbPosition } from "../storage/store";

export type ReconciliationVerdict =
  /** On-chain balance is 0 — tokens are gone, row closed. */
  | "reconciled_closed"
  /** Balance > 0 — position is real, left OPEN. */
  | "retained_open"
  /** Could not read the chain — left OPEN deliberately. */
  | "undetermined_fail_closed";

export interface PositionReconciliation {
  positionId: string;
  jettonMaster: string;
  verdict: ReconciliationVerdict;
  /** On-chain balance in nano units; null when undetermined. */
  onChainNano: string | null;
  /** DB-recorded holding, for drift comparison. */
  recordedNano: string;
  /** Set when the chain and the DB disagree but the position was retained. */
  drift?: string;
  error?: string;
}

/**
 * Read a wallet's balance of one jetton via TEP-74:
 * `get_wallet_address(owner)` on the master, then `get_wallet_data()` on the
 * returned jetton-wallet. Mirrors the resolution in dex/router.ts.
 *
 * Throws on any RPC or parse failure so the caller can fail closed — a
 * returned 0 must mean "chain says zero", never "we could not tell".
 */
async function readJettonBalanceNano(
  client: TonClient,
  jettonMaster: string,
  ownerAddress: Address,
): Promise<bigint> {
  const { stack } = await client.runMethod(
    Address.parse(jettonMaster),
    "get_wallet_address",
    [{ type: "slice", cell: beginCell().storeAddress(ownerAddress).endCell() }],
  );
  const jettonWallet = stack.readAddress();
  // A jetton wallet is deployed lazily on first receipt. If it does not exist
  // the get-method throws, which surfaces as undetermined — correct, because a
  // never-deployed wallet and an unreachable node are indistinguishable here.
  // `readAddress()` already returns an Address; re-parsing its string form
  // would be a needless round-trip that can only introduce failures.
  const data = await client.runMethod(jettonWallet, "get_wallet_data");
  return data.stack.readBigNumber();
}

/**
 * Reconcile every OPEN position at boot.
 *
 * @param injectedClient test seam — production passes nothing and gets the
 *        configured TonClient.
 */
export async function reconcilePositionsAtBoot(
  injectedClient?: TonClient,
): Promise<PositionReconciliation[]> {
  const openPositions = positionsStore.listOpen();
  log.info("RECOVERY", `reconciling ${openPositions.length} open position(s) against chain`);
  if (openPositions.length === 0) return [];

  const client = injectedClient ?? makeClient();
  const results: PositionReconciliation[] = [];
  // Owner address per tier, resolved once — positions of the same tier share a
  // wallet, and key derivation is the slow part of this loop.
  const ownerByTier = new Map<string, Address | null>();

  for (const pos of openPositions) {
    const recordedNano = pos.amount_tokens;
    try {
      let owner = ownerByTier.get(pos.wallet_tier);
      if (owner === undefined) {
        const kp = await loadKeyPairForTier(pos.wallet_tier as "low" | "mid" | "high");
        // `openWallet` builds its contract as `any` and returns `client.open(w)`,
        // so `.address` arrives untyped. Normalise to a real Address here: a
        // look-alike would otherwise fail deep inside `storeAddress` with a
        // message that names the address but not the position.
        const raw = openWallet(client, kp).address;
        owner = raw instanceof Address ? raw : Address.parse(String(raw));
        ownerByTier.set(pos.wallet_tier, owner);
      }
      if (!owner) throw new Error(`no wallet for tier ${pos.wallet_tier}`);

      const balance = await readJettonBalanceNano(client, pos.jetton_master, owner);

      if (balance === 0n) {
        closePosition(pos, "reconciled: on-chain balance 0 at boot");
        log.warn("RECOVERY", `${pos.id} ${pos.symbol ?? "?"}: balance 0 on chain — closing stale row`);
        results.push({
          positionId: pos.id,
          jettonMaster: pos.jetton_master,
          verdict: "reconciled_closed",
          onChainNano: "0",
          recordedNano,
        });
        continue;
      }

      // Drift is reported, never silently corrected — see the header note.
      const drift =
        balance.toString() !== recordedNano
          ? `chain ${balance} vs db ${recordedNano}`
          : undefined;
      if (drift) {
        log.warn("RECOVERY", `${pos.id} ${pos.symbol ?? "?"}: quantity drift — ${drift} (retained; cost basis untouched)`);
      }
      results.push({
        positionId: pos.id,
        jettonMaster: pos.jetton_master,
        verdict: "retained_open",
        onChainNano: balance.toString(),
        recordedNano,
        drift,
      });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      log.err("RECOVERY", `${pos.id}: cannot determine on-chain balance (${error}) — retaining OPEN`);
      results.push({
        positionId: pos.id,
        jettonMaster: pos.jetton_master,
        verdict: "undetermined_fail_closed",
        onChainNano: null,
        recordedNano,
        error,
      });
    }
  }

  const closed = results.filter((r) => r.verdict === "reconciled_closed").length;
  const undetermined = results.filter((r) => r.verdict === "undetermined_fail_closed").length;
  log.info(
    "RECOVERY",
    `reconciliation complete: ${closed} closed, ${results.length - closed - undetermined} retained, ${undetermined} undetermined`,
  );
  return results;
}

function closePosition(pos: DbPosition, reason: string): void {
  positionsStore.upsert({
    ...pos,
    status: "CLOSED",
    close_at: Date.now(),
    // No close_tx: we did not send the sell, we only observed the tokens gone.
    // Overwriting realized PnL from a balance we cannot attribute to a fill
    // would be a guess, so it is left as recorded.
  });
  log.info("RECOVERY", `${pos.id} → CLOSED (${reason})`);
}
