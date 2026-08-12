/**
 * Shared cross-subsystem rate limiter — token-bucket with a global
 * concurrency cap + minimum gap between slot releases.
 *
 * Purpose (2026-08-12 prod incident): the agent has FIVE concurrent callers
 * of the DeDust + STON.fi public REST APIs (sniper scan, sniper monitor,
 * position monitor, coordinator balance refresh, webhook-driven quotes).
 * Each carried its own retry-with-backoff loop, but nothing serialized
 * them. When one caller tripped a 429, every retry fired on the same
 * millisecond beat and stampeded the upstream, compounding the rate-limit
 * failure across all subsystems simultaneously.
 *
 * Pattern is identical to `http/tonapi.ts`'s TONAPI limiter but exposed
 * as a single bucket for the DeDust family + a sibling for STON.fi. Two
 * buckets keep one vendor's 429 from starving the other.
 *
 * Usage:
 *   await acquireDeDustSlot();
 *   try { ... } finally { releaseDeDustSlot(); }
 *
 * All callers in the codebase must funnel through these helpers. The
 * previous `post()`/`get()` retry block in `x1000-client.ts` is kept for
 * the retry/backoff logic itself; this module ONLY owns the bucket.
 */

const MAX_CONCURRENT_DEDUST = 3;   // ≤3 in-flight DeDust requests
const MIN_GAP_MS_DEDUST     = 200; // ≥200ms between slot releases → ≤5 req/s

const MAX_CONCURRENT_STONFI = 3;
const MIN_GAP_MS_STONFI     = 200;

interface BucketState {
  inflight: number;
  lastRelease: number;
  queue: Array<() => void>;
}

const _dedust: BucketState = { inflight: 0, lastRelease: 0, queue: [] };
const _stonfi: BucketState = { inflight: 0, lastRelease: 0, queue: [] };

function _tryDrain(bucket: BucketState, maxConcurrent: number, minGapMs: number): void {
  if (bucket.queue.length === 0 || bucket.inflight >= maxConcurrent) return;
  const now = Date.now();
  const sinceLast = now - bucket.lastRelease;
  if (sinceLast < minGapMs) {
    setTimeout(() => _tryDrain(bucket, maxConcurrent, minGapMs), minGapMs - sinceLast);
    return;
  }
  bucket.inflight++;
  const resolve = bucket.queue.shift();
  if (resolve) resolve();
}

function _release(bucket: BucketState, minGapMs: number): void {
  bucket.inflight--;
  bucket.lastRelease = Date.now();
  setTimeout(() => _tryDrain(bucket, MAX_CONCURRENT_DEDUST, MIN_GAP_MS_DEDUST), minGapMs);
}

function _acquire(bucket: BucketState, maxConcurrent: number, minGapMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    bucket.queue.push(resolve);
    _tryDrain(bucket, maxConcurrent, minGapMs);
  });
}

/** Acquire a DeDust v4 router/coin/trace slot. Pair with `releaseDeDustSlot`. */
export function acquireDeDustSlot(): Promise<void> {
  return _acquire(_dedust, MAX_CONCURRENT_DEDUST, MIN_GAP_MS_DEDUST);
}

export function releaseDeDustSlot(): void {
  _release(_dedust, MIN_GAP_MS_DEDUST);
}

/** Acquire a STON.fi v1 pool/swap slot. Pair with `releaseStonFiSlot`. */
export function acquireStonFiSlot(): Promise<void> {
  return _acquire(_stonfi, MAX_CONCURRENT_STONFI, MIN_GAP_MS_STONFI);
}

export function releaseStonFiSlot(): void {
  _release(_stonfi, MIN_GAP_MS_STONFI);
}

/** Internal: snapshot for ops dashboards and tests. */
export function rateLimitSnapshot(): {
  dedust: { inflight: number; queued: number };
  stonfi: { inflight: number; queued: number };
} {
  return {
    dedust: { inflight: _dedust.inflight, queued: _dedust.queue.length },
    stonfi: { inflight: _stonfi.inflight, queued: _stonfi.queue.length },
  };
}
