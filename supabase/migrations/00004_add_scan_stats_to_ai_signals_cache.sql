
ALTER TABLE ai_signals_cache
  ADD COLUMN IF NOT EXISTS pairs_scanned  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analyzed_count integer DEFAULT 0;
