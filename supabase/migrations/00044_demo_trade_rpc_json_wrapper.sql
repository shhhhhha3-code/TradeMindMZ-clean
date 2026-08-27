-- Stable PostgREST wrapper for opening demo trades.
-- DEMO ONLY. No Pionex/live trading is affected.
--
-- Using one jsonb argument avoids named-parameter schema-cache resolution
-- problems that can occur with overloaded/multi-argument RPC signatures.

CREATE OR REPLACE FUNCTION public.open_demo_trade_v2(p_trade jsonb)
RETURNS SETOF public.demo_trades
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_trade IS NULL OR jsonb_typeof(p_trade) <> 'object' THEN
    RAISE EXCEPTION 'Invalid demo trade payload';
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.open_demo_trade_atomic(
    v_user_id,
    NULLIF(p_trade->>'symbol', ''),
    NULLIF(p_trade->>'pair', ''),
    NULLIF(p_trade->>'coin_name', ''),
    (p_trade->>'buy_price')::numeric,
    (p_trade->>'quantity')::numeric,
    (p_trade->>'investment')::numeric,
    NULLIF(p_trade->>'stop_loss', '')::numeric,
    NULLIF(p_trade->>'take_profit', '')::numeric,
    NULLIF(p_trade->>'signal_id', ''),
    NULLIF(p_trade->>'signal_type', ''),
    NULLIF(p_trade->>'ai_confidence', '')::integer
  );
END;
$$;

REVOKE ALL
  ON FUNCTION public.open_demo_trade_v2(jsonb)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.open_demo_trade_v2(jsonb)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
