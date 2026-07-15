-- ─────────────────────────────────────────────────────────────────────
-- 0001_init.sql — TON trading agent web app schema
--
-- Tables mirror the shared contract in packages/shared/src/index.ts, with
-- a wallet risk-tier dimension (low | mid | high).
--
-- Access model:
--   * authenticated users get READ access via RLS policies.
--   * the agent writes with the service-role key, which bypasses RLS.
--   * no anon access.
-- Realtime is enabled on positions, radar_events, agent_messages.
-- ─────────────────────────────────────────────────────────────────────

-- Enum types -----------------------------------------------------------
do $$ begin
  create type wallet_tier as enum ('low', 'mid', 'high');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tier_status as enum ('active', 'disabled', 'circuit-broken');
exception when duplicate_object then null; end $$;

do $$ begin
  create type trade_action as enum ('BUY', 'SELL', 'SKIP', 'HOLD');
exception when duplicate_object then null; end $$;

do $$ begin
  create type position_status as enum ('OPEN', 'TP1_HIT', 'CLOSED', 'STOPPED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type agent_run_status as enum ('running', 'paused', 'stopped', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_role as enum ('user', 'assistant', 'tool', 'system');
exception when duplicate_object then null; end $$;

-- wallets --------------------------------------------------------------
create table if not exists public.wallets (
  tier            wallet_tier primary key,
  address         text        not null default '',
  balance_ton     double precision not null default 0,
  status          tier_status not null default 'active',
  open_positions  integer     not null default 0,
  total_pnl_ton   double precision not null default 0,
  updated_at      timestamptz not null default now()
);

-- positions (mirror Position + wallet_tier) ----------------------------
create table if not exists public.positions (
  id                 text primary key,
  wallet_tier        wallet_tier not null,
  jetton_master      text not null,
  symbol             text,
  entry_tx_hash      text not null default '',
  entry_price_ton    double precision not null default 0,
  entry_at           bigint not null,
  amount_tokens      text not null default '0',
  cost_basis_ton     double precision not null default 0,
  current_price_ton  double precision,
  pnl_pct            double precision,
  status             position_status not null default 'OPEN',
  take_profit_t1_tx  text,
  close_tx           text,
  close_at           bigint,
  created_at         timestamptz not null default now()
);
create index if not exists positions_tier_idx on public.positions (wallet_tier);
create index if not exists positions_status_idx on public.positions (status);
create index if not exists positions_created_idx on public.positions (created_at desc);

-- radar_events (mirror RadarEvent + wallet_tier) -----------------------
create table if not exists public.radar_events (
  id                     text primary key,
  wallet_tier            wallet_tier,
  detected_at            bigint not null,
  jetton_master          text not null,
  symbol                 text,
  pool_address           text,
  dex                    text,
  initial_liquidity_ton  double precision,
  token_age_hours        double precision,
  renounced              boolean not null default false,
  lp_locked              boolean not null default false,
  honeypot_safe          boolean not null default false,
  ai_score               double precision not null default 0,
  action                 trade_action not null default 'SKIP',
  confidence             double precision not null default 0,
  reasoning              text not null default '',
  created_at             timestamptz not null default now()
);
create index if not exists radar_created_idx on public.radar_events (created_at desc);
create index if not exists radar_detected_idx on public.radar_events (detected_at desc);

-- agent_messages (mirror AgentMessage) ---------------------------------
create table if not exists public.agent_messages (
  id           text primary key,
  thread_id    text not null,
  at           bigint not null,
  role         message_role not null,
  content      text not null default '',
  tool_name    text,
  tool_args    jsonb,
  tool_result  jsonb,
  meta         jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists messages_thread_idx on public.agent_messages (thread_id, at asc);
create index if not exists messages_created_idx on public.agent_messages (created_at desc);

-- agent_status (mirror AgentStatus + tier) -----------------------------
create table if not exists public.agent_status (
  tier            wallet_tier primary key,
  status          agent_run_status not null default 'stopped',
  started_at      bigint,
  bankroll_ton    double precision,
  open_positions  integer not null default 0,
  total_pnl_ton   double precision not null default 0,
  uptime_sec      double precision not null default 0,
  version         text not null default 'unknown',
  updated_at      timestamptz not null default now()
);

-- kill_switch ----------------------------------------------------------
-- Single-row table (id = 1). The agent polls `engaged`.
create table if not exists public.kill_switch (
  id          integer primary key default 1,
  engaged     boolean not null default false,
  at          bigint not null default 0,
  by          text,
  updated_at  timestamptz not null default now(),
  constraint kill_switch_singleton check (id = 1)
);

-- ─────────────────────────────────────────────────────────────────────
-- Seed rows (idempotent) so the dashboard renders before the agent runs.
-- ─────────────────────────────────────────────────────────────────────
insert into public.wallets (tier, status) values
  ('low', 'active'), ('mid', 'active'), ('high', 'active')
on conflict (tier) do nothing;

insert into public.agent_status (tier, status) values
  ('low', 'stopped'), ('mid', 'stopped'), ('high', 'stopped')
on conflict (tier) do nothing;

insert into public.kill_switch (id, engaged) values (1, false)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────
alter table public.wallets        enable row level security;
alter table public.positions      enable row level security;
alter table public.radar_events   enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_status   enable row level security;
alter table public.kill_switch    enable row level security;

-- Authenticated users may READ everything.
-- (Writes come from the service role, which bypasses RLS entirely.)
do $$
declare t text;
begin
  foreach t in array array[
    'wallets','positions','radar_events','agent_messages','agent_status','kill_switch'
  ]
  loop
    execute format(
      'drop policy if exists %I on public.%I;',
      t || '_authenticated_read', t
    );
    execute format(
      'create policy %I on public.%I for select to authenticated using (true);',
      t || '_authenticated_read', t
    );
  end loop;
end $$;

-- Allow authenticated users to WRITE the kill switch (settings STOP button
-- also posts via the service role, but this permits direct client updates
-- if ever desired).
drop policy if exists kill_switch_authenticated_write on public.kill_switch;
create policy kill_switch_authenticated_write
  on public.kill_switch
  for update to authenticated
  using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────
-- Realtime: add tables to the supabase_realtime publication.
-- ─────────────────────────────────────────────────────────────────────
do $$
begin
  alter publication supabase_realtime add table public.positions;
exception when duplicate_object then null; end $$;

do $$
begin
  alter publication supabase_realtime add table public.radar_events;
exception when duplicate_object then null; end $$;

do $$
begin
  alter publication supabase_realtime add table public.agent_messages;
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────
-- v1 — Wallet auth (TON Connect proof-of-ownership)
--   nonces are minted by /api/auth/wallet/challenge (5-minute TTL) and
--   marked consumed on successful /api/auth/wallet/verify. Single-use.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.wallet_auth_nonces (
  nonce          text primary key,
  domain         text not null,
  issued_at      timestamptz not null default now(),
  consumed_at    timestamptz
);
create index if not exists wallet_auth_nonces_issued_idx
  on public.wallet_auth_nonces (issued_at desc);

alter table public.wallet_auth_nonces enable row level security;

drop policy if exists wallet_auth_nonces_authenticated_read on public.wallet_auth_nonces;
create policy wallet_auth_nonces_authenticated_read
  on public.wallet_auth_nonces
  for select to authenticated using (true);

-- Service-role writes happen via /api/auth/wallet/* and are unrestricted.
-- No realtime publication needed — nonces are short-lived.
