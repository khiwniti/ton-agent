const Database = require("better-sqlite3");
const db = new Database("/app/data/agent.db", { readonly: true });
const rows = db
  .prepare(
    "SELECT id, wallet_tier, symbol, dex, status, rugged, emergency_exit, realized_pnl_ton, entry_at, exit_by_ms, current_price_ton, technique FROM positions"
  )
  .all();
console.log("TOTAL:", rows.length);
for (const r of rows) {
  console.log(
    JSON.stringify({
      id: r.id,
      tier: r.wallet_tier,
      sym: r.symbol,
      dex: r.dex,
      status: r.status,
      rugged: r.rugged,
      emexit: r.emergency_exit,
      pnl: r.realized_pnl_ton,
      entry: r.entry_at,
      exitBy: r.exit_by_ms,
      price: r.current_price_ton,
      tech: r.technique,
    })
  );
}
db.close();
