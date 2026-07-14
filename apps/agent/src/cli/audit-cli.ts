/**
 * CLI: standalone security audit on a jetton address.
 * Usage: npm run audit -- EQ...
 */
import "dotenv/config";
import { makeClient } from "../wallet/wallet";
import { fullAudit } from "../security/audit";
import { log } from "../logger";

(async () => {
    const m = process.argv.slice(2).find(a => a.startsWith("EQ") || a.startsWith("kQ"));
    if (!m) {
        console.error("Usage: npm run audit -- <jettonMasterEQ>");
        process.exit(1);
    }
    log.banner("AUDIT", m);
    const c = makeClient();
    const r = await fullAudit(c, m);
    log.ok("CLI", JSON.stringify(r, null, 2));
})();
