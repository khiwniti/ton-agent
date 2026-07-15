import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  isSupabaseAdminConfigured,
  supabaseSentinel,
} from "./sentinel";

/**
 * Service-role Supabase client — SERVER ONLY. Bypasses RLS.
 * Used by /api/ingest, /api/kill, /api/wallets, and the dashboard SSR pages.
 *
 * If Supabase isn't configured (env missing or placeholder), returns a
 * sentinel client that resolves every chainable call (`.from()`, `.upsert()`,
 * `.select()`, etc.) to
 *   { data: null, error: { code: "NOT_CONFIGURED", message: ... } }
 * Pages render empty-state UI; API routes can return 503 via
 * `isSupabaseNotConfigured(error)`.
 */
export function createAdminClient() {
  if (!isSupabaseAdminConfigured()) return supabaseSentinel;
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
