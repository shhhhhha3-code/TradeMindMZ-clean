ALTER TABLE ai_signals_cache
  ADD COLUMN IF NOT EXISTS ai_source     text CHECK (ai_source IN ('gemini','groq')),
  ADD COLUMN IF NOT EXISTS model_used    text,
  ADD COLUMN IF NOT EXISTS gemini_status text CHECK (gemini_status IN ('connected','rate_limited','error'));