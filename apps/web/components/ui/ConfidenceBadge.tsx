/**
 * ConfidenceBadge — color-coded badge for trade position confidence scores.
 *
 * Score tiers:
 *   80-100  🟢 high confidence   → green
 *   60-79   🟡 medium confidence → amber
 *   40-59   🟠 low confidence    → orange
 *   0-39    🔴 very low          → red
 *   null/—  ⚪ no data           → neutral
 */

interface ConfidenceBadgeProps {
  /** 0-100 score, or null/undefined if not available */
  score?: number | null;
  /** Optional size variant */
  size?: "sm" | "md" | "lg";
}

const SCORE_TIER = [
  { min: 80, label: "high", tone: "green" as const },
  { min: 60, label: "medium", tone: "amber" as const },
  { min: 40, label: "moderate", tone: "amber" as const },
  { min: 0, label: "low", tone: "red" as const },
];

const SIZE_CLASSES: Record<string, string> = {
  sm: "text-[10px] px-1 py-0.5",
  md: "text-xs px-1.5 py-0.5",
  lg: "text-sm px-2 py-1",
};

const TONE_CLASSES: Record<string, string> = {
  green: "border-green/40 bg-green/10 text-green",
  amber: "border-amber/40 bg-amber/10 text-amber",
  red: "border-red/40 bg-red/10 text-red",
  neutral: "border-border-strong bg-bg-elev text-fg-dim",
};

function getTier(score: number | null | undefined): { label: string; tone: string } {
  if (score === null || score === undefined) return { label: "no data", tone: "neutral" };
  for (const t of SCORE_TIER) {
    if (score >= t.min) return { label: t.label, tone: t.tone };
  }
  return { label: "very low", tone: "red" };
}

export function ConfidenceBadge({ score, size = "sm" }: ConfidenceBadgeProps) {
  const { label, tone } = getTier(score);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border font-medium mono ${SIZE_CLASSES[size]} ${TONE_CLASSES[tone]}`}
      title={`Confidence: ${score ?? "N/A"} — ${label}`}
    >
      {/* Dot indicator */}
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          tone === "green"
            ? "bg-green"
            : tone === "amber"
              ? "bg-amber"
              : tone === "orange"
                ? "bg-orange"
                : tone === "red"
                  ? "bg-red"
                  : "bg-fg-dim"
        }`}
      />
      {score != null ? (
        <span>
          <span className="tabular-nums">{score}</span>
          <span className="ml-0.5 opacity-70">{label}</span>
        </span>
      ) : (
        <span className="opacity-70">—</span>
      )}
    </span>
  );
}
