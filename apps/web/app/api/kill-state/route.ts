/**
 * GET /api/kill-state
 *
 * Unauthenticated read of the kill-switch flag. Public by design — the
 * operator's status is a signal to anyone holding TON that the agent
 * is halted; visibility is a feature, not a leak.
 *
 * Returns:
 *   { engaged: boolean, at: number | null, source: "supabase" | "default" }
 *
 * When Supabase is unconfigured we return `{ engaged: false, at: null,
 * source: "default" }` so the login banner can render "live" optimistically.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseNotConfigured } from "@/lib/supabase/sentinel";
import type { KillSwitchRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const admin = createAdminClient();
    if (!admin || isSupabaseNotConfigured({})) {
      return NextResponse.json({
        engaged: false,
        at: null,
        source: "default",
      });
    }
    const { data, error } = await admin
      .from("kill_switch")
      .select("engaged, at")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      if (isSupabaseNotConfigured(error)) {
        return NextResponse.json({
          engaged: false,
          at: null,
          source: "default",
        });
      }
      console.warn("[kill-state] read failed:", error.message);
      return NextResponse.json({
        engaged: false,
        at: null,
        source: "default",
      });
    }
    const row = (data as Partial<KillSwitchRow> | null) ?? null;
    return NextResponse.json({
      engaged: !!row?.engaged,
      at: typeof row?.at === "number" ? row.at : null,
      source: "supabase",
    });
  } catch {
    return NextResponse.json({
      engaged: false,
      at: null,
      source: "default",
    });
  }
}
