/**
 * TONAPI HTTP helper with exponential backoff and jitter.
 *
 * Wraps `axios.get` so callers can opt into retry behavior on transient
 * failures (HTTP 429, 5xx, network resets). 429s honor the Retry-After
 * header when present.
 *
 * Backoff schedule (with ±jitter):
 *   attempt 1 → fail →  wait  250ms
 *   attempt 2 → fail →  wait  750ms
 *   attempt 3 → fail →  wait 2250ms
 *   (give up after maxAttempts)
 *
 * Per-attempt timeout: 8s by default.
 *
 * Set LOG_RETRIES=1 to surface each retry via the pretty logger.
 */
import axios, { AxiosError } from "axios";
import { CONFIG } from "../config";
import { log } from "../logger";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAYS_MS = [250, 750, 2250];

function jitter(base: number): number {
  // ±25% multiplicative jitter to spread retries across many clients.
  const delta = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + delta));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRetryStatus(status: number | undefined): boolean {
  if (!status) return true; // network error / no response
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function parseRetryAfter(headers: Record<string, any> | undefined): number | null {
  if (!headers) return null;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return null;
}

export interface TonapiGetOpts {
  /** Optional axios params (e.g. { limit, verified } for jettons). */
  params?: Record<string, any>;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Total attempts including the initial one. */
  maxAttempts?: number;
  /** Custom headers (Authorization injected automatically when configured). */
  headers?: Record<string, string>;
}

/**
 * GET `${CONFIG.tonapiBase}${path}` with retries on 429 / 5xx / network errors.
 * Returns the raw axios response so callers can inspect status/data freely.
 */
export async function tonapiGet(path: string, opts: TonapiGetOpts = {}): Promise<any> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  // TONAPI (tonapi.io) requires its own key from tonconsole.com.
  // When CONFIG.tonapiKey is set, send it as Bearer token.
  if (CONFIG.tonapiKey) {
    headers["Authorization"] = `Bearer ${CONFIG.tonapiKey}`;
  }

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await axios.get(`${CONFIG.tonapiBase}${path}`, {
        headers,
        params: opts.params,
        timeout,
      });
      return r;
    } catch (e: any) {
      lastErr = e;
      const status: number | undefined = (e as AxiosError)?.response?.status;
      const retriable = shouldRetryStatus(status);
      const isLast = attempt >= maxAttempts;

      if (process.env.LOG_RETRIES === "1") {
        log.warn("TONAPI", `attempt ${attempt}/${maxAttempts} ${path} → ${status ?? "no-status"} ${retriable && !isLast ? "RETRY" : "GIVEUP"} (${e.message})`);
      }

      if (!retriable || isLast) throw e;

      const retryAfter = parseRetryAfter((e as AxiosError)?.response?.headers as any);
      const baseIdx = Math.min(attempt - 1, BASE_DELAYS_MS.length - 1);
      const baseDelayMs = BASE_DELAYS_MS[baseIdx];
      const waitMs = Math.max(retryAfter ?? 0, jitter(baseDelayMs));
      await sleep(waitMs);
    }
  }
  throw lastErr;
}
