import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseNotConfigured } from "@/lib/supabase/sentinel";
import { isAuthenticated } from "@/lib/auth";

const NOT_CONFIGURED_MSG =
  "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the web app environment.";

export async function POST(req: NextRequest) {
  try {
    const authenticated = await isAuthenticated();

    if (!authenticated) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { engaged } = await req.json();
    if (typeof engaged !== "boolean") {
      return NextResponse.json({ error: "engaged must be a boolean" }, { status: 400 });
    }

    const admin = createAdminClient();
    const at = Date.now();
    const by = "admin";

    const { data, error } = await admin
      .from("kill_switch")
      .upsert({
        id: 1,
        engaged,
        at,
        by,
        updated_at: new Date().toISOString(),
      })
      .select("engaged, at, by")
      .single();

    if (error) {
      if (isSupabaseNotConfigured(error)) {
        return NextResponse.json({ error: NOT_CONFIGURED_MSG }, { status: 503 });
      }
      console.error("[KILL_SWITCH] Upsert failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (e: any) {
    console.error("[KILL_SWITCH] Crashed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
