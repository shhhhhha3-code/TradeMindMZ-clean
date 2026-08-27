-- Ensure every authenticated user can lazily initialize a demo account.
-- DEMO ONLY. No Pionex/live trading is affected.

CREATE OR REPLACE FUNCTION public.ensure_demo_account()
RETURNS public.demo_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_account public.demo_accounts%ROWTYPE;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO public.demo_accounts (
    user_id,
    balance,
    total_deposited
  )
  VALUES (
    v_user_id,
    500.0,
    500.0
  )
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
    INTO v_account
  FROM public.demo_accounts
  WHERE user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Failed to initialize demo account';
  END IF;

  RETURN v_account;
END;
$$;

REVOKE ALL
  ON FUNCTION public.ensure_demo_account()
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.ensure_demo_account()
  TO authenticated;
