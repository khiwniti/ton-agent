import type { ReactNode } from "react";

type Tone = "teal" | "amber" | "red" | "green" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  teal: "border-teal/40 bg-teal/10 text-teal",
  amber: "border-amber/40 bg-amber/10 text-amber",
  red: "border-red/40 bg-red/10 text-red",
  green: "border-green/40 bg-green/10 text-green",
  neutral: "border-border-strong bg-panel text-fg-muted",
};

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none mono ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

/** Boolean security badge: green when true, red when false. */
export function CheckBadge({
  ok,
  label,
}: {
  ok: boolean;
  label: string;
}) {
  return (
    <Badge tone={ok ? "green" : "red"} title={`${label}: ${ok ? "yes" : "no"}`}>
      <span aria-hidden>{ok ? "✓" : "✕"}</span>
      <span>{label}</span>
    </Badge>
  );
}
