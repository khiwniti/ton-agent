import { Badge } from "./Badge";
import type { Action } from "@/lib/types";

const TONE: Record<Action, "green" | "red" | "amber" | "neutral"> = {
  BUY: "green",
  SELL: "red",
  HOLD: "amber",
  SKIP: "neutral",
};

export function ActionBadge({ action }: { action: Action }) {
  return <Badge tone={TONE[action] ?? "neutral"}>{action}</Badge>;
}
