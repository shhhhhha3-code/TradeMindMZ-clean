-- Add columns required by the ai-analysis Edge Function cache upsert
ALTER TABLE public.ai_signals_cache
  ADD COLUMN IF NOT EXISTS gemini_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS groq_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rotation_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS diagnostics jsonb DEFAULT null,
  ADD COLUMN IF NOT EXISTS error_message text DEFAULT null;
