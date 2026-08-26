
-- Link demo trades to original AI signals for complete lifecycle tracking
ALTER TABLE public.demo_trades
  ADD COLUMN IF NOT EXISTS signal_id text,
  ADD COLUMN IF NOT EXISTS signal_pair text,
  ADD COLUMN IF NOT EXISTS signal_type text,
  ADD COLUMN IF NOT EXISTS signal_confidence int,
  ADD COLUMN IF NOT EXISTS signal_generated_at timestamptz;

ALTER TABLE public.demo_trade_history
  ADD COLUMN IF NOT EXISTS signal_id text,
  ADD COLUMN IF NOT EXISTS signal_pair text,
  ADD COLUMN IF NOT EXISTS signal_type text,
  ADD COLUMN IF NOT EXISTS signal_confidence int,
  ADD COLUMN IF NOT EXISTS signal_generated_at timestamptz;

-- Index for quick lookups by signal
CREATE INDEX IF NOT EXISTS demo_trades_signal_id_idx         ON public.demo_trades(signal_id);
CREATE INDEX IF NOT EXISTS demo_trade_history_signal_id_idx  ON public.demo_trade_history(signal_id);
