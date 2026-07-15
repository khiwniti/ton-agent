/**
 * Cookie-based session for the TON Agent dashboard.
 *
 * Edge-runtime safe: we use globalThis.crypto (Web Crypto) for HMAC so this
 * module can be imported from middleware.ts (which is always Edge).
 *
 * Session payload shape is one of:
 *   - { kind: "wallet",  walletAddress, publicKey, issuedAt, expiresAt }
 *   - { kind: "password", authorized: true, expiresAt }
 *
 * Both flavours verify the same way: HMAC-SHA256 over the JSON payload,
 * base64url-encoded, appended with ".".
 */
import { cookies } from "next/headers";

const SESSION_COOKIE_NAME = "admin_session";
const SESSION_DURATION_DAYS = 30;

function getSecret(): string {
  return (
    process.env.AGENT_SHARED_SECRET ||
    "fallback-secret-development-only-replace-in-production"
  );
}

function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD || "";
}

/**
 * validatePassword — only accept when ENABLE_PASSWORD_LOGIN is explicitly
 * "true" AND admin password is set. Returns false otherwise.
 */
export function validatePassword(password: string): boolean {
  if (process.env.ENABLE_PASSWORD_LOGIN !== "true") return false;
  const adminPassword = getAdminPassword();
  if (!adminPassword) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "ADMIN_PASSWORD missing with ENABLE_PASSWORD_LOGIN=true. Every login attempt will fail.",
      );
    }
    return false;
  }
  return password === adminPassword;
}

interface WalletSessionPayload {
  kind: "wallet";
  walletAddress: string;
  publicKey: string;
  expiresAt: number;
  issuedAt: number;
}

interface PasswordSessionPayload {
  kind: "password";
  authorized: true;
  expiresAt: number;
}

type SessionPayload = WalletSessionPayload | PasswordSessionPayload;

// ─── HMAC helpers (Edge-safe via Web Crypto) ────────────────────────────
const enc = new TextEncoder();

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlEncode(sig);
}

async function hmacVerify(
  data: string,
  secret: string,
  expectedB64Url: string,
): Promise<boolean> {
  const expected = b64urlDecode(expectedB64Url);
  const calc = await hmacSign(data, secret);
  const calcDecoded = b64urlDecode(calc);
  if (calcDecoded.length !== expected.length) return false;
  // Constant-time byte compare (XOR).
  let diff = 0;
  for (let i = 0; i < calcDecoded.length; i++) {
    diff |= calcDecoded[i] ^ expected[i];
  }
  return diff === 0;
}

// ─── Token mint / verify ────────────────────────────────────────────────
export async function createPasswordSessionToken(): Promise<string> {
  const expiresAt = Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const payload: PasswordSessionPayload = {
    kind: "password",
    authorized: true,
    expiresAt,
  };
  const data = JSON.stringify(payload);
  const sig = await hmacSign(data, getSecret());
  return `${data}.${sig}`;
}

export async function createWalletSessionToken(input: {
  walletAddress: string;
  publicKey: string;
}): Promise<string> {
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const payload: WalletSessionPayload = {
    kind: "wallet",
    walletAddress: input.walletAddress,
    publicKey: input.publicKey,
    issuedAt: now,
    expiresAt,
  };
  const data = JSON.stringify(payload);
  const sig = await hmacSign(data, getSecret());
  return `${data}.${sig}`;
}

/** Verify any session token. Returns the verified kind or null. */
export async function verifySessionToken(
  token?: string | null,
): Promise<{ kind: "wallet" | "password"; walletAddress?: string } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [dataStr, signature] = parts;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(dataStr);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) {
    return null;
  }
  if (!(await hmacVerify(dataStr, getSecret(), signature))) return null;

  if ("walletAddress" in payload) {
    return { kind: "wallet", walletAddress: payload.walletAddress };
  }
  if ("authorized" in payload && payload.authorized) {
    return { kind: "password" };
  }
  return null;
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return (await verifySessionToken(session)) !== null;
}

export async function currentWalletAddress(): Promise<string | null> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const v = await verifySessionToken(session);
  return v?.kind === "wallet" ? v.walletAddress ?? null : null;
}

export async function loginSession() {
  const token = await createPasswordSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60,
  });
}

export async function loginWalletSession(input: {
  walletAddress: string;
  publicKey: string;
}) {
  const token = await createWalletSessionToken(input);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60,
  });
}

export async function logoutSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
