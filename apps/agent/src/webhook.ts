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
import { createHmac } from "node:crypto";
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
    log.info("WEBHOOK", `POST kind=${opts.kind} tier=${opts.walletTier ?? '-'} id=${id}`);
    const body = {
      id,
      at: Date.now(),
      kind: opts.kind,
      walletTier: opts.walletTier,
      payload: { ...opts.payload, id },
    };
    const bodyJson = JSON.stringify(body);
    const signature = createHmac("sha256", CONFIG.agentSharedSecret)
      .update(bodyJson)
      .digest("hex");
    await axios.post(url, bodyJson, {
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Secret": signature,
      },
      timeout: 10_000,
    });
    log.ok("WEBHOOK", `OK kind=${opts.kind} id=${id}`);
    return { sent: true, id };
  } catch (e: any) {
    const status: number | undefined = e?.response?.status;
    if (status === 401) {
      // Auth mismatch — config issue, not a transient error. Log at info level
      // so it doesn't spam ERR/WARN on every tick when the secret is wrong.
      log.info("WEBHOOK", `post failed kind=${opts.kind} id=${id} → 401 Unauthorized (check AGENT_SHARED_SECRET)`);
    } else {
      log.warn("WEBHOOK", `post failed kind=${opts.kind} id=${id} → ${e.message}`);
    }
    return { sent: false, id, error: e.message };
  }
}
