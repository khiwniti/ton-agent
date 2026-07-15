import Link from "next/link";

import { WalletCard, type WalletCardData } from "@/components/WalletCard";
import { UserPortfolio } from "@/components/UserPortfolio";
import { ManualSwapPanel } from "@/components/ManualSwapPanel";
import { getDashboardCards } from "@/lib/data";
import { isSupabaseAnonConfigured } from "@/lib/supabase/sentinel";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatPnl, formatTon } from "@/lib/format";
import { TIERS, TIER_LABEL } from "@/lib/types";

export const metadata = { title: "Dashboard · TON Agent" };
// Always render fresh — this is a live control plane.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const configured = isSupabaseAnonConfigured();
  const cards = configured ? await getDashboardCards() : emptyCards();
  const killEngaged = await readKillSwitch();

  const totalPnl = cards.reduce((a, c) => a + c.totalPnlTon, 0);
  const totalOpen = cards.reduce((a, c) => a + c.openPositions, 0);
  const positionsTracked = cards.reduce((a, c) => a + c.pnlHistory.length, 0);
  const activeTiers = cards.filter((c) => c.status === "active").length;
  const totalTiers = cards.length;
  const combinedBalance = cards.reduce((a, c) => a + c.balanceTon, 0);
  const hasAnyBalance = combinedBalance > 0;

  const empty = cards.every(
    (c) =>
      c.balanceTon === 0 &&
      c.totalPnlTon === 0 &&
      c.openPositions === 0 &&
      c.pnlHistory.length === 0,
  );

  const pnlPositive = totalPnl >= 0;

  return (
    <div className="space-y-6">
      {/* Hero / status card */}
      <section
        aria-label="System status"
        className="overflow-hidden rounded-2xl border border-border bg-panel"
      >
        <div className="flex flex-wrap items-start justify-between gap-6 p-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className={`inline-block h-2.5 w-2.5 rounded-full shadow-[0_0_10px_currentColor] ${configured ? "bg-teal text-teal" : "bg-amber text-amber"}`}
              />
              <h1 className="text-xl font-semibold tracking-tight">
                Wallets
              </h1>
              <span
                className={`mono rounded-md border px-1.5 py-0.5 text-[11px] ${
                  configured
                    ? "border-teal/40 bg-teal/10 text-teal"
                    : "border-amber/40 bg-amber/10 text-amber"
                }`}
              >
                {configured ? "database online" : "database offline"}
              </span>
              {killEngaged ? (
                <span className="mono rounded-md border border-red/50 bg-red/10 px-1.5 py-0.5 text-[11px] text-red">
                  kill-switch engaged
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-fg-muted">
              Three risk-tier wallets, one agent. Live from Supabase.
            </p>
          </div>

          <div className="flex items-center gap-4 text-right">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-fg-dim">
                Aggregate PnL
              </div>
              <div
                className={`mono text-2xl font-semibold ${pnlPositive ? "text-green" : "text-red"}`}
              >
                {formatPnl(totalPnl)}{" "}
                <span className="text-xs text-fg-dim">TON</span>
              </div>
            </div>
            <div className="h-10 w-px bg-border-strong" />
            <div>
              <div className="text-[11px] uppercase tracking-wide text-fg-dim">
                Open
              </div>
              <div className="mono text-2xl font-semibold text-fg">
                {totalOpen}
              </div>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <dl className="grid grid-cols-2 gap-px border-t border-border bg-border md:grid-cols-4">
          <Stat
            label="Positions tracked"
            value={String(positionsTracked)}
            hint="recent window (open + closed)"
          />
          <Stat
            label="Active tiers"
            value={configured ? `${activeTiers}/${totalTiers}` : `0/${totalTiers}`}
            hint={
              configured && !empty
                ? TIERS.filter((t) => cards.find((c) => c.tier === t)?.status === "active")
                    .map((t) => TIER_LABEL[t])
                    .join(" · ") || "—"
                : undefined
            }
          />
          <Stat
            label="Combined balance"
            value={hasAnyBalance ? `${formatTon(combinedBalance)} TON` : "—"}
          />
          <Stat
            label="Sync signal"
            value={
              !configured
                ? "—"
                : empty
                  ? "connected · awaiting signal"
                  : "live"
            }
            tone={!configured ? "neutral" : empty ? "neutral" : "teal"}
          />
        </dl>
      </section>

      {/* Setup / empty banners */}
      {!configured ? <SetupBanner /> : empty ? <BootBanner /> : null}

      {/* Connected-wallet portfolio (always rendered — handles its own CTA) */}
      <UserPortfolio />

      {/* Manual trade override (visible only when kill-switch is engaged) */}
      <ManualSwapPanel killActive={killEngaged} />

      {/* Wallet tier grid */}
      <section aria-label="Agent wallet tiers">
        <h2 className="mb-3 text-sm font-semibold text-fg-muted">
          Per-tier view
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {cards.map((c) => (
            <WalletCard key={c.tier} data={c} />
          ))}
        </div>
      </section>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components (page-local; not exported)
// ──────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "teal";
}) {
  return (
    <div className="bg-bg-elev px-6 py-4">
      <dt className="text-[11px] uppercase tracking-wide text-fg-dim">
        {label}
      </dt>
      <dd
        className={`mono mt-1 text-lg font-semibold ${
          tone === "teal" ? "text-teal" : "text-fg"
        }`}
      >
        {value}
      </dd>
      {hint ? (
        <dd className="mt-0.5 text-[11px] text-fg-dim mono">{hint}</dd>
      ) : null}
    </div>
  );
}

function SetupBanner() {
  return (
    <section
      role="status"
      className="rounded-2xl border border-amber/30 bg-amber/5 p-6"
    >
      <h2 className="text-sm font-semibold tracking-wide text-amber">
        Database not connected
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        This dashboard reads from Supabase. Set the environment variables below
        on your Vercel project, then redeploy.
      </p>
      <ol className="mt-4 grid gap-2 text-sm text-fg-muted sm:grid-cols-3">
        <Step
          n={1}
          title="Add env vars"
          body={
            <>
              <code className="mono text-xs text-fg">NEXT_PUBLIC_SUPABASE_URL</code>
              <br />
              <code className="mono text-xs text-fg">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
              <br />
              <code className="mono text-xs text-fg">SUPABASE_SERVICE_ROLE_KEY</code>
            </>
          }
        />
        <Step
          n={2}
          title="Run migration"
          body={
            <>
              Open the Supabase SQL editor and run{" "}
              <code className="mono text-xs text-fg">
                apps/web/supabase/migrations/0001_init.sql
              </code>
              .
            </>
          }
        />
        <Step
          n={3}
          title="Boot the agent"
          body={
            <>
              Start the runtime on your host with{" "}
              <code className="mono text-xs text-fg">npm start</code> — it pushes
              events to <code className="mono text-xs text-fg">/api/ingest</code>.
            </>
          }
        />
      </ol>
      <div className="mt-5 flex flex-wrap gap-3">
        <Link
          href="/api/health"
          className="inline-flex items-center rounded-md border border-border-strong px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-amber/50 hover:text-amber"
        >
          Probe /api/health →
        </Link>
        <Link
          href="/chat"
          className="inline-flex items-center rounded-md border border-border-strong px-3 py-1.5 text-xs text-fg-muted hover:border-teal/50 hover:text-teal"
        >
          Open Chat
        </Link>
      </div>
    </section>
  );
}

function BootBanner() {
  return (
    <section
      role="status"
      className="rounded-2xl border border-border-strong bg-bg-elev p-6"
    >
      <h2 className="text-sm font-semibold tracking-wide text-teal">
        Awaiting first heartbeat
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        Database is connected but the agent hasn&apos;t written any state yet.
        Boot the runtime and it&apos;ll start reporting here.
      </p>
      <p className="mono mt-2 text-xs text-fg-dim">
        Expected sources: <code>agent_status</code> · <code>wallets</code> ·{" "}
        <code>positions</code>
      </p>
    </section>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <li className="rounded-lg border border-border bg-bg-elev p-4">
      <div className="flex items-center gap-2">
        <span className="mono flex h-5 w-5 items-center justify-center rounded-md border border-border-strong bg-panel text-[11px] text-fg-muted">
          {n}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {title}
        </span>
      </div>
      <div className="mt-2 text-sm leading-relaxed">{body}</div>
    </li>
  );
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

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

/**
 * Reads the kill-switch row idempotently. Returns `true` if trading is
 * halted. Used to decide whether the ManualSwapPanel is shown.
 */
async function readKillSwitch(): Promise<boolean> {
  try {
    const admin = createAdminClient();
    if (!admin) return false;
    const { data, error } = await admin
      .from("kill_switch")
      .select("engaged")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    return Boolean((data as { engaged?: boolean } | null)?.engaged);
  } catch {
    return false;
  }
}
