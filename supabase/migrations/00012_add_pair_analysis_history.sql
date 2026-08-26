
-- Rotation tracker: stores per-pair analysis history for intelligent candidate selection
CREATE TABLE IF NOT EXISTS pair_analysis_history (
  pair                   TEXT PRIMARY KEY,
  symbol                 TEXT NOT NULL DEFAULT '',
  last_analyzed_at       TIMESTAMPTZ,
  last_signal_at         TIMESTAMPTZ,
  last_signal_type       TEXT,
  last_signal_score      INTEGER,
  last_ai_confidence     INTEGER,
  last_result            TEXT,
  times_analyzed         INTEGER NOT NULL DEFAULT 0,
  times_with_signal      INTEGER NOT NULL DEFAULT 0,
  recent_win_count       INTEGER NOT NULL DEFAULT 0,
  recent_loss_count      INTEGER NOT NULL DEFAULT 0,
  -- Market state hash: used to detect meaningful changes since last analysis
  last_rsi               NUMERIC(6,2),
  last_price             NUMERIC,
  last_ema9              NUMERIC,
  last_ema21             NUMERIC,
  last_volume_usdt       NUMERIC,
  last_momentum          TEXT,
  -- Cached AI result (skip re-analysis if market state unchanged)
  cached_signal_json     JSONB,
  cache_state_hash       TEXT,
  cache_expires_at       TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS but allow service role full access
ALTER TABLE pair_analysis_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON pair_analysis_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Index for fast staleness + exploration queries
CREATE INDEX IF NOT EXISTS idx_pah_last_analyzed ON pair_analysis_history (last_analyzed_at ASC NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_pah_updated ON pair_analysis_history (updated_at DESC);
