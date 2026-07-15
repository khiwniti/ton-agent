import type { AgentMessageRow } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { formatTime } from "@/lib/format";

type Role = AgentMessageRow["role"];

const ROLE_STYLE: Record<
  Role,
  { wrap: string; label: string; tone: "teal" | "amber" | "red" | "neutral" }
> = {
  user: {
    wrap: "border-teal/30 bg-teal/[0.06]",
    label: "user",
    tone: "teal",
  },
  assistant: {
    wrap: "border-border-strong bg-bg-elev",
    label: "assistant",
    tone: "neutral",
  },
  tool: {
    wrap: "border-amber/30 bg-amber/[0.06]",
    label: "tool",
    tone: "amber",
  },
  system: {
    wrap: "border-border bg-panel/60",
    label: "system",
    tone: "neutral",
  },
};

function prettyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function MessageBubble({ message }: { message: AgentMessageRow }) {
  const style = ROLE_STYLE[message.role] ?? ROLE_STYLE.system;
  const args = prettyJson(message.tool_args);
  const result = prettyJson(message.tool_result);

  return (
    <div className={`rounded-xl border p-3 ${style.wrap}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <Badge tone={style.tone}>{style.label}</Badge>
        {message.tool_name ? (
          <span className="text-xs text-fg-muted mono">
            {message.tool_name}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-fg-dim mono">
          {formatTime(message.at)}
        </span>
      </div>

      {message.content ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">
          {message.content}
        </p>
      ) : null}

      {message.role === "tool" && (args || result) ? (
        <div className="mt-2 space-y-2">
          {args ? (
            <details className="group">
              <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg">
                args
              </summary>
              <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded-lg bg-bg p-2 text-[11px] text-fg-muted mono">
                {args}
              </pre>
            </details>
          ) : null}
          {result ? (
            <details className="group">
              <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg">
                result
              </summary>
              <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded-lg bg-bg p-2 text-[11px] text-fg-muted mono">
                {result}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
