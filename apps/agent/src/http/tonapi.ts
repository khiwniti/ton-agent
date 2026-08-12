/**
 * TONAPI HTTP helper with exponential backoff, jitter, and a global
 * token-bucket rate limiter.
 *
 * Rate limiter: max `MAX_CONCURRENT` in-flight requests at a time, with a
 * minimum `MIN_GAP_MS` drain gap between releases.  This caps throughput to
 * ~6 req/s against the free tier which eliminates most HTTP 429s without
 * any change to callers.
 *
 * Backoff schedule (with ±jitter) on 429 / 5xx / network errors:
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

// ─── Global token-bucket concurrency limiter ─────────────────────────────────
const MAX_CONCURRENT = 3;   // at most 3 simultaneous TONAPI requests
const MIN_GAP_MS     = 150; // minimum ms between slot releases → ≤6-7 req/s

let _inflight = 0;
let _lastRelease = 0;
const _queue: Array<() => void> = [];

function _tryDrain() {
  if (_queue.length === 0 || _inflight >= MAX_CONCURRENT) return;
  const now = Date.now();
  const sinceLast = now - _lastRelease;
  if (sinceLast < MIN_GAP_MS) {
    setTimeout(_tryDrain, MIN_GAP_MS - sinceLast);
    return;
  }
  _inflight++;
  const resolve = _queue.shift()!;
  resolve();
}

function _release() {
  _inflight--;
  _lastRelease = Date.now();
  setTimeout(_tryDrain, MIN_GAP_MS);
}

/** Acquire a rate-limit slot. Must be paired with a `_release()` call. */
function acquireSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    _queue.push(resolve);
    _tryDrain();
  });
}

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

  // Acquire a global rate-limit slot before every attempt.
  await acquireSlot();
  try {
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
  } finally {
    _release();
  }
}

// ─── TONAPI-backed jetton holder count (gated + cached) ─────────────────
// Holder counts have no cheap on-chain equivalent — they are the one piece
// of data that is genuinely TONAPI-exclusive. Both hot-path consumers
// (hotpath/position-monitor, sniper/engine) call this for trend-exit
// corroboration. It must NEVER fire per-tick and must fail soft (null) when
// the key is missing or the API blips.

const HOLDERS_TTL_MS = 5 * 60 * 1000; // 5 minutes — long enough to kill per-tick 429s
const holdersCache = new Map<string, { total: number; ts: number }>();

/**
 * Live holder total for a jetton master, or `null` when TONAPI is not
 * configured, unreachable, or the response is unusable (fail soft — never
 * fabricate a confirm). Cached `HOLDERS_TTL_MS` per master so the trend
 * monitor never hammers the free tier.
 */
export async function fetchHoldersTotal(master: string): Promise<number | null> {
  if (!CONFIG.tonapiKey) return null; // gated: no key → holder leg disabled
  const cached = holdersCache.get(master);
  if (cached && Date.now() - cached.ts < HOLDERS_TTL_MS) return cached.total;
  try {
    const r = await tonapiGet(`/v2/jettons/${master}/holders`, { timeoutMs: 8000 });
    const total = r?.data?.total;
    if (!Number.isFinite(total)) return null;
    holdersCache.set(master, { total, ts: Date.now() });
    return total;
  } catch {
    return null; // fail closed — TONAPI blip must never fabricate a confirm
  }
}
