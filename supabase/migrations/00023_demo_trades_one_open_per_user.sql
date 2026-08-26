
-- Sikkerhet: maks én OPEN demo_trade per bruker.
-- Partial UNIQUE INDEX sikrer at database-INSERT nummer 2 feiler hvis en åpen
-- trade allerede finnes for samme user_id.
--
-- Pre-check: stopp hvis noen bruker allerede har >1 open trade.
DO $$
DECLARE
  conflict RECORD;
BEGIN
  SELECT user_id, COUNT(*) AS open_count
  INTO conflict
  FROM demo_trades
  WHERE status = 'open'
  GROUP BY user_id
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF conflict IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-migration check failed: user_id=% has % open demo_trades. Resolve manually before applying this index.', conflict.user_id, conflict.open_count;
  END IF;
END
$$;

-- DISABLED: Multiple simultaneous open demo trades are allowed.
-- The previous one-open-trade restriction is intentionally removed.
