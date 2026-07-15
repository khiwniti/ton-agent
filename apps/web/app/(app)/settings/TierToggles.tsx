"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  TIER_LABEL,
  type TierStatus,
  type WalletTier,
} from "@/lib/types";

const TIER_TEXT: Record<WalletTier, string> = {
  low: "text-teal",
  mid: "text-amber",
  high: "text-red",
};

interface TierState {
  tier: WalletTier;
  status: TierStatus;
}

export function TierToggles({ initial }: { initial: TierState[] }) {
  const router = useRouter();
  const [state, setState] = useState<TierState[]>(initial);
  const [busy, setBusy] = useState<WalletTier | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(tier: WalletTier, enable: boolean) {
    setBusy(tier);
    setError(null);
    const nextStatus: TierStatus = enable ? "active" : "disabled";

    const res = await fetch("/api/wallets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, status: nextStatus }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(`${TIER_LABEL[tier]}: ${body.error ?? "Unknown error"}`);
    } else {
      setState((prev) =>
        prev.map((t) => (t.tier === tier ? { ...t, status: nextStatus } : t)),
      );
      router.refresh();
    }
    setBusy(null);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-panel">
      {error ? (
        <p role="alert" className="border-b border-red/30 bg-red/10 px-4 py-2 text-xs text-red">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {state.map(({ tier, status }) => {
          const enabled = status === "active";
          const broken = status === "circuit-broken";
          return (
            <li
              key={tier}
              className="flex items-center justify-between px-4 py-3"
            >
              <div>
                <span className={`font-semibold ${TIER_TEXT[tier]}`}>
                  {TIER_LABEL[tier]}
                </span>
                <span className="ml-2 text-xs text-fg-dim mono">{status}</span>
              </div>

              {broken ? (
                <span className="text-xs text-red">
                  circuit-broken — reset from agent
                </span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${TIER_LABEL[tier]} tier ${enabled ? "enabled" : "disabled"}`}
                  disabled={busy === tier}
                  onClick={() => toggle(tier, !enabled)}
                  className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${
                    enabled ? "bg-green" : "bg-border-strong"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      enabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
