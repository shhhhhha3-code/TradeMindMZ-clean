import { supabase } from '@/db/supabase';
import type {
  Profile,
  DemoAccount,
  DemoTrade,
  DemoTradeHistory,
  PionexConnection,
  AISignalsCache,
  UserSettings,
  SignalHistory,
  SignalPerformanceSummary,
  SignalPatternStat,
  SignalPerformanceByAI,
  SignalPerformanceByConfidence,
  SchedulerStatus,
} from '@/types/types';

// ─── Profile ──────────────────────────────────────────────
export async function getProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  return data;
}

export async function updateProfile(userId: string, updates: Partial<Profile>) {
  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId);
  if (error) throw error;
}

// ─── Demo Account ─────────────────────────────────────────
export async function getDemoAccount(userId: string): Promise<DemoAccount | null> {
  const { data, error } = await supabase
    .from('demo_accounts')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[DEMO_ACCOUNT_LOAD_FAILED]', error);
    throw error;
  }

  if (!data) {
    console.error('[DEMO_ACCOUNT_MISSING]', {
      user_id: userId,
      message: 'No demo_accounts row exists for this user',
    });
    throw new Error('Demo account not found');
  }

  console.log('[DEMO_ACCOUNT_LOADED]', {
    balance: data.balance,
    total_deposited: data.total_deposited,
  });

  return data;
}

export async function updateDemoBalance(userId: string, newBalance: number) {
  const { error } = await supabase
    .from('demo_accounts')
    .update({ balance: newBalance })
    .eq('user_id', userId);
  if (error) throw error;
}

export async function resetDemoAccount(userId: string) {
  const { error } = await supabase
    .from('demo_accounts')
    .update({ balance: 500.0, total_deposited: 500.0 })
    .eq('user_id', userId);
  if (error) throw error;
}

export async function refillDemoAccount(userId: string, amount: number) {
  const { data: account } = await supabase
    .from('demo_accounts')
    .select('balance, total_deposited')
    .eq('user_id', userId)
    .maybeSingle();
  if (!account) throw new Error('Demo account not found');
  const { error } = await supabase
    .from('demo_accounts')
    .update({
      balance: account.balance + amount,
      total_deposited: account.total_deposited + amount,
    })
    .eq('user_id', userId);
  if (error) throw error;
}

// ─── Demo Trades ──────────────────────────────────────────
export async function getOpenDemoTrades(userId: string): Promise<DemoTrade[]> {
  const { data, error } = await supabase
    .from('demo_trades')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function openDemoTrade(trade: {
  symbol: string;
  pair: string;
  coin_name: string;
  buy_price: number;
  quantity: number;
  investment: number;
  stop_loss?: number;
  take_profit?: number;
  signal_id?: string;
  signal_type?: 'BUY' | 'SELL';
  ai_confidence?: number;
}) {
  const { error } = await supabase.from('demo_trades').insert(trade);
  if (error) throw error;
}

export async function closeDemoTrade(tradeId: string) {
  const { error } = await supabase
    .from('demo_trades')
    .update({ status: 'closed' })
    .eq('id', tradeId);
  if (error) throw error;
}

export async function recordTradeHistory(history: {
  symbol: string;
  pair: string;
  coin_name: string;
  buy_price: number;
  sell_price: number;
  quantity: number;
  investment: number;
  final_value: number;
  profit_loss: number;
  profit_loss_pct: number;
  stop_loss?: number;
  take_profit?: number;
  signal_id?: string;
  ai_confidence?: number;
  exit_reason: 'manual' | 'take_profit' | 'stop_loss';
  opened_at: string;
}) {
  const { error } = await supabase.from('demo_trade_history').insert(history);
  if (error) throw error;
}

// ─── Demo Trade History ───────────────────────────────────
export async function getDemoTradeHistory(userId: string): Promise<DemoTradeHistory[]> {
  const { data } = await supabase
    .from('demo_trade_history')
    .select('*')
    .eq('user_id', userId)
    .order('closed_at', { ascending: false })
    .limit(100);
  return Array.isArray(data) ? data : [];
}

export async function clearDemoHistory(userId: string) {
  const { error } = await supabase
    .from('demo_trade_history')
    .delete()
    .eq('user_id', userId);
  if (error) throw error;
}

export async function clearOpenTrades(userId: string) {
  const { error } = await supabase
    .from('demo_trades')
    .delete()
    .eq('user_id', userId)
    .eq('status', 'open');
  if (error) throw error;
}

// ─── Pionex Connection ────────────────────────────────────
export async function getPionexConnection(userId: string): Promise<PionexConnection | null> {
  const { data } = await supabase
    .from('pionex_connections')
    .select('id, user_id, api_key, is_connected, last_sync, permissions, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  return data;
}

export async function savePionexConnection(userId: string, apiKey: string, encryptedSecret: string) {
  const existing = await getPionexConnection(userId);
  if (existing) {
    const { error } = await supabase
      .from('pionex_connections')
      .update({ api_key: apiKey, api_secret_encrypted: encryptedSecret, is_connected: false, last_sync: null })
      .eq('user_id', userId);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('pionex_connections')
      .insert({ user_id: userId, api_key: apiKey, api_secret_encrypted: encryptedSecret });
    if (error) throw error;
  }
}

export async function updatePionexConnectionStatus(userId: string, isConnected: boolean) {
  const { error } = await supabase
    .from('pionex_connections')
    .update({ is_connected: isConnected, last_sync: isConnected ? new Date().toISOString() : null })
    .eq('user_id', userId);
  if (error) throw error;
}

export async function removePionexConnection(userId: string) {
  const { error } = await supabase
    .from('pionex_connections')
    .delete()
    .eq('user_id', userId);
  if (error) throw error;
}

// ─── AI Signals Cache ─────────────────────────────────────
export async function getAISignalsCache(): Promise<AISignalsCache | null> {
  const { data } = await supabase
    .from('ai_signals_cache')
    .select('*')
    .eq('id', 'global')
    .maybeSingle();
  return data as AISignalsCache | null;
}

// ─── Signal History ───────────────────────────────────────

/** Fetch a single page of signal_history using Supabase range (0-based offset). */
export async function getSignalHistoryPage(
  page: number,   // 1-based
  pageSize = 20,
): Promise<{ rows: SignalHistory[]; totalCount: number }> {
  const from = (page - 1) * pageSize;
  const to   = from + pageSize - 1;
  const { data, error, count } = await supabase
    .from('signal_history')
    .select('*', { count: 'exact' })
    .order('generated_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return {
    rows: Array.isArray(data) ? (data as SignalHistory[]) : [],
    totalCount: count ?? 0,
  };
}

/** Fetch ALL signal_history rows (used internally for stats/scores that need the full set). */
export async function getSignalHistory(limit = 200): Promise<SignalHistory[]> {
  const { data } = await supabase
    .from('signal_history')
    .select('*')
    .order('generated_at', { ascending: false })
    .limit(limit);
  return Array.isArray(data) ? (data as SignalHistory[]) : [];
}

/** Fetch a page of evaluated signals (result != null) for the AI Performance table. */
export async function getEvaluatedSignalsPage(
  page: number,
  pageSize = 20,
): Promise<{ rows: SignalHistory[]; totalCount: number }> {
  const from = (page - 1) * pageSize;
  const to   = from + pageSize - 1;
  const { data, error, count } = await supabase
    .from('signal_history')
    .select('*', { count: 'exact' })
    .not('result', 'is', null)
    .not('exit_price', 'is', null)
    .order('evaluated_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return {
    rows: Array.isArray(data) ? (data as SignalHistory[]) : [],
    totalCount: count ?? 0,
  };
}

export async function getSignalPerformanceSummary(): Promise<SignalPerformanceSummary | null> {
  // Fetch base summary row from the DB view
  const { data } = await supabase
    .from('signal_performance_summary')
    .select('*')
    .maybeSingle();
  if (!data) return null;

  // Augment with EXPIRED sub-breakdown computed from signal_history.expired_class
  // Uses a single aggregate query — no extra round-trips
  const { data: expBreakdown } = await supabase
    .from('signal_history')
    .select('expired_class')
    .eq('status', 'EXPIRED')
    .not('expired_class', 'is', null);

  let expiredGood = 0;
  let expiredNeutral = 0;
  let expiredBad = 0;
  if (Array.isArray(expBreakdown)) {
    for (const row of expBreakdown) {
      if (row.expired_class === 'GOOD_DIRECTION')  expiredGood++;
      else if (row.expired_class === 'NEUTRAL')    expiredNeutral++;
      else if (row.expired_class === 'BAD_DIRECTION') expiredBad++;
    }
  }

  // Augment: count signals with TP1 > 2.5% of entry (historically aggressive)
  const { data: allEvaluated } = await supabase
    .from('signal_history')
    .select('entry_price, take_profit_1')
    .not('result', 'is', null);

  let aggressiveTP = 0;
  if (Array.isArray(allEvaluated)) {
    for (const row of allEvaluated) {
      const entry = Number(row.entry_price ?? 0);
      const tp1   = Number(row.take_profit_1 ?? 0);
      if (entry > 0 && tp1 > 0) {
        const tp1Pct = Math.abs(tp1 - entry) / entry * 100;
        if (tp1Pct > 2.5) aggressiveTP++;
      }
    }
  }

  return {
    ...(data as SignalPerformanceSummary),
    expired_good_direction:    expiredGood,
    expired_neutral:           expiredNeutral,
    expired_bad_direction:     expiredBad,
    signals_with_aggressive_tp: aggressiveTP,
  };
}

export async function getSignalPatternStats(): Promise<SignalPatternStat[]> {
  const { data } = await supabase
    .from('signal_pattern_performance')
    .select('*');
  return Array.isArray(data) ? (data as SignalPatternStat[]) : [];
}

export async function getSignalPerformanceByAI(): Promise<SignalPerformanceByAI[]> {
  const { data } = await supabase
    .from('signal_performance_by_ai_source')
    .select('*');
  return Array.isArray(data) ? (data as SignalPerformanceByAI[]) : [];
}

export async function getSignalPerformanceByConfidence(): Promise<SignalPerformanceByConfidence[]> {
  const { data } = await supabase
    .from('signal_performance_by_confidence')
    .select('*')
    .order('sort_order', { ascending: true });
  return Array.isArray(data) ? (data as SignalPerformanceByConfidence[]) : [];
}

// ─── User Settings ────────────────────────────────────────
export async function getUserSettings(userId: string): Promise<UserSettings | null> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateUserSettings(userId: string, updates: Partial<Pick<UserSettings, 'email_notifications' | 'signal_alerts' | 'trade_alerts'>>) {
  // Use upsert so the call succeeds whether the row exists or not.
  // Only pass the settable boolean columns — never id, user_id, created_at, updated_at.
  const payload: Record<string, unknown> = { user_id: userId };
  if (updates.email_notifications !== undefined) payload.email_notifications = updates.email_notifications;
  if (updates.signal_alerts       !== undefined) payload.signal_alerts       = updates.signal_alerts;
  if (updates.trade_alerts        !== undefined) payload.trade_alerts        = updates.trade_alerts;

  const { error } = await supabase
    .from('user_settings')
    .upsert(payload, { onConflict: 'user_id' });
  if (error) throw error;
}

// ─── Scheduler status ───────────────────────────────────────────────────────
export async function getSchedulerStatus(id: string): Promise<SchedulerStatus | null> {
  const { data, error } = await supabase
    .from('scheduler_status')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn('[api] getSchedulerStatus error:', error.message);
    return null;
  }
  return data;
}

// ─── FASE 3: Live orders (Pionex real trades) ──────────────────────────────

export interface LiveOrder {
  id: string;
  user_id: string;
  pionex_order_id: string;
  close_order_id:  string | null;
  symbol:          string;
  pair:            string;
  side:            'BUY' | 'SELL';
  status:          string;
  fill_price:      number;
  filled_qty:      number;
  investment:      number;
  quantity:        number | null;
  take_profit:     number | null;
  stop_loss:       number | null;
  signal_type:     'BUY' | 'SELL' | null;
  realized_pnl:    number | null;
  exit_reason:     string | null;
  signal_id:       string | null;
  trade_id:        string | null;
  created_at:      string;
  updated_at:      string;
  filled_at:       string | null;
  closed_at:       string | null;
}

/**
 * Fetch all live orders for the authenticated user.
 */
export async function getLiveOrders(userId: string): Promise<LiveOrder[]> {
  const { data, error } = await supabase
    .from('live_orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[api] getLiveOrders error:', error.message);
    return [];
  }
  return (data ?? []) as LiveOrder[];
}

/**
 * Fetch open live orders (status NEW | PARTIALLY_FILLED | OPEN) for the user.
 * Used by reconciliation to detect stale local state.
 */
export async function getOpenLiveOrders(userId: string): Promise<LiveOrder[]> {
  const { data, error } = await supabase
    .from('live_orders')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['NEW', 'PARTIALLY_FILLED', 'OPEN'])
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[api] getOpenLiveOrders error:', error.message);
    return [];
  }
  return (data ?? []) as LiveOrder[];
}

/**
 * reconcileLiveOrders — call at app-start.
 * Calls the EF reconcile action which returns:
 *   { has_open_on_pionex, has_local_live, open_orders, local_live_orders }
 * Guards Auto Trader from sending a new order when Pionex already has one open.
 */
export async function reconcileLiveOrders(): Promise<{
  has_open_on_pionex: boolean;
  has_local_live:     boolean;
  open_orders:        Record<string, unknown>[];
  local_live_orders:  Record<string, unknown>[];
}> {
  const { data, error } = await supabase.functions.invoke('pionex-proxy', {
    method: 'POST',
    body: { action: 'reconcile' },
  });
  if (error) {
    console.warn('[api] reconcileLiveOrders error:', error.message);
    return { has_open_on_pionex: false, has_local_live: false, open_orders: [], local_live_orders: [] };
  }
  return {
    has_open_on_pionex: data?.has_open_on_pionex ?? false,
    has_local_live:     data?.has_local_live     ?? false,
    open_orders:        data?.open_orders        ?? [],
    local_live_orders:  data?.local_live_orders  ?? [],
  };
}
