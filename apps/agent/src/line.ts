import crypto from "node:crypto";
import { log } from "./logger";

/**
 * LINE Client — Placeholder for LINE messaging integration.
 * Not currently used - exported to satisfy imports.
 */
export class LineClient {
  constructor(private readonly accessToken: string) {}

  async pushMessage(userId: string, message: string): Promise<void> {
    // Placeholder
    console.log(`[LINE] Push to ${userId}: ${message}`);
  }

  async replyMessage(replyToken: string, message: string): Promise<void> {
    // Placeholder
    console.log(`[LINE] Reply: ${message}`);
  }
}

/**
 * Create a LINE client from config.
 * Returns null if not configured.
 */
export function createLineClient(): LineClient | null {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  return new LineClient(token);
}

/**
 * Handle an incoming LINE webhook request (spec 006 Phase 8 — LINE ops webhook).
 * Verifies the x-line-signature HMAC when a channel token is configured,
 * otherwise accepts the payload. Always returns a JSON-serializable object.
 */
export async function handleLineWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string
): Promise<{ ok: boolean; received?: number }> {
  const signature = headerValue(headers["x-line-signature"]);
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (token && signature) {
    const hmac = crypto.createHmac("SHA256", token).update(rawBody).digest("base64");
    if (hmac !== signature) {
      return { ok: false };
    }
  }
  let events: unknown[] = [];
  try {
    const parsed = JSON.parse(rawBody);
    events = Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    // Non-JSON payloads are ignored but still acked (LINE requires 200).
  }
  log.info("LINE", `webhook received ${events.length} event(s)`);
  return { ok: true, received: events.length };
}

function headerValue(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}