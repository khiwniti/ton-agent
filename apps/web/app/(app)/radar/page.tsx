import { createAdminClient } from "@/lib/supabase/admin";
import type { RadarEventRow } from "@/lib/types";
import { RadarStream } from "./RadarStream";

export const metadata = { title: "Radar · TON Agent" };
export const dynamic = "force-dynamic";

export default async function RadarPage() {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("radar_events")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(100);

  const initial = (data as RadarEventRow[] | null) ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Radar</h1>
        <p className="text-sm text-fg-muted">
          Live stream of jettons the agent evaluates. New hits append at the
          top.
        </p>
      </div>
      <RadarStream initial={initial} />
    </div>
  );
}
