import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseNotConfigured } from "@/lib/supabase/sentinel";
import type { WalletTier, TierStatus } from "@/lib/types";

const NOT_CONFIGURED_MSG =
  "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the web app environment.";

export async function PATCH(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { tier, status }: { tier: WalletTier; status: TierStatus } =
      await req.json();

    if (!tier || !status) {
      return NextResponse.json({ error: "Missing tier or status" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { error } = await supabase
      .from("wallets")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("tier", tier);

    if (error) {
      if (isSupabaseNotConfigured(error)) {
        return NextResponse.json({ error: NOT_CONFIGURED_MSG }, { status: 503 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
