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

// Migrate: add confidence_score column to positions table in existing databases.
// CREATE TABLE IF NOT EXISTS only applies to new tables; existing ones skip it.
try {
  db.exec("ALTER TABLE positions ADD COLUMN confidence_score INTEGER NOT NULL DEFAULT 0");
  log.info("STORE", "migrated positions table — added confidence_score column");
} catch {
  // Column already exists — safe to ignore.
}

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
    confidence_score INTEGER NOT NULL DEFAULT 0,
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

  -- Migrate existing tables: add confidence_score if missing (safe to run on fresh DBs too)



  -- TAOF: Agentic Wallets (on-chain budgeting contracts)
  CREATE TABLE IF NOT EXISTS agentic_wallets (
    address TEXT PRIMARY KEY,
    delegated_public_key TEXT NOT NULL,
    daily_limit TEXT NOT NULL,
    accumulated_spend TEXT NOT NULL,
    last_reset_timestamp INTEGER NOT NULL
  );

  -- TAOF: Trade Transactions (active/historical swaps)
  CREATE TABLE IF NOT EXISTS trade_transactions (
    tx_hash TEXT PRIMARY KEY,
    wallet_address TEXT REFERENCES agentic_wallets(address),
    source_token TEXT NOT NULL,
    target_token TEXT NOT NULL,
    input_amount TEXT NOT NULL,
    output_amount TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    gas_fees TEXT,
    timestamp INTEGER NOT NULL
  );

  -- TAOF: Transaction-level locks for serialization
  CREATE TABLE IF NOT EXISTS locks (
    lock_name TEXT PRIMARY KEY,
    tx_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL
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
  confidence_score?: number;
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
    const    stmt = db.prepare(`
      INSERT INTO positions (
        id, wallet_tier, jetton_master, symbol, dex, entry_tx_hash,
        entry_price_ton, entry_price_usd, entry_at, amount_tokens, cost_basis_ton,
        confidence_score,
        current_price_ton, pnl_pct, realized_pnl_ton, status, take_profit_t1_tx, close_tx, close_at
      ) VALUES (
        @id, @wallet_tier, @jetton_master, @symbol, @dex, @entry_tx_hash,
        @entry_price_ton, @entry_price_usd, @entry_at, @amount_tokens, @cost_basis_ton,
        COALESCE(@confidence_score, 0),
        @current_price_ton, @pnl_pct, @realized_pnl_ton, @status, @take_profit_t1_tx, @close_tx, @close_at
      ) ON CONFLICT(id) DO UPDATE SET
        wallet_tier=excluded.wallet_tier,
        symbol=COALESCE(excluded.symbol, symbol),
        dex=COALESCE(excluded.dex, dex),
        confidence_score=COALESCE(excluded.confidence_score, confidence_score),
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

// ─────────────────────────────────────────────────────────────────────
// TAOF: Agentic Wallet store
// ─────────────────────────────────────────────────────────────────────
export interface DbAgenticWallet {
  address: string;
  delegated_public_key: string;
  daily_limit: string;
  accumulated_spend: string;
  last_reset_timestamp: number;
}

export const agenticWalletStore = {
  upsert(w: DbAgenticWallet) {
    db.prepare(`
      INSERT INTO agentic_wallets (address, delegated_public_key, daily_limit, accumulated_spend, last_reset_timestamp)
      VALUES (@address, @delegated_public_key, @daily_limit, @accumulated_spend, @last_reset_timestamp)
      ON CONFLICT(address) DO UPDATE SET
        delegated_public_key=excluded.delegated_public_key,
        daily_limit=excluded.daily_limit,
        accumulated_spend=excluded.accumulated_spend,
        last_reset_timestamp=excluded.last_reset_timestamp
    `).run(w);
  },

  get(address: string): DbAgenticWallet | undefined {
    return db.prepare("SELECT * FROM agentic_wallets WHERE address = ?").get(address) as DbAgenticWallet | undefined;
  },

  listAll(): DbAgenticWallet[] {
    return db.prepare("SELECT * FROM agentic_wallets").all() as DbAgenticWallet[];
  },

  delete(address: string) {
    db.prepare("DELETE FROM agentic_wallets WHERE address = ?").run(address);
  }
};

// ─────────────────────────────────────────────────────────────────────
// TAOF: Trade Transaction store
// ─────────────────────────────────────────────────────────────────────
export interface DbTradeTransaction {
  tx_hash: string;
  wallet_address?: string;
  source_token: string;
  target_token: string;
  input_amount: string;
  output_amount?: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'BOUNCED';
  gas_fees?: string;
  timestamp: number;
}

export const tradeTransactionStore = {
  insert(t: DbTradeTransaction) {
    db.prepare(`
      INSERT INTO trade_transactions (tx_hash, wallet_address, source_token, target_token, input_amount, output_amount, status, gas_fees, timestamp)
      VALUES (@tx_hash, @wallet_address, @source_token, @target_token, @input_amount, @output_amount, @status, @gas_fees, @timestamp)
      ON CONFLICT(tx_hash) DO UPDATE SET
        output_amount=COALESCE(excluded.output_amount, output_amount),
        status=excluded.status,
        gas_fees=excluded.gas_fees
    `).run(t);
  },

  get(txHash: string): DbTradeTransaction | undefined {
    return db.prepare("SELECT * FROM trade_transactions WHERE tx_hash = ?").get(txHash) as DbTradeTransaction | undefined;
  },

  listPending(): DbTradeTransaction[] {
    return db.prepare("SELECT * FROM trade_transactions WHERE status = 'PENDING' ORDER BY timestamp ASC").all() as DbTradeTransaction[];
  },

  listByWallet(address: string): DbTradeTransaction[] {
    return db.prepare("SELECT * FROM trade_transactions WHERE wallet_address = ? ORDER BY timestamp DESC").all(address) as DbTradeTransaction[];
  },

  updateStatus(txHash: string, status: DbTradeTransaction['status'], outputAmount?: string, gasFees?: string) {
    const stmt = db.prepare(`
      UPDATE trade_transactions SET status = ?, output_amount = COALESCE(?, output_amount), gas_fees = COALESCE(?, gas_fees) WHERE tx_hash = ?
    `);
    stmt.run(status, outputAmount ?? null, gasFees ?? null, txHash);
  },

  /** Release any stale locks (> 300 seconds / 5 minutes) */
  releaseStaleLocks() {
    const cutoff = Date.now() - 300_000;
    db.prepare("DELETE FROM locks WHERE created_at < ?").run(cutoff);
    // Also mark any PENDING tx older than 300s as FAILED (timeout)
    db.prepare("UPDATE trade_transactions SET status = 'FAILED' WHERE status = 'PENDING' AND timestamp < ?").run(cutoff);
  }
};

// ─────────────────────────────────────────────────────────────────────
// TAOF: Transaction-level Locking (serialization)
// ─────────────────────────────────────────────────────────────────────
export interface DbLock {
  lock_name: string;
  tx_hash?: string;
  created_at: number;
}

/**
 * Attempt to acquire a named lock. Returns true if the lock was acquired.
 * Returns false if the lock is already held by another transaction.
 */
export function acquireLock(lockName: string, txHash: string): boolean {
  try {
    db.prepare("INSERT INTO locks (lock_name, tx_hash, created_at) VALUES (?, ?, ?)").run(lockName, txHash, Date.now());
    return true;
  } catch {
    return false;
  }
}

/**
 * Release a named lock. Returns true if the lock was released.
 */
export function releaseLock(lockName: string): boolean {
  const result = db.prepare("DELETE FROM locks WHERE lock_name = ?").run(lockName);
  return result.changes > 0;
}

/**
 * Check if a named lock is currently held.
 */
export function isLockHeld(lockName: string): boolean {
  const row = db.prepare("SELECT 1 FROM locks WHERE lock_name = ?").get(lockName);
  return !!row;
}

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
