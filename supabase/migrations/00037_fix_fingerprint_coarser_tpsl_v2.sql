
-- Step 1: Drop existing partial unique index so we can recompute
DROP INDEX IF EXISTS uix_signal_history_live_fingerprint;

-- Step 2: Recompute all fingerprints with 1% bucket (coarser, absorbs TPSL engine drift)
UPDATE public.signal_history
SET setup_fingerprint = md5(
  pair || '|' ||
  signal_type || '|' ||
  ROUND(entry_price / GREATEST(entry_price * 0.01, 0.00001))::text || '|' ||
  COALESCE(ROUND(take_profit_1 / GREATEST(entry_price * 0.01, 0.00001))::text, 'null') || '|' ||
  COALESCE(ROUND(stop_loss     / GREATEST(entry_price * 0.01, 0.00001))::text, 'null')
);

-- Step 3: Keep oldest LIVE row per fingerprint, mark rest DUPLICATE
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
SET status         = 'DUPLICATE',
    evaluated_at   = NOW(),
    exit_timestamp = NOW()
WHERE id IN (SELECT id FROM to_deactivate);

-- Step 4: Recreate partial unique index (clean now)
CREATE UNIQUE INDEX uix_signal_history_live_fingerprint
  ON public.signal_history (setup_fingerprint)
  WHERE status = 'LIVE' AND setup_fingerprint IS NOT NULL;

-- Step 5: Report
DO $$
DECLARE dup_count int; live_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count  FROM public.signal_history WHERE status = 'DUPLICATE';
  SELECT COUNT(*) INTO live_count FROM public.signal_history WHERE status = 'LIVE';
  RAISE NOTICE 'Coarser bucket cleanup: % total duplicates, % LIVE signals remain', dup_count, live_count;
END $$;
