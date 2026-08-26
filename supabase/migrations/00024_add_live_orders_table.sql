
-- FASE 3: live_orders — tracks real Pionex orders sent by Auto Trader.
-- This is the source of truth for live execution state.
-- One row per Pionex order (entry and close tracked separately).

CREATE TABLE IF NOT EXISTS live_orders (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pionex_order_id   text         NOT NULL,
  close_order_id    text,
  symbol            text         NOT NULL,
  pair              text,
  side              text         NOT NULL CHECK (side IN ('BUY', 'SELL')),
  status            text         NOT NULL DEFAULT 'NEW'
                                 CHECK (status IN ('NEW', 'PARTIALLY_FILLED', 'OPEN', 'FILLED', 'CANCELLED', 'FAILED', 'CLOSED', 'UNKNOWN')),
  fill_price        numeric(20, 8),
  filled_qty        numeric(20, 8),
  investment        numeric(20, 8),
  realized_pnl      numeric(20, 8),
  exit_reason       text,
  signal_id         text,
  trade_id          uuid,          -- reference to demo_trades.id if mirrored
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  filled_at         timestamptz,
  closed_at         timestamptz
);

-- Unique on Pionex order id — prevents duplicate rows on upsert
CREATE UNIQUE INDEX IF NOT EXISTS live_orders_pionex_order_id_key
  ON live_orders (pionex_order_id);

-- At most one live OPEN order per user (mirrors demo max-1 rule)
CREATE UNIQUE INDEX IF NOT EXISTS live_orders_one_open_per_user
  ON live_orders (user_id)
  WHERE status IN ('NEW', 'PARTIALLY_FILLED', 'OPEN');

-- Fast lookup by user + status
CREATE INDEX IF NOT EXISTS live_orders_user_status
  ON live_orders (user_id, status);

-- RLS
ALTER TABLE live_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own live orders"
  ON live_orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own live orders"
  ON live_orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own live orders"
  ON live_orders FOR UPDATE
  USING (auth.uid() = user_id);
