/**
 * PositionsTable — displays recent trade positions with confidence score badges.
 *
 * Renders a scrollable table showing:
 *   • confidence score (color-coded badge)
 *   • wallet tier
 *   • token symbol / jetton master
 *   • entry price (TON)
 *   • cost basis (TON)
 *   • PnL %
 *   • status (OPEN / CLOSED / TP1_HIT / STOPPED)
 *   • created time
 */
import { ConfidenceBadge } from "@/components/ui/ConfidenceBadge";
import { formatPct, formatTon, formatTime, truncateAddress } from "@/lib/format";
import { TIER_LABEL, type WalletTier } from "@/lib/types";
import type { PositionView } from "@/lib/data";

const TIER_TEXT: Record<WalletTier, string> = {
  low: "text-teal",
  mid: "text-amber",
  high: "text-red",
};

const STATUS_BADGE: Record<string, { label: string; tone: string }> = {
  OPEN: { label: "open", tone: "bg-green/15 text-green border-green/30" },
  TP1_HIT: { label: "tp1 hit", tone: "bg-amber/15 text-amber border-amber/30" },
  CLOSED: { label: "closed", tone: "bg-fg-dim/10 text-fg-dim border-border-strong" },
  STOPPED: { label: "stopped", tone: "bg-red/15 text-red border-red/30" },
};

export function PositionsTable({ positions }: { positions: PositionView[] }) {
  if (positions.length === 0) return null;

  return (
    <section aria-label="Recent positions">
      <h2 className="mb-3 text-sm font-semibold text-fg-muted">
        Positions
      </h2>
      <div className="overflow-x-auto rounded-2xl border border-border bg-panel">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-fg-dim">
              <th className="px-4 py-3 font-medium">Confidence</th>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">Token</th>
              <th className="px-4 py-3 font-medium text-right">Entry</th>
              <th className="px-4 py-3 font-medium text-right">Cost</th>
              <th className="px-4 py-3 font-medium text-right">PnL</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {positions.map((p) => (
              <tr
                key={p.id}
                className="transition-colors hover:bg-bg-elev"
              >
                {/* Confidence badge */}
                <td className="px-4 py-3">
                  <ConfidenceBadge score={p.confidenceScore} />
                </td>

                {/* Tier */}
                <td className="px-4 py-3">
                  <span className={`mono text-xs font-semibold ${TIER_TEXT[p.walletTier]}`}>
                    {TIER_LABEL[p.walletTier]}
                  </span>
                </td>

                {/* Token */}
                <td className="px-4 py-3">
                  <div className="flex flex-col">
                    <span className="font-medium text-fg">
                      {p.symbol || "—"}
                    </span>
                    <span
                      className="mono text-[11px] text-fg-dim"
                      title={p.jettonMaster}
                    >
                      {truncateAddress(p.jettonMaster, 6, 4)}
                    </span>
                  </div>
                </td>

                {/* Entry price */}
                <td className="px-4 py-3 text-right">
                  <span className="mono text-xs text-fg-muted">
                    {formatTon(p.entryPriceTon, 4)} TON
                  </span>
                </td>

                {/* Cost basis */}
                <td className="px-4 py-3 text-right">
                  <span className="mono text-xs text-fg-muted">
                    {formatTon(p.costBasisTon, 3)} TON
                  </span>
                </td>

                {/* PnL */}
                <td className="px-4 py-3 text-right">
                  {p.pnlPct != null ? (
                    <span
                      className={`mono text-xs font-semibold ${
                        p.pnlPct >= 0 ? "text-green" : "text-red"
                      }`}
                    >
                      {formatPct(p.pnlPct)}
                    </span>
                  ) : (
                    <span className="mono text-xs text-fg-dim">—</span>
                  )}
                </td>

                {/* Status */}
                <td className="px-4 py-3">
                  {(() => {
                    const s = STATUS_BADGE[p.status] ?? {
                      label: p.status.toLowerCase(),
                      tone: "bg-fg-dim/10 text-fg-dim border-border-strong",
                    };
                    return (
                      <span
                        className={`inline-block rounded-md border px-1.5 py-0.5 text-[11px] font-medium mono ${s.tone}`}
                      >
                        {s.label}
                      </span>
                    );
                  })()}
                </td>

                {/* Time */}
                <td className="px-4 py-3 text-right">
                  <span className="mono text-[11px] text-fg-dim">
                    {formatTime(p.createdAt)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-fg-dim text-right">
        {positions.length} position{positions.length === 1 ? "" : "s"} · newest first
      </p>
    </section>
  );
}
