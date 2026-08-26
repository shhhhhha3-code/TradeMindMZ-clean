-- Add a reset timestamp to the global AI signals cache so Diagnostics
-- can display when the performance dataset was last restarted.
ALTER TABLE public.ai_signals_cache
  ADD COLUMN IF NOT EXISTS reset_at timestamptz;

-- Initialize reset_at to now for existing row(s) so the UI has a value.
UPDATE public.ai_signals_cache SET reset_at = now() WHERE reset_at IS NULL;
