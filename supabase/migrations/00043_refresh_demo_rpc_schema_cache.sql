-- Re-publish the atomic demo trade RPC and refresh PostgREST schema cache.
-- DEMO ONLY. No Pionex/live trading is affected.

CREATE OR REPLACE FUNCTION public.open_demo_trade_atomic(
  p_user_id uuid,
  p_symbol text,
  p_pair text,
  p_coin_name text,
  p_buy_price numeric,
  p_quantity numeric,
  p_investment numeric,
  p_stop_loss numeric DEFAULT NULL,
  p_take_profit numeric DEFAULT NULL,
  p_signal_id text DEFAULT NULL,
  p_signal_type text DEFAULT NULL,
  p_ai_confidence integer DEFAULT NULL
)
RETURNS SETOF public.demo_trades
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account public.demo_accounts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized to open demo trade';
  END IF;

  IF p_investment <= 0 OR p_buy_price <= 0 OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Invalid demo trade values';
  END IF;

  INSERT INTO public.demo_accounts (user_id, balance, total_deposited)
  VALUES (p_user_id, 500.0, 500.0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_account
  FROM public.demo_accounts
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Demo account not found';
  END IF;

  IF v_account.balance < p_investment THEN
    RAISE EXCEPTION 'Insufficient demo balance';
  END IF;

  UPDATE public.demo_accounts
  SET balance = balance - p_investment, updated_at = now()
  WHERE user_id = p_user_id;

  RETURN QUERY
  INSERT INTO public.demo_trades (
    user_id, symbol, pair, coin_name, buy_price, quantity, investment,
    stop_loss, take_profit, signal_id, signal_type, ai_confidence,
    status, opened_at, updated_at
  )
  VALUES (
    p_user_id, p_symbol, p_pair, p_coin_name, p_buy_price, p_quantity, p_investment,
    p_stop_loss, p_take_profit, p_signal_id, p_signal_type, p_ai_confidence,
    'open', now(), now()
  )
  RETURNING *;
END;
$$;

REVOKE ALL
  ON FUNCTION public.open_demo_trade_atomic(uuid,text,text,text,numeric,numeric,numeric,numeric,numeric,text,text,integer)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.open_demo_trade_atomic(uuid,text,text,text,numeric,numeric,numeric,numeric,numeric,text,text,integer)
  TO authenticated;

-- PostgREST caches RPC signatures. Explicitly reload after CREATE OR REPLACE.
NOTIFY pgrst, 'reload schema';
