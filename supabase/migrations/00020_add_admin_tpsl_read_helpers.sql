
-- Admin read helpers for end-to-end TP/SL testing.
-- SECURITY DEFINER bypasses RLS so the test script can read state.

CREATE OR REPLACE FUNCTION admin_get_open_demo_trades(p_user_id uuid)
RETURNS TABLE (
  id uuid, symbol text, pair text, coin_name text, buy_price numeric,
  quantity numeric, investment numeric, stop_loss numeric, take_profit numeric,
  signal_id text, signal_type text, ai_confidence int, status text,
  opened_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.symbol, t.pair, t.coin_name, t.buy_price,
         t.quantity, t.investment, t.stop_loss, t.take_profit,
         t.signal_id, t.signal_type, t.ai_confidence, t.status,
         t.opened_at, t.updated_at
  FROM public.demo_trades t
  WHERE t.user_id = p_user_id AND t.status = 'open'
  ORDER BY t.opened_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin_get_demo_trade_history(p_user_id uuid)
RETURNS TABLE (
  id uuid, symbol text, pair text, coin_name text, buy_price numeric,
  sell_price numeric, quantity numeric, investment numeric, final_value numeric,
  profit_loss numeric, profit_loss_pct numeric, stop_loss numeric,
  take_profit numeric, signal_id text, exit_reason text, closed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT h.id, h.symbol, h.pair, h.coin_name, h.buy_price,
         h.sell_price, h.quantity, h.investment, h.final_value,
         h.profit_loss, h.profit_loss_pct, h.stop_loss,
         h.take_profit, h.signal_id, h.exit_reason, h.closed_at
  FROM public.demo_trade_history h
  WHERE h.user_id = p_user_id
  ORDER BY h.closed_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin_get_demo_account(p_user_id uuid)
RETURNS TABLE (balance numeric, total_deposited numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT a.balance, a.total_deposited
  FROM public.demo_accounts a
  WHERE a.user_id = p_user_id;
END;
$$;
