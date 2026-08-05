/**
 * Agent Runtime — config loader.
 * Reads env once at startup. Export `CONFIG` singleton.
 */
import "dotenv/config";
import * as path from "path";
import * as fs from "fs";

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

export const CONFIG = {
    network: opt("NETWORK", "mainnet") as "mainnet" | "testnet",
    rpcEndpoint: opt(
        "TON_RPC_ENDPOINT",
        "https://toncenter.com/api/v2/jsonRPC"
    ),
    tonApiKey: opt("TON_API_KEY", ""),
    tonapiKey: opt("TONAPI_KEY", ""),
    tonapiBase: opt("TONAPI_BASE", "https://tonapi.io/v2"),
    mnemonic: reqAny("WALLET_MASTER_MNEMONIC", "WALLET_MNEMONIC"),
    walletVersion: opt("WALLET_VERSION", "v5r1") as "v3r2" | "v4r2" | "v5r1",
    walletSubwalletId: num("WALLET_SUBWALLET_ID", 698983191),
    publicWebhookUrl: opt("PUBLIC_WEBHOOK_URL", ""),
    observeOnly: bool("OBSERVE_ONLY", false),
    agentSharedSecret: req("AGENT_SHARED_SECRET"),
    nvidiaApiKey: req("NVIDIA_API_KEY"),
    nvidiaModel: opt("NVIDIA_MODEL", "meta/llama-3.1-405b-instruct"),
    tavilyApiKey: req("TAVILY_API_KEY"),
    openaiApiKey: req("OPENAI_API_KEY"),
    anthropicApiKey: req("ANTHROPIC_API_KEY"),
    telegramToken: req("TELEGRAM_BOT_TOKEN"),
    telegramChatId: req("TELEGRAM_CHAT_ID"),
    strategy: {
        maxRiskPct: num("MAX_PORTFOLIO_RISK_PCT", 15),
        minBankrollTon: num("MIN_WALLET_BANKROLL_TON", 1),
        defaultSnipeTon: num("DEFAULT_SNIPE_TON", 0.5),
        slippageTolerance: num("SLIPPAGE_TOLERANCE", 15),
        stopLossPct: num("STOP_LOSS_PCT", 35),
        takeProfitT1Pct: num("TAKE_PROFIT_T1_PCT", 100),
        preferredDex: opt("PREFERRED_DEX", "stonfi") as "stonfi" | "dedust",
    },
    watchlist: opt("WATCHLIST", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    teleton: {
        enabled: bool("TELETON_ENABLED", false),
        apiId: req("TELETON_API_ID"),
        apiHash: req("TELETON_API_HASH"),
        session: req("TELETON_SESSION"),
    },
    // Phase 4 (spec 002 §8.5 / §17): when false, the hot-path
    // position monitor delegates to the legacy wallet/position-manager
    // ticker — so an unsuspecting operator sees zero behavioural change
    // (FR-013 pattern). Flipping to true engages the pure
    // exit/policy-engine.ts state machine + journal-first tick loop.
    exitEngineEnabled: bool("EXIT_ENGINE_ENABLED", false),
};

export const isTestnet = () => CONFIG.network === "testnet";

/**
 * Variables required by the long-running production agent. Supabase
 * credentials are intentionally excluded: they belong to the separately
 * deployed web app, while the agent authenticates through its webhook.
 */
export function getMissingRuntimeEnv(): string[] {
    const missing: string[] = [];
    const requireAny = (label: string, ...keys: string[]) => {
        if (!keys.some((key) => process.env[key]?.trim())) missing.push(label);
    };

    requireAny("WALLET_MASTER_MNEMONIC (or WALLET_MNEMONIC)", "WALLET_MASTER_MNEMONIC", "WALLET_MNEMONIC");
    requireAny("AGENT_SHARED_SECRET", "AGENT_SHARED_SECRET");
    requireAny("PUBLIC_WEBHOOK_URL", "PUBLIC_WEBHOOK_URL");
    requireAny("NVIDIA_API_KEY (or OPENAI_API_KEY or ANTHROPIC_API_KEY)", "NVIDIA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY");

    return missing;
}

export function assertRuntimeEnv(): void {
    const missing = getMissingRuntimeEnv();
    if (missing.length > 0) {
        throw new Error(`Missing required runtime environment variables: ${missing.join(", ")}`);
    }
}

