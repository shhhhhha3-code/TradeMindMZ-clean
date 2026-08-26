-- Allow multiple simultaneous open demo trades per user.
-- DEMO ONLY. No live/Pionex trading is affected.

DROP INDEX IF EXISTS public.demo_trades_one_open_per_user;
