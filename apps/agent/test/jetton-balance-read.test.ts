/**
 * Test: `readUserJettonBalance` in apps/agent/src/dex/router.ts must read the
 * jetton wallet's JETTON balance, not its TON balance.
 *
 * PROD INCIDENT (2026-08-09): every sell bounced in an infinite retry loop:
 *
 *   ERR  DEDUST [LOW] sell BOUNCED: jetton balance did not decrease after
 *        broadcast (before=19909458 after=19909458)
 *   WARN MGR trend_exit sell failed for pos_auto_1786159700589; leaving OPEN
 *
 * Three DIFFERENT positions (45467198424 / 1763200590 / 5548861149 tokens
 * requested) all reported the SAME ~19,909,4XX "balance". Identical balances
 * across three unrelated jettons is impossible — that number was never a token
 * count. It was ~0.0199 TON of storage rent sitting on each jetton-wallet
 * contract, drifting downward between reads (…458 → …437 → …496) as rent was
 * deducted.
 *
 * Root cause: `client.getBalance(jettonWallet)` returns the account's nanoton
 * balance. Reading a jetton balance requires the TEP-74 `get_wallet_data`
 * get-method, whose first stack item is the jetton amount. The correct pattern
 * already existed at recovery/position-recovery.ts:72.
 *
 * Consequence chain: balanceBefore is TON → `spent = before - after` is ~0 for
 * a jetton transfer → verifySellDelta's `spent <= 0n` branch always trips →
 * every sell reports BOUNCED → position-monitor.ts:655 leaves it OPEN "for
 * retry" → the trend is still bearish next tick → infinite loop.
 *
 * These tests pin the read itself. verifySellDelta's delta logic is correct and
 * is covered separately by sell-verify.test.ts — it was being fed garbage.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Address, beginCell } from "@ton/ton";

import { readUserJettonBalance } from "../src/dex/router.js";

const MASTER = Address.parse("EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA");
const OWNER = Address.parse("UQDpFjGfB_Elg_giRSH1gHXEWuaWP3WyRvgJkNETMutqrLFS");
const JETTON_WALLET = Address.parse("UQDAFklJsrNpntQNNVE5AzzEPwCx3fc4o1Uy4_W0T7c-C4Ug");

/** The real jetton balance the wallet holds. */
const HELD_JETTONS = 45_467_198_424n;
/** Storage rent on the jetton-wallet contract — what getBalance would return. */
const RENT_NANOTON = 19_909_458n;

/**
 * Minimal TonClient test double. Records which get-method was invoked so the
 * test can assert on HOW the balance was read, not merely what came back —
 * a stub returning the right number by the wrong route would still be the bug.
 */
function makeClientStub(opts: { jettonBalance?: bigint; throwOnWalletData?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async runMethod(addr: Address, method: string) {
      calls.push(method);
      if (method === "get_wallet_address") {
        return {
          stack: {
            readAddress: () => JETTON_WALLET,
          },
        };
      }
      if (method === "get_wallet_data") {
        if (opts.throwOnWalletData) {
          throw new Error("exit_code: -13 (contract not deployed)");
        }
        return {
          stack: {
            readBigNumber: () => opts.jettonBalance ?? HELD_JETTONS,
          },
        };
      }
      throw new Error(`unexpected get-method: ${method}`);
    },
    async getBalance() {
      calls.push("getBalance");
      return RENT_NANOTON;
    },
  };
}

describe("readUserJettonBalance — reads jettons, not TON", () => {
  it("returns the jetton balance from get_wallet_data", async () => {
    const client = makeClientStub();
    const bal = await readUserJettonBalance(client as never, MASTER, OWNER);

    assert.strictEqual(
      bal,
      HELD_JETTONS,
      "must return the jetton amount from get_wallet_data",
    );
  });

  it("does NOT use getBalance (that returns nanoton storage rent)", async () => {
    const client = makeClientStub();
    await readUserJettonBalance(client as never, MASTER, OWNER);

    assert.ok(
      !client.calls.includes("getBalance"),
      `getBalance returns the jetton wallet's TON rent, not its jetton balance. Calls: ${client.calls.join(", ")}`,
    );
    assert.ok(
      client.calls.includes("get_wallet_data"),
      `must read via the TEP-74 get_wallet_data get-method. Calls: ${client.calls.join(", ")}`,
    );
  });

  it("resolves the jetton wallet via get_wallet_address first", async () => {
    const client = makeClientStub();
    await readUserJettonBalance(client as never, MASTER, OWNER);

    assert.strictEqual(
      client.calls[0],
      "get_wallet_address",
      "the owner's jetton wallet must be derived from the master before reading it",
    );
  });

  it("never returns the rent value for a wallet holding jettons", async () => {
    // The regression's signature: the read returning ~0.0199 TON regardless of
    // which jetton was asked about.
    const client = makeClientStub();
    const bal = await readUserJettonBalance(client as never, MASTER, OWNER);

    assert.notStrictEqual(
      bal,
      RENT_NANOTON,
      "returning the nanoton rent balance is the 2026-08-09 infinite-retry bug",
    );
  });

  it("distinct jettons yield distinct balances", async () => {
    // Three positions reporting an identical balance is what exposed the bug.
    const a = await readUserJettonBalance(
      makeClientStub({ jettonBalance: 45_467_198_424n }) as never,
      MASTER,
      OWNER,
    );
    const b = await readUserJettonBalance(
      makeClientStub({ jettonBalance: 1_763_200_590n }) as never,
      MASTER,
      OWNER,
    );

    assert.notStrictEqual(a, b, "different holdings must read differently");
  });

  it("returns null when the jetton wallet is not deployed (fail closed)", async () => {
    // A never-deployed jetton wallet and an unreachable node are
    // indistinguishable here. Callers treat null as "unverifiable".
    const client = makeClientStub({ throwOnWalletData: true });
    const bal = await readUserJettonBalance(client as never, MASTER, OWNER);

    assert.strictEqual(bal, null, "an unreadable balance must be null, not 0");
  });
});

describe("readUserJettonBalance — feeds verifySellDelta correctly", () => {
  it("a real jetton delta is visible after a successful transfer", async () => {
    const { verifySellDelta } = await import("../src/dex/router.js");

    const before = await readUserJettonBalance(
      makeClientStub({ jettonBalance: HELD_JETTONS }) as never,
      MASTER,
      OWNER,
    );
    const after = await readUserJettonBalance(
      makeClientStub({ jettonBalance: 0n }) as never,
      MASTER,
      OWNER,
    );

    const v = verifySellDelta({
      balanceBefore: before!,
      balanceAfter: after!,
      soldNano: HELD_JETTONS,
    });

    assert.strictEqual(
      v.ok,
      true,
      `a fully-drained jetton wallet must verify as sold, got: ${v.error}`,
    );
  });
});
