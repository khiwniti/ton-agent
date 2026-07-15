/**
 * LLM-call budget — protects against burst API spend from the radar loop.
 *
 * Two caps (both in-memory; restart-reset, which is acceptable because the
 * hourly counter is naturally self-limiting over the rolling window):
 *  - MAX_LLM_CALLS_PER_HOUR (default 30): rolling 60-minute cap.
 *  - RADAR_LLM_CAP_PER_TICK (default 3):  cap inside any 60-second radar tick.
 *
 * On a busy mempool, the radar can surface 5-30 unseen jettons per tick.
 * Without throttling, a fresh ReAct brain runs once per jetton — burning
 * thousands of tokens per minute. The brain also still re-checks the same
 * jetton periodically, so dropping a candidate here doesn't lose value: the
 * gate that consumes here IS the LLM re-eval, not the audit/observation.
 */
import { log } from "../logger";

const MAX_PER_HOUR = Math.max(0, Number(process.env.MAX_LLM_CALLS_PER_HOUR || 30));
const MAX_PER_TICK = Math.max(0, Number(process.env.RADAR_LLM_CAP_PER_TICK || 3));

// Sliding window of timestamps (ms) for calls inside the last 60 minutes.
const HISTORY: number[] = [];

// Per-tick (60-second window) counter.
let perTickUsed = 0;
let perTickWindowStart = Date.now();

function cleanHourlyHistory(now: number) {
  const cutoff = now - 60 * 60 * 1000;
  while (HISTORY.length > 0 && HISTORY[0] < cutoff) HISTORY.shift();
}

function rollPerTick(now: number) {
  if (now - perTickWindowStart > 60_000) {
    perTickUsed = 0;
    perTickWindowStart = now;
  }
}

export interface LlmBudgetDecision {
  allowed: boolean;
  reason?: "hourly_cap" | "per_tick_cap";
  hourlyRemaining: number;
  perTickRemaining: number;
}

/**
 * Try to consume one LLM-driven brain invocation. Returns allowed=false when
 * either cap is exhausted. On allowed=true, the call is recorded.
 */
export function tryConsumeLlmCall(reason: string): LlmBudgetDecision {
  const now = Date.now();
  cleanHourlyHistory(now);
  rollPerTick(now);

  const hourlyRemaining = MAX_PER_HOUR - HISTORY.length;
  const perTickRemaining = MAX_PER_TICK - perTickUsed;

  if (MAX_PER_HOUR > 0 && HISTORY.length >= MAX_PER_HOUR) {
    log.warn("LLM", `hourly cap reached — REJECT reason="${reason}" used=${HISTORY.length}/${MAX_PER_HOUR}`);
    return { allowed: false, reason: "hourly_cap", hourlyRemaining: 0, perTickRemaining };
  }
  if (MAX_PER_TICK > 0 && perTickUsed >= MAX_PER_TICK) {
    log.warn("LLM", `per-tick cap reached — REJECT reason="${reason}" used=${perTickUsed}/${MAX_PER_TICK}`);
    return { allowed: false, reason: "per_tick_cap", hourlyRemaining, perTickRemaining: 0 };
  }

  HISTORY.push(now);
  perTickUsed += 1;
  log.debug("LLM", `consume reason="${reason}" hourly=${HISTORY.length}/${MAX_PER_HOUR} tick=${perTickUsed}/${MAX_PER_TICK}`);
  return { allowed: true, hourlyRemaining: MAX_PER_HOUR - HISTORY.length, perTickRemaining: MAX_PER_TICK - perTickUsed };
}

/** Read-only snapshot for observability/logging. */
export function getLlmBudgetSnapshot() {
  const now = Date.now();
  cleanHourlyHistory(now);
  rollPerTick(now);
  return {
    maxPerHour: MAX_PER_HOUR,
    maxPerTick: MAX_PER_TICK,
    usedPerHour: HISTORY.length,
    usedPerTick: perTickUsed,
    windowStart: perTickWindowStart,
  };
}
