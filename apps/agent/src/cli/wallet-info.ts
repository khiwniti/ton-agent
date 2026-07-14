/**
 * CLI: print live wallet info & balance.
 */
import "dotenv/config";
import { makeClient, openWallet, loadKeyPair } from "../wallet/wallet";
import { fromNano } from "@ton/ton";
import { log } from "../logger";

(async () => {
    const client = makeClient();
    const kp = await loadKeyPair();
    const w = openWallet(client, kp);
    const bal = await w.getBalance();
    log.banner("WALLET INFO", w.address.toString());
    log.ok("CLI", `balance=${fromNano(bal)} TON`);
    log.ok("CLI", `addr=${w.address.toString({ urlSafe: true })}`);
})();
