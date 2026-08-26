-- TradeMindMZ AI cost control + current AI source compatibility.
--
-- The server always performs local market scanning/recommendation scoring.
-- Scheduled runs explicitly use use_ai=false, so OpenAI/Groq are not called by
-- the 7-minute cron. The client can opt into AI review with use_ai=true.

-- Current application uses OpenAI as primary, with Groq fallback.
ALTER TABLE public.ai_signals_cache
  DROP CONSTRAINT IF EXISTS ai_signals_cache_ai_source_check;

ALTER TABLE public.ai_signals_cache
  ADD CONSTRAINT ai_signals_cache_ai_source_check
  CHECK (ai_source IS NULL OR ai_source IN ('openai','gemini','groq'));

ALTER TABLE public.signal_history
  DROP CONSTRAINT IF EXISTS signal_history_ai_source_check;

ALTER TABLE public.signal_history
  ADD CONSTRAINT signal_history_ai_source_check
  CHECK (ai_source IS NULL OR ai_source IN ('openai','gemini','groq'));

-- Make the scheduled server scan local-only. User-triggered/frontend calls
-- decide whether AI review is enabled and send use_ai=true when desired.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('ai-analysis-every-7-minutes');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'ai-analysis-every-7-minutes',
    '*/7 * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ai-analysis',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
        ),
        body := jsonb_build_object('source', 'scheduler', 'use_ai', false)
      );
    $job$
  );
END $$;
