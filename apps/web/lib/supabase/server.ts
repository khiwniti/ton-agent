import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  isSupabaseAnonConfigured,
  supabaseSentinel,
} from "./sentinel";

/**
 * Server Supabase client (RSC / route handlers). Reads and writes the auth
 * session via Next's cookie store. Use for auth-gated reads that should
 * respect RLS as the signed-in user.
 *
 * Returns a sentinel when the anon env isn't configured so /dashboard data
 * fetching degrades to empty-state UI instead of crashing the page on a
 * fresh deploy. We deliberately do NOT `await cookies()` in the unconfigured
 * branch — needs a request scope and we want a fast no-data path.
 */
export async function createClient() {
  if (!isSupabaseAnonConfigured()) return supabaseSentinel;

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: any) {
          try {
            cookiesToSet.forEach(({ name, value, options }: any) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — safe to ignore when middleware
            // is responsible for refreshing the session cookie.
          }
        },
      },
    },
  );
}
