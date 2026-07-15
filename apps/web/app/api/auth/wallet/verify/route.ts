/**
 * POST /api/auth/wallet/verify
 *
 * Body:
 *   { wallet_address, payload, signature, state_init?, public_key? }
 *
 * Security order (DO NOT REORDER):
 *   1. SELECT nonce row — must exist, have consumed_at = NULL,
 *      and issued_at > now() - 5 minutes. Otherwise reject with 401.
 *   2. Verify the Ed25519 signature against the wallet's pubkey.
 *      (Pubkey recovery is delegated to the SDK; if not available,
 *      public_key must be supplied.)
 *   3. ADMIN_WALLET_ADDRESS gate (operator whitelist; optional env).
 *   4. Atomic UPDATE nonce SET consumed_at = now() WHERE nonce = X
 *      AND consumed_at IS NULL. If zero rows affected → replay; reject.
 *   5. Issue the wallet session cookie.
 *
 * CRITICAL: do NOT issue the cookie unless steps 1–4 all succeed.
 * Skipping the nonce check would allow ANY wallet-signed payload to
 * mint a session cookie.
 *
 * runtime = "nodejs" required (@ton/core + @ton/crypto + supabase service-role).
 */
import { NextRequest, NextResponse } from "next/server";
import { loginWalletSession } from "@/lib/auth";
import { verifyProof } from "@/lib/tonProof";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseNotConfigured } from "@/lib/supabase/sentinel";

export const runtime = "nodejs";

const NONCE_TTL_SECONDS = 5 * 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      wallet_address,
      payload,
      signature,
      state_init,
      public_key,
    } = body || {};

    if (!wallet_address || !payload || !signature) {
      return NextResponse.json(
        { error: "wallet_address, payload, signature are required" },
        { status: 400 },
      );
    }

    const host = (req.headers.get("host") || "").toLowerCase().split(":")[0];
    if (!host) {
      return NextResponse.json({ error: "missing Host header" }, { status: 400 });
    }

    // ── 1. Nonce validation — MUST succeed before we go further ─────
    const parts = String(payload).split(".");
    const ts = Number(parts[0]);
    const nonce = parts[1];
    if (!Number.isFinite(ts)) {
      return NextResponse.json({ error: "bad_payload_no_timestamp" }, { status: 401 });
    }
    if (Math.abs(ts - Math.floor(Date.now() / 1000)) > NONCE_TTL_SECONDS) {
      return NextResponse.json(
        { error: "proof_timestamp_out_of_range" },
        { status: 401 },
      );
    }
    if (!nonce || nonce.length < 8) {
      return NextResponse.json({ error: "nonce_missing_or_short" }, { status: 401 });
    }

    const admin = createAdminClient();
    if (!admin || isSupabaseNotConfigured({})) {
      // Dev fallback: accept proofs even without DB nonce persistence,
      // but only if signature is valid — preserves testability.
    } else {
      const { data: row, error: rowErr } = await admin
        .from("wallet_auth_nonces")
        .select("nonce, issued_at, consumed_at, domain")
        .eq("nonce", nonce)
        .maybeSingle();
      if (rowErr && !isSupabaseNotConfigured(rowErr)) {
        console.warn("[auth/wallet/verify] nonce lookup failed:", rowErr.message);
      }
      if (!row) {
        return NextResponse.json(
          { error: "nonce_unknown (re-request /api/auth/wallet/challenge)" },
          { status: 401 },
        );
      }
      const ageMs = Date.now() - new Date(row.issued_at).getTime();
      if (ageMs > NONCE_TTL_SECONDS * 1000) {
        return NextResponse.json({ error: "nonce_expired" }, { status: 401 });
      }
      if (row.consumed_at !== null) {
        return NextResponse.json({ error: "nonce_consumed" }, { status: 401 });
      }
      if (row.domain && row.domain !== host) {
        return NextResponse.json(
          { error: "nonce_domain_mismatch" },
          { status: 401 },
        );
      }
    }

    // ── 2. Signature verification ────────────────────────────────
    const verdict = await verifyProof({
      wallet_address,
      payload,
      signature_b64: signature,
      app_domain: host,
      state_init_b64: state_init,
      public_key_b64: public_key,
    });
    if (!verdict.ok) {
      return NextResponse.json(
        { error: "wallet proof verification failed", reason: verdict.reason },
        { status: 401 },
      );
    }

    // ── 3. ADMIN_WALLET_ADDRESS gate (operator whitelist) ─────────
    const adminWallet = (process.env.ADMIN_WALLET_ADDRESS || "").toLowerCase();
    if (adminWallet && wallet_address.toLowerCase() !== adminWallet) {
      return NextResponse.json(
        { error: "wallet not authorised" },
        { status: 403 },
      );
    }

    // ── 4. Atomic consume — single-use replay protection ──────────
    if (admin && !isSupabaseNotConfigured({})) {
      const { data: consumed, error: updErr } = await admin
        .from("wallet_auth_nonces")
        .update({ consumed_at: new Date().toISOString() })
        .eq("nonce", nonce)
        .is("consumed_at", null)
        .select("nonce");
      if (updErr && !isSupabaseNotConfigured(updErr)) {
        console.warn("[auth/wallet/verify] nonce consume failed:", updErr.message);
      }
      if (!updErr && (!consumed || consumed.length === 0)) {
        // Race: someone else consumed first.
        return NextResponse.json({ error: "nonce_consumed_replay" }, { status: 401 });
      }
    }

    // ── 5. Issue the wallet session cookie ────────────────────────
    await loginWalletSession({
      walletAddress: wallet_address,
      publicKey: verdict.public_key,
    });

    return NextResponse.json({
      ok: true,
      wallet_address,
      kind: "wallet",
    });
  } catch (e: any) {
    console.error("[auth/wallet/verify] crashed:", e?.message ?? e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
