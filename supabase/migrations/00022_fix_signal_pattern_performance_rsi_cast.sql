
-- Drop and recreate the view with safe RSI numeric extraction.
-- The rsi field in signal_history.reasoning JSONB may contain strings like
-- "27.66 (Oversold, near support)" — we strip everything after the first space
-- before casting to numeric, making the cast safe regardless of appended text.

DROP VIEW IF EXISTS signal_pattern_performance;

CREATE VIEW signal_pattern_performance AS
SELECT
  signal_type,
  count(*) AS total,
  count(*) FILTER (WHERE result = 'WIN')  AS wins,
  count(*) FILTER (WHERE result = 'LOSS') AS losses,
  round(
    CASE
      WHEN count(*) FILTER (WHERE result = ANY (ARRAY['WIN','LOSS'])) > 0
      THEN count(*) FILTER (WHERE result = 'WIN')::numeric
           / count(*) FILTER (WHERE result = ANY (ARRAY['WIN','LOSS']))::numeric
           * 100
      ELSE 0
    END, 1
  ) AS win_rate_pct,
  round(avg(pl_pct)   FILTER (WHERE result = ANY (ARRAY['WIN','LOSS','EXPIRED']) AND pl_pct   IS NOT NULL), 2) AS avg_return_pct,
  round(sum(pl_usdt)  FILTER (WHERE result = ANY (ARRAY['WIN','LOSS','EXPIRED']) AND pl_usdt  IS NOT NULL), 4) AS total_pl_usdt,
  round(avg(confidence) FILTER (WHERE result = 'WIN'),  1) AS avg_winning_confidence,
  round(avg(confidence) FILTER (WHERE result = 'LOSS'), 1) AS avg_losing_confidence,
  -- Safe RSI cast: strip any trailing annotation like " (Oversold, near support)"
  -- by keeping only the leading numeric substring before the first space.
  round(
    avg(
      nullif(
        regexp_replace(reasoning ->> 'rsi', '[^0-9.\-].*$', '', 'g'),
        ''
      )::numeric
    ) FILTER (WHERE result = 'WIN'),
  1) AS avg_rsi_win,
  round(
    avg(
      nullif(
        regexp_replace(reasoning ->> 'rsi', '[^0-9.\-].*$', '', 'g'),
        ''
      )::numeric
    ) FILTER (WHERE result = 'LOSS'),
  1) AS avg_rsi_loss
FROM signal_history
WHERE result IS NOT NULL
GROUP BY signal_type;
