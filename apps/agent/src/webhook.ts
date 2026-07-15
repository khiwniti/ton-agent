/**
 * Web-app envelope helper.
 *
 * Single source for the agent's outbound POST shape:
 *   { id, at, kind, walletTier?, payload }
 *
 * The `id` is the **idempotency key**: passing a `stableId` for repeated
 * events (radar events with their own id, position rows with their own id,
 * etc.) ensures web-side upserts deduplicate. When omitted, a fresh id is
 * minted per call (acceptable for one-off `agent_message` pushes).
 *
 * The web ingest route already upserts on row PKs; by constructing a stable
 * outer `id` AND placing it inside `payload.id`, dedupe works regardless of
 * which field the row mapper chooses to trust.
 */
import axios from "axios";
import { CONFIG } from "./config";
import { log } from "./logger";
import { newId, type RiskTier } from "@ton-agent/shared";

export interface PostEnvelopeOpts {
  kind: string;
  walletTier?: RiskTier;
  payload: Record<string, any>;
  /** When provided, becomes both the top-level `id` and `payload.id`. */
  stableId?: string;
}

export interface PostEnvelopeResult {
  sent: boolean;
  id: string;
  reason?: string;
  error?: string;
}

export async function postEnvelope(opts: PostEnvelopeOpts): Promise<PostEnvelopeResult> {
  const url = CONFIG.publicWebhookUrl;
  const id = opts.stableId ?? newId("wh");
  if (!url) {
    return { sent: false, id, reason: "PUBLIC_WEBHOOK_URL not set" };
  }
  try {
    await axios.post(
      url,
      {
        id,
        at: Date.now(),
        kind: opts.kind,
        walletTier: opts.walletTier,
        payload: { ...opts.payload, id },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Secret": CONFIG.agentSharedSecret,
        },
        timeout: 10_000,
      }
    );
    return { sent: true, id };
  } catch (e: any) {
    log.warn("WEBHOOK", `post failed kind=${opts.kind} id=${id} → ${e.message}`);
    return { sent: false, id, error: e.message };
  }
}
