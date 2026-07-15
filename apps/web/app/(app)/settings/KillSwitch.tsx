"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateTime } from "@/lib/format";

export function KillSwitch({
  initialEngaged,
  at,
  by,
}: {
  initialEngaged: boolean;
  at: number;
  by: string | null;
}) {
  const router = useRouter();
  const [engaged, setEngaged] = useState(initialEngaged);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ at: number; by: string | null }>({ at, by });
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (busy) return;
    if (next && !confirm("Engage kill switch? All tiers will stop trading."))
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engaged: next }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as {
        engaged: boolean;
        at: number;
        by: string | null;
      };
      setEngaged(data.engaged);
      setMeta({ at: data.at, by: data.by });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update kill switch");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`rounded-2xl border p-5 ${
        engaged ? "border-red/50 bg-red/[0.06]" : "border-border bg-panel"
      }`}
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <div className="text-center sm:text-left">
          <p className="text-sm text-fg-muted">
            Status:{" "}
            <span
              className={`font-semibold ${engaged ? "text-red" : "text-green"}`}
            >
              {engaged ? "ENGAGED — trading halted" : "clear — trading allowed"}
            </span>
          </p>
          {meta.at ? (
            <p className="mt-1 text-xs text-fg-dim mono">
              last change {formatDateTime(meta.at)}
              {meta.by ? ` · by ${meta.by}` : ""}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-1 text-xs text-red">
              {error}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => toggle(!engaged)}
          disabled={busy}
          aria-pressed={engaged}
          className={`flex h-28 w-28 shrink-0 flex-col items-center justify-center rounded-full border-4 font-bold uppercase tracking-wide transition-transform disabled:opacity-60 ${
            engaged
              ? "border-fg-muted bg-panel text-fg-muted hover:scale-105"
              : "border-red/60 bg-red/90 text-white shadow-[0_0_30px_rgba(239,68,68,0.5)] hover:scale-105"
          }`}
        >
          {busy ? "…" : engaged ? "Resume" : "STOP"}
        </button>
      </div>
    </div>
  );
}
