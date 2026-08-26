
-- Update cleanup to remove both closed and open test trades,
-- and all associated history records.
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
  WHERE user_id = p_user_id AND signal_id LIKE 'sig_test_%';
END;
$$;
