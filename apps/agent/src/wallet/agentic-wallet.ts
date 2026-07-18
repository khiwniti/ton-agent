/**
 * Agentic Wallet — off-chain helpers for the budgeting Tolk contract.
 *
 * Responsibilities:
 *   1. Key delegation: derive the ephemeral agent keypair + compute contract address.
 *   2. Contract deployment: build StateInit + deploy message for the budgeting wallet.
 *   3. Remote state fetching: read storage fields from a deployed budgeting contract.
 *   4. Signed transfer serialization: build an internal message body with the
 *      agent's signature, ready for the budgeting contract's recv_internal.
 *
 * The budgeting contract expects the following message-body layout:
 *   [ signature: bits512 ][ transfer_amount: coins ][ target_address: MsgAddress ][ forward_payload: ^Cell ]
 *
 * See `contracts/budgeting-wallet.tolk` and `specs/.../contracts/budgeting-wallet.md`.
 */
import {
  TonClient,
  Address,
  beginCell,
  storeStateInit,
  toNano,
  type StateInit,
  Cell,
  SendMode,
} from "@ton/ton";
import { sign } from "@ton/crypto";
import { log } from "../logger";
import { loadKeyPairForTier, openWallet, type KeyPair } from "./wallet";
import { sendTransferLocked } from "./locked-wallet";
import { agenticWalletStore } from "../storage/store";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────
/** Tolk exit code 101 = Invalid Signature */
export const EXIT_CODE_INVALID_SIGNATURE = 101;
/** Tolk exit code 102 = Limit Exceeded */
export const EXIT_CODE_LIMIT_EXCEEDED = 102;

// ─────────────────────────────────────────────────────────────────────
// StateInit and Address computation
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic StateInit for the budgeting wallet.
 * The code cell MUST be the real compiled cell (from acton compile).
 */
function buildBudgetingStateInit(
  ownerAddress: Address,
  agentPublicKey: Buffer,
  dailyLimitNano: bigint,
  codeCell: Cell,
): StateInit {
  const dataCell = beginCell()
    .storeAddress(ownerAddress)
    .storeUint(BigInt("0x" + agentPublicKey.toString("hex")), 256)
    .storeCoins(dailyLimitNano)
    .storeCoins(0n) // accumulated_spend starts at 0
    .storeUint(Math.floor(Date.now() / 1000), 32)
    .endCell();

  return { code: codeCell, data: dataCell };
}

/**
 * Compute the contract address for the budgeting wallet.
 * Deterministic — does NOT require a network call.
 *
 * @throws Error if the code cell is empty (needs real compiled code).
 */
export function computeBudgetingAddress(
  ownerAddress: Address,
  agentPublicKey: Buffer,
  dailyLimitNano: bigint,
  codeCell: Cell,
): Address {
  if (codeCell.toBoc().length <= 4) {
    throw new Error(
      "Budgeting wallet code cell is empty. Compile with `acton compile contracts/budgeting-wallet.tolk` first.",
    );
  }
  const stateInit = buildBudgetingStateInit(ownerAddress, agentPublicKey, dailyLimitNano, codeCell);
  return new Address(0, beginCell()
    .store(storeStateInit(stateInit))
    .endCell()
    .hash()
  );
}

// ─────────────────────────────────────────────────────────────────────
// 1. Key Delegation (T008)
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate the ephemeral agent keypair and the corresponding budgeting
 * contract address. This is the first step of delegation: the wallet
 * owner funds the computed address, then the agent can trade.
 *
 * NOTE: Requires a compiled codeCell from `acton compile`. Until the
 * contract is compiled, pass a placeholder Cell — but the address will
 * NOT match the deployed contract.
 */
export async function prepareDelegatedWallet(
  client: TonClient,
  ownerAddress: Address,
  dailyLimitTon: number,
  tier: "low" | "mid" | "high" = "low",
  codeCell: Cell,
): Promise<{
  agentKeyPair: KeyPair;
  contractAddress: Address;
  dailyLimitNano: bigint;
}> {
  const agentKeyPair = await loadKeyPairForTier(tier);
  const dailyLimitNano = toNano(dailyLimitTon.toString());

  // computeBudgetingAddress will throw if codeCell is empty
  const contractAddress = computeBudgetingAddress(
    ownerAddress,
    agentKeyPair.pub,
    dailyLimitNano,
    codeCell,
  );

  log.ok(
    "AGENTIC",
    `[${tier.toUpperCase()}] delegated wallet addr=${contractAddress.toString()} ` +
      `dailyLimit=${dailyLimitTon}TON agentPub=${agentKeyPair.pub.toString("hex").slice(0, 16)}…`,
  );

  return { agentKeyPair, contractAddress, dailyLimitNano };
}

// ─────────────────────────────────────────────────────────────────────
// 2. Contract Deployment (T009)
// ─────────────────────────────────────────────────────────────────────

/**
 * Deploy the budgeting wallet contract by sending a deploy message with
 * the initial funds from the owner wallet.
 *
 * @param codeCell - The compiled Tolk contract code cell (from acton compile).
 */
export async function deployBudgetingWallet(
  client: TonClient,
  ownerKp: KeyPair,
  ownerAddress: Address,
  agentPublicKey: Buffer,
  dailyLimitNano: bigint,
  codeCell: Cell,
  initialFundsTon: number = 0.5,
  tier: "low" | "mid" | "high" = "low",
): Promise<{ address: Address; success: boolean; error?: string }> {
  const stateInit = buildBudgetingStateInit(ownerAddress, agentPublicKey, dailyLimitNano, codeCell);
  const contractAddress = computeBudgetingAddress(ownerAddress, agentPublicKey, dailyLimitNano, codeCell);

  log.info(
    "AGENTIC",
    `[${tier.toUpperCase()}] deploying budgeting wallet at ${contractAddress.toString()} ` +
      `with ${initialFundsTon} TON initial funds`,
  );

  const ownerWallet = openWallet(client, ownerKp);

  try {
    const deployBody = beginCell().storeUint(0, 32).endCell();

    const result = await sendTransferLocked(tier, {
      wallet: ownerWallet,
      secretKey: ownerKp.sec,
      messages: [
        {
          to: contractAddress,
          value: toNano(initialFundsTon.toString()),
          init: stateInit,
          body: deployBody,
        } as any,
      ],
    }, client);

    if (result.ok) {
      // Record the deployed wallet in the local store
      agenticWalletStore.upsert({
        address: contractAddress.toString(),
        delegated_public_key: agentPublicKey.toString("hex"),
        daily_limit: dailyLimitNano.toString(),
        accumulated_spend: "0",
        last_reset_timestamp: Math.floor(Date.now() / 1000),
      });

      log.ok("AGENTIC", `[${tier.toUpperCase()}] budgeting wallet deployed at ${contractAddress.toString()}`);
      return { address: contractAddress, success: true };
    }

    return { address: contractAddress, success: false, error: result.error };
  } catch (e: any) {
    log.err("AGENTIC", `[${tier.toUpperCase()}] deployment failed: ${e.message}`);
    return { address: contractAddress, success: false, error: e.message };
  }
}

/**
 * Check if a budgeting wallet contract exists at the given address.
 *
 * NOTE: The Tolk contract at `contracts/budgeting-wallet.tolk` does
 * NOT currently define get-methods. Add `get fun get_wallet_data()`
 * to the Tolk contract first to enable full state fetching.
 */
export async function fetchBudgetingState(
  client: TonClient,
  contractAddress: Address,
): Promise<{ exists: boolean }> {
  try {
    await client.runMethod(contractAddress, "get_wallet_data");
    return { exists: true };
  } catch (e: any) {
    log.debug("AGENTIC", `fetchBudgetingState failed: ${e.message}`);
    return { exists: false };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. Signed Transfer Serialization (T010)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the signed message body to send to the budgeting contract.
 *
 * Message body layout (matching contract schema):
 *   [ signature: bits512 ][ transfer_amount: coins ]
 *   [ target_address: MsgAddress ][ forward_payload: ^Cell ]
 *
 * The signature covers the hash of the remaining payload
 * (transfer_amount + target_address + forward_payload ref).
 */
function buildSignedTransferBody(
  agentKeyPair: KeyPair,
  transferAmount: bigint,
  targetAddress: Address,
  forwardPayload: Cell,
): Cell {
  const messageContent = beginCell()
    .storeCoins(transferAmount)
    .storeAddress(targetAddress)
    .storeRef(forwardPayload)
    .endCell();

  const messageHash = messageContent.hash();
  const signature = sign(messageHash, agentKeyPair.sec);

  return beginCell()
    .storeBuffer(signature)
    .storeSlice(messageContent.beginParse())
    .endCell();
}

/**
 * Execute a swap through the budgeting wallet contract using the
 * agent's ephemeral key. The signed message is sent directly to the
 * budgeting contract (via a plain internal transfer from the agent's
 * wallet), which validates the signature + daily limit, then forwards
 * the swap payload to the DEX.
 *
 * NOTE: This does NOT use sendTransferLocked because the budgeting
 * contract is NOT a standard wallet — it has no seqno. We send a
 * simple internal() message from the agent's wallet to the contract
 * address with the signed body attached.
 */
export async function executeSwapViaBudgetingWallet(
  client: TonClient,
  agentKeyPair: KeyPair,
  budgetingAddress: Address,
  targetDexAddress: Address,
  transferAmountTon: number,
  forwardPayload: Cell,
  tier: "low" | "mid" | "high" = "low",
): Promise<{ ok: boolean; error?: string; txHash?: string }> {
  const transferAmount = toNano(transferAmountTon.toString());
  const body = buildSignedTransferBody(agentKeyPair, transferAmount, targetDexAddress, forwardPayload);

  try {
    const w = openWallet(client, agentKeyPair);
    const seqno = await w.getSeqno();

    // Send a plain internal transfer to the budgeting contract address.
    // The contract's recv_internal will parse the body, validate the
    // signature, check daily limits, and forward the swap to the DEX.
    await w.sendTransfer({
      seqno,
      secretKey: agentKeyPair.sec,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        {
          to: budgetingAddress,
          value: toNano((transferAmountTon + 0.05).toString()),
          body,
        } as any,
      ],
    });

    log.ok("AGENTIC", `[${tier.toUpperCase()}] swap via budgeting wallet sent seqno=${seqno}`);
    return { ok: true };
  } catch (e: any) {
    log.err("AGENTIC", `[${tier.toUpperCase()}] executeSwapViaBudgeting failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
