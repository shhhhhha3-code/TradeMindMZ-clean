-- ── Extend signal_history for immediate-write lifecycle ──────────────────────
-- 1. Add ai_source so each history row knows which AI generated it
ALTER TABLE public.signal_history
  ADD COLUMN IF NOT EXISTS ai_source      text CHECK (ai_source IN ('gemini','groq')),
  ADD COLUMN IF NOT EXISTS entry_zone_low  numeric,
  ADD COLUMN IF NOT EXISTS entry_zone_high numeric,
  -- status: LIVE while within 20-min window, updated to WIN/LOSS/EXPIRED by signal-expiry EF
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'LIVE'
    CHECK (status IN ('LIVE','WIN','LOSS','EXPIRED'));

-- 2. Unique constraint so upsert on (pair, generated_at) is safe
--    (deduplicates if ai-analysis runs twice for the same batch)
ALTER TABLE public.signal_history
  DROP CONSTRAINT IF EXISTS signal_history_pair_generated_at_key;

ALTER TABLE public.signal_history
  ADD CONSTRAINT signal_history_pair_generated_at_key
  UNIQUE (pair, generated_at);

-- 3. Back-fill status for existing rows that already have a result
UPDATE public.signal_history
  SET status = result
  WHERE result IS NOT NULL AND status = 'LIVE';
