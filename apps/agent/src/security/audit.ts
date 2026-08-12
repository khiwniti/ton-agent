/**
 * Security audit layer.
 *  - Renounce (admin = burn)
 *  - LP locked / burned
 *  - TVM sandbox honeypot
 *  - TONAPI jetton meta fetch
 */
import { Address, beginCell, TonClient } from "@ton/ton";
import { Blockchain } from "@ton/sandbox";
import { log } from "../logger";
import { tonapiGet } from "../http/tonapi";

const BURN = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");

// ─── Shared TTL cache helpers ────────────────────────────────────────────────
const JETTON_TTL_MS = 10 * 60 * 1000;  // 10 min — jetton meta is stable
const AUDIT_TTL_MS  = 15 * 60 * 1000; // 15 min — security posture changes slowly

interface CacheEntry<T> { value: T; ts: number; }

const jettonCache = new Map<string, CacheEntry<any>>();
const auditCache  = new Map<string, CacheEntry<any>>();

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string, ttl: number): T | undefined {
  const e = cache.get(key);
  if (e && Date.now() - e.ts < ttl) return e.value;
  return undefined;
}
function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  cache.set(key, { value, ts: Date.now() });
}

/** 1. Renounce ownership
 *  Primary: uses the already-cached TONAPI `getJetton()` response — zero
 *  additional API calls when the jetton meta has already been fetched.
 *  Fallback: on-chain `get_jetton_data` via TonClient when TONAPI has no admin
 *  field (null admin = renounced on TONAPI means same thing on-chain).
 */
export async function checkRenounced(client: TonClient, master: Address): Promise<boolean> {
  // ── Fast path: TONAPI admin field (no extra request when cache is warm) ──
  try {
    const meta = await getJetton(master.toString());
    if (meta !== null && meta !== undefined) {
      // TONAPI returns admin=null when the contract has no admin (renounced).
      // When admin.address is the zero/burn address we also treat it as renounced.
      if (meta.admin === null || meta.admin === undefined) {
        log.ok("SEC", "renounced (TONAPI admin=null)");
        return true;
      }
      const adminAddr: string | undefined = meta.admin?.address;
      if (adminAddr) {
        const isRenounced = adminAddr === BURN.toString() ||
          adminAddr === "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c" ||
          adminAddr.toLowerCase().startsWith("0:0000000000000");
        isRenounced
          ? log.ok("SEC", "renounced (TONAPI)")
          : log.warn("SEC", `admin=${adminAddr}`);
        return isRenounced;
      }
    }
  } catch {
    // TONAPI path failed — fall through to on-chain
  }

  // ── Fallback: on-chain runMethod (hits toncenter) ──
  try {
    const { stack } = await client.runMethod(master, "get_jetton_data");
    stack.readBigNumber();         // total_supply (unused)
    stack.readBoolean();           // mintable flag (unused)
    const admin = stack.readAddressOpt();
    if (!admin) return true;
    const ok = admin.equals(BURN);
    ok ? log.ok("SEC", "renounced (on-chain)") : log.warn("SEC", `admin=${admin.toString()}`);
    return ok;
  } catch (e: any) {
    log.err("SEC", `renounce ${e.message}`);
    return false;
  }
}

/**
 * 2. LP lock — on-chain.
 *
 * On both STON.fi and DeDust the pool contract is also the LP-token jetton
 * master (TEP-74). "Locked LP" = the LP burn wallet holds ~100% of the total
 * LP supply. We read the pool's `get_jetton_data` total_supply and the burn
 * wallet's jetton balance (get_wallet_address(BURN) → get_wallet_data), then
 * require >=99% of supply held in the burn wallet. NOTE: we do NOT trust
 * `get_jetton_data` admin — STON.fi pools return admin = -1 (null), so an
 * admin==zero-address check would false-negative on every STON.fi pool.
 * Fails closed: any RPC/parse error returns `false`.
 */
export async function checkLpLocked(client: TonClient, pool: Address): Promise<boolean> {
  try {
    const { stack } = await client.runMethod(pool, "get_jetton_data");
    const totalSupply = stack.readBigNumber();
    const { stack: wstack } = await client.runMethod(pool, "get_wallet_address", [
      { type: "slice", cell: beginCell().storeAddress(BURN).endCell() },
    ]);
    const burnWallet = wstack.readAddress();
    const data = await client.runMethod(burnWallet, "get_wallet_data");
    const burnBalance = data.stack.readBigNumber();
    if (totalSupply <= 0n) return false;
    return (burnBalance * 100n) / totalSupply >= 99n;
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

/** 4. Jetton meta via TONAPI (auto retry on 429/5xx). Cached JETTON_TTL_MS. */
export async function getJetton(master: string): Promise<any> {
  const cached = cacheGet(jettonCache, master, JETTON_TTL_MS);
  if (cached !== undefined) return cached;
  try {
    const r = await tonapiGet(`/jettons/${master}`, { timeoutMs: 8000 });
    const data = r.data ?? null;
    cacheSet(jettonCache, master, data);
    return data;
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
  // Detailed audit dimensions for the hot-path monitor (exit policy engine)
  dataAvailable: boolean;
  dataUnavailableReason?: string;
  lpLockedDetail: {
    passed: boolean;
    state: "locked" | "unlocked" | "undetermined";
  };
  honeypotSafeDetail: {
    passed: boolean;
  };
  renouncedDetail: {
    passed: boolean;
  };
}

export async function fullAudit(client: TonClient, master: string, pool?: string): Promise<SecurityReport> {
  // Return cached result if still fresh — avoids repeated on-chain + TONAPI
  // hits for the same token across successive radar ticks.
  const cacheKey = `${master}:${pool ?? ""}`;
  const cached = cacheGet<SecurityReport>(auditCache, cacheKey, AUDIT_TTL_MS);
  if (cached) {
    log.info("SEC", `audit cache hit ${master.slice(0,8)}…`);
    return cached;
  }

  // Parse addresses defensively — TONAPI testnet may return malformed addresses
  let m: Address;
  try {
    m = Address.parse(master);
  } catch {
    log.warn("SEC", `fullAudit: invalid master address "${master?.slice(0, 20) ?? '?'}"`);
    return {
      renounced: false,
      lpLocked: false,
      honeypotSafe: false,
      holders: 0,
      ageHours: 0,
      ok: false,
      dataAvailable: false,
      dataUnavailableReason: "invalid master address",
      lpLockedDetail: { passed: false, state: "undetermined" },
      honeypotSafeDetail: { passed: false },
      renouncedDetail: { passed: false },
    };
  }

  // Track data availability
  let dataAvailable = true;
  let dataUnavailableReason: string | undefined;

  const meta = await getJetton(master);

  // Renounce check
  let renounced = false;
  try {
    renounced = await checkRenounced(client, m);
  } catch (e: any) {
    log.warn("SEC", `renounce check failed: ${e.message}`);
    dataAvailable = false;
    dataUnavailableReason = "renounce check failed";
  }

  // LP lock check
  let lpLocked = false;
  let lpState: "locked" | "unlocked" | "undetermined" = "undetermined";
  if (pool) {
    try {
      lpLocked = await checkLpLocked(client, Address.parse(pool));
      lpState = lpLocked ? "locked" : "unlocked";
    } catch (e: any) {
      log.warn("SEC", `lp lock check failed: ${e.message}`);
      dataAvailable = false;
      dataUnavailableReason = "lp lock check failed";
    }
  } else {
    dataAvailable = false;
    dataUnavailableReason = "no pool provided";
    lpState = "undetermined";
  }

  // Honeypot check
  let honeypotSafe = true;
  if (pool) {
    try {
      honeypotSafe = await checkHoneypot(m, Address.parse(pool));
    } catch (e: any) {
      log.warn("SEC", `honeypot check failed: ${e.message}`);
      dataAvailable = false;
      dataUnavailableReason = "honeypot check failed";
    }
  } else {
    dataAvailable = false;
    dataUnavailableReason = "no pool provided";
  }

  const rep: SecurityReport = {
    renounced,
    lpLocked,
    honeypotSafe,
    holders: meta?.holders_count ?? 0,
    ageHours: 0, // TONAPI doesn't expose exact timestamp; we infer via DeepScan when needed
    ok: renounced && lpLocked && honeypotSafe,
    dataAvailable,
    dataUnavailableReason,
    lpLockedDetail: { passed: lpLocked, state: lpState },
    honeypotSafeDetail: { passed: honeypotSafe },
    renouncedDetail: { passed: renounced },
  };
  log.ok("SEC", `audit ${master.slice(0,8)}…: ${JSON.stringify(rep)}`);
  cacheSet(auditCache, cacheKey, rep);
  return rep;
}

export const fullAuditDetail = fullAudit;
