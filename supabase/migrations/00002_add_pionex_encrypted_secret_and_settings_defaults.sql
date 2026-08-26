
-- Add encrypted secret column to pionex_connections if not present
ALTER TABLE pionex_connections
  ADD COLUMN IF NOT EXISTS api_secret_encrypted TEXT;

-- Ensure demo_accounts has total_deposited
ALTER TABLE demo_accounts
  ADD COLUMN IF NOT EXISTS total_deposited NUMERIC(20, 8) NOT NULL DEFAULT 500.0;

-- Update existing rows so total_deposited isn't 0
UPDATE demo_accounts SET total_deposited = 500.0 WHERE total_deposited = 0;

-- Ensure ai_signals_cache has the right structure
ALTER TABLE ai_signals_cache
  ADD COLUMN IF NOT EXISTS market_data JSONB,
  ADD COLUMN IF NOT EXISTS market_sentiment JSONB;

-- Ensure demo_trades has all needed columns
ALTER TABLE demo_trades
  ADD COLUMN IF NOT EXISTS coin_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Ensure demo_trade_history has all needed columns
ALTER TABLE demo_trade_history
  ADD COLUMN IF NOT EXISTS coin_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
