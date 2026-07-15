"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

/**
 * Tiny PnL sparkline for a wallet card. Colour follows the trend
 * (green up / red down). Purely decorative — hidden from screen readers.
 *
 * Empty state: render a dashed zero-baseline on the full width so the card
 * doesn't read as "blank / placeholder" when there are no closed positions.
 */
export function PnlSparkline({
  data,
  positive,
}: {
  data: number[];
  positive: boolean;
}) {
  if (!data || data.length < 2) {
    return (
      <div className="h-10 w-full" aria-hidden>
        <svg
          viewBox="0 0 200 40"
          preserveAspectRatio="none"
          className="block h-full w-full text-fg-dim"
        >
          <line
            x1="0"
            y1="20"
            x2="200"
            y2="20"
            stroke="currentColor"
            strokeDasharray="3 4"
            strokeWidth="1"
            opacity="0.5"
          />
        </svg>
      </div>
    );
  }

  const chartData = data.map((v, i) => ({ i, v }));
  const stroke = positive ? "var(--color-green)" : "var(--color-red)";

  return (
    <div className="h-10 w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 2, bottom: 2 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
