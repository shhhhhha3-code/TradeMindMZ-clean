-- Refresh PostgREST schema cache AFTER open_demo_trade_v2 exists.
-- DEMO RPC ONLY.

NOTIFY pgrst, 'reload schema';
