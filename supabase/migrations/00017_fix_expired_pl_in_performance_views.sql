-- Fix: include EXPIRED P/L in avg/total P/L for all performance views.
-- Win Rate stays WIN/(WIN+LOSS). EXPIRED never counted as WIN or LOSS.

-- Must DROP and recreate summary view to reorder/add columns
DROP VIEW IF EXISTS signal_performance_summary;

CREATE VIEW signal_performance_summary AS
SELECT
  count(*)                                                             AS total_signals,
  count(*) FILTER (WHERE status = 'LIVE')                             AS live_signals,
  count(*) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED'))          AS evaluated_signals,
  count(*) FILTER (WHERE result = 'WIN')                              AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                             AS losses,
  count(*) FILTER (WHERE result = 'EXPIRED')                         AS expired,
  -- Win rate: WIN / (WIN+LOSS) only
  round(
    CASE
      WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
        THEN (count(*) FILTER (WHERE result = 'WIN'))::numeric
             / (count(*) FILTER (WHERE result IN ('WIN','LOSS')))::numeric * 100
      ELSE 0
    END, 1
  )                                                                    AS win_rate_pct,
  -- Avg P/L: include EXPIRED with valid pl_pct
  round(avg(pl_pct) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED') AND pl_pct IS NOT NULL), 2)
                                                                       AS avg_return_pct,
  round(avg(pl_pct) FILTER (WHERE result = 'WIN'), 2)                AS avg_win_pct,
  round(avg(pl_pct) FILTER (WHERE result = 'LOSS'), 2)               AS avg_loss_pct,
  -- Total P/L: include EXPIRED with valid pl_usdt
  round(sum(pl_usdt) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED') AND pl_usdt IS NOT NULL), 4)
                                                                       AS total_pl_usdt,
  max(pl_pct)                                                         AS best_trade_pct,
  min(pl_pct) FILTER (WHERE result = 'LOSS')                         AS worst_trade_pct,
  -- New: expired-only avg P/L for UI display
  round(avg(pl_pct) FILTER (WHERE result = 'EXPIRED' AND pl_pct IS NOT NULL), 2)
                                                                       AS expired_avg_pl_pct,
  (SELECT pair FROM signal_history WHERE pl_pct IS NOT NULL ORDER BY pl_pct DESC LIMIT 1)
                                                                       AS best_signal_pair,
  (SELECT pair FROM signal_history WHERE result = 'LOSS' AND pl_pct IS NOT NULL ORDER BY pl_pct LIMIT 1)
                                                                       AS worst_signal_pair
FROM signal_history;

-- signal_pattern_performance
CREATE OR REPLACE VIEW signal_pattern_performance AS
SELECT
  signal_type,
  count(*)                                                            AS total,
  count(*) FILTER (WHERE result = 'WIN')                             AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                            AS losses,
  round(
    CASE
      WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
        THEN (count(*) FILTER (WHERE result = 'WIN'))::numeric
             / (count(*) FILTER (WHERE result IN ('WIN','LOSS')))::numeric * 100
      ELSE 0
    END, 1
  )                                                                   AS win_rate_pct,
  round(avg(pl_pct) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED') AND pl_pct IS NOT NULL), 2)
                                                                      AS avg_return_pct,
  round(sum(pl_usdt) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED') AND pl_usdt IS NOT NULL), 4)
                                                                      AS total_pl_usdt,
  round(avg(confidence) FILTER (WHERE result = 'WIN'), 1)            AS avg_winning_confidence,
  round(avg(confidence) FILTER (WHERE result = 'LOSS'), 1)           AS avg_losing_confidence,
  round(avg((reasoning->>'rsi')::numeric) FILTER (WHERE result = 'WIN'), 1)  AS avg_rsi_win,
  round(avg((reasoning->>'rsi')::numeric) FILTER (WHERE result = 'LOSS'), 1) AS avg_rsi_loss
FROM signal_history
WHERE result IS NOT NULL
GROUP BY signal_type;

-- signal_performance_by_ai_source
CREATE OR REPLACE VIEW signal_performance_by_ai_source AS
SELECT
  COALESCE(ai_source, 'unknown')                                     AS ai_source,
  count(*)                                                            AS total,
  count(*) FILTER (WHERE result = 'WIN')                             AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                            AS losses,
  round(
    CASE
      WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
        THEN (count(*) FILTER (WHERE result = 'WIN'))::numeric
             / (count(*) FILTER (WHERE result IN ('WIN','LOSS')))::numeric * 100
      ELSE 0
    END, 1
  )                                                                   AS win_rate_pct,
  round(avg(pl_pct) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED') AND pl_pct IS NOT NULL), 2)
                                                                      AS avg_return_pct,
  round(sum(pl_usdt) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED') AND pl_usdt IS NOT NULL), 4)
                                                                      AS total_pl_usdt
FROM signal_history
WHERE result IS NOT NULL
GROUP BY ai_source;

-- signal_performance_by_confidence
CREATE OR REPLACE VIEW signal_performance_by_confidence AS
SELECT
  CASE
    WHEN confidence >= 80 THEN '80-100'
    WHEN confidence >= 70 THEN '70-79'
    WHEN confidence >= 60 THEN '60-69'
    ELSE 'below-60'
  END                                                                 AS confidence_range,
  CASE
    WHEN confidence >= 80 THEN 1
    WHEN confidence >= 70 THEN 2
    WHEN confidence >= 60 THEN 3
    ELSE 4
  END                                                                 AS sort_order,
  count(*)                                                            AS total,
  count(*) FILTER (WHERE result = 'WIN')                             AS wins,
  count(*) FILTER (WHERE result = 'LOSS')                            AS losses,
  round(
    CASE
      WHEN count(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
        THEN (count(*) FILTER (WHERE result = 'WIN'))::numeric
             / (count(*) FILTER (WHERE result IN ('WIN','LOSS')))::numeric * 100
      ELSE 0
    END, 1
  )                                                                   AS win_rate_pct,
  round(avg(pl_pct) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED') AND pl_pct IS NOT NULL), 2)
                                                                      AS avg_return_pct
FROM signal_history
WHERE result IS NOT NULL
GROUP BY
  CASE WHEN confidence >= 80 THEN '80-100' WHEN confidence >= 70 THEN '70-79' WHEN confidence >= 60 THEN '60-69' ELSE 'below-60' END,
  CASE WHEN confidence >= 80 THEN 1 WHEN confidence >= 70 THEN 2 WHEN confidence >= 60 THEN 3 ELSE 4 END
ORDER BY
  CASE WHEN confidence >= 80 THEN 1 WHEN confidence >= 70 THEN 2 WHEN confidence >= 60 THEN 3 ELSE 4 END;