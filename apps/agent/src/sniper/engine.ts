/**
 * x1000 Uranus memepad sniper engine — autonomous scan → filter → buy →
 * monitor → exit loop.
 *
 * Execution path (research-verified, 2026-08-06):
 *   1. DISCOVER  — DeDust coins API (dedust_v3_memepad, age-desc).
 *   2. GATE      — pure risk filters (filters.ts): verification level,
 *                  curve liquidity floor, curve band, holders, spam.
 *   3. QUOTE     — POST /v4/router/quote (exact_in, memepad protocol).
 *   4. BUILD     — POST /v4/router/swap → {address, amount, payload}.
 *   5. SIGN+SEND — wallet v5r1 direct (or agentic budgeting wallet when
 *                  SNIPER_USE_BUDGETING_WALLET=true).
 *   6. CONFIRM   — poll /v2/traces?msg_hash= until complete.
 *   7. EXIT      — same router path reversed (jetton → native), SL +
 *                  trend-exit from filters.decideExit (2026-08-09: no
 *                  TP/trailing targets — winners ride until the trend
 *                  significantly flips to downtrend).
 *
 * Safety invariants (all fail-closed):
 *   • SNIPER_ENABLED=false → module inert.
 *   • OBSERVE_ONLY or SNIPER_DRY_RUN → scan/gate/quote only, no sign/send.
 *   • Per-trade cap, portfolio %, daily realized-loss breaker, max open
 *     positions — all enforced before any quote is requested.
 *   • Positions live in the dedicated sniper_positions table so the
 *     existing exit-engine never double-manages them.
 */
import { Cell, Address, SendMode, internal } from "@ton/ton";
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "../config";
import { log } from "../logger";
import { makeClient, openWallet, loadKeyPair, type KeyPair } from "../wallet/wallet";
import {
  prepareDelegatedWallet,
  executeSwapViaBudgetingWallet,
} from "../wallet/agentic-wallet";
import { decisionJournalStore, sniperPositionStore, type DbSniperPosition } from "../storage/store";
import {
  fetchNewLaunches,
  fetchCoin,
  getMemepadQuote,
  buildSwapPayload,
  getTraceStatus,
  assetToMaster,
  masterToAsset,
  nanoToTon,
  parseCellFromB64,
  ROUTER_GAS_TON,
  ROUND_TRIP_GAS_TON,
} from "./x1000-client";
import {
  evaluateLaunch,
  decideExit,
  confirmedByFeeds,
  mergeFill,
  positionSizeTon,
  type ExitState,
  type ExitConfirmation,
  type SniperGateConfig,
} from "./filters";
import { TrendTracker, type TrendSignal } from "../exit/trend-monitor";
import { realizedVol } from "../exit/volatility-regime";
import {
  breakEvenPct,
  minViablePositionTon,
  ROUND_TRIP_FEE_PCT,
} from "../economics/trade-economics";
import { getTonUsd } from "./coingecko";
import { fetchHoldersTotal } from "../http/tonapi";

// ── Journal helper ──────────────────────────────────────────────────

function journal(kind: string, data: Record<string, unknown>) {
  try {
    decisionJournalStore.append({
      id: `sniper-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cycle_id: `sniper-${new Date().toISOString().slice(0, 13)}`,
      agent: "sniper",
      final_action: kind,
      output: data,
      input_hash: "sniper",
    });
  } catch (e: unknown) {
    log.warn("SNIPER", `journal append failed: ${errMsg(e)}`);
  }
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Gate config from CONFIG ─────────────────────────────────────────

function gateConfig(): SniperGateConfig {
  const s = CONFIG.sniper;
  return {
    minVerificationLevel: s.minVerificationLevel,
    minCurveTon: s.minCurveTon,
    maxCurvePct: s.maxCurvePct,
    minDistinctBuyers: s.minDistinctBuyers,
    maxAgeSec: 24 * 3600,
    minScore: s.minScore,
    rejectTokenPatterns: [
      /^a\d{4,}$/i,
      /^(test|faucet|airdrop|claim|bonus|free)/i,
      /[^\x20-\x7e]/,
    ],
  };
}

// ── Wallet adapter ──────────────────────────────────────────────────

interface SendResult {
  ok: boolean;
  hash?: string;
  error?: string;
}

/**
 * Sign + broadcast ONE router message. Direct path: master wallet v5r1.
 * Budgeting path: delegated agent key + budgeting contract forward.
 */
async function sendRouterTx(args: {
  to: string;
  amountNano: string;
  payloadB64: string;
  kp: KeyPair;
}): Promise<SendResult> {
  const { to, amountNano, payloadB64, kp } = args;
  const client = makeClient();
  const body = parseCellFromB64(payloadB64);
  // Must be a MessageRelaxed built by internal() — @ton/ton reads msg.info.type
  // when serialising, so a plain {to,value,body} object throws
  // "Cannot read properties of undefined (reading 'type')" at send time.
  // Matches the four call sites in dex/router.ts.
  const msg = internal({ to: Address.parse(to), value: BigInt(amountNano), body });
  log.info("SNIPER", `sendRouterTx: useBudgeting=${CONFIG.sniper.useBudgetingWallet} to=${to.slice(0,16)}… amount=${nanoToTon(amountNano).toFixed(4)} TON`);
  if (CONFIG.sniper.useBudgetingWallet) {
    const ownerWallet = openWallet(client, kp);
    const ownerAddress = ownerWallet.address;
    const codeCell = loadBudgetingCodeCell();
    const { agentKeyPair, contractAddress } = await prepareDelegatedWallet(
      client,
      ownerAddress,

      Math.max(1, CONFIG.sniper.perTradeTon * 5),
      "low",
      codeCell,
    );
    const res = await executeSwapViaBudgetingWallet(
      client,
      agentKeyPair,
      contractAddress,
      Address.parse(to),
      nanoToTon(amountNano),
      body,
      "low",
    );
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }


  const wallet = openWallet(client, kp);
  const seqno = await wallet.getSeqno();
  await wallet.sendTransfer({
    seqno,
    secretKey: kp.sec,
    sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
    messages: [msg],
  });
  return { ok: true, hash: `seqno-${seqno}` };
}
/** All 24 columns upsert binds as named params — fill defaults, then override. */
function positionRow(overrides: Partial<DbSniperPosition> & { id: string }): DbSniperPosition {
  return {
    asset: "",
    master: "",
    symbol: null,
    status: "OPEN",
    entry_tx_hash: null,
    entry_at: 0,
    spent_ton_nano: "0",
    amount_tokens_nano: "0",
    entry_price_ton: 0,
    peak_price_ton: 0,
    current_price_ton: null,
    pnl_pct: null,
    tp1_hit: 0,
    tp1_tx_hash: null,
    close_tx_hash: null,
    close_reason: null,
    close_at: null,
    migrated: 0,
    curve_pct_at_entry: null,
    notes: null,
    max_hold_ms: null,
    exit_by_ms: null,
    technique: "sniper",
    ...overrides,
  };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function loadBudgetingCodeCell(): Cell {
  const candidates = [
    path.resolve(process.cwd(), "build/contracts/budgeting-wallet.boc"),
    path.resolve(process.cwd(), "../../build/contracts/budgeting-wallet.boc"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return Cell.fromBoc(fs.readFileSync(p))[0];
  }
  throw new Error(
    "SNIPER_USE_BUDGETING_WALLET=true but no compiled contract found. Run: acton compile contracts/budgeting-wallet.tolk --boc build/contracts/budgeting-wallet.boc",
  );
}

// ── Scan tick ───────────────────────────────────────────────────────

const seenTickers = new Map<string, number>();

/**
 * Per-position trend tracker (operator directive 2026-08-09). Winners ride
 * the trend with no TP/trailing targets and close on a CONFIRMED downtrend
 * flip; the static stop-loss stays the hard loss floor.
 */
const trendTracker = new TrendTracker({
  fastEmaPeriod: CONFIG.sniper.trendExitFastEma,
  slowEmaPeriod: CONFIG.sniper.trendExitSlowEma,
  confirmTicks: CONFIG.sniper.trendExitConfirmTicks,
  historySize: CONFIG.sniper.trendExitHistory,
  minObservations: CONFIG.sniper.trendExitMinObservations,
});

/** Signal returned when trend exits are disabled — never fires. */
const trendDisabled: TrendSignal = {
  bearish: false,
  confirmations: 0,
  confirmed: false,
  observations: 0,
  fastEma: 0,
  slowEma: 0,
  macdHistogram: 0,
  reason: "",
};

// ── Third-party exit confirmation (Fix 4, 2026-08-09) ───────────────
//
// The trend signal alone fired PAWZ's close at −2% after ~59s (seed-baseline
// EMA flip). Fix 4 requires live on-chain corroboration before a CONFIRMED
// trend flip is trusted to close a position:
//
//   1. DeDust traders — net-selling participation in h24
//      (sell.h24 > 0 AND buy/sell ratio < 1).
//   2. TONAPI holder delta — a shrinking holder count vs. the baseline we
//      captured on the position's first observation.
//
// Both feeds were verified live (2026-08-09). Fail closed: any missing /
// non-finite / error reading → NOT confirmed → hold. The pure gate
// `confirmedByFeeds` lives in filters.ts so it is unit-testable.

/**
 * Baseline holder count per position, captured on the first observation and
 * compared against the live value when a trend flip needs confirmation. A
 * baseline of `null` (TONAPI unreachable at open) disables the holder leg —
 * the DeDust trader leg must then confirm alone.
 */
const holdersBaseline = new Map<string, number>();

/** One discovery + gating + buy pass. Exported for tests/dry-run. */
export async function scanTick(kp: KeyPair | null): Promise<{ scanned: number; passed: number; bought: number }> {
  const s = CONFIG.sniper;
  const launches = await fetchNewLaunches({ limit: 30, maxCurvePct: s.maxCurvePct });
  let passed = 0;
  let bought = 0;

  const open = sniperPositionStore.listOpen();
  if (open.length >= s.maxOpenPositions) {
    log.info("SNIPER", `scan: ${open.length}/${s.maxOpenPositions} open — skipping new entries`);
    return { scanned: launches.length, passed: 0, bought: 0 };
  }

  const today = dayKey();
  const spentToday = sniperPositionStore.spentToday(today);
  const realizedToday = sniperPositionStore.realizedToday(today);
  const dailyLoss =
    s.dailyLossLimitTon > 0 &&
    realizedToday < 0 &&
    nanoToTon(realizedToday.toString()) <= -s.dailyLossLimitTon;
  if (dailyLoss) {
    log.err("SNIPER", `daily loss breaker: realized ${nanoToTon(realizedToday.toString()).toFixed(3)} TON`);
    return { scanned: launches.length, passed: 0, bought: 0 };
  }

  const tonUsd = await getTonUsd().catch(() => null);
  const cfg = gateConfig();

  // ── 2026-08-09: sub-viable positions are GUARANTEED losses ─────────
  // Router gas is FLAT (~0.2 TON round trip) and does not scale with size,
  // so a 0.05 TON lot must rise ~+400% just to break even. The scan loop was
  // opening these anyway (the swap-loop drain: repeated tiny buys churning
  // the bankroll into gas). Stand down below the same viability floor the
  // hot path enforces (sizePosition / minViablePositionTon). Sized against
  // the expected profit target with the built-in 2x safety factor, so the
  // floor lands ~0.8–1.6 TON with defaults: the sniper refuses to open a
  // guaranteed-loss position until SNIPER_PER_TRADE_TON is raised above it
  // or the wallet is funded. Computed once — pure function of config.
  const minViable = minViablePositionTon({
    targetPct: s.takeProfitT1Pct,
    gasTon: ROUND_TRIP_GAS_TON,
    feePct: ROUND_TRIP_FEE_PCT,
  });

  // Every tick re-evaluates the whole feed, so a coin that passes the gates
  // keeps passing on the next tick too. With no "already holding" check the
  // loop re-buys the same token until the wallet drains — on 2026-08-07 that
  // bought MRG seven times in ~90s for ~1 TON, 0.7 of which went to flat
  // router gas. `seenTickers` cannot cover this: it keys on ticker (to catch
  // batch-launch spam) and is a soft -15 score penalty, not a gate.
  //
  // `open` is a snapshot from the top of the tick, so this set is also the
  // in-tick record: buys made below are added to it.
  const heldMasters = new Set(open.map((p) => p.master));

  // Operator handoff guard: masters the operator traded manually are
  // permanently off-limits to the scan. Without this the scan buy path's
  // upsert (id = x1000-0:<master>) re-opens the CLOSED handoff row — on
  // 2026-08-12 the engine re-bought CROAK twice the operator had already
  // closed by hand and parked on the operator's own manual positions.
  const handoffMasters = sniperPositionStore.handoffMasters();

  for (const coin of launches) {
    const asset = coin.asset;
    const ticker = coin.metadata?.ticker ?? "";
    const master = assetToMaster(asset);

    // Same reason the snapshot needs updating: the maxOpen check above ran
    // once, before any of this tick's buys existed.
    if (heldMasters.size >= s.maxOpenPositions) {
      log.info("SNIPER", `scan: reached ${s.maxOpenPositions} open positions — stopping this pass`);
      break;
    }
    if (heldMasters.has(master)) {
      log.info("SNIPER", `skip ${master.slice(0, 14)}… ${ticker || "?"}: already holding`);
      continue;
    }
    if (handoffMasters.has(master)) {
      log.info("SNIPER", `skip ${master.slice(0, 14)}… ${ticker || "?"}: operator handoff — not re-buying`);
      continue;
    }

    const verdict = evaluateLaunch(coin, cfg, { now: Date.now(), seenTickers, tonUsd: tonUsd ?? undefined });
    // Record the ticker AFTER gating. Setting it first made every coin find
    // itself in `seenTickers` and eat its own -15 duplicate-ticker penalty.
    if (ticker) seenTickers.set(ticker.toLowerCase(), Date.now());
    if (!verdict.pass) {
      log.info("SNIPER", `skip ${master.slice(0, 14)}… ${ticker || "?"}: ${verdict.reasons.join("; ")}`);
      continue;
    }
    passed += 1;

    // Portfolio / daily cap. Dry-run has no wallet: assume the cap.
    const bankroll = kp ? await getWalletBalanceTon(kp) : 0;
    // Router gas is flat per swap and is NOT part of the lot, so every open
    // position owes ~0.1 TON of exit gas that no cap accounted for. Reserve it
    // for the positions already open plus this one, or the wallet can fund
    // entries it cannot fund exits for and the last positions strand.
    // `heldMasters.size`, not `open.length`: it counts this tick's buys too, so
    // the second entry in a pass reserves exit gas for the first one as well.
    const gasReserveTon = (heldMasters.size + 1) * ROUTER_GAS_TON;
    const spendableTon = Math.max(0, bankroll - gasReserveTon - ROUTER_GAS_TON);
    const size = kp
      ? positionSizeTon({
          perTradeTon: s.perTradeTon,
          portfolioAllocationPct: s.portfolioPct,
          bankrollTon: spendableTon,
          dailyRemainingTon: Math.max(0, s.perTradeTon * s.maxOpenPositions - nanoToTon(spentToday.toString())),
        })
      : s.perTradeTon;
    if (size <= 0) {
      log.warn("SNIPER", `skip ${ticker}: position size ${size} TON (bankroll ${bankroll.toFixed(2)}, gas reserve ${gasReserveTon.toFixed(2)} for ${heldMasters.size} open + 1)`);
      continue;
    }

    if (size < minViable) {
      log.warn(
        "SNIPER",
        `skip ${ticker}: size ${size.toFixed(3)} TON < min viable ${minViable.toFixed(3)} TON ` +
          `(flat round-trip gas ${ROUND_TRIP_GAS_TON} TON → break-even ${breakEvenPct({ positionTon: size, gasTon: ROUND_TRIP_GAS_TON }).toFixed(0)}%). ` +
          `Raise SNIPER_PER_TRADE_TON above ${minViable.toFixed(2)} or fund the wallet — refusing to open a guaranteed-loss position.`,
      );
      continue;
    }

    if (CONFIG.observeOnly || s.dryRun || !kp) {
      log.ok("SNIPER", `DRY-RUN would buy ${ticker} ${size} TON (score ${verdict.score}) — ${asset}`);
      journal("dry-buy", { asset, ticker, sizeTon: size, score: verdict.score });
      // Claim it in dry-run too, so a dry pass reports the same entry count a
      // live pass would instead of "buying" one token 30 times.
      heldMasters.add(master);
      continue;
    }

    try {
      // Claimed BEFORE the await: buyToken is async, and the whole point of the
      // guard is that nothing else in this pass touches the same token.
      heldMasters.add(master);
      const ok = await buyToken(coin, size, kp);
      if (ok) bought += 1;
      else heldMasters.delete(master);
    } catch (e: unknown) {
      heldMasters.delete(master);
      log.err("SNIPER", `buy ${ticker} failed: ${errMsg(e)}`);
      journal("buy-failed", { asset, ticker, error: errMsg(e) });
    }
  }

  return { scanned: launches.length, passed, bought };
}

async function getWalletBalanceTon(kp: KeyPair | null): Promise<number> {
  if (!kp) return 0;
  // Test override: skip TONAPI if SNIPER_TEST_BALANCE_TON is set
  const testBal = process.env.SNIPER_TEST_BALANCE_TON;
  if (testBal) return parseFloat(testBal);
  const client = makeClient();
  const wallet = openWallet(client, kp);
  const bal = await client.getBalance(wallet.address);
  return nanoToTon(bal.toString());
}

/** Quote + build + sign + send one buy; records the position. */
export async function buyToken(coin: { asset: string; metadata?: { ticker?: string; name?: string } }, sizeTon: number, kp: KeyPair): Promise<boolean> {
  const master = assetToMaster(coin.asset);
  const ticker = coin.metadata?.ticker ?? master.slice(0, 8);
  const amountNano = Math.round(sizeTon * 1e9).toString();

  const quote = await getMemepadQuote({
    inMinter: "native",
    outMinter: masterToAsset(master),
    amountNano,
    slippageBps: CONFIG.sniper.slippageBps,
  });
  log.info("SNIPER", `quote for ${ticker}: in=${quote.in_amount} out=${quote.out_amount} data_len=${typeof quote.swap_data === "string" ? quote.swap_data.length : "?"}`);
  const expectedOutNano = BigInt(quote.out_amount ?? "0");
  if (!quote.out_amount) throw new Error(`quote missing out_amount: ${JSON.stringify(quote)}`);
  const client = makeClient();
  const wallet = openWallet(client, kp);
  const txs = await buildSwapPayload({
    swapData: quote.swap_data,
    senderAddress: wallet.address.toRawString().replace(/^[01]:/, "0:"),
  });
  const tx = txs[0];
  if (!tx) throw new Error("swap returned no transactions");

  const res = await sendRouterTx({
    to: tx.address,
    amountNano: tx.amount,
    payloadB64: tx.payload,
    kp,
  });
  if (!res.ok) throw new Error(res.error || "send failed");

  const entryPriceTon = nanoToTon(expectedOutNano.toString()) > 0 ? sizeTon / nanoToTon(expectedOutNano.toString()) : 0;
  const id = `x1000-${master}`;

  // The row id is derived from the master, so a second buy of the same token
  // upserts onto the SAME primary key. The store's ON CONFLICT sets
  // spent/amount to `excluded.*` — i.e. overwrite, not add — so without this
  // the ledger keeps only the most recent fill. That is what hid six of the
  // seven MRG buys on 2026-08-07: the DB showed 0.034 TON while the daily
  // ledger (which does accumulate) showed the true 1.0 TON, and `listOpen()`
  // returned one position forever, so maxOpenPositions could never bind.
  //
  // The per-asset guard in scanTick should stop re-buys before they get here.
  // This is the backstop for the paths it does not cover — restart mid-tick,
  // manual buy, a future caller — because losing cost basis silently is worse
  // than the duplicate itself.
  const prior = sniperPositionStore.get(id);
  const accumulate = prior?.status === "OPEN";
  const merged = mergeFill(
    accumulate
      ? {
          spentNano: BigInt(prior.spent_ton_nano),
          tokensNano: BigInt(prior.amount_tokens_nano),
          peakPriceTon: prior.peak_price_ton,
        }
      : null,
    { spentNano: BigInt(amountNano), tokensNano: expectedOutNano },
  );
  if (accumulate) {
    log.warn("SNIPER", `${ticker}: adding to existing position — ${nanoToTon(prior.spent_ton_nano)} + ${sizeTon} = ${nanoToTon(merged.spentNano)} TON`);
  }

  const entryAt = accumulate ? prior.entry_at : Date.now();
  // Phase 5.1 hard time-stop: journal the deadline at open (recomputed from
  // entry_at at monitor time, so a later SNIPER_MAX_HOLD_MS change applies
  // to already-open positions on the next tick).
  const maxHoldMs = CONFIG.sniper.maxHoldMs > 0 ? CONFIG.sniper.maxHoldMs : null;
  sniperPositionStore.upsert(positionRow({
    id,
    asset: coin.asset,
    master,
    symbol: ticker,
    status: "OPEN",
    entry_tx_hash: res.hash ?? null,
    entry_at: entryAt,
    spent_ton_nano: merged.spentNano.toString(),
    amount_tokens_nano: merged.tokensNano.toString(),
    entry_price_ton: merged.avgEntryPriceTon,
    peak_price_ton: merged.peakPriceTon,
    current_price_ton: entryPriceTon,
    pnl_pct: 0,
    tp1_hit: accumulate ? prior.tp1_hit : 0,
    migrated: 0,
    curve_pct_at_entry: null,
    max_hold_ms: maxHoldMs,
    exit_by_ms: maxHoldMs != null ? entryAt + maxHoldMs : null,
  }));
  sniperPositionStore.addSpent(dayKey(), BigInt(amountNano));
  log.ok("SNIPER", `BOUGHT ${ticker} ${sizeTon} TON → ${nanoToTon(expectedOutNano.toString()).toExponential(3)} tokens @ ${entryPriceTon.toExponential(3)} TON/token (${tx.address.slice(0, 16)}…)`);
  journal("buy", { asset: coin.asset, ticker, sizeTon, spentNano: amountNano, expectedOutNano: expectedOutNano.toString(), tx: res.hash });
  return true;
}

/**
 * Fraction of the position quoted to establish the TREND marginal price.
 * Mirrors MARK_PROBE_FRACTION in hotpath/position-monitor.ts.
 */
const TREND_PROBE_FRACTION = 0.1;

/**
 * Marginal per-token price via a small probe quote; falls back to the
 * full-position quote price when the probe fails or is dust-sized.
 */
async function probePriceTon(
  pos: DbSniperPosition,
  tokensNano: bigint,
  fallbackPriceTon: number,
): Promise<number> {
  const probeTokens = (tokensNano * BigInt(Math.round(TREND_PROBE_FRACTION * 10_000))) / 10_000n;
  if (probeTokens <= 0n) return fallbackPriceTon;
  try {
    const probe = await getMemepadQuote({
      inMinter: masterToAsset(pos.master),
      outMinter: "native",
      amountNano: probeTokens.toString(),
      slippageBps: CONFIG.sniper.slippageBps,
    });
    const probeOutTon = nanoToTon(probe.out_amount);
    if (!Number.isFinite(probeOutTon) || probeOutTon <= 0) return fallbackPriceTon;
    const probeTokensTon = nanoToTon(probeTokens.toString());
    if (probeTokensTon <= 0) return fallbackPriceTon;
    return probeOutTon / probeTokensTon;
  } catch {
    return fallbackPriceTon;
  }
}

// ── Monitor tick ────────────────────────────────────────────────────

/** One position check pass: reprice via sell quote, apply exit rules. */
export async function monitorTick(kp: KeyPair | null): Promise<{ checked: number; exited: number }> {
  const open = sniperPositionStore.listOpen();
  let exited = 0;

  for (const pos of open) {
    try {
      const coin = await fetchCoin(pos.asset);
      const tokensNano = BigInt(pos.amount_tokens_nano);
      const quote = await getMemepadQuote({
        inMinter: masterToAsset(pos.master),
        outMinter: "native",
        amountNano: tokensNano.toString(),
        slippageBps: CONFIG.sniper.slippageBps,
      });
      const outTon = nanoToTon(quote.out_amount);
      const currentPriceTon = outTon / nanoToTon(tokensNano.toString());
      const pnlPct = pos.entry_price_ton > 0 ? (currentPriceTon / pos.entry_price_ton - 1) * 100 : -100;
      const peak = Math.max(pos.peak_price_ton, currentPriceTon);
      const migrated = coin?.memecoin_extra_details?.migrated ? 1 : 0;

      // Trend monitor (operator directive 2026-08-09): no TP/trailing stops —
      // winners ride until the trend significantly flips to downtrend.
      // The trend series uses a small-PROBE marginal price, not the
      // full-position quote: quoting the whole bag reads worse purely for
      // being larger (the same self-poisoned mark the hot path fixed), which
      // would bias the signal bearish on impact alone.
      const trendPriceTon = await probePriceTon(pos, tokensNano, currentPriceTon);
      const trend: TrendSignal = CONFIG.sniper.trendExitEnabled
        ? trendTracker.observe(pos.id, trendPriceTon, pos.entry_price_ton)
        : trendDisabled;

      // Fix 4 (2026-08-09): third-party exit confirmation. A confirmed trend
      // flip alone (PAWZ: seed-baseline EMA after ~59s) must not fire a close.
      // Corroborate with live on-chain feeds — DeDust h24 trader participation
      // + TONAPI holder delta vs. the baseline captured on first observation.
      // Fail closed to `confirmed=false` (hold) on any feed error.
      let trendConfirmed = trend.confirmed;
      if (trendConfirmed && CONFIG.sniper.trendExitConfirmEnabled) {
        const confirm: ExitConfirmation = {
          sellTraders24h: coin?.traders?.sell?.h24 ?? 0,
          buyTraders24h: coin?.traders?.buy?.h24 ?? 0,
          holdersDeltaPct: 0, // filled below when a baseline exists
        };
        const baseline = holdersBaseline.get(pos.id);
        if (baseline === undefined) {
          // First time we've seen this position — capture the baseline so a
          // later flip can be checked against a shrinking holder count.
          const total = await fetchHoldersTotal(pos.master);
          if (total !== null) {
            holdersBaseline.set(pos.id, total);
            confirm.holdersDeltaPct = 0; // no delta yet — neutral on first tick
          } else {
            // TONAPI unreachable at open: holder leg disabled for this
            // position (baseline `null`). Trader leg must confirm alone.
            holdersBaseline.set(pos.id, Number.NaN);
            confirm.holdersDeltaPct = 0;
          }
        } else if (Number.isFinite(baseline) && baseline > 0) {
          const total = await fetchHoldersTotal(pos.master);
          if (total === null) {
            trendConfirmed = false; // feed down → fail closed to hold
          } else {
            confirm.holdersDeltaPct = ((total - baseline) / baseline) * 100;
          }
        }
        if (trendConfirmed && !confirmedByFeeds(confirm)) {
          log.info(
            "SNIPER",
            `trend flip ${pos.symbol} NOT confirmed by feeds (sell24h ${confirm.sellTraders24h}, buy24h ${confirm.buyTraders24h}, holders Δ${confirm.holdersDeltaPct.toFixed(1)}%) — holding`,
          );
          trendConfirmed = false;
        }
      }

      // Phase 5.1 vol-widened SL: realized vol over the trend tracker's close
      // window vs the entry baseline (first observed close). Elevated
      // realized vol widens the effective stop loss-side only — never a
      // trailing rule (2026-08-09 directive). The first observation is the
      // baseline because the tracker's ring buffer seeds flat at entry, so
      // early realized vol is ~0 until real price action lands.
      const closes = trendTracker.closes(pos.id);
      const volState =
        CONFIG.sniper.slVolWidenEnabled && closes.length >= 2
          ? { realizedVol: realizedVol(closes), baseRealizedVol: realizedVol(closes.slice(0, 2)) }
          : undefined;
      const maxHoldMs = pos.max_hold_ms ?? (CONFIG.sniper.maxHoldMs > 0 ? CONFIG.sniper.maxHoldMs : null);

      sniperPositionStore.upsert(positionRow({
        id: pos.id,
        asset: pos.asset,
        master: pos.master,
        // Preserve the stored status: a row set to CLOSED by an operator
        // handoff (or any external close) must not be re-opened by the
        // monitor's reprice upsert. See sniperPositionStore.upsert —
        // `status=excluded.status` is unconditional, so a literal "OPEN"
        // here would silently resurrect closed rows each tick.
        status: pos.status,
        entry_at: pos.entry_at,
        spent_ton_nano: pos.spent_ton_nano,
        amount_tokens_nano: pos.amount_tokens_nano,
        entry_price_ton: pos.entry_price_ton,
        peak_price_ton: peak,
        current_price_ton: currentPriceTon,
        pnl_pct: pnlPct,
        tp1_hit: pos.tp1_hit,
        migrated,
        // Sticky time-stop fields (NULL tick updates preserve stored values).
        max_hold_ms: pos.max_hold_ms,
        exit_by_ms: pos.exit_by_ms,
        // Table-level discriminator (sticky via positionRow default "sniper").
        technique: pos.technique ?? "sniper",
      }));

      const state: ExitState = {
        entryPriceTon: pos.entry_price_ton,
        currentPriceTon,
        stopLossPct: CONFIG.sniper.stopLossPct,
        trendBearish: trendConfirmed,
        trendReason: trend.reason,
        // Gas-aware noise floor: the flat round-trip router gas dominates a
        // small lot, so the close decision needs the actual notional.
        positionTon: nanoToTon(pos.spent_ton_nano),
        roundTripGasTon: ROUND_TRIP_GAS_TON,
        // Phase 5.1 time-stop inputs (recomputed live from entry_at so config
        // changes take effect on the next tick).
        entryTimeMs: pos.entry_at,
        now: Date.now(),
        maxHoldMs,
        // Phase 5.1 vol-widened SL facts (corroboration-only for width).
        realizedVol: volState?.realizedVol ?? undefined,
        baseRealizedVol: volState?.baseRealizedVol ?? undefined,
        slVolWidenMaxPct: CONFIG.sniper.slVolWidenEnabled ? CONFIG.sniper.slVolWidenMaxPct : undefined,
        // §2.2 peak-giveback trail. The peak is monotonic (ratcheted upward
        // only at line 570) and the config ships OFF — behaviour-neutral.
        // Fields are present only when the feature is wired in, so legacy
        // callers of decideExit (and tests) see an unchanged decision path.
        peakPriceTon: peak,
        givebackEnabled: CONFIG.sniper.givebackEnabled,
        givebackArmPct: CONFIG.sniper.givebackArmPct,
        givebackDropPct: CONFIG.sniper.givebackDropPct,
      };
      const decision = decideExit(state);
      if (decision.action === "hold") continue;

      if (CONFIG.observeOnly || CONFIG.sniper.dryRun || !kp) {
        log.ok("SNIPER", `DRY-RUN exit ${pos.symbol} (${decision.action}: ${decision.reason})`);
        journal("dry-exit", { id: pos.id, action: decision.action, reason: decision.reason });
        continue;
      }

      // 2026-08-09: every exit is a FULL close (no TP1 partials remain).
      const fraction = 1;
      const sellOk = await sellToken(pos.id, kp, decision.action, decision.reason, outTon, fraction);
      if (sellOk) {
        trendTracker.forget(pos.id);
        holdersBaseline.delete(pos.id);
        exited += 1;
      }
    } catch (e: unknown) {
      // Fail closed: skip this position for this tick rather than acting on a
      // bad price. An unroutable quote (dead pool / migration / RPC blip)
      // lands here — never as a 0 price, which would read as -100% PnL and
      // trip the stop-loss into a forced sale.
      log.warn("SNIPER", `monitor ${pos.id} (${pos.symbol}) skipped — no usable quote: ${errMsg(e)}`);
    }
  }
  return { checked: open.length, exited };
}

/**
 * Sell a position through the router (curve sell).
 *
 * `fraction` < 1 is a PARTIAL exit (TP1): it sells that share of the token
 * balance, keeps the position OPEN, and sets tp1_hit so decideExit routes the
 * runner to TP2. Before this existed, TP1 sold everything and closed the
 * position, which made tp1_hit and the whole TP2 branch dead code.
 */
export async function sellToken(id: string, kp: KeyPair, action: string, reason: string, expectedOutTon?: number, fraction = 1): Promise<boolean> {
  const pos = sniperPositionStore.get(id);
  if (!pos || pos.status === "CLOSED") return false;
  const heldNano = BigInt(pos.amount_tokens_nano);
  const isPartial = fraction > 0 && fraction < 1;
  const tokensNano = isPartial
    ? (heldNano * BigInt(Math.round(fraction * 10_000))) / 10_000n
    : heldNano;
  if (tokensNano <= 0n) return false;

  const quote = await getMemepadQuote({
    inMinter: masterToAsset(pos.master),
    outMinter: "native",
    amountNano: tokensNano.toString(),
    slippageBps: CONFIG.sniper.slippageBps,
  });

  const client = makeClient();
  const wallet = openWallet(client, kp);
  const txs = await buildSwapPayload({
    swapData: quote.swap_data,
    senderAddress: wallet.address.toRawString().replace(/^[01]:/, "0:"),
  });
  const tx = txs[0];
  if (!tx) throw new Error("swap returned no transactions");

  const res = await sendRouterTx({ to: tx.address, amountNano: tx.amount, payloadB64: tx.payload, kp });
  if (!res.ok) throw new Error(res.error || "send failed");

  const outTon = nanoToTon(quote.out_amount);
  // Realized PnL must be NET of router gas, which is flat per swap and does not
  // scale with size. `spent_ton_nano` holds the lot only (the entry fee rode on
  // tx.amount and was never recorded), so a full exit has to subtract BOTH legs
  // or the daily-loss breaker under-counts every trade and fires too late.
  const gasNano = BigInt(Math.round((isPartial ? ROUTER_GAS_TON : ROUND_TRIP_GAS_TON) * 1e9));
  const costBasisNano = (BigInt(pos.spent_ton_nano) * BigInt(Math.round((isPartial ? fraction : 1) * 10_000))) / 10_000n;
  const realized = BigInt(quote.out_amount) - costBasisNano - gasNano;
  sniperPositionStore.addRealized(dayKey(), realized);

  const remainingNano = heldNano - tokensNano;
  sniperPositionStore.upsert(positionRow({
    id: pos.id,
    asset: pos.asset,
    master: pos.master,
    symbol: pos.symbol,
    status: isPartial ? "OPEN" : "CLOSED",
    entry_at: pos.entry_at,
    // Keep the cost basis of the REMAINING tokens so the runner's PnL and its
    // own gas subtraction stay honest.
    spent_ton_nano: isPartial ? (BigInt(pos.spent_ton_nano) - costBasisNano).toString() : pos.spent_ton_nano,
    amount_tokens_nano: remainingNano.toString(),
    entry_price_ton: pos.entry_price_ton,
    peak_price_ton: pos.peak_price_ton,
    tp1_hit: isPartial ? 1 : pos.tp1_hit,
    tp1_tx_hash: isPartial ? (res.hash ?? null) : pos.tp1_tx_hash,
    close_tx_hash: isPartial ? null : (res.hash ?? null),
    close_reason: isPartial ? null : `${action}: ${reason}`,
    close_at: isPartial ? null : Date.now(),
    migrated: pos.migrated,
  }));
  log.ok("SNIPER", `${isPartial ? "PARTIAL" : "EXIT"} ${pos.symbol} ${action} → ${outTon.toFixed(4)} TON gross (${nanoToTon(realized.toString()).toFixed(4)} TON net of gas)`);
  journal(isPartial ? "partial-exit" : "exit", { id: pos.id, action, reason, outTon, fraction, realizedNano: realized.toString() });
  return true;
}

// ── Loop control ────────────────────────────────────────────────────

export interface SniperHandle {
  stop: () => void;
}

/** Start the autonomous loop. Returns a handle for graceful shutdown. */
export function startSniper(): SniperHandle {
  const s = CONFIG.sniper;
  const client = makeClient();
  const timers: ReturnType<typeof setInterval>[] = [];

  log.banner("SNIPER", `x1000 Uranus sniper ${s.dryRun || CONFIG.observeOnly ? "(DRY-RUN)" : "(LIVE)"} — scan ${s.scanIntervalMs}ms / monitor ${s.monitorIntervalMs}ms`);

  const kpPromise = (async () => {
    if (CONFIG.observeOnly || s.dryRun) return null;
    const kp = await loadKeyPair();
    const w = openWallet(client, kp);
    const bal = await client.getBalance(w.address);
    log.info("SNIPER", `wallet ${w.address.toString()} balance ${nanoToTon(bal.toString()).toFixed(3)} TON`);
    return kp;
  })();

  let running = true;

  const scanLoop = async () => {
    if (!running) return;
    try {
      const kp = await kpPromise;
      const r = await scanTick(kp);
      log.info("SNIPER", `scan: ${r.scanned} seen, ${r.passed} passed, ${r.bought} bought`);
    } catch (e: unknown) {
      log.err("SNIPER", `scan tick failed: ${errMsg(e)}`);
    }
  };
  const monitorLoop = async () => {
    if (!running) return;
    try {
      const kp = await kpPromise;
      const r = await monitorTick(kp);
      if (r.checked > 0) log.info("SNIPER", `monitor: ${r.checked} positions, ${r.exited} exited`);
    } catch (e: unknown) {
      log.err("SNIPER", `monitor tick failed: ${errMsg(e)}`);
    }
  };

  timers.push(setInterval(scanLoop, s.scanIntervalMs));
  timers.push(setInterval(monitorLoop, s.monitorIntervalMs));
  // Immediate first pass.
  scanLoop();
  monitorLoop();

  return {
    stop: () => {
      running = false;
      for (const t of timers) clearInterval(t);
    },
  };
}
