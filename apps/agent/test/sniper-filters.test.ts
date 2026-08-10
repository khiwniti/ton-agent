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
