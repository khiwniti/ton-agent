/**
 * Agent Runtime — config loader.
 * Reads env once at startup. Export `CONFIG` singleton.
 */
import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { MIN_EXECUTABLE_POOL_LIQUIDITY_TON } from "./risk/scoring";

// Walk up to find the monorepo-root .env
const candidates = [
    process.cwd() + "/.env",
    path.resolve(process.cwd(), "../../../.env"),
    path.resolve(process.cwd(), "../../.env"),
];
for (const c of candidates) {
    if (fs.existsSync(c)) {
        require("dotenv").config({ path: c });
        break;
    }
}

const req = (k: string) => {
    const v = process.env[k];
    if (!v || v.trim() === "") {
        console.error(`[CONFIG] ⚠ Missing ${k} — feature disabled.`);
        return "";
    }
    return v;
};

/**
 * Like `req()` but tries multiple env var names in order, warns ONCE with
 * all names when none are set. Used when a config key has been renamed but
 * legacy env vars still work — e.g. WALLET_MASTER_MNEMONIC (new) vs.
 * WALLET_MNEMONIC (legacy).
 */
const reqAny = (...keys: string[]): string => {
    for (const k of keys) {
        const v = process.env[k];
        if (v && v.trim() !== "") return v;
    }
    // None of the keys resolved — warn once with all enumerated names.
    console.error(`[CONFIG] ⚠ Missing one of [${keys.join(", ")}] — feature disabled.`);
    return "";
};
const opt = (k: string, fb: string) => (process.env[k] && process.env[k] !== "" ? process.env[k]! : fb);
const num = (k: string, fb: number) => {
    const v = process.env[k];
    if (!v) return fb;
    const n = parseFloat(v);
    return isFinite(n) ? n : fb;
};
const bool = (k: string, fb: boolean) => {
    const v = process.env[k];
    if (!v) return fb;
    return v.toLowerCase() === "true" || v === "1";
};

const network = opt("NETWORK", "mainnet") as "mainnet" | "testnet";
const defaultRpc = network === "testnet"
    ? "https://testnet.toncenter.com/api/v2/jsonRPC"
    : "https://toncenter.com/api/v2/jsonRPC";
const defaultTonapiBase = network === "testnet"
    ? "https://testnet.tonapi.io/v2"
    : "https://tonapi.io/v2";

export const CONFIG = {
    network,
    rpcEndpoint: opt("TON_RPC_ENDPOINT", defaultRpc),
    tonApiKey: opt("TON_API_KEY", ""),
    tonapiKey: opt("TONAPI_KEY", ""),
    tonapiBase: opt("TONAPI_BASE", defaultTonapiBase),
    mnemonic: reqAny("WALLET_MASTER_MNEMONIC", "WALLET_MNEMONIC"),
    walletVersion: opt("WALLET_VERSION", "v5r1") as "v3r2" | "v4r2" | "v5r1",
    walletSubwalletId: num("WALLET_SUBWALLET_ID", 698983191),
    publicWebhookUrl: opt("PUBLIC_WEBHOOK_URL", ""),
    observeOnly: bool("OBSERVE_ONLY", false),
    agentSharedSecret: req("AGENT_SHARED_SECRET"),
    nvidiaApiKey: req("NVIDIA_API_KEY"),
    nvidiaModel: opt("NVIDIA_MODEL", "nvidia/nemotron-3-ultra-550b-a55b"),
    exaApiKey: opt("EXA_API_KEY", ""),
    strategy: {
        maxRiskPct: num("MAX_PORTFOLIO_RISK_PCT", 15),
        // 2026-07-24: user challenge mode. Operator's sole 1.26 TON balance
        // was getting blocked by the 1-TON bankroll floor (need 1.5 TON
        // headroom for any buy, but wallet only had 1.26). Lower the floor
        // to ~0 — EXIT_RESERVE_TON (0.4) still keeps the wallet from
        // draining past sell-gas, which is the truly critical invariant.
        // Re-enable by setting MIN_WALLET_BANKROLL_TON=1 once capital
        // returns.
        minBankrollTon: num("MIN_WALLET_BANKROLL_TON", 0),
        // 2026-07-24: user challenge mode. BUY_AMOUNT_TON is a single-knob
        // override for the per-trade ceiling read by the radar scanner
        // (`defCap`). Setting to 0.3 lets 0.3 TON positions flow through;
        // combined with MAX_PORTFOLIO_ALLOCATION_PCT=25 below, the cap
        // chain becomes `min(LOW_MAX_POSITION_TON=0.5, allocCap=0.315,
        // defCap=0.3) = 0.3` so a single 0.3 TON buy fills with ~1 TON left
        // for sell-back gas + bankroll cushion. FALLS BACK to
        // DEFAULT_SNIPE_TON so legacy callers (and tests) keep working.
        buyAmountTon: num("BUY_AMOUNT_TON", 0) || num("DEFAULT_SNIPE_TON", 0.5),
        defaultSnipeTon: num("DEFAULT_SNIPE_TON", 0.5),
        slippageTolerance: num("SLIPPAGE_TOLERANCE", 15),
        stopLossPct: num("STOP_LOSS_PCT", 35),
        takeProfitT1Pct: num("TAKE_PROFIT_T1_PCT", 100),
        preferredDex: opt("PREFERRED_DEX", "stonfi") as "stonfi" | "dedust",
        poolMinimumTon: num("POOL_MINIMUM_TON", 0.05),
        auditCacheTtlMs: num("AUDIT_CACHE_TTL_MS", 300_000),
        deadPoolCacheTtlMs: num("DEAD_POOL_CACHE_TTL_MS", 300_000),
        // When true (default), the security audit HARD-requires renounced
        // ownership: a non-renounced (or undetermined-renounce) jetton fails
        // the audit and is skipped. Set AUDIT_REQUIRE_RENOUNCE=false to make
        // renounce ADVISORY — it is still computed and surfaced in the report,
        // but LP-lock + honeypot become the only hard gates. This admits
        // non-renounced trending tokens (higher rug risk from the mint admin),
        // so only run relaxed with tight per-trade caps.
        auditRequireRenounce: bool("AUDIT_REQUIRE_RENOUNCE", true),
        monitorIntervalMs: num("MONITOR_INTERVAL_MS", 10_000),
        radarIntervalMs: num("RADAR_INTERVAL_MS", 300_000),
        // Effective pool-liquidity floor for radar candidates. Defaults to the
        // shared execution gate (MIN_EXECUTABLE_POOL_LIQUIDITY_TON) so the
        // scanner and the confidence gate can never disagree; deploy a lower
        // RADAR_MIN_LIQUIDITY_TON to admit thinner memecoin pools.
        minLiquidityTon: num("RADAR_MIN_LIQUIDITY_TON", MIN_EXECUTABLE_POOL_LIQUIDITY_TON),
        // Trend-based close (operator directive 2026-08-09): winners ride the
        // trend with NO take-profit or trailing targets — a position closes
        // when the trend SIGNIFICANTLY flips to downtrend (fast EMA < slow
        // EMA + negative MACD histogram, confirmed over
        // TREND_EXIT_CONFIRM_TICKS consecutive monitor ticks). The static
        // stop-loss remains the hard loss floor.
        //
        // TREND_EXIT_MIN_OBSERVATIONS (default 6): the min-observations lock
        // (2026-08-09 PAWZ) — a confirmed flip also requires this many REAL
        // price observations, else the EMA pair only needs to move against the
        // flat seed baseline and trend_exit fires from ~3 real ticks (PAWZ
        // closed at −2% after ~59s). TREND_EXIT_CONFIRM_ENABLED (default
        // true): gate trend_exit on live third-party feeds (TONAPI holders
        // delta + DeDust h24 participation) — fail closed when feeds
        // contradict or are down.
        trendExitEnabled: bool("TREND_EXIT_ENABLED", true),
        trendExitFastEma: num("TREND_EXIT_FAST_EMA", 7),
        trendExitSlowEma: num("TREND_EXIT_SLOW_EMA", 25),
        trendExitConfirmTicks: num("TREND_EXIT_CONFIRM_TICKS", 3),
        trendExitHistory: num("TREND_EXIT_HISTORY", 60),
        trendExitMinObservations: num("TREND_EXIT_MIN_OBSERVATIONS", 6),
        trendExitConfirmEnabled: bool("TREND_EXIT_CONFIRM_ENABLED", true),
    },
    watchlist: opt("WATCHLIST", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    // Phase 4 (spec 002 §8.5 / §17): when false, the hot-path
    // position monitor delegates to the legacy wallet/position-manager
    // ticker — so an unsuspecting operator sees zero behavioural change
    // (FR-013 pattern). Flipping to true engages the pure
    // exit/policy-engine.ts state machine + journal-first tick loop.
    exitEngineEnabled: bool("EXIT_ENGINE_ENABLED", true),
    // Spec 006 Phase 8 — HITL gate policy.
    // First live BUY always requires Telegram tap (one-shot per deployment).
    // After that, auto-trade is allowed only when aiScore >= HITL_MIN_AI_SCORE
    // (default 70). Below-threshold signals still require explicit operator
    // approval before signing. Set HITL_MIN_AI_SCORE=0 to disable the
    // threshold check (only the first-trade gate remains).
    hitlMinAiScore: num("HITL_MIN_AI_SCORE", 70),
    // LLM trade brain. The radar's autopilot fast-path (HITL_DISABLE=true) is a
    // complete decision path on its own: audit + confidence score + SafetyCaps.
    // Running the ReAct brain *alongside* it buys nothing — it burns the hourly
    // LLM budget on candidates already decided, and every streamed message is
    // POSTed to the web webhook, which is the `agent_message` flood in the logs.
    // Default therefore follows autopilot: brain OFF when HITL is disabled.
    // Set LLM_BRAIN_ENABLED=true to force it back on regardless.
    brainEnabled: bool("LLM_BRAIN_ENABLED", process.env.HITL_DISABLE !== "true"),
    // Ultra-accretion feature flags (FR-013)
    fastPathEnabled: bool("FAST_PATH_ENABLED", false),
    localSlmEnabled: bool("LOCAL_SLM_ENABLED", false),
    liteClientEnabled: bool("LITE_CLIENT_ENABLED", false),
    directLiteEnabled: bool("DIRECT_LITE_ENABLED", false),
    shardMiningEnabled: bool("SHARD_MINING_ENABLED", false),
    // Tier toggles — HIGH starts OFF by default (must be explicitly enabled)
    tierEnabled: {
        low: bool("TIER_LOW_ENABLED", true),
        mid: bool("TIER_MID_ENABLED", true),
        high: bool("TIER_HIGH_ENABLED", false),
    } as Record<"low" | "mid" | "high", boolean>,
    // x1000 Uranus memepad sniper (research: research/sniper-x1000.md).
    // Inert unless SNIPER_ENABLED=true. Execution path: DeDust v4 router
    // API (quote → swap payload → sign → broadcast), fill confirmation via
    // the traces API, exits via the same router (memepad sell).
    sniper: {
        enabled: bool("SNIPER_ENABLED", false),
        scanIntervalMs: num("SNIPER_SCAN_INTERVAL_MS", 15_000),
        monitorIntervalMs: num("SNIPER_MONITOR_INTERVAL_MS", 20_000),
        // Per-trade size cap (TON). Kept tight: low-liquidity curves can
        // absorb only a few TON before the price moves against the buyer.
        perTradeTon: num("SNIPER_PER_TRADE_TON", 0.2),
        // Portfolio allocation ceiling for all open sniper positions.
        portfolioPct: num("SNIPER_PORTFOLIO_PCT", 25),
        // Daily loss circuit breaker (TON, realized). 0 disables.
        dailyLossLimitTon: num("SNIPER_DAILY_LOSS_LIMIT_TON", 0.5),
        maxOpenPositions: num("SNIPER_MAX_OPEN_POSITIONS", 5),
        slippageBps: num("SNIPER_SLIPPAGE_BPS", 500),
        minCurveTon: num("SNIPER_MIN_CURVE_TON", 5),
        maxCurvePct: num("SNIPER_MAX_CURVE_PCT", 60),
        minVerificationLevel: num("SNIPER_MIN_VERIFICATION_LEVEL", 3),
        // Distinct BUYER WALLETS in 24h. Replaces SNIPER_MIN_HOLDERS: the
        // upstream API reports holders:0 for every memepad coin, so the old
        // key gated on dead data. Legacy key still honoured.
        minDistinctBuyers: num("SNIPER_MIN_DISTINCT_BUYERS", num("SNIPER_MIN_HOLDERS", 3)),
        minScore: num("SNIPER_MIN_SCORE", 55),
        stopLossPct: num("SNIPER_STOP_LOSS_PCT", 35),
        takeProfitT1Pct: num("SNIPER_TAKE_PROFIT_T1_PCT", 100),
        // TP2 must exceed TP1 or both tiers fire on the same tick. Router gas is
        // a flat 0.2 TON round trip, so TP1 at +100% is only break-even on a
        // 0.2 TON lot — the runner at TP2 is where a position actually earns.
        takeProfitT2Pct: num("SNIPER_TAKE_PROFIT_T2_PCT", 250),
        // Share of the position sold at TP1; the rest rides to TP2.
        // DEPRECATED (2026-08-09): TP1/TP2/trailing exits are replaced by the
        // trend-based close (TREND_EXIT_*). Keys retained for env compat but
        // no longer read by the exit decision.
        tp1SellFraction: num("SNIPER_TP1_SELL_FRACTION", 0.5),
        trailingPct: num("SNIPER_TRAILING_PCT", 0),
        // Trend-based close (operator directive 2026-08-09): winners ride the
        // trend with NO take-profit or trailing targets — a position closes
        // when the trend SIGNIFICANTLY flips to downtrend. The static
        // stop-loss remains the hard loss floor.
        trendExitEnabled: bool("TREND_EXIT_ENABLED", true),
        trendExitFastEma: num("TREND_EXIT_FAST_EMA", 7),
        trendExitSlowEma: num("TREND_EXIT_SLOW_EMA", 25),
        trendExitConfirmTicks: num("TREND_EXIT_CONFIRM_TICKS", 3),
        trendExitHistory: num("TREND_EXIT_HISTORY", 60),
        trendExitMinObservations: num("TREND_EXIT_MIN_OBSERVATIONS", 6),
        trendExitConfirmEnabled: bool("TREND_EXIT_CONFIRM_ENABLED", true),
        // Use the agentic budgeting wallet for sends (production-test mode
        // per the user). False = direct master-wallet send.
        useBudgetingWallet: bool("SNIPER_USE_BUDGETING_WALLET", false),
        // ML-based price prediction
        mlEnabled: bool("ML_ENABLED", false),
        mlConfidenceThreshold: num("ML_CONFIDENCE_THRESHOLD", 0.6),
        mlCacheTTLSeconds: num("ML_CACHE_TTL_SECONDS", 30),
        mlRetrainingIntervalHours: num("ML_RETRAINING_INTERVAL_HOURS", 24),
        mlMinConfidenceForTrade: num("ML_MIN_CONFIDENCE_FOR_TRADE", 0.7),
        // Dry-run: scan + filter + quote, never sign/send. Pairs with
        // OBSERVE_ONLY for the top-level kill switch.
        dryRun: bool("SNIPER_DRY_RUN", false),
        // Live execution gate (plan §3.3): default OFF.
        // Requires: mainnet, OBSERVE_ONLY=false, SNIPER_DRY_RUN=false,
        // kill-switch config present, healthy wallet, exclusive wallet ownership.
        // The sniper will NOT send live transactions unless this is explicitly
        // set to true. Prevents accidental live use in staging/review envs.
        liveExecutionEnabled: bool("SNIPER_LIVE_EXECUTION_ENABLED", false),
    },
    // Real-time market data (research: research/01-architecture.md §2).
    // No public WS feed exists on STON.fi or DeDust (both /ws → 404), so
    // "real-time" = REST poll → derive price → event bus. Poll cadence
    // defaults to 3s; a 10s exit-engine tick accumulates confirmTicks on
    // ~3x more market observations than today, cutting effective trend-flip
    // confirmation latency to ~10-15s without touching whipsaw semantics.
    market: {
        pollEnabled: bool("MARKET_POLL_ENABLED", true),
        pollIntervalMs: num("MARKET_POLL_INTERVAL_MS", 3000),
        maxBackoffMs: num("MARKET_MAX_BACKOFF_MS", 15000),
        // Ticks older than this are discarded as stale (never reset streaks).
        staleAfterMs: num("MARKET_STALE_AFTER_MS", 9000),
    },
    get mlEnabled() { return this.sniper.mlEnabled; },
    get mlConfidenceThreshold() { return this.sniper.mlConfidenceThreshold; },
    get mlCacheTTLSeconds() { return this.sniper.mlCacheTTLSeconds; },
    get mlRetrainingIntervalHours() { return this.sniper.mlRetrainingIntervalHours; },
    get mlMinConfidenceForTrade() { return this.sniper.mlMinConfidenceForTrade; },
};

export const isTestnet = () => CONFIG.network === "testnet";
