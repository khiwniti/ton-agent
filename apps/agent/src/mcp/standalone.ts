/**
 * MCP stdio standalone process — launched by MCP hosts (Claude Desktop,
 * Zed, Cursor, etc.) via the `npm run mcp` script.
 *
 * Why a separate process (not booted inside `index.ts`):
 *   - StdioServerTransport writes JSON-RPC envelopes to STDOUT.
 *   - Our pretty logger writes lines to stdout by default (INFO/OK/TRADE/BANNER).
 *   - Sharing the same stream means MCP clients parse the log noise as
 *     malformed JSON-RPC, breaking the handshake.
 *
 * Lifecycle:
 *   - redirectToStderr() forces every log line through stderr
 *   - startCoordinator() boots wallets, kill-switch poller etc. (NO radar,
 *     NO position monitor — those belong to the autonomous runtime)
 *   - startMcpServer() binds the stdio transport
 *   - SIGINT/SIGTERM → graceful stopMcpServer, exit 0
 *
 * The MCP server is intentionally a peer of the autonomous agent runtime,
 * not a part of it; both can share the SQLite DB without conflict because
 * better-sqlite3 serialises writes.
 */
import "dotenv/config";
import { redirectToStderr, log } from "../logger";
import { startMcpServer, stopMcpServer } from "./server";
import { startCoordinator } from "../core/coordinator";
// Side-effect import — registers all skills so they're discoverable.
import "../skills";

async function main() {
    // First action: redirect logs to stderr so we NEVER touch stdout.
    redirectToStderr();

    log.banner("MCP STANDALONE", "stdio • tools + resources • coordinator attached");

    // Coordinator boots the three tier wallets + status table.
    // We intentionally do NOT call startRadar() or runMonitor() — those belong
    // to the longer-lived autonomous agent runtime in index.ts.
    try {
        await startCoordinator();
        log.info("MCP-STANDALONE", "coordinator bootstrapped");
    } catch (e: any) {
        // Coordinator is OPTIONAL for the MCP server (resources that need it
        // will throw "coordinator not started"). Log loudly but continue so
        // the stdio handshake still succeeds.
        log.err("MCP-STANDALONE", `coordinator failed: ${e.message} — resource readers will degrade`);
    }

    // Boot the actual MCP server. This call AWAITS the JSON-RPC stream.
    const server = await startMcpServer();
    log.info("MCP-STANDALONE", "stdio transport connected; awaiting JSON-RPC frames");

    // Graceful shutdown — required because MCP hosts signal SIGINT/SIGTERM.
    // Await the transport close INLINE before exiting so the JSON-RPC stream
    // drains (vs the prior 100ms timer that could fire BEFORE close finished,
    // truncating pending frames).
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info("MCP-STANDALONE", `signal=${signal} closing stdio transport`);
        try {
            await stopMcpServer(server);
        } catch (e: any) {
            log.warn("MCP-STANDALONE", `stopMcpServer raised: ${e.message}`);
        }
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
    // Final fallback: write to stderr so the MCP host sees the error frame.
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(1);
});
