
-- Helper functions for controlled end-to-end TP/SL testing.
-- These run as SECURITY DEFINER so they bypass RLS and allow the test
-- script to insert/close demo trades without browser auth.

CREATE OR REPLACE FUNCTION admin_insert_demo_trade(
  p_user_id uuid,
  p_symbol text,
  p_pair text,
  p_coin_name text,
  p_buy_price numeric,
  p_quantity numeric,
  p_investment numeric,
  p_stop_loss numeric,
  p_take_profit numeric,
  p_signal_id text,
  p_signal_type text,
  p_ai_confidence int
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO public.demo_trades (
    user_id, symbol, pair, coin_name, buy_price, quantity, investment,
    stop_loss, take_profit, signal_id, signal_type, ai_confidence,
    status, opened_at, updated_at
  ) VALUES (
    p_user_id, p_symbol, p_pair, p_coin_name, p_buy_price, p_quantity, p_investment,
    p_stop_loss, p_take_profit, p_signal_id, p_signal_type, p_ai_confidence,
    'open', now(), now()
  )
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_close_demo_trade(
  p_trade_id uuid,
  p_user_id uuid,
  p_sell_price numeric,
  p_final_value numeric,
  p_profit_loss numeric,
  p_profit_loss_pct numeric,
  p_exit_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade record;
  v_balance numeric;
BEGIN
  SELECT * INTO v_trade FROM public.demo_trades WHERE id = p_trade_id AND status = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade % is not open or does not exist', p_trade_id;
  END IF;

  UPDATE public.demo_trades
  SET status = 'closed', updated_at = now()
  WHERE id = p_trade_id;

  INSERT INTO public.demo_trade_history (
    user_id, symbol, pair, coin_name, buy_price, sell_price, quantity,
    investment, final_value, profit_loss, profit_loss_pct,
    stop_loss, take_profit, signal_id, signal_type, ai_confidence,
    exit_reason, opened_at, closed_at
  ) VALUES (
    p_user_id, v_trade.symbol, v_trade.pair, v_trade.coin_name,
    v_trade.buy_price, p_sell_price, v_trade.quantity,
    v_trade.investment, p_final_value, p_profit_loss, p_profit_loss_pct,
    v_trade.stop_loss, v_trade.take_profit, v_trade.signal_id, v_trade.signal_type, v_trade.ai_confidence,
    p_exit_reason, v_trade.opened_at, now()
  );

  SELECT balance INTO v_balance FROM public.demo_accounts WHERE user_id = p_user_id;
  IF FOUND THEN
    UPDATE public.demo_accounts
    SET balance = v_balance + p_final_value, updated_at = now()
    WHERE user_id = p_user_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin_cleanup_test_trades(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.demo_trade_history
  WHERE user_id = p_user_id AND signal_id LIKE 'sig_test_%';

  DELETE FROM public.demo_trades
  WHERE user_id = p_user_id AND signal_id LIKE 'sig_test_%' AND status = 'open';
END;
$$;
