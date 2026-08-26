-- ============================================================
-- SECTION: SCHEMA
-- ============================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_cron; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";


--
-- Name: EXTENSION "pg_cron"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pg_cron" IS 'Job scheduler for PostgreSQL';


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: pg_net; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";


--
-- Name: EXTENSION "pg_net"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pg_net" IS 'Async HTTP';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";


--
-- Name: EXTENSION "pgcrypto"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pgcrypto" IS 'cryptographic functions';


--
-- Name: supabase_vault; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";


--
-- Name: EXTENSION "supabase_vault"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "supabase_vault" IS 'Supabase Vault Extension';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'user_role'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE TYPE "public"."user_role" AS ENUM (
    'user',
    'admin'
);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: admin_cleanup_test_trades("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_cleanup_test_trades"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  DELETE FROM public.demo_trade_history
  WHERE user_id = p_user_id AND signal_id LIKE 'sig_test_%';

  DELETE FROM public.demo_trades
  WHERE user_id = p_user_id AND signal_id LIKE 'sig_test_%';
END;
$$;


--
-- Name: admin_close_demo_trade("uuid", "uuid", numeric, numeric, numeric, numeric, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_close_demo_trade"("p_trade_id" "uuid", "p_user_id" "uuid", "p_sell_price" numeric, "p_final_value" numeric, "p_profit_loss" numeric, "p_profit_loss_pct" numeric, "p_exit_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


--
-- Name: admin_get_demo_account("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_get_demo_account"("p_user_id" "uuid") RETURNS TABLE("balance" numeric, "total_deposited" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT a.balance, a.total_deposited
  FROM public.demo_accounts a
  WHERE a.user_id = p_user_id;
END;
$$;


--
-- Name: admin_get_demo_trade_history("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_get_demo_trade_history"("p_user_id" "uuid") RETURNS TABLE("id" "uuid", "symbol" "text", "pair" "text", "coin_name" "text", "buy_price" numeric, "sell_price" numeric, "quantity" numeric, "investment" numeric, "final_value" numeric, "profit_loss" numeric, "profit_loss_pct" numeric, "stop_loss" numeric, "take_profit" numeric, "signal_id" "text", "exit_reason" "text", "closed_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


--
-- Name: admin_get_open_demo_trades("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_get_open_demo_trades"("p_user_id" "uuid") RETURNS TABLE("id" "uuid", "symbol" "text", "pair" "text", "coin_name" "text", "buy_price" numeric, "quantity" numeric, "investment" numeric, "stop_loss" numeric, "take_profit" numeric, "signal_id" "text", "signal_type" "text", "ai_confidence" integer, "status" "text", "opened_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


--
-- Name: admin_insert_demo_trade("uuid", "text", "text", "text", numeric, numeric, numeric, numeric, numeric, "text", "text", integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_insert_demo_trade"("p_user_id" "uuid", "p_symbol" "text", "p_pair" "text", "p_coin_name" "text", "p_buy_price" numeric, "p_quantity" numeric, "p_investment" numeric, "p_stop_loss" numeric, "p_take_profit" numeric, "p_signal_id" "text", "p_signal_type" "text", "p_ai_confidence" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


--
-- Name: get_user_role("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_user_role"("uid" "uuid") RETURNS "public"."user_role"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT role FROM profiles WHERE id = uid;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'user'::public.user_role);
  
  -- Create demo account with 500 USDT
  INSERT INTO public.demo_accounts (user_id, balance, total_deposited)
  VALUES (NEW.id, 500.0, 500.0);
  
  -- Create default settings
  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id);
  
  RETURN NEW;
END;
$$;


--
-- Name: trigger_signal_expiry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."trigger_signal_expiry"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  supabase_url text;
  service_key  text;
BEGIN
  supabase_url := current_setting('app.supabase_url', true);
  service_key  := current_setting('app.service_role_key', true);

  -- Only proceed if we have the URL configured
  IF supabase_url IS NULL OR supabase_url = '' THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := supabase_url || '/functions/v1/signal-expiry',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(service_key, '')
    ),
    body    := '{}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  -- Never crash — this is a background task
  NULL;
END;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: ai_signals_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."ai_signals_cache" (
    "id" "text" NOT NULL,
    "signals" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "market_data" "jsonb" DEFAULT '{}'::"jsonb",
    "market_sentiment" "jsonb" DEFAULT '{}'::"jsonb",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pairs_scanned" integer DEFAULT 0,
    "analyzed_count" integer DEFAULT 0,
    "ai_source" "text",
    "model_used" "text",
    "gemini_status" "text",
    "reset_at" timestamp with time zone,
    "gemini_count" integer DEFAULT 0,
    "groq_count" integer DEFAULT 0,
    "cached_count" integer DEFAULT 0,
    "rotation_count" integer DEFAULT 0,
    "diagnostics" "jsonb",
    "error_message" "text",
    "local_setups" "jsonb" DEFAULT '[]'::"jsonb",
    CONSTRAINT "ai_signals_cache_ai_source_check" CHECK (("ai_source" = ANY (ARRAY['gemini'::"text", 'groq'::"text"]))),
    CONSTRAINT "ai_signals_cache_gemini_status_check" CHECK (("gemini_status" = ANY (ARRAY['connected'::"text", 'rate_limited'::"text", 'RATE_LIMIT'::"text", 'error'::"text"])))
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: demo_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."demo_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "balance" numeric(18,8) DEFAULT 500.0 NOT NULL,
    "total_deposited" numeric(18,8) DEFAULT 500.0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: demo_trade_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."demo_trade_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "symbol" "text" NOT NULL,
    "pair" "text" NOT NULL,
    "coin_name" "text" NOT NULL,
    "buy_price" numeric(18,8) NOT NULL,
    "sell_price" numeric(18,8) NOT NULL,
    "quantity" numeric(18,8) NOT NULL,
    "investment" numeric(18,8) NOT NULL,
    "final_value" numeric(18,8) NOT NULL,
    "profit_loss" numeric(18,8) NOT NULL,
    "profit_loss_pct" numeric(10,4) NOT NULL,
    "stop_loss" numeric(18,8),
    "take_profit" numeric(18,8),
    "signal_id" "text",
    "ai_confidence" integer,
    "exit_reason" "text" DEFAULT 'manual'::"text" NOT NULL,
    "opened_at" timestamp with time zone NOT NULL,
    "closed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signal_pair" "text",
    "signal_type" "text",
    "signal_confidence" integer,
    "signal_generated_at" timestamp with time zone,
    CONSTRAINT "demo_trade_history_exit_reason_check" CHECK (("exit_reason" = ANY (ARRAY['manual'::"text", 'take_profit'::"text", 'stop_loss'::"text"])))
);


--
-- Name: demo_trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."demo_trades" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "symbol" "text" NOT NULL,
    "pair" "text" NOT NULL,
    "coin_name" "text" NOT NULL,
    "buy_price" numeric(18,8) NOT NULL,
    "quantity" numeric(18,8) NOT NULL,
    "investment" numeric(18,8) NOT NULL,
    "stop_loss" numeric(18,8),
    "take_profit" numeric(18,8),
    "signal_id" "text",
    "ai_confidence" integer,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signal_pair" "text",
    "signal_type" "text",
    "signal_confidence" integer,
    "signal_generated_at" timestamp with time zone,
    CONSTRAINT "demo_trades_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"])))
);


--
-- Name: live_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."live_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "pionex_order_id" "text" NOT NULL,
    "close_order_id" "text",
    "symbol" "text" NOT NULL,
    "pair" "text",
    "side" "text" NOT NULL,
    "status" "text" DEFAULT 'NEW'::"text" NOT NULL,
    "fill_price" numeric(20,8),
    "filled_qty" numeric(20,8),
    "investment" numeric(20,8),
    "realized_pnl" numeric(20,8),
    "exit_reason" "text",
    "signal_id" "text",
    "trade_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "filled_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "entry_price" numeric(20,8),
    "quantity" numeric(20,8),
    CONSTRAINT "live_orders_side_check" CHECK (("side" = ANY (ARRAY['BUY'::"text", 'SELL'::"text"]))),
    CONSTRAINT "live_orders_status_check" CHECK (("status" = ANY (ARRAY['NEW'::"text", 'PARTIALLY_FILLED'::"text", 'OPEN'::"text", 'FILLED'::"text", 'CANCELLED'::"text", 'FAILED'::"text", 'CLOSED'::"text", 'UNKNOWN'::"text"])))
);


--
-- Name: COLUMN "live_orders"."entry_price"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."live_orders"."entry_price" IS 'Reference/signal entry price at order creation time. Used for P&L baseline.';


--
-- Name: COLUMN "live_orders"."quantity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."live_orders"."quantity" IS 'Rounded quantity sent to Pionex (basePrecision-floored). Immutable after order creation.';


--
-- Name: pair_analysis_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."pair_analysis_history" (
    "pair" "text" NOT NULL,
    "symbol" "text" DEFAULT ''::"text" NOT NULL,
    "last_analyzed_at" timestamp with time zone,
    "last_signal_at" timestamp with time zone,
    "last_signal_type" "text",
    "last_signal_score" integer,
    "last_ai_confidence" integer,
    "last_result" "text",
    "times_analyzed" integer DEFAULT 0 NOT NULL,
    "times_with_signal" integer DEFAULT 0 NOT NULL,
    "recent_win_count" integer DEFAULT 0 NOT NULL,
    "recent_loss_count" integer DEFAULT 0 NOT NULL,
    "last_rsi" numeric(6,2),
    "last_price" numeric,
    "last_ema9" numeric,
    "last_ema21" numeric,
    "last_volume_usdt" numeric,
    "last_momentum" "text",
    "cached_signal_json" "jsonb",
    "cache_state_hash" "text",
    "cache_expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: pionex_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."pionex_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "api_key" "text" NOT NULL,
    "api_secret_encrypted" "text",
    "is_connected" boolean DEFAULT false NOT NULL,
    "last_sync" timestamp with time zone,
    "permissions" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "username" "text",
    "display_name" "text",
    "role" "public"."user_role" DEFAULT 'user'::"public"."user_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: scheduler_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."scheduler_status" (
    "id" "text" NOT NULL,
    "job_name" "text" NOT NULL,
    "interval_minutes" integer NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_run_at" timestamp with time zone,
    "last_success_at" timestamp with time zone,
    "last_error" "text",
    "next_run_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: signal_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."signal_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pair" "text" NOT NULL,
    "symbol" "text" NOT NULL,
    "coin_name" "text" NOT NULL,
    "signal_type" "text" NOT NULL,
    "confidence" integer NOT NULL,
    "entry_price" numeric NOT NULL,
    "take_profit_1" numeric,
    "take_profit_2" numeric,
    "stop_loss" numeric,
    "risk_reward" "text",
    "holding_time" "text",
    "generated_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "exit_price" numeric,
    "result" "text",
    "pl_pct" numeric,
    "reasoning" "jsonb",
    "signal_strength" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "ai_source" "text",
    "entry_zone_low" numeric,
    "entry_zone_high" numeric,
    "status" "text" DEFAULT 'LIVE'::"text" NOT NULL,
    "pl_usdt" numeric,
    "evaluated_at" timestamp with time zone,
    "exit_timestamp" timestamp with time zone,
    "expired_class" "text",
    "server_verdict" "text",
    "recommendation_score" integer,
    "recommendation_breakdown" "jsonb",
    "setup_fingerprint" "text",
    CONSTRAINT "signal_history_ai_source_check" CHECK (("ai_source" = ANY (ARRAY['gemini'::"text", 'groq'::"text"]))),
    CONSTRAINT "signal_history_expired_class_check" CHECK (("expired_class" = ANY (ARRAY['GOOD_DIRECTION'::"text", 'NEUTRAL'::"text", 'BAD_DIRECTION'::"text"]))),
    CONSTRAINT "signal_history_result_check" CHECK (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"]))),
    CONSTRAINT "signal_history_signal_type_check" CHECK (("signal_type" = ANY (ARRAY['BUY'::"text", 'SELL'::"text", 'HOLD'::"text", 'WAIT'::"text"]))),
    CONSTRAINT "signal_history_status_check" CHECK (("status" = ANY (ARRAY['LIVE'::"text", 'WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text", 'DUPLICATE'::"text"])))
);


--
-- Name: signal_pattern_performance; Type: VIEW; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW "public"."signal_pattern_performance" AS
 SELECT "signal_type",
    "count"(*) AS "total",
    "count"(*) FILTER (WHERE ("result" = 'WIN'::"text")) AS "wins",
    "count"(*) FILTER (WHERE ("result" = 'LOSS'::"text")) AS "losses",
    "round"(
        CASE
            WHEN ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))) > 0) THEN ((("count"(*) FILTER (WHERE ("result" = 'WIN'::"text")))::numeric / ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))))::numeric) * (100)::numeric)
            ELSE (0)::numeric
        END, 1) AS "win_rate_pct",
    "round"("avg"("pl_pct") FILTER (WHERE (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"])) AND ("pl_pct" IS NOT NULL))), 2) AS "avg_return_pct",
    "round"("sum"("pl_usdt") FILTER (WHERE (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"])) AND ("pl_usdt" IS NOT NULL))), 4) AS "total_pl_usdt",
    "round"("avg"("confidence") FILTER (WHERE ("result" = 'WIN'::"text")), 1) AS "avg_winning_confidence",
    "round"("avg"("confidence") FILTER (WHERE ("result" = 'LOSS'::"text")), 1) AS "avg_losing_confidence",
    "round"("avg"((NULLIF("regexp_replace"(("reasoning" ->> 'rsi'::"text"), '[^0-9.\-].*$'::"text", ''::"text", 'g'::"text"), ''::"text"))::numeric) FILTER (WHERE ("result" = 'WIN'::"text")), 1) AS "avg_rsi_win",
    "round"("avg"((NULLIF("regexp_replace"(("reasoning" ->> 'rsi'::"text"), '[^0-9.\-].*$'::"text", ''::"text", 'g'::"text"), ''::"text"))::numeric) FILTER (WHERE ("result" = 'LOSS'::"text")), 1) AS "avg_rsi_loss"
   FROM "public"."signal_history"
  WHERE ("result" IS NOT NULL)
  GROUP BY "signal_type";


--
-- Name: signal_performance_by_ai_source; Type: VIEW; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW "public"."signal_performance_by_ai_source" AS
 SELECT COALESCE("ai_source", 'unknown'::"text") AS "ai_source",
    "count"(*) AS "total",
    "count"(*) FILTER (WHERE ("result" = 'WIN'::"text")) AS "wins",
    "count"(*) FILTER (WHERE ("result" = 'LOSS'::"text")) AS "losses",
    "round"(
        CASE
            WHEN ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))) > 0) THEN ((("count"(*) FILTER (WHERE ("result" = 'WIN'::"text")))::numeric / ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))))::numeric) * (100)::numeric)
            ELSE (0)::numeric
        END, 1) AS "win_rate_pct",
    "round"("avg"("pl_pct") FILTER (WHERE (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"])) AND ("pl_pct" IS NOT NULL))), 2) AS "avg_return_pct",
    "round"("sum"("pl_usdt") FILTER (WHERE (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"])) AND ("pl_usdt" IS NOT NULL))), 4) AS "total_pl_usdt"
   FROM "public"."signal_history"
  WHERE ("result" IS NOT NULL)
  GROUP BY "ai_source";


--
-- Name: signal_performance_by_confidence; Type: VIEW; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW "public"."signal_performance_by_confidence" AS
 SELECT
        CASE
            WHEN ("confidence" >= 80) THEN '80-100'::"text"
            WHEN ("confidence" >= 70) THEN '70-79'::"text"
            WHEN ("confidence" >= 60) THEN '60-69'::"text"
            ELSE 'below-60'::"text"
        END AS "confidence_range",
        CASE
            WHEN ("confidence" >= 80) THEN 1
            WHEN ("confidence" >= 70) THEN 2
            WHEN ("confidence" >= 60) THEN 3
            ELSE 4
        END AS "sort_order",
    "count"(*) AS "total",
    "count"(*) FILTER (WHERE ("result" = 'WIN'::"text")) AS "wins",
    "count"(*) FILTER (WHERE ("result" = 'LOSS'::"text")) AS "losses",
    "round"(
        CASE
            WHEN ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))) > 0) THEN ((("count"(*) FILTER (WHERE ("result" = 'WIN'::"text")))::numeric / ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))))::numeric) * (100)::numeric)
            ELSE (0)::numeric
        END, 1) AS "win_rate_pct",
    "round"("avg"("pl_pct") FILTER (WHERE (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"])) AND ("pl_pct" IS NOT NULL))), 2) AS "avg_return_pct"
   FROM "public"."signal_history"
  WHERE ("result" IS NOT NULL)
  GROUP BY
        CASE
            WHEN ("confidence" >= 80) THEN '80-100'::"text"
            WHEN ("confidence" >= 70) THEN '70-79'::"text"
            WHEN ("confidence" >= 60) THEN '60-69'::"text"
            ELSE 'below-60'::"text"
        END,
        CASE
            WHEN ("confidence" >= 80) THEN 1
            WHEN ("confidence" >= 70) THEN 2
            WHEN ("confidence" >= 60) THEN 3
            ELSE 4
        END
  ORDER BY
        CASE
            WHEN ("confidence" >= 80) THEN 1
            WHEN ("confidence" >= 70) THEN 2
            WHEN ("confidence" >= 60) THEN 3
            ELSE 4
        END;


--
-- Name: signal_performance_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW "public"."signal_performance_summary" AS
 SELECT "count"(*) AS "total_signals",
    "count"(*) FILTER (WHERE ("status" = 'LIVE'::"text")) AS "live_signals",
    "count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"]))) AS "evaluated_signals",
    "count"(*) FILTER (WHERE ("result" = 'WIN'::"text")) AS "wins",
    "count"(*) FILTER (WHERE ("result" = 'LOSS'::"text")) AS "losses",
    "count"(*) FILTER (WHERE ("result" = 'EXPIRED'::"text")) AS "expired",
    "round"(
        CASE
            WHEN ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))) > 0) THEN ((("count"(*) FILTER (WHERE ("result" = 'WIN'::"text")))::numeric / ("count"(*) FILTER (WHERE ("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text"]))))::numeric) * (100)::numeric)
            ELSE (0)::numeric
        END, 1) AS "win_rate_pct",
    "round"("avg"("pl_pct") FILTER (WHERE (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"])) AND ("pl_pct" IS NOT NULL))), 2) AS "avg_return_pct",
    "round"("avg"("pl_pct") FILTER (WHERE ("result" = 'WIN'::"text")), 2) AS "avg_win_pct",
    "round"("avg"("pl_pct") FILTER (WHERE ("result" = 'LOSS'::"text")), 2) AS "avg_loss_pct",
    "round"("sum"("pl_usdt") FILTER (WHERE (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'EXPIRED'::"text"])) AND ("pl_usdt" IS NOT NULL))), 4) AS "total_pl_usdt",
    "max"("pl_pct") AS "best_trade_pct",
    "min"("pl_pct") FILTER (WHERE ("result" = 'LOSS'::"text")) AS "worst_trade_pct",
    "round"("avg"("pl_pct") FILTER (WHERE (("result" = 'EXPIRED'::"text") AND ("pl_pct" IS NOT NULL))), 2) AS "expired_avg_pl_pct",
    ( SELECT "signal_history_1"."pair"
           FROM "public"."signal_history" "signal_history_1"
          WHERE ("signal_history_1"."pl_pct" IS NOT NULL)
          ORDER BY "signal_history_1"."pl_pct" DESC
         LIMIT 1) AS "best_signal_pair",
    ( SELECT "signal_history_1"."pair"
           FROM "public"."signal_history" "signal_history_1"
          WHERE (("signal_history_1"."result" = 'LOSS'::"text") AND ("signal_history_1"."pl_pct" IS NOT NULL))
          ORDER BY "signal_history_1"."pl_pct"
         LIMIT 1) AS "worst_signal_pair"
   FROM "public"."signal_history";


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."user_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email_notifications" boolean DEFAULT true NOT NULL,
    "signal_alerts" boolean DEFAULT true NOT NULL,
    "trade_alerts" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ai_signals_cache ai_signals_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'ai_signals_cache_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'ai_signals_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."ai_signals_cache"
    ADD CONSTRAINT "ai_signals_cache_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'app_settings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: app_settings app_settings_user_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'app_settings_user_id_key_key'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_user_id_key_key" UNIQUE ("user_id", "key");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_accounts demo_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'demo_accounts_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'demo_accounts'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."demo_accounts"
    ADD CONSTRAINT "demo_accounts_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_accounts demo_accounts_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'demo_accounts_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'demo_accounts'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."demo_accounts"
    ADD CONSTRAINT "demo_accounts_user_id_key" UNIQUE ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_trade_history demo_trade_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'demo_trade_history_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'demo_trade_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."demo_trade_history"
    ADD CONSTRAINT "demo_trade_history_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_trades demo_trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'demo_trades_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'demo_trades'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."demo_trades"
    ADD CONSTRAINT "demo_trades_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: live_orders live_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'live_orders_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'live_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."live_orders"
    ADD CONSTRAINT "live_orders_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pair_analysis_history pair_analysis_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pair_analysis_history_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'pair_analysis_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pair_analysis_history"
    ADD CONSTRAINT "pair_analysis_history_pkey" PRIMARY KEY ("pair");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pionex_connections pionex_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pionex_connections_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'pionex_connections'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pionex_connections"
    ADD CONSTRAINT "pionex_connections_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pionex_connections pionex_connections_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pionex_connections_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'pionex_connections'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pionex_connections"
    ADD CONSTRAINT "pionex_connections_user_id_key" UNIQUE ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_username_key'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: scheduler_status scheduler_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'scheduler_status_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'scheduler_status'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."scheduler_status"
    ADD CONSTRAINT "scheduler_status_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: signal_history signal_history_pair_generated_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'signal_history_pair_generated_at_key'
      AND n.nspname = 'public'
      AND c.relname = 'signal_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."signal_history"
    ADD CONSTRAINT "signal_history_pair_generated_at_key" UNIQUE ("pair", "generated_at");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: signal_history signal_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'signal_history_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'signal_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."signal_history"
    ADD CONSTRAINT "signal_history_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'user_settings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'user_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: user_settings user_settings_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'user_settings_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'user_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_user_id_key" UNIQUE ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_trade_history_signal_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "demo_trade_history_signal_id_idx" ON "public"."demo_trade_history" USING "btree" ("signal_id");


--
-- Name: demo_trades_one_open_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "demo_trades_one_open_per_user" ON "public"."demo_trades" USING "btree" ("user_id") WHERE ("status" = 'open'::"text");


--
-- Name: demo_trades_signal_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "demo_trades_signal_id_idx" ON "public"."demo_trades" USING "btree" ("signal_id");


--
-- Name: idx_pah_last_analyzed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_pah_last_analyzed" ON "public"."pair_analysis_history" USING "btree" ("last_analyzed_at" NULLS FIRST);


--
-- Name: idx_pah_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_pah_updated" ON "public"."pair_analysis_history" USING "btree" ("updated_at" DESC);


--
-- Name: idx_signal_history_expired_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_signal_history_expired_class" ON "public"."signal_history" USING "btree" ("expired_class") WHERE ("expired_class" IS NOT NULL);


--
-- Name: idx_signal_history_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_signal_history_fingerprint" ON "public"."signal_history" USING "btree" ("setup_fingerprint");


--
-- Name: idx_signal_history_live_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_signal_history_live_score" ON "public"."signal_history" USING "btree" ("status", "signal_strength" DESC) WHERE ("status" = 'LIVE'::"text");


--
-- Name: idx_signal_history_server_verdict; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_signal_history_server_verdict" ON "public"."signal_history" USING "btree" ("server_verdict") WHERE ("server_verdict" IS NOT NULL);


--
-- Name: live_orders_one_open_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "live_orders_one_open_per_user" ON "public"."live_orders" USING "btree" ("user_id") WHERE ("status" = ANY (ARRAY['NEW'::"text", 'PARTIALLY_FILLED'::"text", 'OPEN'::"text"]));


--
-- Name: live_orders_pionex_order_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "live_orders_pionex_order_id_key" ON "public"."live_orders" USING "btree" ("pionex_order_id");


--
-- Name: live_orders_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "live_orders_user_status" ON "public"."live_orders" USING "btree" ("user_id", "status");


--
-- Name: signal_history_ai_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "signal_history_ai_source_idx" ON "public"."signal_history" USING "btree" ("ai_source");


--
-- Name: signal_history_evaluated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "signal_history_evaluated_at_idx" ON "public"."signal_history" USING "btree" ("evaluated_at");


--
-- Name: signal_history_generated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "signal_history_generated_at_idx" ON "public"."signal_history" USING "btree" ("generated_at" DESC);


--
-- Name: signal_history_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "signal_history_pair_idx" ON "public"."signal_history" USING "btree" ("pair");


--
-- Name: signal_history_result_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "signal_history_result_idx" ON "public"."signal_history" USING "btree" ("result");


--
-- Name: signal_history_signal_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "signal_history_signal_type_idx" ON "public"."signal_history" USING "btree" ("signal_type");


--
-- Name: signal_history_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "signal_history_status_idx" ON "public"."signal_history" USING "btree" ("status");


--
-- Name: uix_signal_history_live_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "uix_signal_history_live_fingerprint" ON "public"."signal_history" USING "btree" ("setup_fingerprint") WHERE (("status" = 'LIVE'::"text") AND ("setup_fingerprint" IS NOT NULL));


--
-- Name: demo_accounts demo_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "demo_accounts_updated_at" BEFORE UPDATE ON "public"."demo_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();


--
-- Name: demo_trades demo_trades_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "demo_trades_updated_at" BEFORE UPDATE ON "public"."demo_trades" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();


--
-- Name: pionex_connections pionex_connections_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "pionex_connections_updated_at" BEFORE UPDATE ON "public"."pionex_connections" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();


--
-- Name: profiles profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();


--
-- Name: user_settings user_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "user_settings_updated_at" BEFORE UPDATE ON "public"."user_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();


--
-- Name: app_settings app_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'app_settings_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_accounts demo_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'demo_accounts_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'demo_accounts'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."demo_accounts"
    ADD CONSTRAINT "demo_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_trade_history demo_trade_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'demo_trade_history_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'demo_trade_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."demo_trade_history"
    ADD CONSTRAINT "demo_trade_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_trades demo_trades_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'demo_trades_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'demo_trades'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."demo_trades"
    ADD CONSTRAINT "demo_trades_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: live_orders live_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'live_orders_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'live_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."live_orders"
    ADD CONSTRAINT "live_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pionex_connections pionex_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pionex_connections_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'pionex_connections'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pionex_connections"
    ADD CONSTRAINT "pionex_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'user_settings_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'user_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles Admins have full access to profiles; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Admins have full access to profiles'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Admins have full access to profiles" ON "public"."profiles" TO "authenticated" USING (("public"."get_user_role"("auth"."uid"()) = 'admin'::"public"."user_role"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ai_signals_cache Anon users can read signals cache; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Anon users can read signals cache'
      AND n.nspname = 'public'
      AND c.relname = 'ai_signals_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Anon users can read signals cache" ON "public"."ai_signals_cache" FOR SELECT TO "anon" USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ai_signals_cache Authenticated users can read signals cache; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Authenticated users can read signals cache'
      AND n.nspname = 'public'
      AND c.relname = 'ai_signals_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Authenticated users can read signals cache" ON "public"."ai_signals_cache" FOR SELECT TO "authenticated" USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: live_orders Users can insert own live orders; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can insert own live orders'
      AND n.nspname = 'public'
      AND c.relname = 'live_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can insert own live orders" ON "public"."live_orders" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: live_orders Users can read own live orders; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can read own live orders'
      AND n.nspname = 'public'
      AND c.relname = 'live_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can read own live orders" ON "public"."live_orders" FOR SELECT USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: live_orders Users can update own live orders; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can update own live orders'
      AND n.nspname = 'public'
      AND c.relname = 'live_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can update own live orders" ON "public"."live_orders" FOR UPDATE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can update their own profile'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK ((NOT ("role" IS DISTINCT FROM "public"."get_user_role"("auth"."uid"()))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles Users can view their own profile; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can view their own profile'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can view their own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_accounts Users manage own demo account; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users manage own demo account'
      AND n.nspname = 'public'
      AND c.relname = 'demo_accounts'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users manage own demo account" ON "public"."demo_accounts" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_trades Users manage own demo trades; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users manage own demo trades'
      AND n.nspname = 'public'
      AND c.relname = 'demo_trades'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users manage own demo trades" ON "public"."demo_trades" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pionex_connections Users manage own pionex connection; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users manage own pionex connection'
      AND n.nspname = 'public'
      AND c.relname = 'pionex_connections'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users manage own pionex connection" ON "public"."pionex_connections" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: user_settings Users manage own settings; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users manage own settings'
      AND n.nspname = 'public'
      AND c.relname = 'user_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users manage own settings" ON "public"."user_settings" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_trade_history Users manage own trade history; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users manage own trade history'
      AND n.nspname = 'public'
      AND c.relname = 'demo_trade_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users manage own trade history" ON "public"."demo_trade_history" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ai_signals_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_signals_cache" ENABLE ROW LEVEL SECURITY;

--
-- Name: signal_history anon can insert signal_history; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'anon can insert signal_history'
      AND n.nspname = 'public'
      AND c.relname = 'signal_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "anon can insert signal_history" ON "public"."signal_history" FOR INSERT WITH CHECK (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: scheduler_status anon can read scheduler_status; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'anon can read scheduler_status'
      AND n.nspname = 'public'
      AND c.relname = 'scheduler_status'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "anon can read scheduler_status" ON "public"."scheduler_status" FOR SELECT USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: signal_history anon can read signal_history; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'anon can read signal_history'
      AND n.nspname = 'public'
      AND c.relname = 'signal_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "anon can read signal_history" ON "public"."signal_history" FOR SELECT USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: signal_history anon can update signal_history; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'anon can update signal_history'
      AND n.nspname = 'public'
      AND c.relname = 'signal_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "anon can update signal_history" ON "public"."signal_history" FOR UPDATE USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: app_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."app_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: app_settings app_settings_anon_block; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'app_settings_anon_block'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "app_settings_anon_block" ON "public"."app_settings" TO "anon" USING (false);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: app_settings app_settings_delete; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'app_settings_delete'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "app_settings_delete" ON "public"."app_settings" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: app_settings app_settings_insert; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'app_settings_insert'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "app_settings_insert" ON "public"."app_settings" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: app_settings app_settings_select; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'app_settings_select'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "app_settings_select" ON "public"."app_settings" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: app_settings app_settings_update; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'app_settings_update'
      AND n.nspname = 'public'
      AND c.relname = 'app_settings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "app_settings_update" ON "public"."app_settings" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: demo_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."demo_accounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: demo_trade_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."demo_trade_history" ENABLE ROW LEVEL SECURITY;

--
-- Name: demo_trades; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."demo_trades" ENABLE ROW LEVEL SECURITY;

--
-- Name: live_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."live_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: pair_analysis_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pair_analysis_history" ENABLE ROW LEVEL SECURITY;

--
-- Name: pionex_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pionex_connections" ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduler_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."scheduler_status" ENABLE ROW LEVEL SECURITY;

--
-- Name: pair_analysis_history service_role_all; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'service_role_all'
      AND n.nspname = 'public'
      AND c.relname = 'pair_analysis_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "service_role_all" ON "public"."pair_analysis_history" TO "service_role" USING (true) WITH CHECK (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: signal_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."signal_history" ENABLE ROW LEVEL SECURITY;

--
-- Name: user_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."user_settings" ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--




-- ============================================================
-- SECTION: DIFF FILTER OBJECTS
-- ============================================================
-- Objects that match diff-filter.json but cannot be represented
-- precisely by pg_dump --filter.

-- auth.users trigger: on_auth_user_created
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND t.tgname = 'on_auth_user_created'
      AND n.nspname = 'auth'
      AND c.relname = 'users'
  ) THEN
    EXECUTE 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();';
  END IF;
END
$pg_schema_restore$;

-- ============================================================
-- SECTION: STORAGE BUCKETS DATA
-- ============================================================


-- ============================================================
-- SECTION: CRON JOBS
-- ============================================================
-- 用户自定义 pg_cron 任务。

DO $pg_cron_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'signal-expiry-every-1-minute') THEN
    PERFORM cron.alter_job(
      job_id := (SELECT jobid FROM cron.job WHERE jobname = 'signal-expiry-every-1-minute'),
      schedule := '* * * * *',
      command := '
    SELECT net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = ''project_url'') || ''/functions/v1/signal-expiry'',
      headers := jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''apikey'', (select decrypted_secret from vault.decrypted_secrets where name = ''publishable_key'')
      ),
      body := jsonb_build_object(''scheduled'', true, ''source'', ''pg_cron'')
    ) AS request_id;
  ',
      active := true
    );
  ELSE
    PERFORM cron.schedule('signal-expiry-every-1-minute', '* * * * *', '
    SELECT net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = ''project_url'') || ''/functions/v1/signal-expiry'',
      headers := jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''apikey'', (select decrypted_secret from vault.decrypted_secrets where name = ''publishable_key'')
      ),
      body := jsonb_build_object(''scheduled'', true, ''source'', ''pg_cron'')
    ) AS request_id;
  ');
  END IF;
END
$pg_cron_restore$;
DO $pg_cron_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-analysis-every-7-minutes') THEN
    PERFORM cron.alter_job(
      job_id := (SELECT jobid FROM cron.job WHERE jobname = 'ai-analysis-every-7-minutes'),
      schedule := '*/7 * * * *',
      command := '
    SELECT net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = ''project_url'') || ''/functions/v1/ai-analysis'',
      headers := jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''apikey'', (select decrypted_secret from vault.decrypted_secrets where name = ''publishable_key''),
        ''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''publishable_key'')
      ),
      body := jsonb_build_object(''scheduled'', true, ''source'', ''pg_cron'')
    ) AS request_id;
  ',
      active := true
    );
  ELSE
    PERFORM cron.schedule('ai-analysis-every-7-minutes', '*/7 * * * *', '
    SELECT net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = ''project_url'') || ''/functions/v1/ai-analysis'',
      headers := jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''apikey'', (select decrypted_secret from vault.decrypted_secrets where name = ''publishable_key''),
        ''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''publishable_key'')
      ),
      body := jsonb_build_object(''scheduled'', true, ''source'', ''pg_cron'')
    ) AS request_id;
  ');
  END IF;
END
$pg_cron_restore$;
