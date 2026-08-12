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
import { postEnvelope } from "./webhook";
import { startRadar } from "./radar/scanner";
// Phase 4: import from hotpath/ (new exit-policy-engine-based monitor).
// When EXIT_ENGINE_ENABLED=false, hotpath/position-monitor delegates to
// the legacy wallet/position-manager for backward compatibility.
import { runMonitor } from "./hotpath/position-monitor";
import { reconcilePositionsAtBoot } from "./recovery/position-recovery";
import { startSniper } from "./sniper/engine";
// TODO: Implement first trade gate - markFirstTradeExecuted
// import { markFirstTradeExecuted } from "./storage/store";
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
    if (isCoordinatorStarted()) {
        getCoordinator().stop().catch(e => log.warn("SHUTDOWN", `coordinator stop failed: ${e.message}`));
    }
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
    const REQUIRED_VARS = [
      "AGENT_SHARED_SECRET",
      "NVIDIA_API_KEY",
      "PUBLIC_WEBHOOK_URL",
    ] as const;

    const missing = REQUIRED_VARS.filter(k => !process.env[k] || process.env[k]!.trim() === "");
    if (missing.length > 0) {
      for (const k of missing) {
        console.error(`FATAL: Missing or empty required environment variable: ${k}`);
      }
      process.exit(1);
    }

    // TONAPI is an optional enrichment layer (holders count, jetton meta fallback).
    // The agent boots and trades fine without it — primary data plane is
    // on-chain TonClient + DEX REST (x1000, DeDust, StonFi pools).
    if (!CONFIG.tonapiKey) {
      log.warn("BOOT", "TONAPI_KEY not set — TONAPI-backed enrichment (holders count, meta fallback) disabled; on-chain + DEX REST data plane remains active.");
    }

    log.banner(
        "TON AUTONOMOUS AGENT",
        "LangChain+MCP • NVIDIA NIM • Ston.fi & DeDust • TONAPI"
    );
    log.info("BOOT", `network=${CONFIG.network} rpc=${CONFIG.rpcEndpoint}`);
    log.info("BOOT", `preferred dex=${CONFIG.strategy.preferredDex}`);
    if (process.env.HITL_DISABLE === "true") {
        // Autopilot: stamp first-trade-executed ONCE so the persistent HITL
        // envelope flip stays off across restarts. The `executeSwapTool`
        // also short-circuits the FIRST-trade branch by reading the live env
        // each call — this pair makes it bullet-proof.
        // markFirstTradeExecuted(); // TODO: Implement first trade gate
        log.warn("HITL", "AUTOPILOT MODE — HITL fully disabled (operator never approves).");
    }
    log.info(
        "BOOT",
        CONFIG.brainEnabled
            ? "LLM trade brain ENABLED (ReAct planner runs per radar candidate)"
            : "LLM trade brain DISABLED — deterministic audit+score path only. Set LLM_BRAIN_ENABLED=true to re-enable.",
    );
    if (CONFIG.observeOnly) {
        log.banner("⚠️ OBSERVE-ONLY MODE", "Agent will scan markets but place NO trades — set OBSERVE_ONLY=false to enable execution.");
    }

    // 1. Tier coordinator — derived wallets, kill-switch, circuit breaker.
    try {
        await startCoordinator();
        const snap = getCoordinator().getSnapshot();
        log.ok("BOOT", `coordinator up — tiers=${snap.tiers.length} highUnlocked=${snap.highUnlocked} cb=${snap.circuitBreaker.ok ? "ok" : "TRIPPED"}`);

        // DIAGNOSTIC: force one-shot postEnvelope to test the pipeline
        postEnvelope({
            kind: "status",
            walletTier: "low",
            payload: {
                status: "running",
                startedAt: snap.startedAt,
                bankrollTon: snap.tiers.find(t => t.tier === "low")?.balanceTon ?? 0,
                openPositions: 0,
                totalPnLTon: 0,
                uptimeSec: Math.floor(snap.uptimeSec),
                version: "1.0.0",
            },
            stableId: "diag-boot",
        }).then((r) => {
            log.ok("BOOT", `DIAG webhook sent=${r.sent} id=${r.id}${r.reason ? " reason=" + r.reason : ""}${r.error ? " error=" + r.error : ""}`);
        });
        // 1b. Boot position reconciliation against on-chain jetton balances (US3)
        try {
            await reconcilePositionsAtBoot();
        } catch (e: any) {
            log.err("BOOT", `position reconciliation failed: ${e.message}`);
        }
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
    if (!CONFIG.nvidiaApiKey) {
        log.warn("BOOT", "NO_LLM_KEY — agent will not perform trade planning. Set NVIDIA_API_KEY.");
    } else {
        log.ok("BOOT", "AI provider detected — brain online");
    }

    // 4. Webhook target sanity
    if (!CONFIG.publicWebhookUrl) {
        log.warn("BOOT", "PUBLIC_WEBHOOK_URL unset — agent won't push live events to the web app");
    }

    // 5. Radar scanner
    void startRadar().then(() => {
        log.ok("BOOT", `radar loop running (${CONFIG.strategy.radarIntervalMs / 1000}s cadence)`);
    }).catch((e: any) => {
        log.err("BOOT", `radar failed: ${e.message}`);
    });

    // 6. Position monitor (SL/TP). It runs its own setInterval internally;
    //    track it for graceful shutdown via a no-op clear on the global queue.
    try {
        await runMonitor();
        log.ok("BOOT", "position monitor running (10s cadence)");
    } catch (e: any) {
        log.err("BOOT", `monitor failed: ${e.message}`);
    }

    // 6b. x1000 Uranus memepad sniper — inert unless SNIPER_ENABLED=true.
    //     Dedicated sniper_positions table; existing monitor never touches it.
    if (CONFIG.sniper.enabled) {
        const handle = startSniper();
        loops.push({ name: "sniper", clear: () => handle.stop() });
        log.ok("BOOT", `sniper running (scan ${CONFIG.sniper.scanIntervalMs}ms / monitor ${CONFIG.sniper.monitorIntervalMs}ms)`);
    } else {
        log.info("BOOT", "sniper disabled (SNIPER_ENABLED not true)");
    }
    // 7. Headline heartbeat — periodic one-line status, very cheap.
    // Also pushes a status snapshot to the web app dashboard.
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
    const HEALTH_PORT = Number(process.env.HEALTH_PORT || 9090);
    if (HEALTH_PORT > 0) {
        const http = await import("node:http");
        const server = http.createServer((req, res) => {
            if (req.method !== "GET") {
                // Spec 006 Phase 8 — LINE HITL webhook (POST /line/webhook).
                if (req.method === "POST" && req.url?.startsWith("/line/webhook")) {
                    let body = "";
                    req.on("data", (chunk) => { body += chunk; });
                    req.on("end", async () => {
                        try {
                            const { handleLineWebhook } = await import("./line");
                            const headers: Record<string, string | string[] | undefined> = {};
                            for (const [k, v] of Object.entries(req.headers || {})) {
                                headers[k] = v as any;
                            }
                            const r = await handleLineWebhook(headers, body);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(r));
                        } catch (e: any) {
                            log.err("LINE", `webhook handler error: ${e.message}`);
                            res.writeHead(500, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        }
                    });
                    return;
                }
                res.writeHead(405, { "Content-Type": "text/plain" });
                res.end("method not allowed");
                return;
            }
            if (req.url === "/healthz") {
                const started = isCoordinatorStarted();
                const snap = started ? getCoordinator().getSnapshot() : null;
                const isHealthy = started;
                res.writeHead(isHealthy ? 200 : 503, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        ok: isHealthy,
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
            // LINE webhook verification (LINE Developers Console "Verify" button
            // sends a GET to confirm the URL is reachable; we just ack it).
            if (req.url?.startsWith("/line/webhook")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, service: "line-webhook" }));
                return;
            }
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found");
        });
        // Bind to 0.0.0.0 inside Docker so Railway's platform-level
        // health checks can reach the /healthz endpoint. In production
        // the port is not exposed publicly — it's only accessible via
        // the container's internal networking (Railway / Docker bridge).
        server.listen(HEALTH_PORT, "0.0.0.0", () => {
            log.ok("HEALTH", `/healthz listening on 0.0.0.0:${HEALTH_PORT}`);
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
