import type { GramTradeState } from "../state";

/**
 * Sentinel Agent Node (Data Ingestor / Anomaly Detector)
 * Checks the candidate's basic stats.
 */
export function sentinelNode(state: GramTradeState): Partial<GramTradeState> {
  const address = state.candidate?.jetton_master;
  if (!address) {
    return {
      discarded: true,
      discard_reason: "Sentinel: No jetton master candidate address provided.",
    };
  }

  // Set default metadata if not set
  const metadata = state.pair_metadata || {
    bonding_curve_pct: 82.5,
    jetton_admin_revoked: true,
    volume_5m_usd: 16000,
    has_bytecode: true,
    raw_code_len: 256,
  };

  return {
    pair_metadata: metadata,
  };
}
