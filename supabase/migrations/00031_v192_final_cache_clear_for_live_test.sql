
-- Final V192 cache clear before live test invocation
UPDATE pair_analysis_history
SET cache_state_hash = NULL, cache_expires_at = NULL, updated_at = NOW();
UPDATE ai_signals_cache
SET signals = '[]'::jsonb, error_message = NULL, updated_at = NOW()
WHERE id = 'global';
