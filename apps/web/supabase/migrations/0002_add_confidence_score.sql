-- ─────────────────────────────────────────────────────────────────────
-- 0002_add_confidence_score.sql
--
-- Adds the `confidence_score` column to the production `positions` table
-- which was created by the initial migration (0001_init.sql) before the
-- column existed. Safe to run on fresh deployments too — the IF NOT EXISTS
-- guard prevents errors on already-migrated databases.
-- ─────────────────────────────────────────────────────────────────────

-- Add confidence_score column to the positions table for existing databases.
-- The column tracks the 0-100 score computed by the agent's scoring engine
-- from audit results, holder count, token age, pool liquidity, and tier alignment.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'positions'
      and column_name = 'confidence_score'
  ) then
    alter table public.positions
      add column confidence_score integer not null default 0;
  end if;
end $$;
