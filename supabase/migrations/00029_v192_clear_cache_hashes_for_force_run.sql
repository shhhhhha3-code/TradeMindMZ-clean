
-- V192 Force run prep: clear all cache hashes so every pair goes to AI queue.
-- Also empty signals so FRESHNESS guard finds zero live signals.
UPDATE pair_analysis_history
SET cache_state_hash = NULL,
    cache_expires_at = NULL,
    updated_at       = NOW();

UPDATE ai_signals_cache
SET signals    = '[]'::jsonb,
    error_message = NULL,
    updated_at = NOW()
WHERE id = 'global';
