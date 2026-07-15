import {
  TIER_LABEL,
  type TierStatus,
  type WalletTier,
} from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { PnlSparkline } from "@/components/PnlSparkline";
import { formatPnl, formatTon, truncateAddress } from "@/lib/format";

const TIER_RING: Record<WalletTier, string> = {
  low: "before:bg-teal",
  mid: "before:bg-amber",
  high: "before:bg-red",
};

const TIER_TEXT: Record<WalletTier, string> = {
  low: "text-teal",
  mid: "text-amber",
  high: "text-red",
};

function StatusBadge({ status }: { status: TierStatus }) {
  switch (status) {
    case "active":
      return <Badge tone="green">active</Badge>;
    case "disabled":
      return <Badge tone="neutral">disabled</Badge>;
    case "circuit-broken":
      return <Badge tone="red">circuit-broken</Badge>;
  }
}

export interface WalletCardData {
  tier: WalletTier;
  address: string;
  balanceTon: number;
  openPositions: number;
  totalPnlTon: number;
  status: TierStatus;
  pnlHistory: number[];
}

export function WalletCard({ data }: { data: WalletCardData }) {
  const positive = data.totalPnlTon >= 0;

  return (
    <article
      aria-label={`${TIER_LABEL[data.tier]} tier wallet`}
      className={`relative overflow-hidden rounded-2xl border border-border bg-panel p-5 before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:content-[''] ${TIER_RING[data.tier]}`}
    >
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className={`text-sm font-semibold tracking-wide ${TIER_TEXT[data.tier]}`}>
            {TIER_LABEL[data.tier]}
          </h2>
          <span className="text-xs text-fg-dim">tier</span>
        </div>
        <StatusBadge status={data.status} />
      </header>

      <p className="mt-1 text-xs text-fg-dim mono" title={data.address || undefined}>
        {data.address ? truncateAddress(data.address, 8, 6) : "no wallet"}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <dt className="text-xs text-fg-muted">Balance</dt>
          <dd className="mono text-xl font-semibold text-fg">
            {formatTon(data.balanceTon)}{" "}
            <span className="text-xs text-fg-dim">TON</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Open positions</dt>
          <dd className="mono text-xl font-semibold text-fg">
            {data.openPositions}
          </dd>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-fg-muted">Total PnL</span>
          <span
            className={`mono text-lg font-semibold ${positive ? "text-green" : "text-red"}`}
          >
            {formatPnl(data.totalPnlTon)}{" "}
            <span className="text-xs text-fg-dim">TON</span>
          </span>
        </div>
        <div className="mt-2">
          <PnlSparkline data={data.pnlHistory} positive={positive} />
        </div>
      </div>
    </article>
  );
}
