
-- api_secret_encrypted comes from edge function only; allow null from client upserts where secret isn't re-submitted
ALTER TABLE pionex_connections
  ALTER COLUMN api_secret_encrypted DROP NOT NULL;

-- Allow market_data and market_sentiment to be nullable (edge function populates them)
ALTER TABLE ai_signals_cache
  ALTER COLUMN market_data DROP NOT NULL,
  ALTER COLUMN market_sentiment DROP NOT NULL;

-- Ensure ai_signals_cache signals column allows initial empty insert
ALTER TABLE ai_signals_cache
  ALTER COLUMN signals SET DEFAULT '[]'::jsonb;
