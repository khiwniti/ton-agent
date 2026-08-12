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
    confidence_score INTEGER NOT NULL DEFAULT 0,
    current_price_ton REAL,
    pnl_pct REAL,
    realized_pnl_ton REAL,
    status TEXT NOT NULL,
    close_tx TEXT,
    close_at INTEGER,
    -- Phase 4 hot-path exit-policy state. Declared HERE (not only as an
    -- ALTER migration) so a fresh DB has them from the start: the migration
    -- below cannot create them before this statement runs.
    max_hold_ms INTEGER,
    exit_by_ms INTEGER,
    rugged INTEGER NOT NULL DEFAULT 0,
    rugged_at INTEGER,
    emergency_exit INTEGER NOT NULL DEFAULT 0,
    -- Cumulative TON burned on gas for this position (entry + exit legs).
    -- Added 2026-08-08: realized_pnl_ton previously omitted gas entirely, so
    -- the books reported -0.188 TON while the wallet drained to 0.000000.
    gas_ton REAL NOT NULL DEFAULT 0,
    -- Live-monitor trend state (written every tick while OPEN). Declared HERE
    -- so a fresh DB has them from the start; POSITION_MIGRATIONS covers
    -- existing databases.
    trend_bearish INTEGER NOT NULL DEFAULT 0,
    trend_confirmations INTEGER NOT NULL DEFAULT 0,
    trend_observations INTEGER NOT NULL DEFAULT 0,
    trend_reason TEXT,
    trend_updated_at INTEGER,
    feed_confirmed INTEGER NOT NULL DEFAULT 0,
    -- Provenance discriminator (2026-08-11): "swing" | "sniper" | NULL.
    -- Recorded at open; nothing gates on it yet — it feeds per-technique
    -- reporting and the technique exit matrix (research/05-technique-exit-matrix.md).
    technique TEXT
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

  -- GRAM Phase 1: append-only decision journal (never UPDATE in place)
  CREATE TABLE IF NOT EXISTS decision_journal (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    agent TEXT NOT NULL,
    model_used TEXT,
    input_hash TEXT NOT NULL,
    tool_calls TEXT,
    output TEXT,
    cap_check_result TEXT,
    hitl_status TEXT,
    final_action TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_decision_journal_cycle
    ON decision_journal(cycle_id, ts);

  CREATE TABLE IF NOT EXISTS agent_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/**
 * Column migrations for databases created before a column was added to the
 * CREATE TABLE above. MUST run after it — an ALTER on a table that does not
 * exist yet fails, and on a fresh DB that failure used to be swallowed,
 * leaving the table without the Phase-4 columns and making every
 * positionsStore.upsert throw `no such column: excluded.max_hold_ms`.
 *
 * Only "duplicate column name" is expected (column already present). Anything
 * else is a real schema fault and must surface rather than be absorbed.
 */
const POSITION_MIGRATIONS: Array<[string, string]> = [
  ["confidence_score", "INTEGER NOT NULL DEFAULT 0"],
  ["max_hold_ms", "INTEGER"],
  ["exit_by_ms", "INTEGER"],
  ["rugged", "INTEGER NOT NULL DEFAULT 0"],
  ["rugged_at", "INTEGER"],
  ["emergency_exit", "INTEGER NOT NULL DEFAULT 0"],
  ["gas_ton", "REAL NOT NULL DEFAULT 0"],
  ["trend_bearish", "INTEGER NOT NULL DEFAULT 0"],
  ["trend_confirmations", "INTEGER NOT NULL DEFAULT 0"],
  ["trend_observations", "INTEGER NOT NULL DEFAULT 0"],
  ["trend_reason", "TEXT"],
  ["trend_updated_at", "INTEGER"],
  ["feed_confirmed", "INTEGER NOT NULL DEFAULT 0"],
  // Volatility- & structure-adaptive exits (2026-08-11) — journaled facts
  // so the dashboard can surface regime. NULL when the module is disabled.
  ["atr_close_ton", "REAL"],
  ["volatility_regime", "TEXT"],
  ["structure_stop_level_ton", "REAL"],
  ["technique", "TEXT"],
];
for (const [col, type] of POSITION_MIGRATIONS) {
  try {
    db.exec(`ALTER TABLE positions ADD COLUMN ${col} ${type}`);
    log.info("STORE", `migrated positions table — added ${col} column`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}

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
  close_tx?: string;
  close_at?: number;
  // Phase 4 hot-path exit state (all optional/nullable for migration compat)
  max_hold_ms?: number | null;       // 0/NULL = no TimeExit
  exit_by_ms?: number | null;        // deadline = entry_at + max_hold_ms
  rugged?: number;                    // 1 once emergency-exit fired (never reset)
  rugged_at?: number | null;
  emergency_exit?: number;            // 1 once an emergency exit was executed
  /** Cumulative gas (TON) charged against this position. Already deducted
   *  from realized_pnl_ton — kept separately so gas can be audited and the
   *  ENTRY_GAS_TON/EXIT_GAS_TON estimates calibrated against reality. */
  gas_ton?: number;
  // Live-monitor trend state (written every tick while OPEN)
  trend_bearish?: number; // 1 once the trend engine reports bearish
  trend_confirmations?: number; // consecutive bearish observations seen
  trend_observations?: number; // real (non-seed) observations seen
  trend_reason?: string | null;
  trend_updated_at?: number | null;
  feed_confirmed?: number; // 1 = external feeds corroborated the flip
  // Phase 4.5 volatility-adaptive exit state (written every tick while OPEN)
  atr_close_ton?: number | null; // close-only ATR proxy (price units)
  volatility_regime?: string | null; // calm | normal | spiked | unknown
  structure_stop_level_ton?: number | null; // high-water − k×ATR, clamped
  // Provenance discriminator (2026-08-11): "swing" | "sniper" | null.
  technique?: string | null;
}

// Positions API
export const positionsStore = {
  /**
   * Insert or update a position.
   *
   * Every optional field of `DbPosition` is defaulted before binding. SQLite
   * named parameters are all-or-nothing: a key absent from the object throws
   * `Missing named parameter "..."` at run time, not compile time, so a caller
   * passing a partial row (several do, via `as any`) would fail mid-trade —
   * after the swap has already settled on chain.
   */
  upsert(p: DbPosition) {
    const row = {
      symbol: null,
      dex: null,
      entry_price_usd: null,
      confidence_score: null,
      current_price_ton: null,
      pnl_pct: null,
      realized_pnl_ton: null,
      close_tx: null,
      close_at: null,
      max_hold_ms: null,
      exit_by_ms: null,
      rugged: null,
      rugged_at: null,
      emergency_exit: null,
      // Sticky columns: omitted fields must bind NULL so the UPDATE-side
      // COALESCE preserves the stored value (gas accumulates across partial
      // closes; rugged/emergency_exit stay set once flipped). A `0` default
      // here would silently reset them on every tick update.
      gas_ton: null,
      trend_bearish: 0,
      trend_confirmations: 0,
      trend_observations: 0,
      trend_reason: null,
      trend_updated_at: null,
      feed_confirmed: 0,
      // Phase 4.5 volatility facts — overwritten every tick like trend state.
      atr_close_ton: null,
      volatility_regime: null,
      structure_stop_level_ton: null,
      technique: null, // "swing" | "sniper" set at open; sticky thereafter
      ...p,
    };
    const    stmt = db.prepare(`
      INSERT INTO positions (
        id, wallet_tier, jetton_master, symbol, dex, entry_tx_hash,
        entry_price_ton, entry_price_usd, entry_at, amount_tokens, cost_basis_ton,
        confidence_score,
        current_price_ton, pnl_pct, realized_pnl_ton, status, take_profit_t1_tx, close_tx, close_at,
        -- Phase 4 columns were in the UPDATE clause but NOT here, so a new
        -- position's time limit was dropped on INSERT: max_hold_ms/exit_by_ms
        -- landed NULL and the TimeExit rule never fired for it.
        max_hold_ms, exit_by_ms, rugged, rugged_at, emergency_exit, gas_ton,
        trend_bearish, trend_confirmations, trend_observations, trend_reason, trend_updated_at, feed_confirmed,
        atr_close_ton, volatility_regime, structure_stop_level_ton,
        technique
      ) VALUES (
        @id, @wallet_tier, @jetton_master, @symbol, @dex, @entry_tx_hash,
        @entry_price_ton, @entry_price_usd, @entry_at, @amount_tokens, @cost_basis_ton,
        COALESCE(@confidence_score, 0),
        @current_price_ton, @pnl_pct, @realized_pnl_ton, @status, @close_tx, @close_at,
        @max_hold_ms, @exit_by_ms, COALESCE(@rugged, 0), @rugged_at, COALESCE(@emergency_exit, 0), COALESCE(@gas_ton, 0),
        @trend_bearish, @trend_confirmations, @trend_observations, @trend_reason, @trend_updated_at, @feed_confirmed,
        @atr_close_ton, @volatility_regime, @structure_stop_level_ton,
        @technique
      ) ON CONFLICT(id) DO UPDATE SET
        wallet_tier=excluded.wallet_tier,
        symbol=COALESCE(excluded.symbol, symbol),
        dex=COALESCE(excluded.dex, dex),
        confidence_score=COALESCE(@confidence_score, confidence_score),
        current_price_ton=excluded.current_price_ton,
        pnl_pct=excluded.pnl_pct,
        realized_pnl_ton=excluded.realized_pnl_ton,
        status=excluded.status,
        close_tx=COALESCE(excluded.close_tx, close_tx),
        close_at=COALESCE(excluded.close_at, close_at),
        -- Phase 4 exit state. max_hold_ms/exit_by_ms set on entry only; the
        -- tick just updates price/pnl/status and at exit flips rugged flags.
        -- Sticky columns reference the raw @param, NOT excluded.*: excluded
        -- holds the post-COALESCE insert value (0 when omitted), which would
        -- overwrite the stored value. @param is NULL when omitted, so
        -- COALESCE(@x, col) keeps the stored value (once set, stays set).
        max_hold_ms=COALESCE(excluded.max_hold_ms, max_hold_ms),
        exit_by_ms=COALESCE(excluded.exit_by_ms, exit_by_ms),
        rugged=COALESCE(@rugged, rugged),
        rugged_at=COALESCE(excluded.rugged_at, rugged_at),
        emergency_exit=COALESCE(@emergency_exit, emergency_exit),
        gas_ton=COALESCE(@gas_ton, gas_ton),
        -- Trend state overwritten every tick like price/pnl (NOT sticky).
        trend_bearish=excluded.trend_bearish,
        trend_confirmations=excluded.trend_confirmations,
        trend_observations=excluded.trend_observations,
        trend_reason=excluded.trend_reason,
        trend_updated_at=excluded.trend_updated_at,
        feed_confirmed=excluded.feed_confirmed,
        -- Phase 4.5 volatility facts overwritten every tick like trend state.
        atr_close_ton=excluded.atr_close_ton,
        volatility_regime=excluded.volatility_regime,
        structure_stop_level_ton=excluded.structure_stop_level_ton,
        -- Sticky: set at open, preserved on tick updates (COALESCE with @param
        -- NULL when the caller omits it — same pattern as max_hold_ms).
        technique=COALESCE(@technique, technique)
    `);
    stmt.run(row);
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

  /** True if this jetton ever had a terminal exit (RUG_EXIT / STOPPED). */
  hasTerminalExit(jettonMaster: string): boolean {
    const res = db
      .prepare("SELECT 1 FROM positions WHERE jetton_master = ? AND status IN ('RUG_EXIT', 'STOPPED') LIMIT 1")
      .get(jettonMaster) as any;
    return !!res;
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

// ─────────────────────────────────────────────────────────────────────
// GRAM Phase 1: Append-only decision journal
// Rule: if it is not journaled, it did not happen (for post-mortems).
// ─────────────────────────────────────────────────────────────────────
export interface DbJournalEntry {
  id: string;
  cycle_id: string;
  ts: number;
  agent: string;
  model_used?: string | null;
  input_hash: string;
  tool_calls?: string | null;
  output?: string | null;
  cap_check_result?: string | null;
  hitl_status?: string | null;
  final_action: string;
}

export interface JournalAppendInput {
  cycle_id: string;
  agent: string;
  final_action: string;
  input_hash?: string;
  model_used?: string;
  tool_calls?: unknown;
  output?: unknown;
  cap_check_result?: unknown;
  hitl_status?: string;
  /** Optional stable id; auto-generated when omitted. */
  id?: string;
}

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const decisionJournalStore = {
  /**
   * Append a journal row. Never updates existing rows.
   * Returns the assigned id.
   */
  append(entry: JournalAppendInput): string {
    const id =
      entry.id ??
      `jrn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const row: DbJournalEntry = {
      id,
      cycle_id: entry.cycle_id,
      ts: Date.now(),
      agent: entry.agent,
      model_used: entry.model_used ?? null,
      input_hash: entry.input_hash ?? "none",
      tool_calls: jsonOrNull(entry.tool_calls),
      output: jsonOrNull(entry.output),
      cap_check_result: jsonOrNull(entry.cap_check_result),
      hitl_status: entry.hitl_status ?? null,
      final_action: entry.final_action,
    };
    db.prepare(`
      INSERT INTO decision_journal (
        id, cycle_id, ts, agent, model_used, input_hash,
        tool_calls, output, cap_check_result, hitl_status, final_action
      ) VALUES (
        @id, @cycle_id, @ts, @agent, @model_used, @input_hash,
        @tool_calls, @output, @cap_check_result, @hitl_status, @final_action
      )
    `).run(row);
    return id;
  },

  listByCycle(cycleId: string): DbJournalEntry[] {
    return db
      .prepare(
        "SELECT * FROM decision_journal WHERE cycle_id = ? ORDER BY ts ASC",
      )
      .all(cycleId) as DbJournalEntry[];
  },

  get(id: string): DbJournalEntry | undefined {
    return db
      .prepare("SELECT * FROM decision_journal WHERE id = ?")
      .get(id) as DbJournalEntry | undefined;
  },

  count(): number {
    const row = db
      .prepare("SELECT COUNT(*) as c FROM decision_journal")
      .get() as { c: number };
    return row?.c ?? 0;
  },
};

// ─────────────────────────────────────────────────────────────────────
// First-trade HITL gate — persisted in agent_settings so a restart after
// the first trade does not re-arm the human approval requirement.
// ─────────────────────────────────────────────────────────────────────
const getSetting = db.prepare("SELECT value FROM agent_settings WHERE key = ?");
const setSetting = db.prepare(`
  INSERT INTO agent_settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const deleteSetting = db.prepare("DELETE FROM agent_settings WHERE key = ?");

const FIRST_TRADE_KEY = "first_trade_executed";

export function isFirstTradeExecuted(): boolean {
  const row = getSetting.get(FIRST_TRADE_KEY) as { value: string } | undefined;
  return row?.value === "1";
}

export function markFirstTradeExecuted(): void {
  setSetting.run(FIRST_TRADE_KEY, "1");
}

/** Test/ops escape hatch — clears the flag so the gate re-arms. */
export function resetFirstTradeGate(): void {
  deleteSetting.run(FIRST_TRADE_KEY);
}


// ─────────────────────────────────────────────────────────────────────
// x1000 sniper (spec: sniper-x1000) — dedicated position table.
//
// Deliberately SEPARATE from `positions`: the sniper manages its own
// lifecycle (curve buys via DeDust v4 router, sells via the memepad) and
// must NOT be picked up by the existing exit-engine/position-manager
// loops, which target stonfi/dedust pool positions with a different
// lifecycle. Sniper decisions still flow into decision_journal (shared,
// append-only) for post-mortems.
// ─────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sniper_positions (
    id TEXT PRIMARY KEY,
    asset TEXT NOT NULL,
    master TEXT NOT NULL,
    symbol TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    entry_tx_hash TEXT,
    entry_at INTEGER NOT NULL,
    spent_ton_nano TEXT NOT NULL,
    amount_tokens_nano TEXT NOT NULL,
    entry_price_ton REAL NOT NULL,
    peak_price_ton REAL NOT NULL,
    current_price_ton REAL,
    pnl_pct REAL,
    close_tx_hash TEXT,
    close_reason TEXT,
    close_at INTEGER,
    migrated INTEGER NOT NULL DEFAULT 0,
    curve_pct_at_entry REAL,
    notes TEXT,
    /* Hard time-stop (2026-08-11): max_hold_ms 0/NULL = disabled;
       exit_by_ms = entry_at + max_hold_ms, recomputed at monitor time. */
    max_hold_ms INTEGER,
    exit_by_ms INTEGER,
    /* Technique discriminator (research/05-technique-exit-matrix.md):
       this table is inherently the SNIPER technique, so the column is
       always "sniper"; recorded for symmetric reporting with 'positions'. */
    technique TEXT DEFAULT 'sniper'
  );

  CREATE TABLE IF NOT EXISTS sniper_daily (
    day TEXT PRIMARY KEY,
    spent_ton_nano TEXT NOT NULL DEFAULT '0',
    realized_ton_nano TEXT NOT NULL DEFAULT '0'
  );
`);

// Phase 5.1 hard time-stop columns — additive migration for existing DBs
// (mirrors POSITION_MIGRATIONS above; duplicate-column errors swallowed).
const SNIPER_POSITION_MIGRATIONS: Array<[string, string]> = [
  ["max_hold_ms", "INTEGER"],
  ["exit_by_ms", "INTEGER"],
  ["technique", "TEXT"],
];
for (const [col, type] of SNIPER_POSITION_MIGRATIONS) {
  try {
    db.exec(`ALTER TABLE sniper_positions ADD COLUMN ${col} ${type}`);
    log.info("STORE", `migrated sniper_positions table — added ${col} column`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}

export interface DbSniperPosition {
  id: string;
  asset: string;
  master: string;
  symbol: string | null;
  status: "OPEN" | "CLOSED" | "STOPPED" | "REJECTED";
  entry_tx_hash: string | null;
  entry_at: number;
  spent_ton_nano: string;
  amount_tokens_nano: string;
  entry_price_ton: number;
  peak_price_ton: number;
  current_price_ton: number | null;
  pnl_pct: number | null;
  close_tx_hash: string | null;
  close_reason: string | null;
  close_at: number | null;
  migrated: number;
  curve_pct_at_entry: number | null;
  notes: string | null;
  // Phase 5.1 hard time-stop (0/NULL = disabled)
  max_hold_ms?: number | null;
  exit_by_ms?: number | null;
  // Always "sniper" for this table (see CREATE TABLE comment).
  technique?: string | null;
}

export const sniperPositionStore = {
  upsert(p: Partial<DbSniperPosition> & { id: string }) {
    db.prepare(`
      INSERT INTO sniper_positions (
        id, asset, master, symbol, status, entry_tx_hash, entry_at,
        spent_ton_nano, amount_tokens_nano, entry_price_ton, peak_price_ton,
        current_price_ton, pnl_pct, close_tx_hash,
        close_reason, close_at, migrated, curve_pct_at_entry, notes,
        max_hold_ms, exit_by_ms, technique
      ) VALUES (
        @id, @asset, @master, @symbol, @status, @entry_tx_hash, @entry_at,
        @spent_ton_nano, @amount_tokens_nano, @entry_price_ton, @peak_price_ton,
        @current_price_ton, @pnl_pct, @close_tx_hash,
        @close_reason, @close_at, @migrated, @curve_pct_at_entry, @notes,
        @max_hold_ms, @exit_by_ms, @technique
      )
      ON CONFLICT(id) DO UPDATE SET
        symbol=COALESCE(excluded.symbol, symbol),
        status=excluded.status,
        entry_tx_hash=COALESCE(excluded.entry_tx_hash, entry_tx_hash),
        spent_ton_nano=excluded.spent_ton_nano,
        amount_tokens_nano=excluded.amount_tokens_nano,
        entry_price_ton=excluded.entry_price_ton,
        peak_price_ton=excluded.peak_price_ton,
        -- Sticky, like almost every other field in this clause. sellToken()
        -- omits both, so positionRow() defaults them to NULL; with a bare
        -- excluded.* that NULL overwrote the last repriced values, and the
        -- final price and PnL of every CLOSED sniper trade were discarded on
        -- write (9/9 CLOSED rows in production were NULL while both OPEN rows
        -- were populated). COALESCE keeps the most recent monitorTick reprice,
        -- which is the best available proxy for the exit price.
        current_price_ton=COALESCE(excluded.current_price_ton, current_price_ton),
        pnl_pct=COALESCE(excluded.pnl_pct, pnl_pct),
        close_tx_hash=COALESCE(excluded.close_tx_hash, close_tx_hash),
        close_reason=COALESCE(excluded.close_reason, close_reason),
        close_at=COALESCE(excluded.close_at, close_at),
        migrated=excluded.migrated,
        curve_pct_at_entry=COALESCE(excluded.curve_pct_at_entry, curve_pct_at_entry),
        notes=excluded.notes,
        -- Phase 5.1 time-stop (sticky: NULL on tick updates preserves stored).
        max_hold_ms=COALESCE(@max_hold_ms, max_hold_ms),
        exit_by_ms=COALESCE(@exit_by_ms, exit_by_ms),
        -- Technique is table-fixed "sniper"; sticky via COALESCE.
        technique=COALESCE(@technique, technique)
    `).run(p);
  },

  listOpen(): DbSniperPosition[] {
    return db
      .prepare("SELECT * FROM sniper_positions WHERE status = 'OPEN' ORDER BY entry_at ASC")
      .all() as DbSniperPosition[];
  },

  /**
   * Masters the engine must never re-buy: any position closed by an operator
   * handoff ("that coin is mine, leave it alone"). The scan path keys on
   * master, so this maps to masters — a coin the operator traded manually
   * stays out of the scan feed even after the handoff row is CLOSED.
   */
  handoffMasters(): Set<string> {
    const rows = db
      .prepare("SELECT master FROM sniper_positions WHERE close_reason = 'manual_handoff'")
      .all() as Array<{ master: string }>;
    return new Set(rows.map((r) => r.master));
  },

  get(id: string): DbSniperPosition | undefined {
    return db.prepare("SELECT * FROM sniper_positions WHERE id = ?").get(id) as DbSniperPosition | undefined;
  },

  /** Total realized PnL (nanoTON) for the day — circuit breaker input. */
  realizedToday(day: string): bigint {
    const row = db
      .prepare("SELECT realized_ton_nano FROM sniper_daily WHERE day = ?")
      .get(day) as { realized_ton_nano: string } | undefined;
    return BigInt(row?.realized_ton_nano ?? "0");
  },

  spentToday(day: string): bigint {
    const row = db
      .prepare("SELECT spent_ton_nano FROM sniper_daily WHERE day = ?")
      .get(day) as { spent_ton_nano: string } | undefined;
    return BigInt(row?.spent_ton_nano ?? "0");
  },

  addSpent(day: string, nano: bigint) {
    db.prepare(`
      INSERT INTO sniper_daily (day, spent_ton_nano) VALUES (?, ?)
      ON CONFLICT(day) DO UPDATE SET spent_ton_nano = CAST(spent_ton_nano AS INTEGER) + ?
    `).run(day, nano.toString(), nano.toString());
  },

  addRealized(day: string, nano: bigint) {
    db.prepare(`
      INSERT INTO sniper_daily (day, realized_ton_nano) VALUES (?, ?)
      ON CONFLICT(day) DO UPDATE SET realized_ton_nano = CAST(realized_ton_nano AS INTEGER) + ?
    `).run(day, nano.toString(), nano.toString());
  },
};