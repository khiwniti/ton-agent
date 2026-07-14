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
    tonApiKey: req("TON_API_KEY"),
    tonapiBase: opt("TONAPI_BASE", "https://tonapi.io/v2"),
    mnemonic: req("WALLET_MNEMONIC"),
    walletVersion: opt("WALLET_VERSION", "v5r1") as "v3r2" | "v4r2" | "v5r1",
    walletSubwalletId: num("WALLET_SUBWALLET_ID", 698983191),
    publicWebhookUrl: opt("PUBLIC_WEBHOOK_URL", ""),
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
};

export const isTestnet = () => CONFIG.network === "testnet";
