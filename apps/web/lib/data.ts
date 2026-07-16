import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/sentinel";
import {
  TIERS,
  type AgentStatusRow,
  type PositionRow,
  type WalletRow,
  type WalletTier,
} from "@/lib/types";
import type { WalletCardData } from "@/components/WalletCard";

/**
 * Assemble the 3-wallet dashboard view. Combines the `wallets` table with
 * live `agent_status` (open positions / PnL) and derives a small PnL history
 * from recent closed positions for the sparkline.
 *
 * Uses the admin client (service role key) so the password-login users can
 * read data without a Supabase Auth session. The RLS policies require the
 * `authenticated` role, but this app uses custom cookie-based auth, not
 * Supabase Auth sessions.
 */
export async function getDashboardCards(): Promise<WalletCardData[]> {
  if (!isSupabaseAdminConfigured()) return emptyCards();
  const supabase = createAdminClient();

  const [wallets, statuses, positions] = await Promise.all([
    supabase.from("wallets").select("*"),
    supabase.from("agent_status").select("*"),
    supabase
      .from("positions")
      .select("wallet_tier,pnl_pct,cost_basis_ton,created_at,status")
      .order("created_at", { ascending: true })
      .limit(300),
  ]);

  const walletByTier = new Map<WalletTier, WalletRow>();
  (wallets.data as WalletRow[] | null)?.forEach((w) =>
    walletByTier.set(w.tier, w),
  );

  const statusByTier = new Map<WalletTier, AgentStatusRow>();
  (statuses.data as AgentStatusRow[] | null)?.forEach((s) =>
    statusByTier.set(s.tier, s),
  );

  // Build a cumulative PnL series per tier from closed positions.
  const historyByTier = new Map<WalletTier, number[]>();
  const posRows = (positions.data as Partial<PositionRow>[] | null) ?? [];
  for (const tier of TIERS) historyByTier.set(tier, []);
  for (const p of posRows) {
    const tier = p.wallet_tier as WalletTier | undefined;
    if (!tier || !historyByTier.has(tier)) continue;
    const arr = historyByTier.get(tier)!;
    const prev = arr.length ? arr[arr.length - 1] : 0;
    const realized =
      p.pnl_pct != null && p.cost_basis_ton != null
        ? (p.pnl_pct / 100) * p.cost_basis_ton
        : 0;
    arr.push(prev + realized);
  }

  return TIERS.map((tier) => {
    const w = walletByTier.get(tier);
    const s = statusByTier.get(tier);
    return {
      tier,
      address: w?.address ?? "",
      balanceTon: s?.bankroll_ton ?? w?.balance_ton ?? 0,
      openPositions: w?.open_positions ?? s?.open_positions ?? 0,
      totalPnlTon: s?.total_pnl_ton ?? w?.total_pnl_ton ?? 0,
      status: w?.status ?? "active",
      pnlHistory: historyByTier.get(tier) ?? [],
    } satisfies WalletCardData;
  });
}

function emptyCards(): WalletCardData[] {
  return TIERS.map((tier) => ({
    tier,
    address: "",
    balanceTon: 0,
    openPositions: 0,
    totalPnlTon: 0,
    status: "active",
    pnlHistory: [],
  }));
}
