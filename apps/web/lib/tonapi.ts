/**
 * TONAPI (https://tonapi.io/v2) helper — browser-safe read calls.
 *
 * `getAccountBalance(address)` — returns the wallet's TON balance in human units.
 * `getAccountJettons(address, limit)` — returns up to `limit` jettons the wallet holds.
 *
 * Best-effort. When the public rate limit (no key) is exhausted we degrade to
 * returning null / empty rather than throwing — the UI is informational.
 */

const BASE = process.env.NEXT_PUBLIC_TONAPI_BASE || "https://tonapi.io/v2";
const KEY = process.env.NEXT_PUBLIC_TONAPI_KEY || "";

async function tonApiGet(path: string): Promise<any> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (KEY) headers["Authorization"] = `Bearer ${KEY}`;

  const r = await fetch(`${BASE}${path}`, {
    headers,
    // Reasonable timeout — defer to Next runtime defaults (15s).
    cache: "no-store",
  });
  if (!r.ok) {
    throw new Error(`TONAPI ${path} → HTTP ${r.status}`);
  }
  return r.json();
}

export interface JettonHolding {
  jetton: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    image?: string;
  };
  balance: string; // raw (big int as string)
  walletAddress: string;
  price?: { prices: { usd?: number } } | null;
}

export async function getAccountBalance(address: string): Promise<number | null> {
  try {
    const r = await tonApiGet(`/accounts/${encodeURIComponent(address)}`);
    return Number(r?.balance ?? 0) / 1e9;
  } catch {
    return null;
  }
}

export async function getAccountJettons(
  address: string,
  limit = 10,
): Promise<JettonHolding[]> {
  try {
    const r = await tonApiGet(
      `/accounts/${encodeURIComponent(address)}/jettons?limit=${limit}`,
    );
    return Array.isArray(r?.jettons) ? (r.jettons as JettonHolding[]) : [];
  } catch {
    return [];
  }
}
