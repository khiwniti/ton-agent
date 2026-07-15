import { createAdminClient } from "@/lib/supabase/admin";
import type { KillSwitchRow, WalletRow } from "@/lib/types";
import { TIERS } from "@/lib/types";
import { KillSwitch } from "./KillSwitch";
import { TierToggles } from "./TierToggles";
import { RiskParams } from "./RiskParams";

export const metadata = { title: "Settings · TON Agent" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = createAdminClient();
  const [{ data: kill }, { data: wallets }] = await Promise.all([
    supabase.from("kill_switch").select("*").eq("id", 1).maybeSingle(),
    supabase.from("wallets").select("*"),
  ]);

  const killRow = (kill as KillSwitchRow | null) ?? {
    id: 1,
    engaged: false,
    at: 0,
    by: null,
    updated_at: "",
  };

  const walletRows = (wallets as WalletRow[] | null) ?? [];
  const byTier = new Map(walletRows.map((w) => [w.tier, w]));
  const tierState = TIERS.map((tier) => ({
    tier,
    status: byTier.get(tier)?.status ?? "active",
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-fg-muted">
          Emergency controls and per-tier configuration.
        </p>
      </div>

      <section aria-labelledby="kill-heading">
        <h2 id="kill-heading" className="mb-3 text-sm font-semibold text-fg-muted">
          Emergency stop
        </h2>
        <KillSwitch initialEngaged={killRow.engaged} at={killRow.at} by={killRow.by} />
      </section>

      <section aria-labelledby="tiers-heading">
        <h2 id="tiers-heading" className="mb-3 text-sm font-semibold text-fg-muted">
          Wallet tiers
        </h2>
        <TierToggles initial={tierState} />
      </section>

      <section aria-labelledby="risk-heading">
        <h2 id="risk-heading" className="mb-3 text-sm font-semibold text-fg-muted">
          Risk parameters
        </h2>
        <RiskParams />
      </section>
    </div>
  );
}
