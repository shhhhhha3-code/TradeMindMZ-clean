
-- V192 FORCE ANALYSIS: Clear all remaining cache_state_hash/cache_expires_at entries.
-- This is a one-time bypass to force every pair through AI re-analysis.
-- All scoring history, win/loss counts, and times_analyzed are preserved.
UPDATE pair_analysis_history
SET
  cache_state_hash = NULL,
  cache_expires_at = NULL,
  updated_at       = NOW();

-- Also reset signals to empty so FRESHNESS guard finds zero live signals.
UPDATE ai_signals_cache
SET
  signals    = '[]'::jsonb,
  updated_at = NOW()
WHERE id = 'global';
