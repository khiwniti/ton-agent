/**
 * Data validation module for market data.
 * Validates incoming WebSocket data for consistency, completeness, and sanity.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PoolStateValidation {
  address: string;
  dex: 'stonfi' | 'dedust';
  reserve0: bigint;
  reserve1: bigint;
  price: number;
  liquidity: number;
}

export interface TradeValidation {
  poolAddress: string;
  dex: 'stonfi' | 'dedust';
  amountIn: bigint;
  amountOut: bigint;
  price: number;
}

export class DataValidator {
  /**
   * Validate pool state data.
   */
  validatePoolState(state: PoolStateValidation): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (!state.address || state.address.length === 0) {
      errors.push('Pool address is required');
    }

    if (!state.dex || !['stonfi', 'dedust'].includes(state.dex)) {
      errors.push('DEX must be either "stonfi" or "dedust"');
    }

    // Validate reserves
    if (state.reserve0 < 0n) {
      errors.push('Reserve 0 cannot be negative');
    }

    if (state.reserve1 < 0n) {
      errors.push('Reserve 1 cannot be negative');
    }

    // Validate price
    if (state.price <= 0 || !isFinite(state.price)) {
      errors.push('Price must be positive and finite');
    }

    // Validate liquidity
    if (state.liquidity < 0) {
      errors.push('Liquidity cannot be negative');
    }

    // Sanity checks
    if (state.reserve0 === 0n && state.reserve1 === 0n) {
      warnings.push('Both reserves are zero - pool may be empty');
    }

    if (state.price > 1e10) {
      warnings.push('Price is unusually high - possible data error');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate trade data.
   */
  validateTrade(trade: TradeValidation): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (!trade.poolAddress || trade.poolAddress.length === 0) {
      errors.push('Pool address is required');
    }

    if (!trade.dex || !['stonfi', 'dedust'].includes(trade.dex)) {
      errors.push('DEX must be either "stonfi" or "dedust"');
    }

    // Validate amounts
    if (trade.amountIn <= 0n) {
      errors.push('Amount in must be positive');
    }

    if (trade.amountOut <= 0n) {
      errors.push('Amount out must be positive');
    }

    // Validate price
    if (trade.price <= 0 || !isFinite(trade.price)) {
      errors.push('Price must be positive and finite');
    }

    // Sanity checks
    if (trade.amountIn > 1n * 10n ** 18n) {
      warnings.push('Amount in is unusually large - possible data error');
    }

    if (trade.amountOut > 1n * 10n ** 18n) {
      warnings.push('Amount out is unusually large - possible data error');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate address format (TON address).
   */
  validateAddress(address: string): boolean {
    // TON addresses are 48 hex characters (user-friendly format)
    const tonAddressRegex = /^[a-zA-Z0-9_-]{48}$/;
    return tonAddressRegex.test(address);
  }

  /**
   * Validate timestamp is within acceptable range.
   */
  validateTimestamp(timestamp: number, maxAgeMs: number = 60000): boolean {
    const now = Date.now();
    const age = now - timestamp;
    return age >= 0 && age <= maxAgeMs;
  }

  /**
   * Check for price deviation from previous value.
   */
  validatePriceDeviation(
    currentPrice: number,
    previousPrice: number,
    maxDeviation: number = 0.5 // 50% max deviation
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (previousPrice <= 0) {
      warnings.push('No previous price for comparison');
      return { valid: true, errors, warnings };
    }

    const deviation = Math.abs(currentPrice - previousPrice) / previousPrice;

    if (deviation > maxDeviation) {
      errors.push(`Price deviation ${(deviation * 100).toFixed(2)}% exceeds maximum ${maxDeviation * 100}%`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
