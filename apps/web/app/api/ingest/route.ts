import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseNotConfigured } from "@/lib/supabase/sentinel";
import { mapIngest } from "@/lib/ingest";
import type { IngestBody } from "@/lib/types";

const NOT_CONFIGURED_MSG =
  "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the web app environment.";

export async function POST(req: NextRequest) {
  const secretHeader = req.headers.get("x-agent-secret");
  const expectedSecret = process.env.AGENT_SHARED_SECRET;

  if (!expectedSecret || secretHeader !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body: IngestBody = await req.json();
    if (!body || !body.kind || !body.payload) {
      return NextResponse.json({ error: "Invalid body shape" }, { status: 400 });
    }

    const mapped = mapIngest(body.kind, body.walletTier, body.payload, body.id);
    if (!mapped) {
      return NextResponse.json({ error: `Unknown event kind: ${body.kind}` }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { error } = await supabase.from(mapped.table).upsert(mapped.row);

    if (error) {
      if (isSupabaseNotConfigured(error)) {
        return NextResponse.json({ error: NOT_CONFIGURED_MSG }, { status: 503 });
      }
      console.error("[INGEST] Database upsert failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[INGEST] Webhook handling crashed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
