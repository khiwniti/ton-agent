import { beginCell, Cell, Address, Dictionary, toNano, fromNano, Slice, Builder, Transaction } from "@ton/core";
import type {
  BocTemplate,
  LeafCellData,
  PoolSnapshot,
  FastPathSignal,
} from "./fastpath-types";
import type { TradingPolicy } from "./policy-types";

// Re-export types for convenience
export type {
  BocTemplate,
  LeafCellData,
  PoolSnapshot,
  FastPathSignal,
} from "./fastpath-types";

/**
 * Compile a BOC template from a swap transaction pattern.
 * Called in cold path during pool discovery/pre-compilation.
 *
 * The template encodes the STATIC structure of a swap transaction.
 * Only the leaf cell (amount/recipient/forward params) is dynamic.
 */
export function compileBocTemplate(
  dex: "stonfi" | "dedust",
  poolAddress: string,
  tokenAddress: string,
  side: "buy" | "sell",
  walletAddress: string,
  walletPublicKey: Buffer, // Not used in template but kept for future signing integration
  estimatedGasNanoTon: number,
  policyVersion: number
): BocTemplate {
  const poolAddr = Address.parse(poolAddress);
  const tokenAddr = Address.parse(tokenAddress);
  const walletAddr = Address.parse(walletAddress);

  let templateCell: Cell;
  const queryId = 0; // Placeholder - will be replaced at execution time

  if (dex === "dedust") {
    if (side === "buy") {
      // DeDust BUY: TON → Jetton (native vault)
      // Op: 0xea06185d (VaultNative.SWAP)
      // Body: op(32) + queryId(64) + amount(coins) + poolAddress + reserved(1) + limit(coins) + maybeRef(next) + ref(swapParams)
      // swapParams: deadline(32) + recipientAddress + referralAddress + maybeRef(fulfillPayload) + maybeRef(rejectPayload)

      const swapParamsCell = beginCell()
        .storeUint(0, 32) // deadline - placeholder
        .storeAddress(walletAddr) // recipient
        .storeAddress(null) // referral - none
        .storeMaybeRef(null) // fulfillPayload - none
        .storeMaybeRef(null) // rejectPayload - none
        .endCell();

      templateCell = beginCell()
        .storeUint(0xea06185d, 32) // VaultNative.SWAP opcode
        .storeUint(BigInt(queryId), 64) // queryId - placeholder
        .storeCoins(0n) // amount - PLACEHOLDER (leaf)
        .storeAddress(poolAddr)
        .storeUint(0, 1) // reserved bit
        .storeCoins(0n) // limit - PLACEHOLDER (leaf)
        .storeMaybeRef(null) // next step - none
        .storeRef(swapParamsCell)
        .endCell();
    } else {
      // DeDust SELL: Jetton → TON (jetton vault)
      // Jetton wallet transfer: op(0xf8a7ea5, 32) + queryId(64) + amount(coins) + destination + responseDestination +
      //   custom_payload(bit) + forward_ton_amount(coins) + forward_payload(bit+ref)
      // forward_payload: op(0x178d4519, 32) + poolAddress + limit + maybeRef(next) + ref(swapParams)

      const forwardPayloadCell = beginCell()
        .storeUint(0x178d4519, 32) // VaultJetton.SWAP opcode
        .storeAddress(poolAddr)
        .storeCoins(0n) // limit - placeholder
        .storeMaybeRef(null) // next - none
        .storeRef(
          beginCell()
            .storeUint(0, 32) // deadline
            .storeAddress(walletAddr) // recipient
            .storeAddress(null) // referral
            .storeMaybeRef(null) // fulfill
            .storeMaybeRef(null) // reject
            .endCell()
        )
        .endCell();

      templateCell = beginCell()
        .storeUint(0xf8a7ea5, 32) // Jetton transfer opcode
        .storeUint(BigInt(queryId), 64) // queryId - placeholder
        .storeCoins(0n) // amount - PLACEHOLDER (leaf)
        .storeAddress(poolAddr) // destination = vault
        .storeAddress(walletAddr) // response destination
        .storeBit(0) // custom_payload = null
        .storeCoins(0n) // forward_ton_amount - PLACEHOLDER (leaf)
        .storeBit(1) // forward_payload is a ref
        .storeRef(forwardPayloadCell)
        .endCell();
    }
  } else {
    // Ston.fi BUY: TON → Jetton
    // Router proxy-ton swap: op(0x5ae40180, 32) + queryId(64) + jetton_wallet + min_amount + ...
    // This is a simplified template - Ston.fi uses different patterns

    if (side === "buy") {
      // Ston.fi buy via pTON router
      templateCell = beginCell()
        .storeUint(0x5ae40180, 32) // ProxyTON swap opcode (approx)
        .storeUint(BigInt(queryId), 64)
        .storeCoins(0n) // amount - PLACEHOLDER
        .storeAddress(tokenAddr) // jetton master
        .storeAddress(walletAddr) // recipient
        .storeCoins(0n) // min_out - PLACEHOLDER
        .endCell();
    } else {
      // Ston.fi sell: Jetton → TON
      templateCell = beginCell()
        .storeUint(0xf8a7ea5, 32) // Jetton transfer
        .storeUint(BigInt(queryId), 64)
        .storeCoins(0n) // amount - PLACEHOLDER
        .storeAddress(poolAddr) // destination = pool
        .storeAddress(walletAddr) // response
        .storeBit(0) // no custom payload
        .storeCoins(0n) // forward ton - PLACEHOLDER
        .storeBit(0) // no forward payload
        .endCell();
    }
  }

  // Serialize template BOC
  const bocBytes = templateCell.toBoc({ idx: false });
  const templateBoc = Buffer.from(bocBytes);

  // Compute template hash for cache invalidation
  const hash = templateCell.hash();
  const templateHash = Buffer.from(hash);

  return {
    templateBoc,
    templateHash,
    dex,
    poolAddress,
    tokenAddress,
    side,
    estimatedGasNanoTon,
    compiledAt: Date.now(),
    policyVersion,
  };
}

/**
 * Find the leaf cell path in a template for fast rebuild.
 * Returns array of child indices to navigate to the dynamic leaf cell.
 *
 * For DeDust buy: root[2] = amount(coins), root[5] = limit(coins)
 * For DeDust sell: root[2] = amount(coins), root[6] = forward_ton_amount(coins)
 * For Ston.fi: similar patterns
 */
export function findLeafPath(template: Cell, side: "buy" | "sell"): number[] {
  // Parse the template to find dynamic cells (coins/amount fields)
  const slice = template.beginParse();

  // Skip opcode (32 bits)
  slice.loadUint(32);

  if (slice.remainingBits < 64) return [];

  // queryId (64 bits) - static
  slice.loadUint(64);

  if (side === "buy") {
    // For buy templates (both DEXes), the first coins after queryId is the amount
    // This is typically at index 2 in the cell's children (0=opcode, 1=queryId, 2=amount)
    return [2];
  } else {
    // For sell templates, amount is also typically at index 2
    // forward_ton_amount is at a later index (6 for DeDust)
    return [2, 6]; // Both amount and forward_ton_amount are dynamic
  }
}

/**
 * Rebuild a leaf cell from template using @ton/core Builder API.
 * This is the hot-path critical function — target <50μs.
 *
 * Pattern:
 * 1. Parse template BOC → Cell
 * 2. Navigate to leaf position using Slice operations
 * 3. Rebuild leaf using Builder: beginCell().storeUint().storeAddress().storeCoins().storeBit().endCell()
 * 4. Reassemble parent cells using storeRef()
 * 5. Serialize fresh BOC
 *
 * @param templateBoc - The pre-compiled template BOC
 * @param leafData - Dynamic data for the leaf cell
 * @returns Fresh BOC bytes ready for broadcast
 */
export function rebuildLeafCell(
  templateBoc: Buffer,
  leafData: LeafCellData
): Buffer {
  const template = Cell.fromBoc(templateBoc)[0];

  // Parse template to extract static structure
  const slice = template.beginParse();

  // Load static prefix (opcode)
  const opcode = slice.loadUint(32);
  // Skip old queryId from template - we use the one from leafData
  slice.loadUint(64);

  // Now rebuild the cell with dynamic values
  const builder = beginCell()
    .storeUint(opcode, 32)
    .storeUint(leafData.queryId, 64) // Use queryId from leafData
    .storeCoins(leafData.amount) // Dynamic: amount
    .storeAddress(leafData.recipient) // Dynamic: recipient
    .storeAddress(leafData.responseDestination) // Dynamic: response dest
    .storeBit(leafData.forwardPayload !== null ? 1 : 0); // custom_payload flag

  if (leafData.forwardPayload !== null) {
    builder
      .storeCoins(leafData.forwardTonAmount) // Dynamic: forward ton amount
      .storeBit(1) // forward_payload is a ref
      .storeRef(leafData.forwardPayload); // Dynamic: forward payload
  } else {
    builder
      .storeCoins(leafData.forwardTonAmount) // Dynamic: forward ton amount
      .storeBit(0); // no forward payload
  }

  const rebuiltCell = builder.endCell();
  const bocBytes = rebuiltCell.toBoc({ idx: false });

  return Buffer.from(bocBytes);
}

/**
 * Rebuild a DeDust native vault swap payload (BUY).
 * Specialized version for the exact cell layout used in production.
 */
export function rebuildDedustNativeBuyLeaf(
  templateBoc: Buffer,
  amount: bigint,
  limit: bigint,
  queryId: number
): Buffer {
  const template = Cell.fromBoc(templateBoc)[0];
  const slice = template.beginParse();

  // Load static structure
  const opcode = slice.loadUint(32); // 0xea06185d
  const _oldQueryId = slice.loadUint(64);
  const _oldAmount = slice.loadCoins();
  const poolAddr = slice.loadAddress();
  const reserved = slice.loadUint(1);
  const _oldLimit = slice.loadCoins();
  // nextRef is a maybeRef - check if present
  const hasNextRef = slice.loadBit();
  const nextRef = hasNextRef ? slice.loadRef() : null;
  const swapParamsRef = slice.loadRef();

  // Rebuild with new dynamic values
  const builder = beginCell()
    .storeUint(opcode, 32)
    .storeUint(BigInt(queryId), 64)
    .storeCoins(amount) // Dynamic
    .storeAddress(poolAddr)
    .storeUint(reserved, 1)
    .storeCoins(limit) // Dynamic
    .storeMaybeRef(nextRef)
    .storeRef(swapParamsRef); // Static

  const rebuiltCell = builder.endCell();
  return Buffer.from(rebuiltCell.toBoc({ idx: false }));
}

/**
 * Rebuild a DeDust jetton vault swap payload (SELL).
 * Specialized version for the exact cell layout used in production.
 */
export function rebuildDedustJettonSellLeaf(
  templateBoc: Buffer,
  amount: bigint,
  forwardTonAmount: bigint,
  queryId: number
): Buffer {
  const template = Cell.fromBoc(templateBoc)[0];
  const slice = template.beginParse();

  // Load static structure
  const opcode = slice.loadUint(32); // 0xf8a7ea5
  const _oldQueryId = slice.loadUint(64);
  const _oldAmount = slice.loadCoins();
  const destAddr = slice.loadAddress();
  const responseAddr = slice.loadAddress();
  const hasCustomPayload = slice.loadBit();
  const _oldForwardTon = slice.loadCoins();
  const hasForwardPayload = slice.loadBit();
  const forwardPayloadRef = hasForwardPayload ? slice.loadRef() : null;

  // Rebuild with new dynamic values
  const builder = beginCell()
    .storeUint(opcode, 32)
    .storeUint(BigInt(queryId), 64)
    .storeCoins(amount) // Dynamic
    .storeAddress(destAddr)
    .storeAddress(responseAddr)
    .storeBit(hasCustomPayload ? 1 : 0)
    .storeCoins(forwardTonAmount) // Dynamic
    .storeBit(hasForwardPayload ? 1 : 0);

  if (hasForwardPayload && forwardPayloadRef) {
    builder.storeRef(forwardPayloadRef); // Static
  }

  const rebuiltCell = builder.endCell();
  return Buffer.from(rebuiltCell.toBoc({ idx: false }));
}

/**
 * Validate a BOC template is still usable (pool hasn't migrated, etc).
 * Checks: pool address matches, dex matches, policy version current.
 */
export function validateBocTemplate(
  template: BocTemplate,
  currentPoolState: PoolSnapshot,
  currentPolicyVersion: number
): boolean {
  // Pool address must match
  if (template.poolAddress !== currentPoolState.address) {
    return false;
  }

  // DEX must match
  if (template.dex !== currentPoolState.dex) {
    return false;
  }

  // Policy version must be current (or within 1 for grace)
  if (template.policyVersion < currentPolicyVersion - 1) {
    return false;
  }

  // Token address must match
  if (template.tokenAddress !== currentPoolState.token0 &&
      template.tokenAddress !== currentPoolState.token1) {
    return false;
  }

  // TTL check (optional - template older than 1 hour might be stale)
  const ageMs = Date.now() - template.compiledAt;
  if (ageMs > 3600000) { // 1 hour
    return false;
  }

  return true;
}

/**
 * Extract pool snapshot from on-chain pool data for template validation.
 */
export function extractPoolSnapshot(
  dex: "stonfi" | "dedust",
  poolAddress: string,
  poolData: any,
  tokenAddress: string
): PoolSnapshot {
  // poolData structure varies by DEX - this is a best-effort extraction
  return {
    address: poolAddress,
    reserve0: poolData.reserve0 ?? poolData.reserve_0 ?? 0n,
    reserve1: poolData.reserve1 ?? poolData.reserve_1 ?? 0n,
    token0: poolData.token0 ?? poolData.token_0_address ?? tokenAddress,
    token1: poolData.token1 ?? poolData.token_1_address ?? "",
    dex,
    timestamp: Date.now(),
    feeBps: poolData.feeBps ?? poolData.fee_bps ?? 30, // Default 0.3%
  };
}