/**
 * Main agent runtime entry.
 * Boots:
 *   • Hot wallet + balance print
 *   • LangChain trade brain sanity check
 *   • Radar loop (60s cadence)
 *   • Position monitor (10s cadence)
 */
import { log } from "./logger";
import { CONFIG } from "./config";
import { makeClient, openWallet, loadKeyPair } from "./wallet/wallet";
import { fromNano } from "@ton/ton";
import { startRadar } from "./radar/scanner";
import { runMonitor } from "./wallet/position-manager";

async function main() {
    log.banner(
        "TON AUTONOMOUS AGENT",
        "LangChain+MCP • NVIDIA NIM • Ston.fi & DeDust • TONAPI"
    );
    log.info("BOOT", `network=${CONFIG.network} rpc=${CONFIG.rpcEndpoint}`);
    log.info("BOOT", `preferred dex=${CONFIG.strategy.preferredDex}`);

    // Wallet sanity
    if (!CONFIG.mnemonic) {
        log.warn("BOOT", "WALLET_MNEMONIC unset — running OBSERVE-ONLY mode");
    } else {
        try {
            const client = makeClient();
            const kp = await loadKeyPair();
            const w = openWallet(client, kp);
            const bal = await w.getBalance();
            log.ok("BOOT", `wallet=${w.address.toString()} bal=${fromNano(bal)} TON`);
            const balTon = Number(fromNano(bal));
            if (balTon < CONFIG.strategy.minBankrollTon) {
                log.warn("BOOT", `bankroll ${balTon} < ${CONFIG.strategy.minBankrollTon} TON — trades paused until refilled`);
            }
        } catch (e: any) {
            log.err("BOOT", `wallet boot failed: ${e.message}`);
        }
    }

    // AI keys sanity
    if (!CONFIG.anthropicApiKey && !CONFIG.openaiApiKey && !CONFIG.nvidiaApiKey) {
        log.warn("BOOT", "NO_LLM_KEY — agent will not perform trade planning. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY.");
    } else {
        log.ok("BOOT", "AI provider detected — brain online");
    }

    // Webhook target sanity
    if (!CONFIG.publicWebhookUrl) {
        log.warn("BOOT", "PUBLIC_WEBHOOK_URL unset — agent won't push live events to the web app");
    }

    // Start the loops
    try {
        await startRadar();
    } catch (e: any) { log.err("BOOT", `radar failed: ${e.message}`); }

    try {
        await runMonitor();
    } catch (e: any) { log.err("BOOT", `monitor failed: ${e.message}`); }

    log.ok("BOOT", "Agent loops running. Press Ctrl+C to stop.");
}

main().catch(e => log.err("BOOT", `Fatal: ${e.message}`));
