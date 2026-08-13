/**
 * Market Scanner — read-only market data specialist.
 *
 * Tools: pool discovery, price/volume fetch, candidate enrichment.
 * NO transact tools — containment layer.
 * Model: cheap/fast (e.g., nemotron-3-ultra or local).
 */
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { newId } from "@ton-agent/shared";
import { CONFIG } from "../../config";
import { log } from "../../logger";
import { poolMonitorService } from "../../market";
import type { PoolState } from "../../market/pool-monitor";

export interface MarketScannerInput {
  cycle_id: string;
  /** Optional: seed from scheduler or Telegram command */
  seed_jetton_master?: string;
}

export interface MarketScannerOutput {
  cycle_id: string;
  candidates: JettonCandidate[];
  /** One winner if single-shot; empty for multi-candidate mode */
  winner?: JettonCandidate;
}

export interface JettonCandidate {
  jetton_master: string;
  symbol?: string;
  pool_address?: string;
  pool_tvl_ton?: number;
  volume_24h_ton?: number;
  price_ton?: number;
  price_change_24h_pct?: number;
  liquidity_ton?: number;
  holders?: number;
  age_hours?: number;
  bonding_curve_pct?: number;
  source: "stonfi" | "dedust" | "tonapi" | "manual";
  enriched_at: number;
}

/**
 * Deterministic enrichment helpers (no LLM).
 * In production these call the pool monitor / TONAPI directly.
 */
export async function enrichCandidate(
  jettonMaster: string,
): Promise<JettonCandidate | null> {
  try {
    // Find pool by jetton master from all monitored pools
    const allPools = poolMonitorService.getAllPools();
    const pool = allPools.find((p) => {
      // Pool state doesn't directly have jetton_master, need to check token addresses
      return p.token0Address === jettonMaster || p.token1Address === jettonMaster;
    });
    if (!pool) return null;

    const candidate: JettonCandidate = {
      jetton_master: jettonMaster,
      pool_address: pool.address,
      pool_tvl_ton: pool.liquidity, // Using liquidity as TVL proxy
      volume_24h_ton: pool.volume24h,
      price_ton: pool.price,
      price_change_24h_pct: 0, // Not directly available
      liquidity_ton: pool.liquidity,
      holders: 0, // Not available from pool state
      age_hours: 0, // Not available
      bonding_curve_pct: 0, // Not applicable for DEX pools
      source: pool.dex,
      enriched_at: Date.now(),
    };

    // Try to get symbol from metadata
    try {
      const { getJettonMetaTool } = await import("../../mcp/tools");
      const meta = await getJettonMetaTool.invoke({ jettonMaster });
      if (meta?.symbol) candidate.symbol = meta.symbol;
    } catch {}

    return candidate;
  } catch (e: any) {
    log.debug("MARKET_SCANNER", `enrich failed for ${jettonMaster}: ${e.message}`);
    return null;
  }
}

/**
 * Scan for new candidates — called by scheduler or supervisor.
 * Returns top-N by volume/liquidity heuristics.
 */
export async function scanForCandidates(
  limit = 10,
): Promise<JettonCandidate[]> {
  try {
    const pools = poolMonitorService.getAllPools();
    // Sort by volume descending
    const sorted = [...pools].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
    const candidates: JettonCandidate[] = [];

    for (const pool of sorted) {
      // Try both token0 and token1 as jetton masters
      for (const master of [pool.token0Address, pool.token1Address]) {
        if (master && master !== "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c") { // Skip native TON
          const enriched = await enrichCandidate(master);
          if (enriched) candidates.push(enriched);
          if (candidates.length >= limit) break;
        }
      }
      if (candidates.length >= limit) break;
    }

    return candidates;
  } catch (e: any) {
    log.debug("MARKET_SCANNER", `scan failed: ${e.message}`);
    return [];
  }
}

/**
 * LLM-based qualitative filter (optional — used when supervisor wants reasoning).
 * Receives pre-enriched candidates, returns filtered + scored list.
 * NO tool calls — just reasoning on provided data.
 */
export function makeMarketScannerAgent() {
  const llm = new ChatOpenAI({
    apiKey: CONFIG.nvidiaApiKey,
    model: CONFIG.nvidiaModel,
    temperature: 0.1,
    configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
  });

  const systemPrompt = `You are a quantitative market scanner for TON jetton pairs.
Given a list of pre-enriched candidates (price, TVL, volume, liquidity, age, bonding curve), rank them by probability of a profitable swing trade (1h–24h hold).

HARD FILTERS (auto-reject):
- TVL < 10 TON (too thin)
- Liquidity < 5 TON (slippage risk)
- Age < 1 hour AND bonding_curve_pct < 80% (too early / sniper trap)
- Volume/TVL ratio < 0.1 (dead pool)
- Top 10 holder concentration > 35% (sybil risk — provided in enrichment)

SCORING (0–100):
- Volume momentum (24h vol / TVL): 30 pts
- Liquidity depth (TVL > 100 TON): 20 pts
- Organic holders (>200, growing): 20 pts
- Price action (positive 24h, not parabolic): 15 pts
- Bonding curve 80–95% (pre-graduation momentum): 15 pts

Return ONLY JSON:
{
  "ranked": [
    {"jetton_master": "...", "score": 85, "reason": "..."},
    ...
  ],
  "rejected": [
    {"jetton_master": "...", "reason": "TVL 3 TON < 10 threshold"},
    ...
  ]
}`;

  const agent = createReactAgent({
    llm,
    tools: [], // NO tools — pure reasoning on provided context
    prompt: systemPrompt,
  });

  return agent;
}

/**
 * Main entry for supervisor: enrich + optionally LLM-rank.
 */
export async function marketScannerNode(
  input: MarketScannerInput,
): Promise<MarketScannerOutput> {
  const { cycle_id, seed_jetton_master } = input;

  let candidates: JettonCandidate[] = [];

  if (seed_jetton_master) {
    const enriched = await enrichCandidate(seed_jetton_master);
    if (enriched) candidates = [enriched];
  } else {
    candidates = await scanForCandidates(20);
  }

  if (candidates.length === 0) {
    return { cycle_id, candidates: [] };
  }

  // Optional LLM ranking (supervisor decides whether to invoke)
  // For now, return deterministic top by volume/TVL ratio
  const ranked = candidates
    .filter((c) => c.pool_tvl_ton && c.pool_tvl_ton! >= 10 && c.liquidity_ton && c.liquidity_ton! >= 5)
    .sort((a, b) => {
      const ratioA = (a.volume_24h_ton ?? 0) / (a.pool_tvl_ton ?? 1);
      const ratioB = (b.volume_24h_ton ?? 0) / (b.pool_tvl_ton ?? 1);
      return ratioB - ratioA;
    })
    .slice(0, 5);

  return {
    cycle_id,
    candidates: ranked,
    winner: ranked[0],
  };
}