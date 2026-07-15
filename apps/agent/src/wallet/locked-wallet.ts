import { TonClient, SendMode } from "@ton/ton";
import { log } from "../logger";

class WalletMutex {
  private promise: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void;
    const nextPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentPromise = this.promise;
    this.promise = nextPromise;
    await currentPromise;
    return release!;
  }
}

// Separate lock per risk tier to avoid blocking different wallets
const locks: Record<string, WalletMutex> = {
  low: new WalletMutex(),
  mid: new WalletMutex(),
  high: new WalletMutex(),
};

/**
 * Polls the wallet seqno until it increases, meaning the transaction was
 * successfully written to a block.
 */
async function waitSeqnoIncrement(wallet: any, startSeqno: number, timeoutMs = 45_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const seq = await wallet.getSeqno();
      if (seq > startSeqno) {
        return true;
      }
    } catch {
      // Ignore network/RPC glitches during polling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export interface LockedTransferRequest {
  wallet: any;
  secretKey: Buffer;
  messages: any[];
  sendMode?: SendMode;
}

/**
 * Safely executes a wallet transfer inside a mutex and waits for seqno confirmation.
 */
export async function sendTransferLocked(
  tier: "low" | "mid" | "high",
  req: LockedTransferRequest,
  client: TonClient
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const release = await locks[tier].acquire();
  try {
    const seqno = await req.wallet.getSeqno();
    log.info("WALLET", `[${tier.toUpperCase()}] lock acquired. seqno=${seqno}`);

    await req.wallet.sendTransfer({
      seqno,
      secretKey: req.secretKey,
      sendMode: req.sendMode ?? SendMode.PAY_GAS_SEPARATELY,
      messages: req.messages,
    });

    log.info("WALLET", `[${tier.toUpperCase()}] transaction broadcasted. Waiting for confirmation...`);
    const success = await waitSeqnoIncrement(req.wallet, seqno);

    if (!success) {
      log.warn("WALLET", `[${tier.toUpperCase()}] seqno failed to increment within timeout.`);
      return { ok: false, error: "Confirmation timeout (seqno did not increase)" };
    }

    log.ok("WALLET", `[${tier.toUpperCase()}] transaction confirmed!`);
    return { ok: true };
  } catch (e: any) {
    log.err("WALLET", `[${tier.toUpperCase()}] transfer error: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    release();
  }
}
