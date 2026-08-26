
-- ── signal_history table ─────────────────────────────────────────────────────
create table if not exists public.signal_history (
  id              uuid primary key default gen_random_uuid(),
  pair            text        not null,
  symbol          text        not null,
  coin_name       text        not null,
  signal_type     text        not null check (signal_type in ('BUY','SELL','HOLD','WAIT')),
  confidence      int         not null,
  entry_price     numeric     not null,
  take_profit_1   numeric,
  take_profit_2   numeric,
  stop_loss       numeric,
  risk_reward     text,
  holding_time    text,
  generated_at    timestamptz not null,
  expires_at      timestamptz not null,
  exit_price      numeric,
  result          text        check (result in ('WIN','LOSS','EXPIRED')),
  pl_pct          numeric,
  reasoning       jsonb,
  signal_strength int,
  created_at      timestamptz default now()
);

-- Allow anon to read/write (same pattern as other tables in this project)
alter table public.signal_history enable row level security;
create policy "anon can read signal_history"  on public.signal_history for select using (true);
create policy "anon can insert signal_history" on public.signal_history for insert with check (true);
create policy "anon can update signal_history" on public.signal_history for update using (true);

-- index for fast pattern queries
create index if not exists signal_history_pair_idx         on public.signal_history(pair);
create index if not exists signal_history_generated_at_idx on public.signal_history(generated_at desc);
create index if not exists signal_history_result_idx       on public.signal_history(result);
create index if not exists signal_history_signal_type_idx  on public.signal_history(signal_type);

-- ── performance_summary view ─────────────────────────────────────────────────
create or replace view public.signal_performance_summary as
select
  count(*)                                                       as total_signals,
  count(*) filter (where result = 'WIN')                         as wins,
  count(*) filter (where result = 'LOSS')                        as losses,
  count(*) filter (where result = 'EXPIRED')                     as expired,
  round(
    case when count(*) filter (where result in ('WIN','LOSS')) > 0
      then count(*) filter (where result = 'WIN')::numeric
           / count(*) filter (where result in ('WIN','LOSS')) * 100
      else 0 end, 1)                                             as win_rate_pct,
  round(avg(pl_pct) filter (where result in ('WIN','LOSS')), 2)  as avg_return_pct,
  round(avg(pl_pct) filter (where result = 'WIN'), 2)            as avg_win_pct,
  round(avg(pl_pct) filter (where result = 'LOSS'), 2)           as avg_loss_pct,
  max(pl_pct)                                                    as best_trade_pct,
  min(pl_pct) filter (where result = 'LOSS')                    as worst_trade_pct
from public.signal_history;

-- ── pattern_performance view — for AI feedback ────────────────────────────────
create or replace view public.signal_pattern_performance as
select
  signal_type,
  count(*)                                                                   as total,
  count(*) filter (where result = 'WIN')                                    as wins,
  round(
    case when count(*) filter (where result in ('WIN','LOSS')) > 0
      then count(*) filter (where result = 'WIN')::numeric
           / count(*) filter (where result in ('WIN','LOSS')) * 100
      else 0 end, 1)                                                        as win_rate_pct,
  round(avg(pl_pct) filter (where result in ('WIN','LOSS')), 2)             as avg_return_pct,
  round(avg(confidence) filter (where result = 'WIN'), 1)                   as avg_winning_confidence,
  round(avg(confidence) filter (where result = 'LOSS'), 1)                  as avg_losing_confidence,
  -- RSI bucket analysis (from reasoning jsonb)
  round(avg((reasoning->>'rsi')::numeric) filter (where result = 'WIN'), 1) as avg_rsi_win,
  round(avg((reasoning->>'rsi')::numeric) filter (where result = 'LOSS'), 1) as avg_rsi_loss
from public.signal_history
group by signal_type;
