-- Allow the exact error category names used by the Edge Function
ALTER TABLE public.ai_signals_cache DROP CONSTRAINT IF EXISTS ai_signals_cache_gemini_status_check;
ALTER TABLE public.ai_signals_cache ADD CONSTRAINT ai_signals_cache_gemini_status_check
  CHECK (gemini_status = ANY (ARRAY['connected'::text, 'rate_limited'::text, 'RATE_LIMIT'::text, 'error'::text]));