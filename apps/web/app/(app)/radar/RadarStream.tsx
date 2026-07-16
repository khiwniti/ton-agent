"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RadarEventRow, WalletTier } from "@/lib/types";
import { TIER_LABEL } from "@/lib/types";
import { ActionBadge } from "@/components/ui/ActionBadge";
import { Badge, CheckBadge } from "@/components/ui/Badge";
import { ConfidenceBadge } from "@/components/ui/ConfidenceBadge";
import { formatTime, truncateAddress } from "@/lib/format";

const TIER_TONE: Record<WalletTier, "teal" | "amber" | "red"> = {
  low: "teal",
  mid: "amber",
  high: "red",
};

export function RadarStream({ initial }: { initial: RadarEventRow[] }) {
  const [rows, setRows] = useState<RadarEventRow[]>(initial);
  const [live, setLive] = useState(false);
  const seen = useRef(new Set(initial.map((r) => r.id)));

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("radar_events_stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "radar_events" },
        (payload: any) => {
          const row = payload.new as RadarEventRow;
          if (seen.current.has(row.id)) return;
          seen.current.add(row.id);
          setRows((prev) => [row, ...prev].slice(0, 200));
        },
      )
      .subscribe((status: any) => {
        setLive(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-sm text-fg-muted">
          {rows.length} event{rows.length === 1 ? "" : "s"}
        </span>
        <span className="flex items-center gap-2 text-xs mono">
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full ${live ? "bg-green" : "bg-fg-dim"}`}
          />
          <span className={live ? "text-green" : "text-fg-dim"}>
            {live ? "live" : "connecting…"}
          </span>
        </span>
      </div>

      <div className="scroll-thin max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Live radar events</caption>
          <thead className="sticky top-0 bg-bg-elev text-left text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Time</th>
              <th scope="col" className="px-4 py-2 font-medium">Symbol</th>
              <th scope="col" className="px-4 py-2 font-medium">Jetton</th>
              <th scope="col" className="px-4 py-2 font-medium">Safety</th>
              <th scope="col" className="px-4 py-2 font-medium">Action</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Conf.</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-fg-dim">
                  No radar events yet. Waiting for the agent…
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border/60 hover:bg-bg-elev/50"
                >
                  <td className="whitespace-nowrap px-4 py-2 text-fg-muted mono">
                    {formatTime(r.detected_at)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.symbol ?? "—"}</span>
                      {r.wallet_tier ? (
                        <Badge tone={TIER_TONE[r.wallet_tier]}>
                          {TIER_LABEL[r.wallet_tier]}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td
                    className="px-4 py-2 text-fg-muted mono"
                    title={r.jetton_master}
                  >
                    {truncateAddress(r.jetton_master)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      <CheckBadge ok={r.renounced} label="renounced" />
                      <CheckBadge ok={r.lp_locked} label="LP" />
                      <CheckBadge ok={r.honeypot_safe} label="safe" />
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <ActionBadge action={r.action} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <ConfidenceBadge score={Math.round(r.confidence)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
