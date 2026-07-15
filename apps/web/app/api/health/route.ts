import { NextResponse } from "next/server";
import {
  isSupabaseAdminConfigured,
  isSupabaseNotConfigured,
} from "@/lib/supabase/sentinel";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/health
 *
 * Lightweight liveness + readiness endpoint for Vercel Monitoring, uptime
 * checks, and operator dashboards. Returns:
 *   200 { status: "ok" | "degraded", checks: {...} }
 *
 * Status semantics:
 *   • `ok`       — service-role Supabase reachable, env looks correct.
 *   • `degraded` — env present but DB unreachable, or admin not configured.
 *
 * Always returns 200 (the process itself is up). The `status` field is the
 * truth. We deliberately do NOT authenticate this endpoint — it's safe to
 * expose, no secrets leak.
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; note?: string }> = {
    env: {
      ok: isSupabaseAdminConfigured(),
      note: isSupabaseAdminConfigured()
        ? "SUPABASE env present"
        : "NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY missing",
    },
    db: { ok: false },
  };

  if (isSupabaseAdminConfigured()) {
    const supabase = createAdminClient();
    const probe = await supabase
      .from("kill_switch")
      .select("id", { count: "exact", head: true });
    if (probe.error) {
      if (isSupabaseNotConfigured(probe.error)) {
        checks.env = { ok: false, note: "unconfigured" };
      } else {
        checks.db = { ok: false, note: probe.error.message };
      }
    } else {
      checks.db = { ok: true };
    }
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      service: "ton-agent-web",
      at: Date.now(),
      checks,
    },
    { status: 200 },
  );
}
