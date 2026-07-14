/**
 * Security audit layer.
 *  - Renounce (admin = burn)
 *  - LP locked / burned
 *  - TVM sandbox honeypot
 *  - TONAPI jetton meta fetch
 */
import { Address, TonClient, fromNano } from "@ton/ton";
import { Blockchain } from "@ton/sandbox";
import axios from "axios";
import { CONFIG } from "../config";
import { log } from "../logger";

const BURN = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
const tonapiHeaders = () => {
    const h: any = {};
    if (CONFIG.tonApiKey) h.Authorization = `Bearer ${CONFIG.tonApiKey}`;
    return h;
};

/** 1. Renounce ownership */
export async function checkRenounced(client: TonClient, master: Address): Promise<boolean> {
    try {
        const { stack } = await client.runMethod(master, "get_jetton_data");
        stack.readBigNumber();         // total_supply (unused)
        stack.readBoolean();      // mintable flag (unused)
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
        const r = await axios.get(`${CONFIG.tonapiBase}/accounts/${pool.toString()}`,
            { headers: tonapiHeaders(), timeout: 8000 });
        const ifs = r.data?.interfaces ?? [];
        if (ifs.length === 0) return false;
        return true;
    } catch (e: any) {
        log.warn("SEC", `LP uncertain (${e.message})`);
        return false;
    }
}

/** 3. Honeypot sandbox */
export async function checkHoneypot(master: Address, pool: Address): Promise<boolean> {
    try {
        const bc = await Blockchain.create();
        const t = await bc.treasury("t");
        const buy = await t.send({ to: pool, value: 1_500_000_000n, body: undefined });
        for (const tx of buy.transactions) {
            if (tx.description.type === "generic" &&
                tx.description.computePhase?.type === "vm" &&
                tx.description.computePhase.exitCode !== 0) return false;
        }
        const sell = await t.send({ to: pool, value: 200_000_000n, body: undefined });
        for (const tx of sell.transactions) {
            const cOk = tx.description.computePhase?.type === "vm" &&
                tx.description.computePhase.exitCode === 0;
            const aOk = !tx.description.actionPhase || tx.description.actionPhase.success;
            if (!cOk || !aOk) return false;
        }
        return true;
    } catch (e: any) {
        log.err("SEC", `sandbox ${e.message}`);
        return false;
    }
}

/** 4. Jetton meta */
export async function getJetton(master: string): Promise<any> {
    try {
        const r = await axios.get(`${CONFIG.tonapiBase}/jettons/${master}`,
            { headers: tonapiHeaders(), timeout: 8000 });
        return r.data;
    } catch { return null; }
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
    const m = Address.parse(master);
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
