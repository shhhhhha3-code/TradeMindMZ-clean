
-- V158: Add server-computed recommendation fields to signal_history
ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS server_verdict        text,
  ADD COLUMN IF NOT EXISTS recommendation_score  integer,
  ADD COLUMN IF NOT EXISTS recommendation_breakdown jsonb;

-- Index for querying by verdict
CREATE INDEX IF NOT EXISTS idx_signal_history_server_verdict
  ON signal_history (server_verdict)
  WHERE server_verdict IS NOT NULL;
