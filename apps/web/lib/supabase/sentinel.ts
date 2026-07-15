/**
 * Sentinel for an unconfigured Supabase client.
 *
 * Returned by `createAdminClient()` / `createClient()` when either the
 * project URL or the role key is missing in the runtime environment.
 *
 * Every chainable Supabase call (`.from("x").select("y").eq(...)`) is
 * modelled as a plain JS function call that *returns the sentinel itself*,
 * so chaining works. Awaiting the sentinel calls `.then` which we wire to a
 * single resolved `Promise` returning
 *
 *   { data: null, error: { message: "supabase not configured", code: "NOT_CONFIGURED" } }
 *
 * Existing page and route handlers already destructure `{ data, error }` and
 * fall back with `data ?? []`, so they render empty-state UI / 503 JSON
 * without any per-call-site try/catch.
 *
 * Implementation note: we deliberately avoid relying on a callable-function
 * Proxy target + `apply` trap. Instead, every property access via the `get`
 * trap returns a stable *arrow thunk* (a plain function guaranteed callable
 * in every JS runtime / bundler). This avoids subtle edge cases where
 * certain toolchains or transpiled RSC payloads lose proxy-callability and
 * surface as "supabase.from is not a function".
 */

export const SUPABASE_NOT_CONFIGURED_CODE = "NOT_CONFIGURED" as const;

export const notConfiguredError = Object.freeze({
  message: "supabase not configured",
  code: SUPABASE_NOT_CONFIGURED_CODE,
} as const);

const dummyResult = Object.freeze({
  data: null,
  error: notConfiguredError,
} as const);

// Single resolved promise so `await` is idempotent and identical result.
const resolved = Promise.resolve(dummyResult);

// One thunk reused by EVERY chainable Supabase method: `.from()`, `.select()`,
// `.eq()`, `.order()`, `.limit()`, `.upsert()`, `.update()`, `.rpc()` …
const chainThunk = () => supabaseSentinel;

/**
 * Proxy whose `get` trap returns:
 *   - For `then` / `catch` / `finally`: a Promise method bound to the resolved
 *     sentinel promise, so `await supabaseSentinel` resolves to `{ data, error }`.
 *   - For `Symbol.toStringTag`, `data`, `error`: diagnostic primitives.
 *   - For ANY OTHER property (including `.from`, `.select`, `.auth`, etc.):
 *     a plain arrow function that returns the sentinel. The caller can invoke
 *     the function with any args (Supabase method signatures) without breaking —
 *     chaining then resumes from `supabaseSentinel` again.
 */
export const supabaseSentinel: any = new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === "then") {
      return (onFulfilled?: (v: typeof dummyResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        (resolved as Promise<typeof dummyResult>).then(onFulfilled, onRejected);
    }
    if (prop === "catch") {
      return (onRejected: (e: unknown) => unknown) =>
        (resolved as Promise<typeof dummyResult>).catch(onRejected);
    }
    if (prop === "finally") {
      return (onFinally: () => void) =>
        (resolved as Promise<typeof dummyResult>).finally(onFinally);
    }
    if (prop === Symbol.toStringTag) return "SupabaseSentinel";
    // Mirror diagnostic props in case a caller logs the error object directly.
    if (prop === "data") return null;
    if (prop === "error") return notConfiguredError;
    // ✅ Plain arrow thunk — guaranteed callable, never loses to bundler quirks.
    return chainThunk;
  },
});

export function isSupabaseNotConfigured(
  err: { code?: string } | null | undefined,
): boolean {
  return err?.code === SUPABASE_NOT_CONFIGURED_CODE;
}

/**
 * Cheap presence check — true when both URL + required key are set.
 * Used by /api/health, login/logout responses, and the dashboard banner.
 */
export function isSupabaseAdminConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export function isSupabaseAnonConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
