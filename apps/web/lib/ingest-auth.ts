import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify HMAC-SHA256 signature for agent webhook requests.
 * 
 * Uses timing-safe comparison to prevent timing attacks.
 * The signature is expected in the x-agent-secret header.
 */
export function verifyIngestSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined
): boolean {
  if (!secret || !signature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}
