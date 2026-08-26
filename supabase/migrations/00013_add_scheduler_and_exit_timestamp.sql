-- Background signal-engine scheduler: run AI analysis every 7 minutes and
-- evaluate active signals every 1 minute, independent of any browser.

-- 1. Enable pg_cron (pg_net is already enabled by migration 00011)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Add exit_timestamp to signal_history
ALTER TABLE public.signal_history
  ADD COLUMN IF NOT EXISTS exit_timestamp timestamptz;

-- 3. Scheduler status table
CREATE TABLE IF NOT EXISTS public.scheduler_status (
  id              text PRIMARY KEY,
  job_name        text NOT NULL,
  interval_minutes int NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text,
  next_run_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.scheduler_status (id, job_name, interval_minutes, is_active, next_run_at)
VALUES
  ('ai-analysis', 'AI market analysis', 7, false, now() + interval '7 minutes'),
  ('signal-expiry', 'Signal TP/SL/expiry', 1, false, now() + interval '1 minute')
ON CONFLICT (id) DO UPDATE SET
  job_name         = EXCLUDED.job_name,
  interval_minutes = EXCLUDED.interval_minutes,
  updated_at       = now();

-- 4. RLS
ALTER TABLE public.scheduler_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon can read scheduler_status" ON public.scheduler_status;
CREATE POLICY "anon can read scheduler_status"
  ON public.scheduler_status
  FOR SELECT USING (true);

-- 5. Drop old cron job if exists
SELECT cron.unschedule('trigger-signal-expiry') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'trigger-signal-expiry'
);

-- 6. Schedule AI analysis every 7 minutes
SELECT cron.schedule(
  'ai-analysis-every-7-minutes',
  '*/7 * * * *',
  $$
    SELECT net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ai-analysis',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
      ),
      body := jsonb_build_object('scheduled', true, 'source', 'pg_cron')
    ) AS request_id;
  $$
);

-- 7. Schedule signal expiry every 1 minute
SELECT cron.schedule(
  'signal-expiry-every-1-minute',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/signal-expiry',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
      ),
      body := jsonb_build_object('scheduled', true, 'source', 'pg_cron')
    ) AS request_id;
  $$
);
