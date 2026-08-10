/**
 * Agent control-plane read API.
 *
 * Bridges the agent's SQLite database (agent.db — persisted on the Fly.io
 * volume) to the web dashboard over HTTP. The web app runs on Vercel
 * serverless which is stateless and cannot open the Fly volume's SQLite
 * file directly, so it fetches this API server-side instead.
 *
 * Auth: every request must carry `X-Agent-Secret` matching
 * AGENT_SHARED_SECRET (same secret the web app holds). Fail-closed when the
 * secret is missing.
 *
 * Endpoints:
 *   GET  /api/dashboard  → aggregated live snapshot (tiers, positions,
 *                          messages, PnL history, kill switch, journal)
 *   GET  /api/positions  → recent positions, newest first (?limit=N)
 *   POST /api/kill       → { engaged: boolean, reason?: string } — operator
 *                          kill-switch override (takes precedence over the
 *                          remote poller until lifted)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONFIG } from "../config";
import { log } from "../logger";
import { db, type DbPosition, type DbTierStatus } from "../storage/store";
import { getCoordinator, isCoordinatorStarted } from "../core/coordinator";

const TIERS = ["low", "mid", "high"] as const;
type Tier = (typeof TIERS)[number];

// ─── Auth ────────────────────────────────────────────────────────────────
function safeEqual(a: string, b: string): boolean {
  // Constant-time compare via HMAC digests (avoids length-leak on raw strings).
  const ha = createHmac("sha256", a).digest();
  const hb = createHmac("sha256", b).digest();
  return timingSafeEqual(ha, hb);
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = CONFIG.agentSharedSecret;
  if (!expected) {
    log.warn("READ-API", "AGENT_SHARED_SECRET not set — denying control-plane request (fail closed)");
    return false;
  }
  const provided = req.headers["x-agent-secret"];
  if (!provided || typeof provided !== "string" || !provided) return false;
  return safeEqual(provided, expected);
}

// ─── Response helpers ────────────────────────────────────────────────────
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Agent-Secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e instanceof Error ? e : new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

// ─── Queries against agent.db ────────────────────────────────────────────
function tierRows(): Map<string, DbTierStatus> {
  const map = new Map<string, DbTierStatus>();
  for (const tier of TIERS) {
    const row = db
      .prepare("SELECT * FROM tier_status WHERE tier = ?")
      .get(tier) as DbTierStatus | undefined;
    if (row) map.set(tier, row);
  }
  return map;
}

function recentPositions(limit: number): DbPosition[] {
  return db
    .prepare("SELECT * FROM positions ORDER BY entry_at DESC LIMIT ?")
    .all(limit) as DbPosition[];
}

function recentMessages(limit: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT id, thread_id, wallet_tier, at, role, content, tool_name, meta FROM agent_messages ORDER BY at DESC LIMIT ?",
    )
    .all(limit) as Array<Record<string, unknown>>;
}

function pnlHistory(limit: number): Array<{ day: string; pnl_ton: number }> {
  const rows = db
    .prepare("SELECT day, pnl_ton FROM daily_pnl_log ORDER BY day DESC LIMIT ?")
    .all(limit) as Array<{ day: string; pnl_ton: number }>;
  return rows.reverse(); // oldest → newest
}

function recentJournal(limit: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT id, cycle_id, ts, agent, model_used, final_action FROM decision_journal ORDER BY ts DESC LIMIT ?",
    )
    .all(limit) as Array<Record<string, unknown>>;
}

function toPositionView(p: DbPosition) {
  return {
    id: p.id,
    walletTier: p.wallet_tier,
    symbol: p.symbol ?? null,
    jettonMaster: p.jetton_master,
    dex: p.dex ?? null,
    entryTxHash: p.entry_tx_hash,
    entryPriceTon: p.entry_price_ton,
    entryAt: p.entry_at,
    amountTokens: p.amount_tokens,
    costBasisTon: p.cost_basis_ton,
    confidenceScore: p.confidence_score ?? 0,
    currentPriceTon: p.current_price_ton ?? null,
    pnlPct: p.pnl_pct ?? null,
    realizedPnlTon: p.realized_pnl_ton ?? null,
    status: p.status,
    closeTx: p.close_tx ?? null,
    closeAt: p.close_at ?? null,
  };
}

// ─── Snapshot assembly ───────────────────────────────────────────────────
function dashboardSnapshot() {
  const coordinatorStarted = isCoordinatorStarted();
  const snap = coordinatorStarted ? getCoordinator().getSnapshot() : null;
  const statusRows = tierRows();

  const tiers = TIERS.map((tier) => {
    const s = statusRows.get(tier);
    const live = snap?.tiers.find((x) => x.tier === tier);
    return {
      tier,
      address: live?.address ?? s?.wallet_address ?? "",
      status:
        s?.status ??
        (tier === "high" && !snap?.highUnlocked ? "paused" : "running"),
      balanceTon: live?.balanceTon ?? s?.bankroll_ton ?? 0,
      openPositions: live?.openPositions ?? s?.open_positions ?? 0,
      closedTrades: live?.closedTrades ?? s?.closed_trades ?? 0,
      totalPnlTon: s?.total_pnl_ton ?? 0,
      realizedPnlTon: s?.realized_pnl_ton ?? 0,
      dailyPnlTon: live?.dailyPnlTon ?? s?.daily_pnl_ton ?? 0,
      uptimeSec: s?.uptime_sec ?? snap?.uptimeSec ?? 0,
      unlocked: live?.unlocked ?? tier !== "high",
      maxPositionTon: live?.maxPositionTon ?? null,
      maxOpen: live?.maxOpen ?? null,
    };
  });

  return {
    generatedAt: Date.now(),
    uptimeSec: snap?.uptimeSec ?? 0,
    coordinatorStarted,
    killSwitch: snap?.killSwitch ?? { active: false },
    circuitBreaker: snap?.circuitBreaker ?? { ok: true, todayPnl: 0 },
    highUnlocked: snap?.highUnlocked ?? false,
    tiers,
    // 200 rows: the web slices to its table limit and ALSO derives per-tier
    // realized-PnL sparklines from this list, so keep history wide enough.
    positions: recentPositions(200).map(toPositionView),
    messages: recentMessages(50),
    pnlHistory: pnlHistory(30),
    journal: recentJournal(20),
  };
}

// ─── Router ──────────────────────────────────────────────────────────────
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Agent-Secret",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(res, 200, dashboardSnapshot());
    return;
  }

  if (method === "GET" && url.pathname === "/api/positions") {
    const raw = Number(url.searchParams.get("limit") ?? 50);
    const limit = Math.min(Number.isFinite(raw) && raw > 0 ? raw : 50, 200);
    sendJson(res, 200, {
      generatedAt: Date.now(),
      positions: recentPositions(limit).map(toPositionView),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/kill") {
    if (!isCoordinatorStarted()) {
      sendJson(res, 503, { error: "coordinator not started" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const engaged = body.engaged;
    if (typeof engaged !== "boolean") {
      sendJson(res, 400, { error: "engaged must be a boolean" });
      return;
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const result = getCoordinator().setKillSwitch(engaged, reason);
    log.info("READ-API", `kill switch set by operator: engaged=${engaged}`);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
