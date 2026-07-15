/**
 * POST /api/auth/wallet/challenge
 *
 * The browser calls this BEFORE opening the wallet modal. We:
 *   1. Mint a random nonce (32 base64url chars ≈ 192 bits of entropy).
 *   2. Insert { nonce, app_domain } into wallet_auth_nonces table.
 *   3. Return { payload, app_domain, expires_at }.
 *
 * The browser sets `tonConnectUI.setConnectRequestParameters({ tonProof:
 * { payload } })` so the connected wallet signs our payload as part of the
 * connect handshake. The wallet returns the proof in the connect event, and
 * /verify is called with the actual signature.
 *
 * auth requirements: NONE — this is open (anyone can request a challenge)
 * to avoid leaking auth status to phishing scripts.
 *
 * runtime = "nodejs" required for crypto randomness.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseNotConfigured } from "@/lib/supabase/sentinel";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const admin = createAdminClient();

  // Domain = Host header (sanity-clipped: bare hostname, lowercase).
  const host = (req.headers.get("host") || "").toLowerCase().split(":")[0];
  if (!host) {
    return NextResponse.json({ error: "missing Host header" }, { status: 400 });
  }

  // 12 random bytes → 16 base64url chars (≈96 bits). Plenty for replay
  // protection since row is single-use.
  const nonce = randomBytes(12).toString("base64url");
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5-minute TTL

  // Best-effort persistence. If Supabase is unconfigured, we still allow
  // the challenge so the user can complete a proof-of-ownership sign-in
  // via /login but verification will hit the missing-nonce check. The
  // cookie-less "session" is intended for dev — production MUST configure
  // Supabase first.
  try {
    if (admin && !isSupabaseNotConfigured({})) {
      const { error } = await admin
        .from("wallet_auth_nonces")
        .insert({
          nonce,
          domain: host,
          issued_at: new Date().toISOString(),
          consumed_at: null,
        });
      if (error && !isSupabaseNotConfigured(error)) {
        console.warn("[auth/wallet/challenge] nonce insert failed:", error.message);
      }
    }
  } catch (e) {
    console.warn("[auth/wallet/challenge] supabase path skipped:", e);
  }

  // The TON Connect proof `payload` is <unix-seconds>.<random>. Browsers
  // produce this themselves but we render it server-side to avoid getting
  // clock-skewed on the client.
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}.${nonce}`;

  return NextResponse.json({
    payload,
    app_domain: host,
    expires_at: expiresAt,
  });
}
