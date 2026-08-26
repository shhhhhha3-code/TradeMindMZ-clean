
-- Schedule signal-expiry Edge Function to run every 5 minutes server-side
-- This ensures signals are always evaluated even when no browser is open.
-- Uses Supabase's built-in pg_net extension to call the Edge Function.

-- Enable pg_net if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Create a function that invokes the signal-expiry Edge Function via HTTP
CREATE OR REPLACE FUNCTION public.trigger_signal_expiry()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  supabase_url text;
  service_key  text;
BEGIN
  supabase_url := current_setting('app.supabase_url', true);
  service_key  := current_setting('app.service_role_key', true);

  -- Only proceed if we have the URL configured
  IF supabase_url IS NULL OR supabase_url = '' THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := supabase_url || '/functions/v1/signal-expiry',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(service_key, '')
    ),
    body    := '{}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  -- Never crash — this is a background task
  NULL;
END;
$$;

-- Drop the old summary view and replace with one that includes ALL signals
-- (not just result IS NOT NULL) so the frontend can show pending count too.
DROP VIEW IF EXISTS public.signal_performance_summary;

CREATE VIEW public.signal_performance_summary AS
SELECT
  COUNT(*)                                                              AS total_signals,
  COUNT(*) FILTER (WHERE status = 'LIVE')                              AS live_signals,
  COUNT(*) FILTER (WHERE result IN ('WIN','LOSS','EXPIRED'))           AS evaluated_signals,
  COUNT(*) FILTER (WHERE result = 'WIN')                               AS wins,
  COUNT(*) FILTER (WHERE result = 'LOSS')                              AS losses,
  COUNT(*) FILTER (WHERE result = 'EXPIRED')                           AS expired,
  ROUND(
    CASE
      WHEN COUNT(*) FILTER (WHERE result IN ('WIN','LOSS')) > 0
        THEN (COUNT(*) FILTER (WHERE result = 'WIN')::numeric /
              COUNT(*) FILTER (WHERE result IN ('WIN','LOSS'))::numeric * 100)
      ELSE 0
    END, 1
  )                                                                     AS win_rate_pct,
  ROUND(AVG(pl_pct) FILTER (WHERE result IN ('WIN','LOSS')), 2)        AS avg_return_pct,
  ROUND(AVG(pl_pct) FILTER (WHERE result = 'WIN'),  2)                 AS avg_win_pct,
  ROUND(AVG(pl_pct) FILTER (WHERE result = 'LOSS'), 2)                 AS avg_loss_pct,
  ROUND(SUM(pl_usdt) FILTER (WHERE result IN ('WIN','LOSS')), 4)       AS total_pl_usdt,
  MAX(pl_pct)                                                           AS best_trade_pct,
  MIN(pl_pct) FILTER (WHERE result = 'LOSS')                           AS worst_trade_pct,
  -- Best and worst signal identifiers
  (SELECT pair FROM public.signal_history
   WHERE pl_pct IS NOT NULL ORDER BY pl_pct DESC LIMIT 1)              AS best_signal_pair,
  (SELECT pair FROM public.signal_history
   WHERE result = 'LOSS' AND pl_pct IS NOT NULL ORDER BY pl_pct ASC LIMIT 1) AS worst_signal_pair
FROM public.signal_history;
