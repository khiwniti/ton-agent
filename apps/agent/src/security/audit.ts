/**
 * Security audit layer.
 *  - Renounce (admin = burn)
 *  - LP locked / burned
 *  - TVM sandbox honeypot
 *  - TONAPI jetton meta fetch
 */
import { Address, TonClient } from "@ton/ton";
import { Blockchain } from "@ton/sandbox";
import { log } from "../logger";
import { tonapiGet } from "../http/tonapi";

const BURN = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");

/** 1. Renounce ownership */
export async function checkRenounced(client: TonClient, master: Address): Promise<boolean> {
  try {
    const { stack } = await client.runMethod(master, "get_jetton_data");
    stack.readBigNumber();         // total_supply (unused)
    stack.readBoolean();           // mintable flag (unused)
    const admin = stack.readAddressOpt();
    if (!admin) return true;
    const ok = admin.equals(BURN);
    ok ? log.ok("SEC", "renounced") : log.warn("SEC", `admin=${admin.toString()}`);
    return ok;
  } catch (e: any) {
    log.err("SEC", `renounce ${e.message}`);
    return false;
  }
}

/** 2. LP lock — heuristic via TONAPI */
export async function checkLpLocked(pool: Address): Promise<boolean> {
  try {
    const r = await tonapiGet(`/accounts/${pool.toString()}`, { timeoutMs: 8000 });
    const ifs = r.data?.interfaces ?? [];
    if (ifs.length === 0) return false;
    return true;
  } catch (e: any) {
    log.warn("SEC", `LP uncertain (${e.message})`);
    return false;
  }
}

/** 3. Honeypot sandbox — sandbox is local so retry doesn't apply. */
export async function checkHoneypot(master: Address, pool: Address): Promise<boolean> {
  try {
    const bc = await Blockchain.create();
    const t = await bc.treasury("t");

    // BEHAVIOR-PARITY with the original honeypot check:
    //   - Original only failed when vm-compute exit code was non-zero
    //     (it ignored `description.type`).
    //   - Ticktock / bounced-shard descriptions are NOT treated as failures
    //     here because the original code did not check `desc.type` either.
    // Narrow — narrow as needed for type access to compile:
    const isVmComputeFailed = (
      desc: { computePhase?: { type?: string; exitCode?: number } | null }
    ): boolean =>
      desc.computePhase?.type === "vm" && (desc.computePhase.exitCode ?? 0) !== 0;
    const isActionFailed = (
      desc: { actionPhase?: { success?: boolean } | null }
    ): boolean =>
      desc.actionPhase != null && !desc.actionPhase.success;
    const isOk = (desc: any): boolean =>
      !isVmComputeFailed(desc) && !isActionFailed(desc);

    const buy = await t.send({ to: pool, value: 1_500_000_000n, body: undefined });
    for (const tx of buy.transactions) {
      if (!isOk(tx.description as any)) return false;
    }

    const sell = await t.send({ to: pool, value: 200_000_000n, body: undefined });
    for (const tx of sell.transactions) {
      if (!isOk(tx.description as any)) return false;
    }
    return true;
  } catch (e: any) {
    log.err("SEC", `sandbox ${e.message}`);
    return false;
  }
}

/** 4. Jetton meta via TONAPI (auto retry on 429/5xx). */
export async function getJetton(master: string): Promise<any> {
  try {
    const r = await tonapiGet(`/jettons/${master}`, { timeoutMs: 8000 });
    return r.data;
  } catch {
    return null;
  }
}

export interface SecurityReport {
  renounced: boolean;
  lpLocked: boolean;
  honeypotSafe: boolean;
  holders: number;
  ageHours: number;
  ok: boolean;
}

export async function fullAudit(client: TonClient, master: string, pool?: string): Promise<SecurityReport> {
  // Parse addresses defensively — TONAPI testnet may return malformed addresses
  let m: Address;
  try {
    m = Address.parse(master);
  } catch {
    log.warn("SEC", `fullAudit: invalid master address "${master?.slice(0, 20) ?? '?'}"`);
    return { renounced: false, lpLocked: false, honeypotSafe: false, holders: 0, ageHours: 0, ok: false };
  }
  const meta = await getJetton(master);
  const renounced = await checkRenounced(client, m);
  const lpLocked = pool ? await checkLpLocked(Address.parse(pool)) : false;
  const honeypotSafe = pool ? await checkHoneypot(m, Address.parse(pool)) : true;

  const rep: SecurityReport = {
    renounced,
    lpLocked,
    honeypotSafe,
    holders: meta?.holders_count ?? 0,
    ageHours: 0, // TONAPI doesn't expose exact timestamp; we infer via DeepScan when needed
    ok: renounced && lpLocked && honeypotSafe,
  };
  log.ok("SEC", `audit ${master.slice(0,8)}…: ${JSON.stringify(rep)}`);
  return rep;
}
