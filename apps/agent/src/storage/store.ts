import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { log } from "../logger";

const dataDir = process.env.DATA_DIR || "./data";
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "agent.db");
log.info("STORE", `Initializing SQLite DB at ${dbPath}`);

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    wallet_tier TEXT NOT NULL,
    jetton_master TEXT NOT NULL,
    symbol TEXT,
    dex TEXT,
    entry_tx_hash TEXT NOT NULL,
    entry_price_ton REAL NOT NULL,
    entry_price_usd REAL,
    entry_at INTEGER NOT NULL,
    amount_tokens TEXT NOT NULL,
    cost_basis_ton REAL NOT NULL,
    current_price_ton REAL,
    pnl_pct REAL,
    realized_pnl_ton REAL,
    status TEXT NOT NULL,
    take_profit_t1_tx TEXT,
    close_tx TEXT,
    close_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS seen_jettons (
    master TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tier_status (
    tier TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    wallet_address TEXT,
    started_at INTEGER,
    bankroll_ton REAL,
    open_positions INTEGER DEFAULT 0,
    closed_trades INTEGER DEFAULT 0,
    total_pnl_ton REAL DEFAULT 0,
    realized_pnl_ton REAL DEFAULT 0,
    daily_pnl_ton REAL DEFAULT 0,
    uptime_sec REAL DEFAULT 0,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    wallet_tier TEXT,
    at INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_args TEXT,
    tool_result TEXT,
    meta TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_pnl_log (
    day TEXT PRIMARY KEY, -- YYYY-MM-DD
    pnl_ton REAL NOT NULL DEFAULT 0
  );
`);

// Helper types matching shared schema
export interface DbPosition {
  id: string;
  wallet_tier: string;
  jetton_master: string;
  symbol?: string;
  dex?: string;
  entry_tx_hash: string;
  entry_price_ton: number;
  entry_price_usd?: number;
  entry_at: number;
  amount_tokens: string;
  cost_basis_ton: number;
  current_price_ton?: number;
  pnl_pct?: number;
  realized_pnl_ton?: number;
  status: string;
  take_profit_t1_tx?: string;
  close_tx?: string;
  close_at?: number;
}

// Positions API
export const positionsStore = {
  upsert(p: DbPosition) {
    const stmt = db.prepare(`
      INSERT INTO positions (
        id, wallet_tier, jetton_master, symbol, dex, entry_tx_hash,
        entry_price_ton, entry_price_usd, entry_at, amount_tokens, cost_basis_ton,
        current_price_ton, pnl_pct, realized_pnl_ton, status, take_profit_t1_tx, close_tx, close_at
      ) VALUES (
        @id, @wallet_tier, @jetton_master, @symbol, @dex, @entry_tx_hash,
        @entry_price_ton, @entry_price_usd, @entry_at, @amount_tokens, @cost_basis_ton,
        @current_price_ton, @pnl_pct, @realized_pnl_ton, @status, @take_profit_t1_tx, @close_tx, @close_at
      ) ON CONFLICT(id) DO UPDATE SET
        wallet_tier=excluded.wallet_tier,
        symbol=COALESCE(excluded.symbol, symbol),
        dex=COALESCE(excluded.dex, dex),
        current_price_ton=excluded.current_price_ton,
        pnl_pct=excluded.pnl_pct,
        realized_pnl_ton=excluded.realized_pnl_ton,
        status=excluded.status,
        take_profit_t1_tx=COALESCE(excluded.take_profit_t1_tx, take_profit_t1_tx),
        close_tx=COALESCE(excluded.close_tx, close_tx),
        close_at=COALESCE(excluded.close_at, close_at)
    `);
    stmt.run(p);
  },

  listOpen(): DbPosition[] {
    return db.prepare("SELECT * FROM positions WHERE status IN ('OPEN', 'TP1_HIT')").all() as DbPosition[];
  },

  listOpenByTier(tier: string): DbPosition[] {
    return db.prepare("SELECT * FROM positions WHERE status IN ('OPEN', 'TP1_HIT') AND wallet_tier = ?").all(tier) as DbPosition[];
  },

  get(id: string): DbPosition | undefined {
    return db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as DbPosition | undefined;
  },

  countClosedForTier(tier: string): number {
    const res = db.prepare("SELECT COUNT(*) as count FROM positions WHERE status IN ('CLOSED', 'STOPPED') AND wallet_tier = ?").get(tier) as any;
    return res?.count || 0;
  },

  countPositiveClosedForTier(tier: string): number {
    const res = db.prepare("SELECT COUNT(*) as count FROM positions WHERE status IN ('CLOSED', 'STOPPED') AND pnl_pct > 0 AND wallet_tier = ?").get(tier) as any;
    return res?.count || 0;
  }
};

// Seen Jettons API
export const seenStore = {
  add(master: string) {
    db.prepare("INSERT OR IGNORE INTO seen_jettons (master, seen_at) VALUES (?, ?)").run(master, Date.now());
  },
  has(master: string): boolean {
    const row = db.prepare("SELECT 1 FROM seen_jettons WHERE master = ?").get(master);
    return !!row;
  },
  clearOld() {
    // Keep top 2000
    db.prepare(`
      DELETE FROM seen_jettons WHERE master NOT IN (
        SELECT master FROM seen_jettons ORDER BY seen_at DESC LIMIT 2000
      )
    `).run();
  }
};

// Tier Status API
export interface DbTierStatus {
  tier: string;
  status: string;
  wallet_address?: string;
  started_at?: number;
  bankroll_ton?: number;
  open_positions?: number;
  closed_trades?: number;
  total_pnl_ton?: number;
  realized_pnl_ton?: number;
  daily_pnl_ton?: number;
  uptime_sec?: number;
  updated_at?: number;
}

export const statusStore = {
  upsert(s: DbTierStatus) {
    const stmt = db.prepare(`
      INSERT INTO tier_status (
        tier, status, wallet_address, started_at, bankroll_ton,
        open_positions, closed_trades, total_pnl_ton, realized_pnl_ton, daily_pnl_ton, uptime_sec, updated_at
      ) VALUES (
        @tier, @status, @wallet_address, @started_at, @bankroll_ton,
        @open_positions, @closed_trades, @total_pnl_ton, @realized_pnl_ton, @daily_pnl_ton, @uptime_sec, @updated_at
      ) ON CONFLICT(tier) DO UPDATE SET
        status=excluded.status,
        wallet_address=COALESCE(excluded.wallet_address, wallet_address),
        started_at=COALESCE(excluded.started_at, started_at),
        bankroll_ton=COALESCE(excluded.bankroll_ton, bankroll_ton),
        open_positions=excluded.open_positions,
        closed_trades=excluded.closed_trades,
        total_pnl_ton=excluded.total_pnl_ton,
        realized_pnl_ton=excluded.realized_pnl_ton,
        daily_pnl_ton=excluded.daily_pnl_ton,
        uptime_sec=excluded.uptime_sec,
        updated_at=excluded.updated_at
    `);
    stmt.run({
      open_positions: 0,
      closed_trades: 0,
      total_pnl_ton: 0,
      realized_pnl_ton: 0,
      daily_pnl_ton: 0,
      uptime_sec: 0,
      updated_at: Date.now(),
      ...s
    });
  },

  get(tier: string): DbTierStatus | undefined {
    return db.prepare("SELECT * FROM tier_status WHERE tier = ?").get(tier) as DbTierStatus | undefined;
  }
};

// Daily PnL tracking for circuit breaker
export const dailyPnlStore = {
  getTodayPnl(): number {
    const today = new Date().toISOString().split("T")[0];
    const row = db.prepare("SELECT pnl_ton FROM daily_pnl_log WHERE day = ?").get(today) as any;
    return row?.pnl_ton || 0;
  },
  addPnl(pnl: number) {
    const today = new Date().toISOString().split("T")[0];
    db.prepare(`
      INSERT INTO daily_pnl_log (day, pnl_ton)
      VALUES (?, ?)
      ON CONFLICT(day) DO UPDATE SET pnl_ton = pnl_ton + excluded.pnl_ton
    `).run(today, pnl);
  }
};
