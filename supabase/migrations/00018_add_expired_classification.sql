
-- Fase 5: EXPIRED sub-classification
-- Adds expired_class column to signal_history and backfills existing EXPIRED rows.
-- Rules (mirror Python analysis thresholds):
--   GOOD_DIRECTION : moved ≥50% of tp1_dist toward TP
--   BAD_DIRECTION  : moved ≥50% of sl_dist toward SL
--   NEUTRAL        : little movement
-- NEVER changes WIN / LOSS status.

ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS expired_class text CHECK (expired_class IN ('GOOD_DIRECTION','NEUTRAL','BAD_DIRECTION'));

-- Backfill all existing EXPIRED rows
UPDATE signal_history
SET expired_class = CASE
  WHEN exit_price IS NOT NULL AND entry_price > 0 AND take_profit_1 IS NOT NULL AND stop_loss IS NOT NULL AND status = 'EXPIRED'
  THEN (
    WITH vals AS (
      SELECT
        CASE WHEN signal_type = 'BUY'
          THEN (exit_price - entry_price) / entry_price * 100
          ELSE (entry_price - exit_price) / entry_price * 100
        END AS dir_pct,
        ABS(take_profit_1 - entry_price) / entry_price * 100 AS tp1_dist,
        ABS(entry_price   - stop_loss)   / entry_price * 100 AS sl_dist
    )
    SELECT
      CASE
        WHEN dir_pct >= 0.5 * tp1_dist AND dir_pct > 0       THEN 'GOOD_DIRECTION'
        WHEN dir_pct < 0   AND ABS(dir_pct) >= 0.5 * sl_dist THEN 'BAD_DIRECTION'
        ELSE 'NEUTRAL'
      END
    FROM vals
  )
  ELSE NULL
END
WHERE status = 'EXPIRED';

-- Index for fast AI Performance queries by category
CREATE INDEX IF NOT EXISTS idx_signal_history_expired_class
  ON signal_history (expired_class)
  WHERE expired_class IS NOT NULL;

-- Index for BEST_CURRENT_SETUP lookup: LIVE signals ordered by score
CREATE INDEX IF NOT EXISTS idx_signal_history_live_score
  ON signal_history (status, signal_strength DESC)
  WHERE status = 'LIVE';
