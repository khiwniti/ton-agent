import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentMessageRow } from "@/lib/types";
import { ChatTimeline } from "./ChatTimeline";

export const metadata = { title: "Chat · TON Agent" };
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_messages")
    .select("*")
    .order("at", { ascending: true })
    .limit(500);

  const initial = (data as AgentMessageRow[] | null) ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Agent chat</h1>
        <p className="text-sm text-fg-muted">
          ReAct timeline — the agent&apos;s reasoning, tool calls, and results,
          grouped by thread.
        </p>
      </div>
      <ChatTimeline initial={initial} />
    </div>
  );
}
