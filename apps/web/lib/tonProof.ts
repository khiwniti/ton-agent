/**
 * Server-side TON Connect ("ton_proof") proof-of-ownership verifier.
 *
 * Two paths, in priority order:
 *   A. Delegate to @tonconnect/sdk's verifier (checkProof / verify /
 *      verifyProof — we feature-detect). When present, this is the
 *      canonical implementation; it handles every wallet version and
 *      recovers pubkey from wallet stateInit consistently.
 *   B. Hand-rolled verifier that we run ourselves. REQUIRES
 *      public_key_b64. We deliberately do NOT parse stateInit to extract
 *      the pubkey here — the v5r1 / v4 / v3 layouts differ and a
 *      fixed-offset probe returns garbage as the "pubkey", causing all
 *      legitimate proofs to fail. Wallets (Tonkeeper, OpenMask,
 *      MyTonWallet) include `account.publicKey` in the connectItems on
 *      a fresh connect, so the client is expected to forward it.
 *
 * Cell layout (per the TON Connect proof v1 spec):
 *
 *     outer cell:
 *       uint32: 0x07  (the "proof-of-ownership" tag)
 *       ref:    inner cell
 *
 *     inner cell:
 *       uint32: timestamp  (unix seconds, parsed from the payload — not Date.now!)
 *       ref:    payload cell (utf-8 of the received payload)
 *       uint8:  domain length
 *       bytes:  utf-8 of app_domain (storeString writes this exact layout)
 *
 * Wallet signs: `ed25519(sha256(outer_cell.boc_hash), secret_key)`.
 * Server reconstructs with the SAME timestamp; computes the hash; verifies.
 *
 * IMPORTANT:
 *   - runtime = "nodejs" required.
 *   - The `app_domain` MUST match the host the BROWSER saw, so a stolen
 *     proof from a phishing site is rejected.
 *   - The `signature` MUST be base64 of the raw 64-byte ed25519 sig.
 */

import "server-only";
import { Cell, beginCell } from "@ton/core";
import * as tonCrypto from "@ton/crypto";

/** Resolve a NaCl detached-verify function regardless of SDK surface. */
function resolveNaclVerify():
  | ((sig: Buffer, msg: Buffer, pk: Buffer) => boolean)
  | null {
  const mod = tonCrypto as any;
  if (typeof mod.verify === "function") return mod.verify.bind(mod);
  const nacl = mod.nacl?.sign?.detached ?? mod.tweetnacl?.sign?.detached;
  if (nacl && typeof nacl.verify === "function") return nacl.verify.bind(nacl);
  return null;
}

export interface VerifyProofInput {
  wallet_address: string;
  /** Original TON Connect payload string (e.g. "1737465600.12345"). */
  payload: string;
  /** Base64 ed25519 signature returned by the wallet for the proof cell. */
  signature_b64: string;
  /** Domain the BROWSER saw (e.g. "ton-agent.vercel.app"). */
  app_domain: string;
  /** The wallet object's `stateInit` base64 string (optional). */
  state_init_b64?: string;
  /**
   * Wallet public key, base64 of raw 32 bytes. REQUIRED for the hand-rolled
   * fallback. REQUIRED for the SDK path. The wallet sends this on fresh keep.
   */
  public_key_b64?: string;
}

export interface VerifyProofOk {
  ok: true;
  public_key: string;
  address: string;
}

export interface VerifyProofErr {
  ok: false;
  reason: string;
}

export type VerifyProofResult = VerifyProofOk | VerifyProofErr;

// ─────────────────────────────────────────────────────────────────────
// Cell builder — exactly matches wallets' wire format.
// ─────────────────────────────────────────────────────────────────────
function buildProofCell(timestamp: number, payload: string, app_domain: string): Cell {
  // inner: uint32(ts) . ref(payload-cell) . bits8(domain_len) . bytes(domain)
  //
  // `@ton/core`'s v0.63.1 Builder does NOT expose `storeString()` (added in
  // later versions), so we emit the same byte layout manually:
  //   `storeUint(len, 8).storeBuffer(bytes)` writes exactly what
  //   storeString would write — (uint8 len, bytes) — and is wire-compatible
  //   with the wallet-side signer regardless of SDK version.
  const inner = beginCell()
    .storeUint(timestamp, 32)
    .storeRef(beginCell().storeBuffer(Buffer.from(payload, "utf8")).endCell())
    .storeUint(app_domain.length, 8)
    .storeBuffer(Buffer.from(app_domain, "utf8"))
    .endCell();
  // outer: uint32(0x07) . ref(inner)
  return beginCell().storeUint(0x07, 32).storeRef(inner).endCell();
}

// ─────────────────────────────────────────────────────────────────────
// Path A — SDK delegation.
// ─────────────────────────────────────────────────────────────────────
async function verifyViaSdk(input: VerifyProofInput): Promise<VerifyProofResult | null> {
  const publicKey = input.public_key_b64;
  if (!publicKey) {
    // Both paths require publicKey — if it's missing, fall through to
    // hand-rolled where we'll return a clear `public_key_unrecoverable`.
    return null;
  }
  let mod: any;
  try {
    mod = await import("@tonconnect/sdk");
  } catch {
    return null;
  }
  const parts = input.payload.split(".");
  const ts = Number(parts[0]);
  const proofArg = {
    timestamp: ts,
    domain: { lengthBytes: input.app_domain.length, value: input.app_domain },
    payload: input.payload,
    signature: input.signature_b64,
  };

  // Try a few common export names. SDK shape varies across patches.
  const tryCandidates: Array<[string, (fn: any) => any]> = [
    [
      "checkProof",
      (fn) => fn({ proof: proofArg, publicKey, address: input.wallet_address }),
    ],
    [
      "verify",
      (fn) => fn({ proof: proofArg, publicKey, address: input.wallet_address }),
    ],
    [
      "verifyProof",
      (fn) => fn(input.wallet_address, proofArg, publicKey),
    ],
  ];

  for (const [name, call] of tryCandidates) {
    const fn = mod[name];
    if (typeof fn !== "function") continue;
    try {
      const verdict = await call(fn);
      // SDK responses vary:
      //   { valid: true | false, error?: string }
      //   { ok:    true | false, reason?: string }
      //   throws on invalid (we catch below)
      // Normalise — only ACCEPT when an explicit TRUE flag is present.
      const ok =
        verdict &&
        ((typeof verdict.valid === "boolean" && verdict.valid) ||
          (typeof verdict.ok === "boolean" && verdict.ok) ||
          (typeof verdict.success === "boolean" && verdict.success));
      if (ok) return { ok: true, public_key: publicKey, address: input.wallet_address };
      const reason =
        (verdict && (verdict.reason ?? verdict.error ?? verdict.message)) ??
        `${name}_verdict_false`;
      return { ok: false, reason };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: msg };
    }
  }

  console.warn(
    "[verifyProof] @tonconnect/sdk loaded but no recognisable verifier export; falling back. exports=",
    Object.keys(mod),
  );
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Path B — hand-rolled. Requires public_key_b64. NO stateInit probing.
// ─────────────────────────────────────────────────────────────────────
function verifyHandRolled(input: VerifyProofInput): VerifyProofResult {
  const publicKey = input.public_key_b64;
  if (!publicKey) {
    return {
      ok: false,
      reason:
        "public_key_unrecoverable (no public_key_b64 supplied — ensure the wallet includes account.publicKey)",
    };
  }

  const pubkeyBuf = Buffer.from(publicKey, "base64");
  if (pubkeyBuf.length !== 32) {
    return { ok: false, reason: "pubkey_bad_length" };
  }

  const parts = input.payload.split(".");
  const ts = Number(parts[0]);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_payload_no_timestamp" };

  const cell = buildProofCell(ts, input.payload, input.app_domain);
  const cellHash = cell.hash();

  const sigBuf = Buffer.from(input.signature_b64, "base64");
  if (sigBuf.length !== 64) {
    return { ok: false, reason: `signature_bad_length_${sigBuf.length}` };
  }

  const naclVerify = resolveNaclVerify();
  if (!naclVerify) {
    return { ok: false, reason: "nacl_verify_unavailable" };
  }
  const ok = naclVerify(sigBuf, cellHash, pubkeyBuf);
  if (!ok) return { ok: false, reason: "signature_invalid" };

  return { ok: true, public_key: publicKey, address: input.wallet_address };
}

// ─────────────────────────────────────────────────────────────────────
// Public entry — try SDK, fall through to hand-rolled on miss.
// ─────────────────────────────────────────────────────────────────────
export async function verifyProof(
  input: VerifyProofInput,
): Promise<VerifyProofResult> {
  const sdkResult = await verifyViaSdk(input);
  if (sdkResult) return sdkResult;
  return verifyHandRolled(input);
}
