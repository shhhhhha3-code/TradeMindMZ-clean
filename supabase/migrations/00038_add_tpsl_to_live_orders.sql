-- Persist app-side TP/SL configuration for real Pionex live orders.
ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS take_profit numeric(20,8),
  ADD COLUMN IF NOT EXISTS stop_loss numeric(20,8),
  ADD COLUMN IF NOT EXISTS signal_type text;

COMMENT ON COLUMN public.live_orders.take_profit IS
  'TradeMindMZ app-side TAKE PROFIT trigger price.';

COMMENT ON COLUMN public.live_orders.stop_loss IS
  'TradeMindMZ app-side STOP LOSS trigger price.';

COMMENT ON COLUMN public.live_orders.signal_type IS
  'Original entry direction: BUY or SELL.';
