import { TIER_LABEL, type WalletTier } from "@/lib/types";

/**
 * Static reference of the risk envelope per tier. These mirror the agent's
 * runtime config (apps/agent). Displayed read-only here; the agent is the
 * source of truth. Adjust to match the agent's actual parameters.
 */
const PARAMS: Record<
  WalletTier,
  {
    maxPositionTon: number;
    maxOpen: number;
    takeProfitPct: number;
    stopLossPct: number;
    minAiScore: number;
  }
> = {
  low: {
    maxPositionTon: 1,
    maxOpen: 2,
    takeProfitPct: 25,
    stopLossPct: 15,
    minAiScore: 80,
  },
  mid: {
    maxPositionTon: 3,
    maxOpen: 3,
    takeProfitPct: 60,
    stopLossPct: 25,
    minAiScore: 65,
  },
  high: {
    maxPositionTon: 5,
    maxOpen: 4,
    takeProfitPct: 150,
    stopLossPct: 40,
    minAiScore: 50,
  },
};

const TIER_TEXT: Record<WalletTier, string> = {
  low: "text-teal",
  mid: "text-amber",
  high: "text-red",
};

const ROWS: { key: keyof (typeof PARAMS)["low"]; label: string; suffix: string }[] =
  [
    { key: "maxPositionTon", label: "Max position", suffix: "TON" },
    { key: "maxOpen", label: "Max open", suffix: "" },
    { key: "takeProfitPct", label: "Take profit", suffix: "%" },
    { key: "stopLossPct", label: "Stop loss", suffix: "%" },
    { key: "minAiScore", label: "Min AI score", suffix: "" },
  ];

export function RiskParams() {
  const tiers = Object.keys(PARAMS) as WalletTier[];
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-panel">
      <table className="w-full text-sm">
        <caption className="sr-only">Risk parameters per tier</caption>
        <thead className="bg-bg-elev text-left text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">
              Parameter
            </th>
            {tiers.map((t) => (
              <th
                key={t}
                scope="col"
                className={`px-4 py-2 text-right font-semibold ${TIER_TEXT[t]}`}
              >
                {TIER_LABEL[t]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key} className="border-t border-border/60">
              <th scope="row" className="px-4 py-2 text-left font-normal text-fg-muted">
                {row.label}
              </th>
              {tiers.map((t) => (
                <td key={t} className="px-4 py-2 text-right mono text-fg">
                  {PARAMS[t][row.key]}
                  {row.suffix ? (
                    <span className="ml-1 text-xs text-fg-dim">{row.suffix}</span>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-4 py-2 text-xs text-fg-dim">
        Read-only. The agent runtime is the source of truth for live values.
      </p>
    </div>
  );
}
