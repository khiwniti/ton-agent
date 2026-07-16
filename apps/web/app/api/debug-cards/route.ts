import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/sentinel";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = isSupabaseAdminConfigured();
  const info: Record<string, any> = {
    configured,
    env: {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL ? "set" : "missing",
      key: process.env.SUPABASE_SERVICE_ROLE_KEY
        ? `set (${process.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 10)}...)`
        : "missing",
    },
  };

  if (configured) {
    try {
      const supabase = createAdminClient();
      const { data, error } = await supabase.from("agent_status").select("*");
      info.agentStatus = { data, error };
    } catch (e: any) {
      info.error = e.message;
    }
  } else {
    info.reason = "Supabase admin not configured";
  }

  return NextResponse.json(info);
}
