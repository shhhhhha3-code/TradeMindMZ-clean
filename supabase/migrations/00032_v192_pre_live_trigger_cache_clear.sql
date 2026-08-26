
-- V192 final cache clear before live trigger invocation
UPDATE pair_analysis_history
SET cache_state_hash = NULL, cache_expires_at = NULL, updated_at = NOW();
UPDATE ai_signals_cache
SET signals = '[]'::jsonb, error_message = NULL, updated_at = NOW()
WHERE id = 'global';
