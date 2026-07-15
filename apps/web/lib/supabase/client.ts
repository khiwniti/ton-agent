"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

/**
 * Browser Supabase client. Uses the public anon key and reads/writes the
 * auth session from cookies (via @supabase/ssr). Safe to import in client
 * components; used for Realtime subscriptions on /radar and /chat.
 *
 * If Supabase isn't configured (env vars missing or still the .env.example
 * placeholders), we return a sentinel object that returns a clear
 * `{ error: { message: ... } }` response from each method instead of
 * letting `fetch()` throw a raw `TypeError: Failed to fetch`. The login
 * form already destructures `{ error }` so the user sees a UI message
 * ("Supabase is not configured — see .env.local") rather than an
 * opaque network error.
 */
const PLACEHOLDER_VALUES = new Set([
  "your-project",
  "your-anon-key",
  "your-service-role-key",
  "change-me-to-32-bytes-of-randomness",
  "change-me-to-a-long-random-string",
]);

function isConfigured(): boolean {
  if (!publicEnv.supabaseUrl || !publicEnv.supabaseAnonKey) return false;
  // Catch the placeholder values shipped in .env.example — these would
  // not match any real Supabase project and DNS would NXDOMAIN anyway.
  return !PLACEHOLDER_VALUES.has(publicEnv.supabaseUrl) &&
         !PLACEHOLDER_VALUES.has(publicEnv.supabaseAnonKey);
}

function notConfiguredMessage(): string {
  return "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in apps/web/.env.local, then restart `next dev`. See README.md.";
}

function notConfiguredClient(): any {
  // A minimal stub that mirrors the methods callers actually use
  // (signInWithOtp, etc.). Returning `{ error: { message } }` lets the
  // LoginForm's existing destructuring pattern work without changes.
  const stubError = { message: notConfiguredMessage() };
  return {
    __notConfigured: true,
    auth: {
      signInWithOtp: async () => ({ data: null, error: stubError }),
      signInWithPassword: async () => ({ data: null, error: stubError }),
      signUp: async () => ({ data: null, error: stubError }),
      signOut: async () => ({ error: stubError }),
      getUser: async () => ({ data: { user: null }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: (_cb: any) => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
  };
}

export function createClient() {
  if (!isConfigured()) {
    return notConfiguredClient();
  }
  return createBrowserClient(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
  );
}

