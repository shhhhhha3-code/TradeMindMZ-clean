
-- app_settings: server-side key/value store per user
-- Used for LIVE_TRADING_ENABLED toggle (user-controlled, server-enforced)
CREATE TABLE IF NOT EXISTS app_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Authenticated users can only read/write their own settings
CREATE POLICY "app_settings_select" ON app_settings
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "app_settings_insert" ON app_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "app_settings_update" ON app_settings
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "app_settings_delete" ON app_settings
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Anon: no access
CREATE POLICY "app_settings_anon_block" ON app_settings
  FOR ALL TO anon USING (false);
