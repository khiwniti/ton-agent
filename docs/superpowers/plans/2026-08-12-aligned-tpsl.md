# Aligned TP/SL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the operator-approved alignment of the TON Agent's TP/SL onto the Claude.ai chain "Intelligent Stop Loss and Take Profit for Swing Trading Crypto": giveback trail as the winner-close core, ATR band journal-only corroboration, vol-widened SL, SNIPER time-stop, and chain-sizing (pool-depth cap + slippage probe).

**Architecture:** All exit-logic changes are pure-function changes in `sniper/filters.ts` + config-key flips in `config.ts`, exercised by `decideExit()` unit tests; the engine (`sniper/engine.ts`) already wires the giveback trail and vol-widen facts into the exit state — this plan adds the ATR journal row and the two sizing guards at the buy site, then flips the prod Fly secrets per the spec's deploy table.

**Tech Stack:** TypeScript (Node 20), `node:test`, `tsx`, better-sqlite3 (SQLite at `DATA_DIR`), Fly.io secrets.

## Global Constraints

- **Node 24 build environment (team memory):** prefix every node/npm/test command with the Node v24.15.0 PATH — `export PATH="$HOME/.local/share/mise/shims:$PATH"` (or the exact PATH from `node24-build-env.md`) — or better-sqlite3 will not load on system Node 26.
- **Test runner:** per-file process isolation via `apps/agent/scripts/run-tests.sh` (sets fresh `DATA_DIR` + test mnemonic). Do NOT run `tsx --test` on the whole directory in one process — config/store singletons bleed between suites.
- **Prod DB probing:** pipe a probe script into `fly ssh console -a ton-agent-runtime -C "node -"`; single-quote the script; no `//` comments (they collapse the heredoc). Any new env var in the plan must be set via `fly secrets set -a ton-agent-runtime` (each set restarts the machine).
- **Do NOT touch SWING** (no time-stop, no giveback; only SNIPER keys ship). All changes are SNIPER-scoped per the spec.
- **Vercel/Vercel CLI:** irrelevant to this repo (agent runs on Fly.io). Ignore Vercel session guidance here.

---

### Task 1: Ship the giveback trail (config default ON)

**Files:**
- Create: `apps/agent/test/config-defaults.test.ts`
- Modify: `apps/agent/src/config.ts:271` (`givebackEnabled` default)
- Regression: `apps/agent/test/sniper-filters.test.ts` (existing giveback tests stay green — they pass `givebackEnabled: true` explicitly)

**Interfaces:**
- Consumes: `CONFIG` from `apps/agent/src/config.ts` (eager singleton; pure env reads, safe to import in tests under the runner's DATA_DIR/mnemonic env).
- Produces: config default `givebackEnabled: true` so the prod secret flip (Task 8) is the only remaining activation. The engine already passes `givebackEnabled: CONFIG.sniper.givebackEnabled` into the exit state (engine.ts:701), so the flip flows through without engine changes.

- [ ] **Step 1: Write the failing test (default-on)**

Create `apps/agent/test/config-defaults.test.ts`:

```ts
/**
 * Pin the aligned-TP/SL config defaults (spec 2026-08-12). CONFIG is an
 * eager singleton reading process.env at import; the runner provides
 * DATA_DIR + mnemonic. These assertions fail first, then flip the defaults.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../src/config.js";

test("aligned TP/SL: giveback trail ships enabled by default", () => {
  assert.equal(CONFIG.sniper.givebackEnabled, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env DATA_DIR=$(mktemp -d) WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/config-defaults.test.ts`
Expected: FAIL — `CONFIG.sniper.givebackEnabled` is `false` (current default).

- [ ] **Step 3: Flip the default**

In `apps/agent/src/config.ts` (sniper block), change:

```ts
givebackEnabled: bool("SNIPER_GIVEBACK_ENABLED", false),
```

to:

```ts
givebackEnabled: bool("SNIPER_GIVEBACK_ENABLED", true),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=<node24> scripts/run-tests.sh`
Expected: config-defaults passes; sniper-filters still green (the giveback unit tests pass `givebackEnabled: true` explicitly and do not depend on the default).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/test/config-defaults.test.ts
git commit -m "feat(sniper): ship giveback trail as default-on winner-close"
```

---

### Task 2: ATR corroboration band (journal-only)

**Files:**
- Create: `apps/agent/src/exit/atr-band.ts`
- Modify: `apps/agent/src/sniper/engine.ts:677-704` (ExitState construction) and `apps/agent/src/sniper/engine.ts:708-716` (journal call site)
- Test: `apps/agent/test/atr-band.test.ts` (new)

**Interfaces:**
- Consumes: `atrClose(closes: number[], period?: number): number` from `apps/agent/src/exit/volatility-regime.ts:43`; `trendTracker.closes(pos.id): number[]`; `CONFIG.sniper.trendExitAtrMult` (number, default 3.0, journal-only today).
- Produces: `atrBandState(opts: { closes: number[]; atrMult?: number; entryPriceTon: number; peakPriceTon: number }): { bandLevelTon: number | null; breached: boolean }` — pure, unit-tested. Band = `peakPriceTon − atrMult × atr`; `breached` when `closes[last] < band`. Never emitted as an exit action; the engine journals it.

- [ ] **Step 1: Write the failing test**

Create `apps/agent/test/atr-band.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { atrBandState } from "../src/exit/atr-band.js";

test("atrBandState: computes a Chandelier-style band below the peak", () => {
  const closes = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0];
  const r = atrBandState({ closes, atrMult: 3, entryPriceTon: 1.0, peakPriceTon: 2.0 });
  assert.ok(r.bandLevelTon != null && r.bandLevelTon < 2.0, `band ${r.bandLevelTon} below peak`);
  assert.ok(r.bandLevelTon > 1.0, `band ${r.bandLevelTon} above entry (3xATR on this series)`);
});

test("atrBandState: never reports a band without enough closes", () => {
  const r = atrBandState({ closes: [1.0], atrMult: 3, entryPriceTon: 1.0, peakPriceTon: 1.5 });
  assert.equal(r.bandLevelTon, null);
  assert.equal(r.breached, false);
});

test("atrBandState: breached when the last close pierces the band", () => {
  const closes = [1.0, 1.2, 1.4, 1.6, 1.8, 1.5]; // high ATR then a drop
  const r = atrBandState({ closes, atrMult: 1, entryPriceTon: 1.0, peakPriceTon: 1.8 });
  assert.equal(r.breached, true);
});

test("atrBandState: band clamps to entry — a winner cannot 'breach' below its cost", () => {
  const closes = [1.0, 1.01, 1.02, 1.03, 1.04, 1.05];
  const r = atrBandState({ closes, atrMult: 3, entryPriceTon: 1.0, peakPriceTon: 1.05 });
  assert.ok(r.bandLevelTon == null || r.bandLevelTon >= 1.0, `clamped band ${r.bandLevelTon}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/atr-band.test.ts`
Expected: FAIL — `Cannot find module '../src/exit/atr-band.js'`.

- [ ] **Step 3: Implement the pure function**

Create `apps/agent/src/exit/atr-band.ts`:

```ts
/**
 * Chandelier-style ATR band — JOURNAL-ONLY corroboration (§1 of the aligned
 * TP/SL design, 2026-08-12). It trails `atrMult` × ATR below the highest
 * peak, mirroring the chain's Chandelier/Supertrend signal, but it is NEVER
 * a sell trigger: the engine writes it to decision_journal for post-trade
 * analysis. The three authoritative triggers remain structure-stop, giveback,
 * and trend-flip.
 */
import { atrClose } from "./volatility-regime.js";

export interface AtrBandOpts {
  closes: number[];
  atrMult?: number;
  entryPriceTon: number;
  peakPriceTon: number;
}

export interface AtrBandState {
  /** Band level in TON; null when there are too few closes to compute ATR. */
  bandLevelTon: number | null;
  /** Last close pierced the band from above. */
  breached: boolean;
}

export function atrBandState(opts: AtrBandOpts): AtrBandState {
  const atrMult = opts.atrMult ?? 3;
  if (!Number.isFinite(opts.entryPriceTon) || opts.entryPriceTon <= 0 || !Number.isFinite(opts.peakPriceTon) || opts.peakPriceTon <= 0) {
    return { bandLevelTon: null, breached: false };
  }
  const closes = opts.closes.filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 2) return { bandLevelTon: null, breached: false };

  const atr = atrClose(closes);
  if (!Number.isFinite(atr) || atr <= 0) return { bandLevelTon: null, breached: false };

  const raw = opts.peakPriceTon - atrMult * atr;
  // Clamp to entry: a winner's band can never sit below its own cost basis,
  // which would read a +40% position as "breached" at breakeven.
  const bandLevelTon = Math.max(raw, opts.entryPriceTon);
  const breached = closes[closes.length - 1] < bandLevelTon;
  return { bandLevelTon, breached };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/atr-band.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the journal row in the engine**

In `apps/agent/src/sniper/engine.ts`, import the function, then inside `monitorTick` after the upsert and before `decideExit(state)`, compute the band from the trend closes and journal it **unconditionally** (append-only; never gates the exit):

```ts
import { atrBandState } from "../exit/atr-band.js";
```

In `monitorTick`, just before `const decision = decideExit(state);` — reusing the `closes` variable already fetched at line 644 (`const closes = trendTracker.closes(pos.id);`):

```ts
      // §1 ATR corroboration (journal-only). Append-only: written every tick
      // a band is computable, never used as an exit trigger.
      const band = atrBandState({
        closes,
        atrMult: CONFIG.sniper.trendExitAtrMult,
        entryPriceTon: pos.entry_price_ton,
        peakPriceTon: peak,
      });
      if (band.bandLevelTon != null) {
        journal("atr-band", {
          id: pos.id,
          bandLevelTon: band.bandLevelTon,
          atrMult: CONFIG.sniper.trendExitAtrMult,
          breached: band.breached,
          currentPriceTon,
          pnlPct,
        });
      }
```

(The `journal(kind, data)` helper at `engine.ts:73-86` already appends with `final_action: kind`, `input_hash: "sniper"` — no change needed.)

- [ ] **Step 6: Verify the engine still compiles and the suite passes**

Run: `PATH=<node24> npm run build -w apps/agent` then `PATH=<node24> scripts/run-tests.sh`
Expected: build clean; all suites green.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/exit/atr-band.ts apps/agent/src/sniper/engine.ts apps/agent/test/atr-band.test.ts
git commit -m "feat(exit): ATR Chandelier band as journal-only corroboration"
```

---

### Task 3: Ship the vol-widened SL

**Files:**
- Modify: `apps/agent/test/config-defaults.test.ts` (created in Task 1)
- Modify: `apps/agent/src/config.ts:277` (`slVolWidenEnabled` default)
- Regression: `apps/agent/test/sniper-filters.test.ts` (existing `effectiveStopPct` tests at lines 546-582 stay green — they pass `slVolWidenMaxPct` explicitly)

**Interfaces:**
- Consumes: `effectiveStopPct(stopLossPct, realizedVol, baseRealizedVol, maxPct?)` — positional args, already implemented, clamps the base −35% up to `slVolWidenMaxPct` 50% in SPIKED regimes. Unchanged.
- Produces: config default `slVolWidenEnabled: true`. The engine already gates `slVolWidenMaxPct` into the exit state on `CONFIG.sniper.slVolWidenEnabled` (engine.ts:695), so the flip flows through without engine changes.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent/test/config-defaults.test.ts`:

```ts
test("aligned TP/SL: volatility-widened SL ships enabled by default", () => {
  assert.equal(CONFIG.sniper.slVolWidenEnabled, true);
});

test("aligned TP/SL: widened-stop cap default is 50%", () => {
  assert.equal(CONFIG.sniper.slVolWidenMaxPct, 50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env DATA_DIR=$(mktemp -d) WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/config-defaults.test.ts`
Expected: FAIL — `CONFIG.sniper.slVolWidenEnabled` is `false` (current default).

- [ ] **Step 3: Flip the default**

In `apps/agent/src/config.ts`:

```ts
slVolWidenEnabled: bool("SNIPER_SL_VOL_WIDEN", false),
```

to:

```ts
slVolWidenEnabled: bool("SNIPER_SL_VOL_WIDEN", true),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=<node24> scripts/run-tests.sh`
Expected: all green (config-defaults + the positional `effectiveStopPct` unit tests in sniper-filters).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/test/config-defaults.test.ts
git commit -m "feat(sniper): ship volatility-widened SL as default-on"
```

---

### Task 4: Ship the SNIPER time-stop

**Files:**
- Modify: `apps/agent/test/config-defaults.test.ts`
- Modify: `apps/agent/src/config.ts:225` (`maxHoldMs` default)
- Test: `apps/agent/test/sniper-filters.test.ts` (add time-stop unit test — pins the `decideExit` branch independent of config)

**Interfaces:**
- Consumes: `decideExit`'s `entryTimeMs` / `now` / `maxHoldMs` branch (already implemented — fires `time_exit` when `now − entryTimeMs ≥ maxHoldMs`).
- Produces: config default `maxHoldMs: 3600000`.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent/test/config-defaults.test.ts`:

```ts
test("aligned TP/SL: SNIPER time-stop ships at 1h", () => {
  assert.equal(CONFIG.sniper.maxHoldMs, 3_600_000);
});
```

Also add the branch unit test to `apps/agent/test/sniper-filters.test.ts` (this pins the `decideExit` time branch and passes regardless of the config default — it passes `maxHoldMs` explicitly):

```ts
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
  assert.match(d.reason, /time/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env DATA_DIR=$(mktemp -d) WALLET_MASTER_MNEMONIC="test test test test test test test test test test test junk" ../../node_modules/.bin/tsx --test test/config-defaults.test.ts`
Expected: FAIL — `CONFIG.sniper.maxHoldMs` is `0` (current default). (The `decideExit` branch test passes immediately — that branch was implemented in the 2026-08-12 time-exit wiring.)

- [ ] **Step 3: Flip the default**

In `apps/agent/src/config.ts` (sniper block):

```ts
maxHoldMs: num("SNIPER_MAX_HOLD_MS", 0),
```

to:

```ts
maxHoldMs: num("SNIPER_MAX_HOLD_MS", 3600000),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=<node24> scripts/run-tests.sh`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/test/config-defaults.test.ts apps/agent/test/sniper-filters.test.ts
git commit -m "feat(sniper): ship 1h SNIPER time-stop as default-on"
```

---

### Task 5: Sizing guard — worst-case SL economics

**Files:**
- Modify: `apps/agent/src/sniper/engine.ts` sizing block (lines 386-394, the `if (size < minViable)` check)
- Test: `apps/agent/test/policy-manager.test.ts` or new `apps/agent/test/sizing-guard.test.ts`

**Interfaces:**
- Consumes: `minViablePositionTon`, `breakEvenPct`, `CONFIG.sniper.perTradeTon`, `CONFIG.sniper.slVolWidenMaxPct` (all in scope at the buy site).
- Produces: a pure `worstCaseSlLossOk({ perTradeTon, slVolWidenMaxPct, minViablePositionTon }): boolean` helper exported from `sniper/engine.ts` (or a new `sniper/sizing.ts`) so the guard is unit-testable without the wallet.

- [ ] **Step 1: Write the failing test**

Create `apps/agent/test/sizing-guard.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { worstCaseSlLossOk } from "../src/sniper/sizing.js";

test("worstCaseSlLossOk: a 0.15 lot clears the floor at the widened stop", () => {
  // perTradeTon × (1 − slVolWidenMaxPct/100) = 0.15 × 0.5 = 0.075 ≥ minViable
  assert.equal(worstCaseSlLossOk({ perTradeTon: 0.15, slVolWidenMaxPct: 50, minViablePositionTon: 0.05 }), true);
});

test("worstCaseSlLossOk: a lot that cannot survive the widened SL is refused", () => {
  // 0.06 × 0.5 = 0.03 < 0.05 → refuse (worst-case SL eats the gas floor)
  assert.equal(worstCaseSlLossOk({ perTradeTon: 0.06, slVolWidenMaxPct: 50, minViablePositionTon: 0.05 }), false);
});

test("worstCaseSlLossOk: no widening → plain perTradeTon floor applies", () => {
  assert.equal(worstCaseSlLossOk({ perTradeTon: 0.06, slVolWidenMaxPct: 0, minViablePositionTon: 0.05 }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/sizing-guard.test.ts`
Expected: FAIL — `Cannot find module '../src/sniper/sizing.js'`.

- [ ] **Step 3: Implement the helper + wire the guard**

Create `apps/agent/src/sniper/sizing.ts`:

```ts
/**
 * Worst-case SL economics (spec §2 "Sizing guard", 2026-08-12).
 *
 * Vol-widening raises the effective stop distance (worst case
 * `slVolWidenMaxPct` instead of the base), so the lot must still clear the
 * economic floor at THAT distance: `perTradeTon × (1 − slVolWidenMaxPct/100)`
 * is what survives a worst-case SL fill, and it must be ≥ the min-viable
 * floor or gas eats the position before it can ever be a winner.
 */
export function worstCaseSlLossOk(args: {
  perTradeTon: number;
  slVolWidenMaxPct: number;
  minViablePositionTon: number;
}): boolean {
  const survive = args.perTradeTon * (1 - args.slVolWidenMaxPct / 100);
  return survive >= args.minViablePositionTon;
}
```

In `apps/agent/src/sniper/engine.ts`, after the existing `if (size < minViable)` block (line 394), add:

```ts
    // Spec §2 sizing guard: at the vol-widened stop the worst-case loss is
    // slVolWidenMaxPct of the lot; if what survives can't clear the min-viable
    // floor, the position is a guaranteed loss at the widened stop even if it
    // clears at the base stop. Refuse.
    if (worstCaseSlLossOk({ perTradeTon: size, slVolWidenMaxPct: CONFIG.sniper.slVolWidenMaxPct, minViablePositionTon: minViable }) === false) {
      log.warn("SNIPER", `skip ${ticker}: size ${size.toFixed(3)} TON cannot survive the widened SL ` +
        `(${(size * (1 - CONFIG.sniper.slVolWidenMaxPct / 100)).toFixed(3)} TON after -${CONFIG.sniper.slVolWidenMaxPct}% < min viable ${minViable.toFixed(3)} TON)`);
      continue;
    }
```

Import `worstCaseSlLossOk` from `./sizing.js` at the top of `engine.ts`.

- [ ] **Step 4: Run tests + build to verify**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/sizing-guard.test.ts` then `PATH=<node24> npm run build -w apps/agent`
Expected: tests PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/sniper/sizing.ts apps/agent/src/sniper/engine.ts apps/agent/test/sizing-guard.test.ts
git commit -m "feat(sizing): refuse lots that cannot survive the vol-widened SL"
```

---

### Task 6: Sizing guard — % of pool depth cap

**Files:**
- Modify: `apps/agent/src/config.ts` (add `SNIPER_MAX_POOL_DEPTH_SHARE_PCT`, default 2)
- Modify: `apps/agent/src/sniper/engine.ts` buy-site sizing (before `buyToken`)
- Test: `apps/agent/test/sizing-guard.test.ts`

**Interfaces:**
- Consumes: `coin.memecoin_extra_details.curve_ton_collected` (nanoTON string — pool depth available to buy against); `nanoToTon()`.
- Produces: `poolDepthCapTon(poolDepthNano: string | null | undefined, maxSharePct: number): number | null` in `sniper/sizing.ts` — null when no depth data (no cap, legacy coins).

- [ ] **Step 1: Write the failing test**

Add to `apps/agent/test/sizing-guard.test.ts`:

```ts
import { poolDepthCapTon } from "../src/sniper/sizing.js";

test("poolDepthCapTon: caps the lot at maxSharePct of pool depth", () => {
  // 10 TON depth, 2% → cap 0.2 TON
  assert.equal(poolDepthCapTon("10000000000", 2), 0.2);
});

test("poolDepthCapTon: null when the pool reports no depth", () => {
  assert.equal(poolDepthCapTon(undefined, 2), null);
  assert.equal(poolDepthCapTon(null, 2), null);
});

test("poolDepthCapTon: zero/malformed depth → null (no cap)", () => {
  assert.equal(poolDepthCapTon("0", 2), null);
  assert.equal(poolDepthCapTon("abc", 2), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/sizing-guard.test.ts`
Expected: FAIL — `poolDepthCapTon` not exported.

- [ ] **Step 3: Implement**

In `apps/agent/src/sniper/sizing.ts`, add:

```ts
/**
 * %-of-pool-depth cap (spec §4, 2026-08-12): cap the lot at `maxSharePct`
 * of the pool's collected depth so a buy cannot move price more than ~that
 * against itself on a thin memepad curve. null when depth is unknown — the
 * legacy coins don't report it, and refusing them would strand the feature.
 */
export function poolDepthCapTon(
  poolDepthNano: string | null | undefined,
  maxSharePct: number,
): number | null {
  if (poolDepthNano == null) return null;
  const depthTon = Number(poolDepthNano) / 1e9;
  if (!Number.isFinite(depthTon) || depthTon <= 0) return null;
  return depthTon * (maxSharePct / 100);
}
```

Add the config key in `apps/agent/src/config.ts` sniper block (next to `perTradeTon`):

```ts
maxPoolDepthSharePct: num("SNIPER_MAX_POOL_DEPTH_SHARE_PCT", 2),
```

In `apps/agent/src/sniper/engine.ts`, in the scan loop where `size` is decided (after the worst-case guard), add:

```ts
    // Spec §4 %-of-pool-depth cap: refuse a lot that would move the pool
    // more than maxPoolDepthSharePct against itself. Null depth → no cap.
    const depthCap = poolDepthCapTon(coin.memecoin_extra_details?.curve_ton_collected, CONFIG.sniper.maxPoolDepthSharePct);
    if (depthCap != null && size > depthCap) {
      log.warn("SNIPER", `skip ${ticker}: size ${size.toFixed(3)} TON > pool depth cap ${depthCap.toFixed(3)} TON (${CONFIG.sniper.maxPoolDepthSharePct}% of ${nanoToTon(coin.memecoin_extra_details.curve_ton_collected).toFixed(3)} TON curve)`);
      continue;
    }
```

- [ ] **Step 4: Run tests + build to verify**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/sizing-guard.test.ts` then `PATH=<node24> npm run build -w apps/agent`
Expected: tests PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/src/sniper/sizing.ts apps/agent/src/sniper/engine.ts apps/agent/test/sizing-guard.test.ts
git commit -m "feat(sizing): cap lot at % of pool depth"
```

---

### Task 7: Sizing guard — slippage probe before entry

**Files:**
- Modify: `apps/agent/src/sniper/engine.ts` buy path (`buyToken` — quote already fetched there)
- Test: `apps/agent/test/sizing-guard.test.ts`

**Interfaces:**
- Consumes: `getMemepadQuote()` → `RouterQuote` with `swap_is_possible?: boolean`, `price_impact?: number`, `out_amount: string`.
- Produces: `slippageProbeOk(quote: { swap_is_possible?: boolean; price_impact?: number }, maxImpactPct: number): { ok: boolean; reason?: string }` in `sniper/sizing.ts`.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent/test/sizing-guard.test.ts`:

```ts
import { slippageProbeOk } from "../src/sniper/sizing.js";

test("slippageProbeOk: over-tolerance price impact → skip", () => {
  const r = slippageProbeOk({ swap_is_possible: true, price_impact: 12 }, 5);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /impact/i);
});

test("slippageProbeOk: within tolerance → proceed", () => {
  const r = slippageProbeOk({ swap_is_possible: true, price_impact: 2 }, 5);
  assert.equal(r.ok, true);
});

test("slippageProbeOk: impossible swap → skip", () => {
  const r = slippageProbeOk({ swap_is_possible: false, price_impact: undefined }, 5);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /not possible/i);
});

test("slippageProbeOk: no impact data → proceed (legacy quote)", () => {
  const r = slippageProbeOk({ swap_is_possible: true, price_impact: undefined }, 5);
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/sizing-guard.test.ts`
Expected: FAIL — `slippageProbeOk` not exported.

- [ ] **Step 3: Implement**

In `apps/agent/src/sniper/sizing.ts`, add:

```ts
/**
 * Slippage probe (spec §4, 2026-08-12): before executing, request the real
 * quote and refuse a fill that deviates beyond tolerance from the model's
 * pool-price assumption. Prevents buying a fill worse than the model thinks.
 */
export function slippageProbeOk(
  quote: { swap_is_possible?: boolean; price_impact?: number },
  maxImpactPct: number,
): { ok: boolean; reason?: string } {
  if (quote.swap_is_possible === false) {
    return { ok: false, reason: "router reports the swap is not possible" };
  }
  const impact = quote.price_impact;
  if (impact == null || !Number.isFinite(impact)) {
    return { ok: true }; // legacy quote without impact data → no probe signal
  }
  if (impact > maxImpactPct) {
    return { ok: false, reason: `price impact ${impact.toFixed(1)}% > tolerance ${maxImpactPct}%` };
  }
  return { ok: true };
}
```

Add a config key next to `slippageBps` in `apps/agent/src/config.ts`:

```ts
slippageProbeMaxImpactPct: num("SNIPER_SLIPPAGE_PROBE_MAX_IMPACT_PCT", 5),
```

In `apps/agent/src/sniper/engine.ts`, inside `buyToken` right after the quote is fetched (line 447, before `buildSwapPayload`), add:

```ts
  // Spec §4 slippage probe: refuse a fill that moves the price beyond
  // tolerance — buying that is a guaranteed-worse entry than the model priced.
  const probe = slippageProbeOk(quote, CONFIG.sniper.slippageProbeMaxImpactPct);
  if (!probe.ok) {
    throw new Error(`slippage probe failed for ${ticker}: ${probe.reason}`);
  }
```

(The `throw` is deliberate: `buyToken`'s caller already deletes the held claim and journals `buy-failed` in the catch at `engine.ts:412-414` — a probed-out entry is recorded, not silently skipped.)

- [ ] **Step 4: Run tests + build to verify**

Run: `PATH=<node24> ../../node_modules/.bin/tsx --test test/sizing-guard.test.ts` then `PATH=<node24> npm run build -w apps/agent`
Expected: tests PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/src/sniper/sizing.ts apps/agent/src/sniper/engine.ts apps/agent/test/sizing-guard.test.ts
git commit -m "feat(sizing): slippage probe refuses over-tolerance fills"
```

---

### Task 8: Full-suite regression + deploy

**Files:**
- Modify: none (verification + prod secrets)

- [ ] **Step 1: Full test suite**

Run: `PATH=<node24> scripts/run-tests.sh`
Expected: ALL TEST FILES PASSED (now 31 files with the three new suites: `config-defaults`, `atr-band`, `sizing-guard`).

- [ ] **Step 2: Build**

Run: `PATH=<node24> npm run build -w apps/agent`
Expected: clean compile (this is the Fly deploy build gate).

- [ ] **Step 3: Commit any stragglers + confirm tree**

```bash
git add -A
git commit -m "test(sniper): atr-band + sizing-guard suites"
```

(If nothing is staged, skip this step.)

- [ ] **Step 4: Deploy the code to prod**

From the REPO ROOT (Dockerfile + fly.toml live there):

```bash
cd /Users/admin/ton-agent && fly deploy -a ton-agent-runtime
```

Expected: deploy succeeds (verify with `fly status -a ton-agent-runtime` → Running).

- [ ] **Step 5: Flip the prod secrets per the spec change table**

```bash
fly secrets set -a ton-agent-runtime \
  SNIPER_GIVEBACK_ENABLED=true \
  SNIPER_MAX_HOLD_MS=3600000 \
  SNIPER_SL_VOL_WIDEN=true \
  SNIPER_MAX_OPEN_POSITIONS=5
```

(Each `fly secrets set` restarts the machine; set them all in one command so there is a single restart.)

- [ ] **Step 6: Verify live config took effect**

Probe prod (single-quoted heredoc, no `//` comments):

```bash
cat /tmp/verify-config.cjs | fly ssh console -a ton-agent-runtime -C "node -"
```

with `/tmp/verify-config.cjs` containing:

```js
const { CONFIG } = require("./apps/agent/dist/config.js");
const s = CONFIG.sniper;
console.log(JSON.stringify({
  givebackEnabled: s.givebackEnabled,
  maxHoldMs: s.maxHoldMs,
  slVolWidenEnabled: s.slVolWidenEnabled,
  slVolWidenMaxPct: s.slVolWidenMaxPct,
  maxOpenPositions: s.maxOpenPositions,
  perTradeTon: s.perTradeTon,
}, null, 2));
```

Expected output: `givebackEnabled: true`, `maxHoldMs: 3600000`, `slVolWidenEnabled: true`, `slVolWidenMaxPct: 50`, `maxOpenPositions: 5`, `perTradeTon: 0.15`.

- [ ] **Step 7: Confirm the watch loop sees the new exit behaviour (smoke)**

Run the watch probe from the prior CROAK session (or `fly logs -a ton-agent-runtime | tail -50`) for ~10 minutes.
Expected: no `WATCH|open=0` regression; if a position exists it is monitored with the giveback/time/vol facts in the journal rows (`decision_journal` rows with `final_action` in `giveback_exit | time_exit | atr-band`).

- [ ] **Step 8: Commit the deploy-state doc update**

In `docs/superpowers/specs/2026-08-12-aligned-tpsl-design.md`, update the "Deployed-config change summary" table to note the secrets are live (add a `Deployed: yes (2026-08-12)` annotation), then:

```bash
git add docs/superpowers/specs/2026-08-12-aligned-tpsl-design.md
git commit -m "docs(exit): mark aligned TP/SL config deployed to prod"
```

---

## Self-Review

**Spec coverage:**
- §1 winner-close giveback → Task 1 (default-on) + Task 2 (ATR journal-only corroboration). ✔
- §2 structure SL keep + vol-widen ship → Task 3 (default-on; structure SL untouched). ✔
- §2 sizing guard → Task 5 (worst-case SL economics). ✔
- §3 time-stop 1h SNIPER → Task 4 (default 3600000). ✔
- §4 min-viable floor (keep) → pre-existing; sizing guard adds the widened-stop variant. ✔
- §4 %-of-pool-depth cap → Task 6. ✔
- §4 slippage-probe → Task 7. ✔
- §5 circuit breakers unchanged → no task (documented in spec). ✔
- §6 tests (giveback arm/fire/clamp, ATR journal, vol-widen clamp, time-stop, pool cap, probe, sizing guard) → Tasks 1-7 tests. ✔
- Deployed-config table → Task 8. ✔

**Placeholder scan:** No TBD/TODO. Every step has concrete code or commands. Tasks 1/3/4 assert config defaults through `CONFIG` (the only observable of a default flip — `decideExit`/`effectiveStopPct` take their values as arguments from the engine, so a config-default test cannot go through them). `effectiveStopPct` is positional-args; the plan uses that shape in the regression note, not an object. ✔

**Type consistency:** `atrBandState`, `worstCaseSlLossOk`, `poolDepthCapTon`, `slippageProbeOk` names and signatures are defined once (in Tasks 2/5/6/7) and reused in later tasks. `engine.ts` imports reference `../exit/atr-band.js` and `./sizing.js` matching the created files. Config keys: `SNIPER_MAX_POOL_DEPTH_SHARE_PCT`, `SNIPER_SLIPPAGE_PROBE_MAX_IMPACT_PCT` consistent across Tasks 6/7. `config-defaults.test.ts` is created in Task 1 and extended in Tasks 3/4 — consistent path. ✔
