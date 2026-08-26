
-- V192: Add missing local_setups column to ai_signals_cache.
-- This was causing all ai-analysis upserts to fail silently (column not found),
-- so the EF returned signals in-memory but the DB row stayed at signals=[].
ALTER TABLE ai_signals_cache
  ADD COLUMN IF NOT EXISTS local_setups jsonb DEFAULT '[]'::jsonb;

-- Also clear cache hashes so next force run bypasses both cache gates.
UPDATE pair_analysis_history
SET cache_state_hash = NULL,
    cache_expires_at = NULL,
    updated_at       = NOW();

-- Reset signals to empty, clear any stale error_message.
UPDATE ai_signals_cache
SET signals       = '[]'::jsonb,
    error_message = NULL,
    updated_at    = NOW()
WHERE id = 'global';
