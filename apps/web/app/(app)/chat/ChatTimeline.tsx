"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AgentMessageRow } from "@/lib/types";
import { MessageBubble } from "@/components/MessageBubble";
import { formatDateTime } from "@/lib/format";

interface Thread {
  threadId: string;
  messages: AgentMessageRow[];
  lastAt: number;
}

function groupByThread(messages: AgentMessageRow[]): Thread[] {
  const map = new Map<string, AgentMessageRow[]>();
  for (const m of messages) {
    const list = map.get(m.thread_id) ?? [];
    list.push(m);
    map.set(m.thread_id, list);
  }
  const threads: Thread[] = [];
  for (const [threadId, msgs] of map) {
    const sorted = [...msgs].sort((a, b) => a.at - b.at);
    threads.push({
      threadId,
      messages: sorted,
      lastAt: sorted.length ? sorted[sorted.length - 1].at : 0,
    });
  }
  // Most recently active thread first.
  return threads.sort((a, b) => b.lastAt - a.lastAt);
}

export function ChatTimeline({ initial }: { initial: AgentMessageRow[] }) {
  const [messages, setMessages] = useState<AgentMessageRow[]>(initial);
  const [live, setLive] = useState(false);
  const seen = useRef(new Set(initial.map((m) => m.id)));

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("agent_messages_stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_messages" },
        (payload: any) => {
          const row = payload.new as AgentMessageRow;
          if (seen.current.has(row.id)) return;
          seen.current.add(row.id);
          setMessages((prev) => [...prev, row]);
        },
      )
      .subscribe((status: any) => setLive(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const threads = useMemo(() => groupByThread(messages), [messages]);

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-xs mono">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${live ? "bg-green" : "bg-fg-dim"}`}
        />
        <span className={live ? "text-green" : "text-fg-dim"}>
          {live ? "live" : "connecting…"}
        </span>
        <span className="text-fg-dim">· {threads.length} thread(s)</span>
      </div>

      {threads.length === 0 ? (
        <div className="rounded-2xl border border-border bg-panel px-4 py-12 text-center text-fg-dim">
          No messages yet. The agent&apos;s reasoning will stream here.
        </div>
      ) : (
        <div className="space-y-6">
          {threads.map((t) => (
            <section
              key={t.threadId}
              aria-label={`Thread ${t.threadId}`}
              className="rounded-2xl border border-border bg-panel"
            >
              <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-medium text-fg-muted mono">
                  thread · {t.threadId}
                </h2>
                <span className="text-xs text-fg-dim mono">
                  {formatDateTime(t.lastAt)}
                </span>
              </header>
              <ol className="scroll-thin max-h-[60vh] space-y-3 overflow-auto p-4">
                {t.messages.map((m) => (
                  <li key={m.id}>
                    <MessageBubble message={m} />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
