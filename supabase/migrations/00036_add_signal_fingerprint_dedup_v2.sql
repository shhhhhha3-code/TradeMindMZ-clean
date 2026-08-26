
-- ── Migration v2: setup_fingerprint deduplication ─────────────────────────
-- Step 1: Add fingerprint column
ALTER TABLE public.signal_history
  ADD COLUMN IF NOT EXISTS setup_fingerprint text;

-- Step 2: Allow DUPLICATE as a status value
ALTER TABLE public.signal_history
  DROP CONSTRAINT IF EXISTS signal_history_status_check;
ALTER TABLE public.signal_history
  ADD CONSTRAINT signal_history_status_check
    CHECK (status = ANY (ARRAY['LIVE','WIN','LOSS','EXPIRED','DUPLICATE']));

-- Step 3: Populate fingerprint for ALL existing rows
UPDATE public.signal_history
SET setup_fingerprint = md5(
  pair || '|' ||
  signal_type || '|' ||
  ROUND(entry_price / GREATEST(entry_price * 0.001, 0.00001))::text || '|' ||
  COALESCE(ROUND(take_profit_1 / GREATEST(entry_price * 0.001, 0.00001))::text, 'null') || '|' ||
  COALESCE(ROUND(stop_loss     / GREATEST(entry_price * 0.001, 0.00001))::text, 'null')
)
WHERE setup_fingerprint IS NULL;

-- Step 4: Clean up duplicates BEFORE creating the unique index.
-- For each fingerprint group keep the OLDEST LIVE row (canonical).
-- All other LIVE rows for the same fingerprint → DUPLICATE.
WITH canonical AS (
  SELECT DISTINCT ON (setup_fingerprint)
    id
  FROM public.signal_history
  WHERE status = 'LIVE' AND setup_fingerprint IS NOT NULL
  ORDER BY setup_fingerprint, generated_at ASC
),
to_deactivate AS (
  SELECT sh.id
  FROM public.signal_history sh
  WHERE sh.status = 'LIVE'
    AND sh.setup_fingerprint IS NOT NULL
    AND sh.id NOT IN (SELECT id FROM canonical)
)
UPDATE public.signal_history
SET status       = 'DUPLICATE',
    evaluated_at = NOW(),
    exit_timestamp = NOW()
WHERE id IN (SELECT id FROM to_deactivate);

-- Step 5: NOW create the partial unique index (no conflicts remain)
CREATE UNIQUE INDEX IF NOT EXISTS uix_signal_history_live_fingerprint
  ON public.signal_history (setup_fingerprint)
  WHERE status = 'LIVE' AND setup_fingerprint IS NOT NULL;

-- Step 6: Regular index for fingerprint lookups
CREATE INDEX IF NOT EXISTS idx_signal_history_fingerprint
  ON public.signal_history (setup_fingerprint);

-- Step 7: Report
DO $$
DECLARE dup_count int; live_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count  FROM public.signal_history WHERE status = 'DUPLICATE';
  SELECT COUNT(*) INTO live_count FROM public.signal_history WHERE status = 'LIVE';
  RAISE NOTICE 'Cleanup: % duplicates marked, % LIVE signals remain', dup_count, live_count;
END $$;
