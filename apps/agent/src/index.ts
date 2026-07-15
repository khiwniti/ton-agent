/**
 * Main agent runtime entry.
 *
 * Boots:
 *   • Tier coordinator (per-tier hot wallets, kill-switch poller, status snapshots)
 *   • Radar loop (60s cadence) — detects new TON jettons
 *   • Position monitor (10s cadence) — applies stop-loss / take-profit
 *
 * Long-lived process with graceful shutdown on SIGINT/SIGTERM.
 */
import { log } from "./logger";
import { CONFIG } from "./config";
import { fromNano } from "@ton/ton";
import { makeClient, openWallet, loadKeyPair } from "./wallet/wallet";
import { getCoordinator, startCoordinator, isCoordinatorStarted } from "./core/coordinator";
import { startRadar } from "./radar/scanner";
import { runMonitor } from "./wallet/position-manager";
// Side-effect import — registers all skills so the brain prompt and the
// `npm run skill` CLI see them.
import "./skills";

// Background loops registered here so the shutdown handler can clear them.
type Loop = { name: string; clear: () => void };
const loops: Loop[] = [];
let shuttingDown = false;

function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.banner("SHUTDOWN", `signal=${signal} clearing ${loops.length} loops`);
    for (const l of loops) {
        try { l.clear(); }
        catch (e: any) { log.warn("SHUTDOWN", `${l.name} clear failed: ${e.message}`); }
    }
    // Coordinators have no timers of their own outside this process; sentinel log only.
    log.info("SHUTDOWN", "Tier coordinator snapshot (final):", {
        started: isCoordinatorStarted(),
        coordinates: isCoordinatorStarted() ? getCoordinator().getSnapshot() : null,
    });
    // Allow a tick for any in-flight logs to flush.
    setTimeout(() => process.exit(0), 250).unref();
}

async function main() {
    log.banner(
        "TON AUTONOMOUS AGENT",
        "LangChain+MCP • NVIDIA NIM • Ston.fi & DeDust • TONAPI"
    );
    log.info("BOOT", `network=${CONFIG.network} rpc=${CONFIG.rpcEndpoint}`);
    log.info("BOOT", `preferred dex=${CONFIG.strategy.preferredDex}`);

    // 1. Tier coordinator — derived wallets, kill-switch, circuit breaker.
    try {
        await startCoordinator();
        const snap = getCoordinator().getSnapshot();
        log.ok("BOOT", `coordinator up — tiers=${snap.tiers.length} highUnlocked=${snap.highUnlocked} cb=${snap.circuitBreaker.ok ? "ok" : "TRIPPED"}`);
    } catch (e: any) {
        log.err("BOOT", `coordinator failed to boot: ${e.message}`);
        // Continue: the rest of the runtime still useful for observe-only ops.
    }

    // 2. Legacy single-wallet sanity (kept for parity with prior boot logs).
    if (!CONFIG.mnemonic) {
        log.warn("BOOT", "WALLET_MNEMONIC unset — running OBSERVE-ONLY mode");
    } else {
        try {
            const client = makeClient();
            const kp = await loadKeyPair();
            const w = openWallet(client, kp);
            const bal = await w.getBalance();
            log.ok("BOOT", `primary wallet=${w.address.toString()} bal=${fromNano(bal)} TON`);
            const balTon = Number(fromNano(bal));
            if (balTon < CONFIG.strategy.minBankrollTon) {
                log.warn("BOOT", `bankroll ${balTon} < ${CONFIG.strategy.minBankrollTon} TON — trades paused until refilled`);
            }
        } catch (e: any) {
            log.err("BOOT", `wallet boot failed: ${e.message}`);
        }
    }

    // 3. AI keys sanity
    if (!CONFIG.anthropicApiKey && !CONFIG.openaiApiKey && !CONFIG.nvidiaApiKey) {
        log.warn("BOOT", "NO_LLM_KEY — agent will not perform trade planning. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY.");
    } else {
        log.ok("BOOT", "AI provider detected — brain online");
    }

    // 4. Webhook target sanity
    if (!CONFIG.publicWebhookUrl) {
        log.warn("BOOT", "PUBLIC_WEBHOOK_URL unset — agent won't push live events to the web app");
    }

    // 5. Radar scanner
    try {
        await startRadar();
        log.ok("BOOT", "radar loop running (60s cadence)");
    } catch (e: any) {
        log.err("BOOT", `radar failed: ${e.message}`);
    }

    // 6. Position monitor (SL/TP). It runs its own setInterval internally;
    //    track it for graceful shutdown via a no-op clear on the global queue.
    try {
        await runMonitor();
        log.ok("BOOT", "position monitor running (10s cadence)");
    } catch (e: any) {
        log.err("BOOT", `monitor failed: ${e.message}`);
    }

    // 7. Headline heartbeat — periodic one-line status, very cheap.
    if (isCoordinatorStarted()) {
        const hb = setInterval(() => {
            if (shuttingDown || !isCoordinatorStarted()) return;
            const s = getCoordinator().getSnapshot();
            log.info(
                "HEARTBEAT",
                `up=${Math.floor(s.uptimeSec)}s cb=${s.circuitBreaker.ok ? "ok" : "TRIPPED"} kill=${s.killSwitch.active ? "ON" : "off"} ` +
                    s.tiers.map((t) => `${t.tier.toUpperCase()}=${t.balanceTon.toFixed(2)}T/${t.openPositions}o`).join(" "),
            );
        }, 60_000);
        loops.push({ name: "heartbeat", clear: () => clearInterval(hb) });
    }

    // 8. Local /healthz server (loopback-only). Surfaced for uptime checks
    //    and to expose a plain snapshot for ops dashboards. Disabled unless
    //    HEALTH_PORT is set.
    const HEALTH_PORT = Number(process.env.HEALTH_PORT || 0);
    if (HEALTH_PORT > 0) {
        const http = await import("node:http");
        const server = http.createServer((req, res) => {
            if (req.method !== "GET") {
                res.writeHead(405, { "Content-Type": "text/plain" });
                res.end("method not allowed");
                return;
            }
            if (req.url === "/healthz") {
                const started = isCoordinatorStarted();
                const snap = started ? getCoordinator().getSnapshot() : null;
                const ok = !!snap && snap.circuitBreaker.ok;
                res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        ok,
                        uptimeSec: snap?.uptimeSec ?? 0,
                        startedAt: snap?.startedAt ?? null,
                        coordinatorStarted: started,
                        killSwitch: snap?.killSwitch ?? null,
                        circuitBreaker: snap?.circuitBreaker ?? null,
                        highUnlocked: snap?.highUnlocked ?? false,
                        tiers: snap?.tiers ?? [],
                    })
                );
                return;
            }
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found");
        });
        server.listen(HEALTH_PORT, "127.0.0.1", () => {
            log.ok("HEALTH", `/healthz listening on 127.0.0.1:${HEALTH_PORT}`);
        });
        loops.push({
            name: "healthServer",
            clear: () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    // Force-close hanging sockets after a short grace window so
                    // SIGTERM during shutdown doesn't hang indefinitely.
                    setTimeout(() => resolve(), 1000).unref();
                }) as any,
        });
    }

    // 9. Process signals
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("uncaughtException", (err) => {
        log.err("FATAL", `uncaughtException: ${err.message}`);
        shutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason: any) => {
        log.err("FATAL", `unhandledRejection: ${reason?.message ?? String(reason)}`);
        // Don't necessarily exit on a single rejection — log and continue.
    });

    log.ok("BOOT", "Agent loops running. Press Ctrl+C to stop.");
    log.info("BOOT", "Orchestration framework online — 5 skills registered; MCP server runs separately via `npm run mcp`.");
}

// Convenience re-export so external runners can probe state without importing internal modules.
export { getCoordinator, startCoordinator } from "./core/coordinator";

main().catch(e => log.err("BOOT", `Fatal: ${e.message}`));
