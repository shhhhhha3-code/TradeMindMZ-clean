
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- User roles
CREATE TYPE public.user_role AS ENUM ('user', 'admin');

-- Profiles table
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  username text UNIQUE,
  display_name text,
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Demo trading accounts
CREATE TABLE public.demo_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  balance numeric(18,8) NOT NULL DEFAULT 500.0,
  total_deposited numeric(18,8) NOT NULL DEFAULT 500.0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- Demo open trades
CREATE TABLE public.demo_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  pair text NOT NULL,
  coin_name text NOT NULL,
  buy_price numeric(18,8) NOT NULL,
  quantity numeric(18,8) NOT NULL,
  investment numeric(18,8) NOT NULL,
  stop_loss numeric(18,8),
  take_profit numeric(18,8),
  signal_id text,
  ai_confidence integer,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Demo trade history (closed trades)
CREATE TABLE public.demo_trade_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  pair text NOT NULL,
  coin_name text NOT NULL,
  buy_price numeric(18,8) NOT NULL,
  sell_price numeric(18,8) NOT NULL,
  quantity numeric(18,8) NOT NULL,
  investment numeric(18,8) NOT NULL,
  final_value numeric(18,8) NOT NULL,
  profit_loss numeric(18,8) NOT NULL,
  profit_loss_pct numeric(10,4) NOT NULL,
  stop_loss numeric(18,8),
  take_profit numeric(18,8),
  signal_id text,
  ai_confidence integer,
  exit_reason text NOT NULL DEFAULT 'manual' CHECK (exit_reason IN ('manual', 'take_profit', 'stop_loss')),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);

-- Pionex connections (secure storage of API keys)
CREATE TABLE public.pionex_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  api_key text NOT NULL,
  api_secret_encrypted text NOT NULL,
  is_connected boolean NOT NULL DEFAULT false,
  last_sync timestamptz,
  permissions jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- AI signals cache (shared cache, not per-user)
CREATE TABLE public.ai_signals_cache (
  id text PRIMARY KEY,
  signals jsonb NOT NULL DEFAULT '[]',
  market_data jsonb NOT NULL DEFAULT '{}',
  market_sentiment jsonb NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- User notification settings
CREATE TABLE public.user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  email_notifications boolean NOT NULL DEFAULT true,
  signal_alerts boolean NOT NULL DEFAULT true,
  trade_alerts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- Insert default signals cache
INSERT INTO public.ai_signals_cache (id, signals, market_data, market_sentiment, generated_at)
VALUES ('global', '[]'::jsonb, '{}'::jsonb, '{"score": 50, "label": "Neutral"}'::jsonb, now());

-- Trigger: auto-sync new users to profiles
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'user'::public.user_role);
  
  -- Create demo account with 500 USDT
  INSERT INTO public.demo_accounts (user_id, balance, total_deposited)
  VALUES (NEW.id, 500.0, 500.0);
  
  -- Create default settings
  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id);
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Helper: get user role (SECURITY DEFINER to prevent policy recursion)
CREATE OR REPLACE FUNCTION get_user_role(uid uuid)
RETURNS user_role
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = uid;
$$;

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER demo_accounts_updated_at BEFORE UPDATE ON demo_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER demo_trades_updated_at BEFORE UPDATE ON demo_trades FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER pionex_connections_updated_at BEFORE UPDATE ON pionex_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER user_settings_updated_at BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- RLS Policies
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_trade_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pionex_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_signals_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- profiles policies
CREATE POLICY "Admins have full access to profiles" ON profiles
  FOR ALL TO authenticated USING (get_user_role(auth.uid()) = 'admin'::user_role);

CREATE POLICY "Users can view their own profile" ON profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id)
  WITH CHECK (role IS NOT DISTINCT FROM get_user_role(auth.uid()));

-- demo_accounts policies
CREATE POLICY "Users manage own demo account" ON demo_accounts
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- demo_trades policies
CREATE POLICY "Users manage own demo trades" ON demo_trades
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- demo_trade_history policies
CREATE POLICY "Users manage own trade history" ON demo_trade_history
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- pionex_connections policies
CREATE POLICY "Users manage own pionex connection" ON pionex_connections
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ai_signals_cache - all authenticated users can read, only service role can write
CREATE POLICY "Authenticated users can read signals cache" ON ai_signals_cache
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Anon users can read signals cache" ON ai_signals_cache
  FOR SELECT TO anon USING (true);

-- user_settings policies
CREATE POLICY "Users manage own settings" ON user_settings
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
