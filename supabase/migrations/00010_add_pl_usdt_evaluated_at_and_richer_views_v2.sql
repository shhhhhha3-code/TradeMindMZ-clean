
-- ── 1. Extend signal_history ──────────────────────────────────────────────────
ALTER TABLE public.signal_history
  ADD COLUMN IF NOT EXISTS pl_usdt       numeric,
  ADD COLUMN IF NOT EXISTS evaluated_at  timestamptz;

-- ── 2. Drop dependent views before recreation ─────────────────────────────────
DROP VIEW IF EXISTS public.signal_performance_summary CASCADE;
DROP VIEW IF EXISTS public.signal_pattern_performance CASCADE;
DROP VIEW IF EXISTS public.signal_performance_by_ai_source CASCADE;
DROP VIEW IF EXISTS public.signal_performance_by_confidence CASCADE;

-- ── 3. signal_performance_summary — richer stats ─────────────────────────────
CREATE VIEW public.signal_performance_summary AS
SELECT
  count(*)                                                                     AS total_signals,
  count(*) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED'))                   AS evaluated_signals,
  count(*) FILTER (WHERE result = 'WIN')                                       AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                                      AS losses,
  count(*) FILTER (WHERE result = 'EXPIRED')                                   AS expired,
  round(
    CASE WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
      THEN count(*) FILTER (WHERE result = 'WIN')::numeric
           / count(*) FILTER (WHERE result IN ('WIN','LOSS')) * 100
      ELSE 0 END, 1)                                                           AS win_rate_pct,
  round(avg(pl_pct)   FILTER (WHERE result IN ('WIN','LOSS')), 2)              AS avg_return_pct,
  round(avg(pl_pct)   FILTER (WHERE result = 'WIN'),  2)                       AS avg_win_pct,
  round(avg(pl_pct)   FILTER (WHERE result = 'LOSS'), 2)                       AS avg_loss_pct,
  round(sum(pl_usdt)  FILTER (WHERE result IN ('WIN','LOSS')), 4)              AS total_pl_usdt,
  max(pl_pct)                                                                  AS best_trade_pct,
  min(pl_pct) FILTER (WHERE result = 'LOSS')                                   AS worst_trade_pct
FROM public.signal_history
WHERE result IS NOT NULL;

-- ── 4. signal_pattern_performance — by signal_type ───────────────────────────
CREATE VIEW public.signal_pattern_performance AS
SELECT
  signal_type,
  count(*)                                                                      AS total,
  count(*) FILTER (WHERE result = 'WIN')                                       AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                                      AS losses,
  round(
    CASE WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
      THEN count(*) FILTER (WHERE result = 'WIN')::numeric
           / count(*) FILTER (WHERE result IN ('WIN','LOSS')) * 100
      ELSE 0 END, 1)                                                           AS win_rate_pct,
  round(avg(pl_pct)    FILTER (WHERE result IN ('WIN','LOSS')), 2)             AS avg_return_pct,
  round(sum(pl_usdt)   FILTER (WHERE result IN ('WIN','LOSS')), 4)             AS total_pl_usdt,
  round(avg(confidence) FILTER (WHERE result = 'WIN'),  1)                     AS avg_winning_confidence,
  round(avg(confidence) FILTER (WHERE result = 'LOSS'), 1)                     AS avg_losing_confidence,
  round(avg((reasoning->>'rsi')::numeric) FILTER (WHERE result = 'WIN'),  1)   AS avg_rsi_win,
  round(avg((reasoning->>'rsi')::numeric) FILTER (WHERE result = 'LOSS'), 1)   AS avg_rsi_loss
FROM public.signal_history
WHERE result IS NOT NULL
GROUP BY signal_type;

-- ── 5. signal_performance_by_ai_source ───────────────────────────────────────
CREATE VIEW public.signal_performance_by_ai_source AS
SELECT
  COALESCE(ai_source, 'unknown')                                               AS ai_source,
  count(*)                                                                     AS total,
  count(*) FILTER (WHERE result = 'WIN')                                       AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                                      AS losses,
  round(
    CASE WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
      THEN count(*) FILTER (WHERE result = 'WIN')::numeric
           / count(*) FILTER (WHERE result IN ('WIN','LOSS')) * 100
      ELSE 0 END, 1)                                                           AS win_rate_pct,
  round(avg(pl_pct)  FILTER (WHERE result IN ('WIN','LOSS')), 2)               AS avg_return_pct,
  round(sum(pl_usdt) FILTER (WHERE result IN ('WIN','LOSS')), 4)               AS total_pl_usdt
FROM public.signal_history
WHERE result IS NOT NULL
GROUP BY ai_source;

-- ── 6. signal_performance_by_confidence ──────────────────────────────────────
CREATE VIEW public.signal_performance_by_confidence AS
SELECT
  CASE
    WHEN confidence >= 80 THEN '80-100'
    WHEN confidence >= 70 THEN '70-79'
    WHEN confidence >= 60 THEN '60-69'
    ELSE 'below-60'
  END                                                                          AS confidence_range,
  CASE
    WHEN confidence >= 80 THEN 1
    WHEN confidence >= 70 THEN 2
    WHEN confidence >= 60 THEN 3
    ELSE 4
  END                                                                          AS sort_order,
  count(*)                                                                     AS total,
  count(*) FILTER (WHERE result = 'WIN')                                       AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                                      AS losses,
  round(
    CASE WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
      THEN count(*) FILTER (WHERE result = 'WIN')::numeric
           / count(*) FILTER (WHERE result IN ('WIN','LOSS')) * 100
      ELSE 0 END, 1)                                                           AS win_rate_pct,
  round(avg(pl_pct) FILTER (WHERE result IN ('WIN','LOSS')), 2)                AS avg_return_pct
FROM public.signal_history
WHERE result IS NOT NULL
GROUP BY confidence_range, sort_order
ORDER BY sort_order;

-- ── 7. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS signal_history_evaluated_at_idx ON public.signal_history(evaluated_at);
CREATE INDEX IF NOT EXISTS signal_history_ai_source_idx    ON public.signal_history(ai_source);
CREATE INDEX IF NOT EXISTS signal_history_status_idx       ON public.signal_history(status);
