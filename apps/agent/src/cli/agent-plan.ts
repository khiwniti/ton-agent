/**
 * CLI: run a one-shot querry through the trade brain.
 * Usage:
 *   npx ts-node src/cli/agent-plan.ts "Audit and trade $DOGS jetton EQ…"
 */
import "dotenv/config";
import { log } from "../logger";
import { runTradeBrain } from "../ai/brain";

(async () => {
    const q = process.argv.slice(2).join(" ").trim();
    if (!q) {
        console.error("Provide a query: npx ts-node src/cli/agent-plan.ts \"audit and trade ...\"");
        process.exit(1);
    }
    log.banner("AGENT PLAN", q.slice(0, 80));
    const res = await runTradeBrain(q, { pushToWeb: false });
    log.ok("CLI", `done thread=${res.threadId} msgs=${res.messages.length}`);
})();
