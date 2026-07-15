const SESSION_DURATION_DAYS = 30;

function getSecret(): string {
  return process.env.AGENT_SHARED_SECRET || "fallback-secret-development-only-replace-in-production";
}

/**
  * Generate a HMAC signature for the session cookie
  */
async function generateSignature(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Buffer.from(signature).toString("base64url");
}

/**
  * Create cookie session value
  */
export async function createSessionToken(): Promise<string> {
  const expiresAt = Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const payload = JSON.stringify({ authorized: true, expiresAt });
  const signature = await generateSignature(payload, getSecret());
  return `${payload}.${signature}`;
}

/**
  * Verify if the session token is valid
  */
export async function verifySessionToken(token?: string): Promise<boolean> {
  if (!token) return false;
  
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  
  const [payloadStr, signature] = parts;
  
  try {
    const expectedSignature = await generateSignature(payloadStr, getSecret());
    if (signature !== expectedSignature) return false;
    
    const payload = JSON.parse(payloadStr);
    if (!payload.authorized) return false;
    if (payload.expiresAt < Date.now()) return false;
    
    return true;
  } catch {
    return false;
  }
}
