"use client";

/**
 * UserPortfolio — connected wallet's read-only balance + jetton list.
 *
 * Source: tonapi.io /accounts/{address}/jettons. We do NOT sign anything
 * here; this is purely informational. The agent's three tier wallets are
 * still the only wallets that sign trades by default. The emergency
 * <ManualSwapPanel /> is what lets you sign from THIS wallet in a
 * kill-switch event.
 */
import { useEffect, useState } from "react";
import { useTonWallet } from "@tonconnect/ui-react";
import { getAccountBalance, getAccountJettons, type JettonHolding } from "@/lib/tonapi";
import { Button } from "@/components/ui/Button";
import { formatTon, truncateAddress } from "@/lib/format";

export function UserPortfolio() {
  const wallet = useTonWallet();
  const [balance, setBalance] = useState<number | null>(null);
  const [jettons, setJettons] = useState<JettonHolding[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const address = wallet?.account?.address ?? null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!address) {
        setBalance(null);
        setJettons([]);
        return;
      }
      setLoading(true);
      setErr(null);
      try {
        const [bal, jets] = await Promise.all([
          getAccountBalance(address),
          getAccountJettons(address, 8),
        ]);
        if (cancelled) return;
        setBalance(bal);
        setJettons(jets);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!address) {
    return (
      <section
        aria-label="Your connected wallet"
        className="rounded-2xl border border-border bg-panel p-5"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-fg-muted tracking-wide">
              Your wallet
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              Connect a wallet to see your TON balance and jettons here. The
              agent&apos;s three tier wallets trade autonomously — yours only
              appears when you explicitly sign a manual trade.
            </p>
          </div>
          <Button
            kind="ton"
            onClick={() => {
              // The TonConnect button lives in the global header; tapping
              // here scrolls to it for discoverability.
              const header = document.querySelector(
                '[data-ton-connect-button]',
              );
              header?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            aria-label="Connect wallet (visible in header)"
          >
            Connect wallet
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Your connected wallet"
      className="overflow-hidden rounded-2xl border border-border bg-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg-elev px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-fg-muted">
            Your wallet
          </h2>
          <p
            className="mono mt-0.5 text-[11px] text-fg-dim"
            title={address}
          >
            {truncateAddress(address, 8, 6)}
          </p>
        </div>
        <div className="text-right">
          <dt className="text-[11px] uppercase tracking-wide text-fg-dim">
            Balance
          </dt>
          <dd className="mono text-lg font-semibold text-fg">
            {loading
              ? "…"
              : balance !== null
                ? `${formatTon(balance, 3)} TON`
                : "—"}
          </dd>
        </div>
      </header>

      {err ? (
        <p className="px-5 py-3 text-xs text-red" role="alert">
          {err}
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {loading ? (
          <li className="px-5 py-4 text-sm text-fg-muted">Loading…</li>
        ) : jettons.length === 0 ? (
          <li className="px-5 py-4 text-sm text-fg-muted">
            No jettons on this wallet.
          </li>
        ) : (
          jettons.map((j) => (
            <li
              key={j.jetton.address}
              className="flex items-center justify-between gap-2 px-5 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-fg">
                  {j.jetton.symbol || j.jetton.name || "Unknown jetton"}
                </p>
                <p
                  className="mono truncate text-[11px] text-fg-dim"
                  title={j.jetton.address}
                >
                  {truncateAddress(j.jetton.address, 6, 4)}
                </p>
              </div>
              <div className="mono text-sm font-semibold text-fg">
                {formatBalance(j.balance, j.jetton.decimals)}
              </div>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
function formatBalance(raw: string, decimals: number): string {
  try {
    const big = BigInt(raw);
    const divisor = 10n ** BigInt(decimals);
    const whole = big / divisor;
    const frac = big % divisor;
    const fracStr = (Number(frac) / Number(divisor)).toFixed(2);
    return `${whole.toString()}${fracStr.replace(/^0\./, ".")}`;
  } catch {
    return "—";
  }
}
