/**
 * Unit tests for src/sniper/filters.ts — the pure risk gates and exit
 * decisions. This file's header claims "PURE functions, unit-tested" but no
 * test existed; these tests close that gap (2026-08-10).
 *
 * Covered:
 *   • decideExit() — 2026-08-09 operator directive + gas-aware noise floor:
 *     no take-profit, no trailing. Winners ride; a confirmed downtrend flip
 *     closes a winner (structure over price level) or a gap-through loser;
 *     a shallow loser above the stop HOLDs when the flat router gas dominates
 *     the outcome.
 *   • confirmedByFeeds() — fail-closed corroboration gate over live feeds.
 *   • netProceedsTon(), mergeFill(), positionSizeTon(), hardGates(),
 *     softScore().
 *
 * Run:
 *   DATA_DIR=$(mktemp -d) npx tsx --test test/sniper-filters.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideExit,
  confirmedByFeeds,
  effectiveStopPct,
  netProceedsTon,
  mergeFill,
  positionSizeTon,
  hardGates,
  softScore,
  DEFAULT_GATE_CONFIG,
  type ExitState,
  type GateCtx,
} from "../src/sniper/filters";
import type { X1000Coin } from "../src/sniper/x1000-client";

// ── decideExit: 2026-08-09 operator directive ────────────────────────────

function state(overrides: Partial<ExitState> = {}): ExitState {
  return {
    entryPriceTon: 0.001, // TON per token
    currentPriceTon: 0.001,
    stopLossPct: 35,
    ...overrides,
  };
}

test("decideExit: +50% winner, no trend flip → hold (no TP target)", () => {
  const s = state({ currentPriceTon: 0.0015 }); // +50%
  const d = decideExit(s);
  assert.deepEqual(d, { action: "hold" });
});

test("decideExit: winner with confirmed downtrend flip → trend_exit", () => {
  const s = state({
    currentPriceTon: 0.0013, // +30% winner
    trendBearish: true,
    trendReason: "fast EMA < slow EMA (3 confirmed ticks)",
  });
  const d = decideExit(s);
  assert.equal(d.action, "trend_exit");
  assert.match(d.reason, /trend flipped to downtrend/);
});

test("decideExit: gap-through loser below stop with trend flip → trend_exit (GULYA)", () => {
  // GULYA realized -80.5% against a -35% stop because the stop was gapped
  // through. A confirmed flip on a gross loser below the stop must act on
  // structure instead of the price level.
  const s = state({
    currentPriceTon: 0.0002, // -80%
    trendBearish: true,
    trendReason: "confirmed flip",
  });
  const d = decideExit(s);
  assert.equal(d.action, "trend_exit");
});

test("decideExit: loser below stop, NO trend flip → stop_loss", () => {
  const s = state({ currentPriceTon: 0.0005 }); // -50% ≤ -35%
  const d = decideExit(s);
  assert.equal(d.action, "stop_loss");
  assert.match(d.reason, /-50/);
});

test("decideExit: exact stop-loss pnl fires", () => {
  const s = state({ currentPriceTon: 0.00065 }); // -35% exactly
  const d = decideExit(s);
  assert.equal(d.action, "stop_loss");
});

test("decideExit: shallow loser above stop with trend flip → hold (noise floor)", () => {
  // PAWZ case: -2% on a 0.44 TON lot with 0.2 TON round-trip gas. Closing
  // nets a guaranteed loss; the flip is not proof the position is doomed.
  const s = state({
    currentPriceTon: 0.00098, // -2% (above -35% stop)
    trendBearish: true,
    positionTon: 0.44,
    roundTripGasTon: 0.2,
  });
  const d = decideExit(s);
  assert.equal(d.action, "hold");
  assert.match(d.reason, /noise floor/);
  assert.match(d.reason, /nets /);
});

test("decideExit: shallow loser with trend flip but LARGE lot → still holds (above stop)", () => {
  // Even a big lot holds: the noise floor is about the pnl being above the
  // stop, not the gas fraction. The flip alone is insufficient evidence.
  const s = state({
    currentPriceTon: 0.00098, // -2%
    trendBearish: true,
    positionTon: 50, // gas is negligible here
    roundTripGasTon: 0.2,
  });
  const d = decideExit(s);
  assert.equal(d.action, "hold");
});

test("decideExit: -34.99% (above stop) → hold", () => {
  const s = state({ currentPriceTon: 0.0006501 });
  const d = decideExit(s);
  assert.equal(d.action, "hold");
});

// ── decideExit: §2.2 peak-giveback trail (2026-08-11) ──────────────────
// Profit-armed, full-exit trail. Precedence: trend → giveback → time → stop.
// Invariants (§2.4): profit-armed only, never loss-side (net-breakeven
// clamp), full exit, monotonic peak, disabled by default.

test("givebackExit: fires on giveback threshold with pnl > 0", () => {
  const s = state({
    entryPriceTon: 0.001,
    currentPriceTon: 0.0014, // peak 0.002, now +40%
    peakPriceTon: 0.002,
    givebackEnabled: true,
    givebackArmPct: 10,
    givebackDropPct: 20,
  });
  // peak 0.002 × (1 − 0.2) = 0.0016; 0.0014 ≤ 0.0016 → fires, pnl +40%.
  const d = decideExit(s);
  assert.equal(d.action, "giveback_exit");
  assert.match(d.reason, /giveback/);
  assert.match(d.reason, /pnl 40\.0%/);
});

test("givebackExit: silent below the arm (profit-armed invariant 1)", () => {
  // arm level = entry × 1.10 = 0.0011. Peak 0.00105 (+5%) is BELOW the arm,
  // so the trail never arms — even though the price gave back 21% from the
  // peak and sits below entry (−17.5%). Invariant 1: below the arm the trail
  // does not exist.
  const s = state({
    entryPriceTon: 0.001,
    currentPriceTon: 0.000825,
    peakPriceTon: 0.00105,
    givebackEnabled: true,
    givebackArmPct: 10,
    givebackDropPct: 20,
  });
  const d = decideExit(s);
  assert.equal(d.action, "hold"); // −17.5% > −35% stop → plain hold
});

test("givebackExit: clamp prevents loss-side exit (invariant 2)", () => {
  // Small lot (0.5 TON) with flat 0.2 TON round-trip gas: net breakeven is
  // entry × (1 + 0.2/0.5) = 0.001 × 1.4 = 0.0014. The raw giveback level
  // (peak 0.002 × 0.6 = 0.0012) would cross below entry — the net-breakeven
  // clamp lifts it to 0.0014, so a close at 0.00135 still exits in profit
  // (+35%), never below net breakeven.
  const s = state({
    entryPriceTon: 0.001,
    currentPriceTon: 0.00135, // +35%
    peakPriceTon: 0.002, // peak +100%
    givebackEnabled: true,
    givebackArmPct: 10,
    givebackDropPct: 40, // raw level 0.002 × 0.6 = 0.0012 < 0.0014 clamp
    positionTon: 0.5,
    roundTripGasTon: 0.2,
  });
  const d = decideExit(s);
  // The level clamps to net breakeven 0.0014; current 0.00135 ≤ 0.0014 → still
  // fires, but at a PROFIT (+35%) because the clamp lifted the level above the
  // raw giveback. The key invariant: never fires below net breakeven.
  assert.equal(d.action, "giveback_exit");
  assert.match(d.reason, /pnl 35\.0%/);
});

test("givebackExit: current above the giveback level → hold", () => {
  const s = state({
    entryPriceTon: 0.001,
    currentPriceTon: 0.0018, // +80%
    peakPriceTon: 0.002,
    givebackEnabled: true,
    givebackArmPct: 10,
    givebackDropPct: 20, // level 0.0016; 0.0018 > 0.0016 → hold
  });
  const d = decideExit(s);
  assert.equal(d.action, "hold");
});

test("givebackExit: disabled (default) → no-op, hold", () => {
  const s = state({
    currentPriceTon: 0.0014,
    peakPriceTon: 0.002,
    // givebackEnabled absent → OFF per §2.5
    givebackArmPct: 10,
    givebackDropPct: 20,
  });
  const d = decideExit(s);
  assert.equal(d.action, "hold");
});

test("decideExit: trend flip outranks giveback on the same tick (precedence)", () => {
  // Both fire: confirmed downtrend flip AND the price gave back past the
  // giveback level. The doc mandates trend → giveback → time → stop.
  const s = state({
    entryPriceTon: 0.001,
    currentPriceTon: 0.0014, // +40%
    peakPriceTon: 0.002,
    givebackEnabled: true,
    givebackArmPct: 10,
    givebackDropPct: 20, // level 0.0016; 0.0014 ≤ 0.0016 → giveback would fire
    trendBearish: true,
    trendReason: "fast EMA < slow EMA (3 confirmed ticks)",
  });
  const d = decideExit(s);
  assert.equal(d.action, "trend_exit");
  assert.match(d.reason, /trend flipped to downtrend/);
});

test("decideExit: time_exit fires once maxHoldMs elapsed (2026-08-12 alignment)", () => {
  const s = state({
    entryPriceTon: 0.001,
    currentPriceTon: 0.0012, // +20% — above stop, no trend flip
    entryTimeMs: 1_700_000_000_000,
    now: 1_700_003_600_000, // +1h
    maxHoldMs: 3_600_000,
  });
  const d = decideExit(s);
  assert.equal(d.action, "time_exit");
  // Shipped reason (filters.ts): `max hold ${mins}m exceeded (held ...m)`.
  assert.match(d.reason, /max hold/i);
});

test("givebackExit: peak below entry with enabled trail → silent (never arms on a loss)", () => {
  const s = state({
    entryPriceTon: 0.001,
    currentPriceTon: 0.0008, // −20%
    peakPriceTon: 0.0009, // peak itself below entry
    givebackEnabled: true,
    givebackArmPct: 10,
    givebackDropPct: 20,
  });
  const d = decideExit(s);
  assert.equal(d.action, "hold"); // not even the stop: −20% > −35%
});

// ── netProceedsTon ────────────────────────────────────────────────────────

test("netProceedsTon: gross minus flat gas", () => {
  // +50% on 1 TON = 1.5 gross, minus 0.2 gas = 1.3 net.
  assert.equal(netProceedsTon(50, 1, 0.2), 1.3);
});

test("netProceedsTon: small lot close nets negative even on a gain", () => {
  // +20% on 0.1 TON = 0.12 gross, minus 0.2 gas = -0.08. The trap that makes
  // small lots unattractive to close.
  const net = netProceedsTon(20, 0.1, 0.2);
  assert.ok(net < 0, `expected negative net, got ${net}`);
});

// ── confirmedByFeeds: fail-closed exit corroboration ─────────────────────

test("confirmedByFeeds: healthy net-selling + shrinking holders → true", () => {
  assert.equal(
    confirmedByFeeds({ sellTraders24h: 12, buyTraders24h: 3, holdersDeltaPct: -8 }),
    true,
  );
});

test("confirmedByFeeds: holders growing contradicts a downtrend flip → false", () => {
  assert.equal(
    confirmedByFeeds({ sellTraders24h: 12, buyTraders24h: 3, holdersDeltaPct: 5 }),
    false,
  );
});

test("confirmedByFeeds: buyers exceed sellers → false", () => {
  assert.equal(
    confirmedByFeeds({ sellTraders24h: 3, buyTraders24h: 12, holdersDeltaPct: -8 }),
    false,
  );
});

test("confirmedByFeeds: no sellers at all → false", () => {
  assert.equal(
    confirmedByFeeds({ sellTraders24h: 0, buyTraders24h: 3, holdersDeltaPct: -8 }),
    false,
  );
});

test("confirmedByFeeds: no buyers (pure exit flow) → allowed", () => {
  // sellTraders24h=10 > 0 and buyTraders24h=0 → `buyTraders24h > 0` is false,
  // so the sellers>=buyers check is skipped; shrinking holders corroborates.
  assert.equal(
    confirmedByFeeds({ sellTraders24h: 10, buyTraders24h: 0, holdersDeltaPct: -3 }),
    true,
  );
});

test("confirmedByFeeds: NaN holders delta → fail closed", () => {
  assert.equal(
    confirmedByFeeds({ sellTraders24h: 12, buyTraders24h: 3, holdersDeltaPct: NaN }),
    false,
  );
});

test("confirmedByFeeds: Infinity → fail closed", () => {
  assert.equal(
    confirmedByFeeds({ sellTraders24h: Infinity, buyTraders24h: 3, holdersDeltaPct: -8 }),
    false,
  );
});

// ── mergeFill: weighted-average entry + re-anchored peak ─────────────────

test("mergeFill: second fill re-weights the average entry price", () => {
  // Prior: 1 TON spent for 1000 tokens → 0.001 TON/token.
  // Fill:  0.4 TON spent for 200 tokens → 0.002 TON/token.
  // Total: 1.4 TON / 1200 tokens = 0.0011666... TON/token.
  const merged = mergeFill(
    { spentNano: 1_000_000_000n, tokensNano: 1000_000_000_000n, peakPriceTon: 0.001 },
    { spentNano: 400_000_000n, tokensNano: 200_000_000_000n },
  );
  assert.equal(merged.spentNano, 1_400_000_000n);
  assert.equal(merged.tokensNano, 1200_000_000_000n);
  assert.ok(Math.abs(merged.avgEntryPriceTon - 1.4 / 1200) < 1e-12);
});

test("mergeFill: fresh open (prior null) takes the fill's price", () => {
  const merged = mergeFill(null, {
    spentNano: 500_000_000n,
    tokensNano: 1000_000_000_000n,
  });
  assert.equal(merged.spentNano, 500_000_000n);
  assert.equal(merged.avgEntryPriceTon, 0.0005);
});

test("mergeFill: peak re-anchors upward only", () => {
  // Prior peak 0.003 with avg 0.001; new avg 0.002 → peak stays 0.003.
  const up = mergeFill(
    { spentNano: 1_000_000_000n, tokensNano: 1000_000_000_000n, peakPriceTon: 0.003 },
    { spentNano: 400_000_000n, tokensNano: 200_000_000_000n }, // avg → 0.001167
  );
  assert.equal(up.peakPriceTon, 0.003);
  // A fill that raises the avg above the peak re-anchors to the new basis.
  const raises = mergeFill(
    { spentNano: 1_000_000_000n, tokensNano: 1000_000_000_000n, peakPriceTon: 0.0005 },
    { spentNano: 1_000_000_000n, tokensNano: 500_000_000_000n }, // avg → 0.001333
  );
  assert.ok(raises.peakPriceTon >= 0.001333);
});

test("mergeFill: zero tokens (fresh open) → avg entry price fails closed to 0", () => {
  // A fill that returned no tokens is a broken quote: with `prior = null`
  // the merged total is exactly zero, so the divide-by-zero guard must yield
  // a 0 entry price (reads as -100% PnL downstream) instead of NaN.
  const merged = mergeFill(null, { spentNano: 0n, tokensNano: 0n });
  assert.equal(merged.spentNano, 0n);
  assert.equal(merged.tokensNano, 0n);
  assert.equal(merged.avgEntryPriceTon, 0);
});

// ── positionSizeTon: cap chain ───────────────────────────────────────────

test("positionSizeTon: per-trade cap binds when alloc/daily are larger", () => {
  const size = positionSizeTon({
    perTradeTon: 0.3,
    portfolioAllocationPct: 25,
    bankrollTon: 10, // alloc = 2.5
    dailyRemainingTon: 5,
  });
  assert.equal(size, 0.3);
});

test("positionSizeTon: portfolio alloc binds", () => {
  const size = positionSizeTon({
    perTradeTon: 5,
    portfolioAllocationPct: 25,
    bankrollTon: 1, // alloc = 0.25
    dailyRemainingTon: 5,
  });
  assert.equal(size, 0.25);
});

test("positionSizeTon: daily remaining binds", () => {
  const size = positionSizeTon({
    perTradeTon: 5,
    portfolioAllocationPct: 100,
    bankrollTon: 100,
    dailyRemainingTon: 0.1,
  });
  assert.equal(size, 0.1);
});

test("positionSizeTon: clamps to 0, never negative", () => {
  const size = positionSizeTon({
    perTradeTon: 5,
    portfolioAllocationPct: 10,
    bankrollTon: -2, // negative bankroll
    dailyRemainingTon: 5,
  });
  assert.equal(size, 0);
});

test("positionSizeTon: rounds to nano precision", () => {
  const size = positionSizeTon({
    perTradeTon: 0.123456789123,
    portfolioAllocationPct: 100,
    bankrollTon: 100,
    dailyRemainingTon: 100,
  });
  assert.equal(size, 0.123456789);
});

// ── hardGates + softScore (launch filters) ────────────────────────────────

/** Minimal valid X1000Coin for gate tests. */
function coin(overrides: Partial<X1000Coin> = {}): X1000Coin {
  const now = Date.now();
  return {
    asset: "jetton:0:test",
    created_at: new Date(now - 60_000).toISOString(),
    verification_level: 3,
    // Name/ticker deliberately avoid the DEFAULT_GATE_CONFIG spam prefixes
    // ("test", "free", ...) so the healthy-launch fixture passes clean.
    metadata: { name: "Nova Coin", ticker: "NVT", decimals: 9 },
    // At exactly minDistinctBuyers: the healthy launch needs buyers to pass.
    traders: { buy: { h24: 3 }, sell: { h24: 0 } },
    tags: [],
    memecoin_extra_details: {
      author: "test",
      contract_type: "dedust_v3_memepad",
      curve_ton_collected: "20000000000", // 20 TON
      curve_ton_max: "100000000000", // 100 TON
      migrated: false,
    },
    ...overrides,
  } as X1000Coin;
}

const ctx: GateCtx = { now: Date.now(), seenTickers: new Map() };

test("hardGates: passes a healthy launch", () => {
  const reasons = hardGates(coin(), DEFAULT_GATE_CONFIG, ctx);
  assert.deepEqual(reasons, []);
});

test("hardGates: low verification rejects", () => {
  const reasons = hardGates(
    coin({ verification_level: 2 }),
    DEFAULT_GATE_CONFIG,
    ctx,
  );
  assert.ok(reasons.some((r) => r.startsWith("verification 2 < 3")));
});

test("hardGates: thin curve rejects", () => {
  const reasons = hardGates(
    coin({
      memecoin_extra_details: {
        author: "test",
        contract_type: "dedust_v3_memepad",
        curve_ton_collected: "1000000000", // 1 TON < 5 floor
        curve_ton_max: "100000000000",
        migrated: false,
      },
    }),
    DEFAULT_GATE_CONFIG,
    ctx,
  );
  assert.ok(reasons.some((r) => r.startsWith("curve")));
});

test("hardGates: distinct buyers gate reads h24 traders, not holders", () => {
  // The upstream API reports holders:0 for memepad coins; the live signal is
  // distinct buyer wallets in h24. A launch with 2 buyers must reject.
  const reasons = hardGates(
    coin({ traders: { buy: { h24: 2 }, sell: { h24: 0 } } }),
    DEFAULT_GATE_CONFIG,
    ctx,
  );
  assert.ok(reasons.some((r) => r.startsWith("distinct buyers 2 < 3")));
});

test("hardGates: spam ticker pattern rejects", () => {
  const reasons = hardGates(
    coin({ metadata: { name: "Free Coins", ticker: "FREE" } }),
    DEFAULT_GATE_CONFIG,
    ctx,
  );
  assert.ok(reasons.some((r) => r.startsWith("pattern")));
});

test("softScore: more distinct buyers + sweet-spot curve → higher score", () => {
  const quiet = softScore(
    coin({ traders: { buy: { h24: 3 }, sell: { h24: 0 } } }),
    ctx,
  );
  const hot = softScore(
    coin({ traders: { buy: { h24: 60 }, sell: { h24: 10 } } }),
    ctx,
  );
  assert.ok(hot > quiet, `expected hot ${hot} > quiet ${quiet}`);
});

test("softScore: duplicate ticker in window is penalized", () => {
  const seen = new Map<string, number>([["nvt", Date.now()]]);
  const withDup = softScore(coin(), { now: Date.now(), seenTickers: seen });
  const withoutDup = softScore(coin(), ctx);
  assert.equal(withDup, Math.max(0, withoutDup - 15));
});

test("softScore: score is clamped to 0..100", () => {
  const maxed = softScore(
    coin({
      metadata: {
        name: "Max Coin",
        ticker: "MAX1",
        social_links: ["https://t.me/x", "https://x.com/y"],
      },
      traders: { buy: { h24: 500 }, sell: { h24: 100 } },
    }),
    ctx,
  );
  assert.ok(maxed >= 0 && maxed <= 100, `got ${maxed}`);
});

// ── effectiveStopPct: Phase 5.1 vol-widened SL ───────────────────────────

test("effectiveStopPct: returns static stop when vol data absent", () => {
  assert.equal(effectiveStopPct(35), 35);
  assert.equal(effectiveStopPct(35, undefined, undefined), 35);
  assert.equal(effectiveStopPct(35, NaN, 10), 35);
  assert.equal(effectiveStopPct(35, 10, NaN), 35);
});

test("effectiveStopPct: returns static stop when vol is NOT elevated", () => {
  // realizedVol <= baseRealizedVol → no widening.
  assert.equal(effectiveStopPct(35, 10, 10), 35);
  assert.equal(effectiveStopPct(35, 5, 10), 35);
});

test("effectiveStopPct: widens loss-side when vol is elevated AND a cap > base is set", () => {
  // Fail-closed: without an explicit cap the widened width clamps to the
  // static base (widening is config-gated — never wider than configured).
  assert.equal(effectiveStopPct(35, 20, 10), 35);
  assert.equal(effectiveStopPct(35, 20, 10, 80), 70); // 2× baseline → 2× width
  assert.equal(effectiveStopPct(35, 15, 10, 80), 52.5); // 1.5× baseline
});

test("effectiveStopPct: clamps to slVolWidenMaxPct cap", () => {
  // 4× vol → raw 140%, but the cap holds at 50%.
  assert.equal(effectiveStopPct(35, 40, 10, 50), 50);
  // Cap below the static base is ignored (floor is static width).
  assert.equal(effectiveStopPct(35, 40, 10, 20), 35);
});

test("effectiveStopPct: base floor is absolute (negative stopLossPct ok)", () => {
  // The static key is signed (+35/-35) — the effective width must be positive.
  // Without an explicit cap the widened width is bounded by the static base
  // (cap defaults to base), so a negative stopLossPct still yields a positive,
  // static-bounded result — never a loss-side exit wider than the cap allows.
  assert.equal(effectiveStopPct(-35, 20, 10), 35);
  // With an explicit cap, the widened width applies and stays positive.
  assert.equal(effectiveStopPct(-35, 20, 10, 80), 70);
});

test("decideExit: vol-widened stop fires at the widened level, not the static", () => {
  // Static stop −35%. 2× vol → widened −70%. A −40% pnl must still HOLD
  // (above the widened stop) but would have fired the static stop.
  const s = state({
    currentPriceTon: 0.0006, // −40%
    realizedVol: 20,
    baseRealizedVol: 10,
    slVolWidenMaxPct: 80,
  });
  const d = decideExit(s);
  assert.equal(d.action, "hold");
});

test("decideExit: vol-widened stop still fires at the widened level", () => {
  // −40% is within the widened −70% stop; a −75% pnl clears it.
  const s = state({
    currentPriceTon: 0.00025, // −75%
    realizedVol: 20,
    baseRealizedVol: 10,
    slVolWidenMaxPct: 80,
  });
  const d = decideExit(s);
  assert.equal(d.action, "stop_loss");
  assert.match(d.reason, /vol-widened to 70%/);
});
