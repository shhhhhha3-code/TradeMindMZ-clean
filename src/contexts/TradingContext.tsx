import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { supabase } from '@/db/supabase';
import { useAuth } from './AuthContext';
import { toast } from 'sonner';
import {
  computeLiveSignalScores, fmtSignalAge, REC_AGING_MS,
  holdingTimeToMsFE,
  AUTO_TRADER_INVESTMENT_PCT,
} from '@/lib/signal-scoring';
import { evaluateDemoTradeTPSL, formatDemoTradeCheck } from '@/lib/demo-trade-utils';
import type { ScoredSignal } from '@/lib/signal-scoring';
import {
  getMockProvider,
  getPionexProvider,
  OrderBlockedError,
  type ExecutionResult,
} from '@/services/exchange';
import {
  preflightLiveOrder,
  type LiveOrderPreflight,
  type LiveOrderErrorCode,
} from '@/lib/live-order-utils';
import type {
  DemoAccount,
  DemoTrade,
  DemoTradeHistory,
  AISignalsCache,
  AISignal,
  MarketData,
  DemoPerformance,
  SignalHistory,
  SignalPerformanceSummary,
  SignalPatternStat,
  SignalPerformanceByAI,
  SignalPerformanceByConfidence,
  SchedulerStatus,
} from '@/types/types';
import {
  getDemoAccount,
  getOpenDemoTrades,
  getDemoTradeHistory,
  getAISignalsCache,
  openDemoTrade,
  closeDemoTrade,
  recordTradeHistory,
  updateDemoBalance,
  resetDemoAccount,
  refillDemoAccount,
  clearDemoHistory,
  clearOpenTrades,
  getSignalHistory,
  getSignalPerformanceSummary,
  getSignalPatternStats,
  getSignalPerformanceByAI,
  getSignalPerformanceByConfidence,
  getSchedulerStatus,
  getLiveOrders,
  reconcileLiveOrders,
  type LiveOrder,
} from '@/db/api';

// ── Utility: fetch with timeout ───────────────────────────────────────────────
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// ── Utility: retry with exponential backoff ───────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, attempts = 2, baseMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Parse a holding_time string like "3-6 hours", "6-12 hours", "1-3 days"
 * and return the upper-bound duration in milliseconds.
 * Falls back to 6 hours if unparseable.
 */

interface TradingContextValue {
  demoAccount: DemoAccount | null;
  openTrades: DemoTrade[];
  tradeHistory: DemoTradeHistory[];
  signalsCache: AISignalsCache | null;
  /** Live signals filtered to only those within 20-min window */
  liveSignals: AISignal[];
  marketPrices: Record<string, MarketData>;
  marketDataStatus: 'live' | 'cached' | 'error';
  pionexAccountStatus: 'connected' | 'disconnected' | 'error';
  aiAnalysisStatus: 'idle' | 'updating' | 'error';
  /** AI model analysis can be disabled to save provider/API costs. Server-side local scoring remains active. */
  aiAnalysisEnabled: boolean;
  setAiAnalysisEnabled: (enabled: boolean) => void;
  lastAIUpdate: Date | null;
  lastAnalysisError: string | null;
  scanStats: {
    pairsScanned: number;
    analyzedByAI: number;
    opportunities: number;
    openaiCount: number;
    groqCount: number;
    cachedCount: number;
    rotationCount: number;
  } | null;
  performance: DemoPerformance;
  loadingDemo: boolean;
  // Signal history + performance
  signalHistory: SignalHistory[];
  signalPerfSummary: SignalPerformanceSummary | null;
  signalPatternStats: SignalPatternStat[];
  signalPerfByAI: SignalPerformanceByAI[];
  signalPerfByConfidence: SignalPerformanceByConfidence[];
  loadingSignalHistory: boolean;
  refreshSignalHistory: () => Promise<void>;
  // Scheduler status (server-side)
  schedulerStatus: SchedulerStatus | null;
  loadingSchedulerStatus: boolean;
  refreshSchedulerStatus: () => Promise<void>;
  /** ISO timestamp of the last completed scheduler analysis (signals refreshed). */
  schedulerCompletedAt: string | null;
  // Auto Trader state (global, persistent)
  autoTraderEnabled: boolean;
  autoTraderTradeId: string | null;
  autoTraderTotalTrades: number;
  autoTraderLastAction: string;
  autoTraderBestSetup: ScoredSignal | null;
  autoTraderBestOverallScore: ScoredSignal | null;
  autoTraderSelectedSignal: ScoredSignal | null;
  startAutoTrader: () => void;
  stopAutoTrader: () => void;
  // FASE 3: Live trading state
  /** true når server-side LIVE_TRADING_ENABLED=true og Pionex er koblet til */
  isPionexLive: boolean;
  /** Max investering per trade fra server (USDT). 0 = ingen kunstig grense satt. */
  /** true etter første ekte Pionex-trade er fullstendig gjennomført (OPEN→CLOSED). */
  firstLiveTradeDone: boolean;
  /** Alle live_orders for brukeren (ekte Pionex-trades). */
  liveOrders: LiveOrder[];
  /** Åpne live_orders (status NEW | PARTIALLY_FILLED | OPEN). */
  openLiveOrders: LiveOrder[];
  /** Oppdater live_orders fra databasen. */
  refreshLiveOrders: () => Promise<void>;
  /** Hent live-status på nytt fra server (live_status EF action). */
  refreshLiveStatus: () => Promise<void>;
  /** Slå LIVE TRADING PÅ eller AV server-side. Returnerer ny status. */
  toggleLiveTrading: (enable: boolean) => Promise<boolean>;
  /** Dry-run mode: kjører alle sjekker, men sender aldri ordre til Pionex. */
  dryRunMode: boolean;
  setDryRunMode: (enabled: boolean) => void;
  /** Siste sporing av Manual Buy / Auto Trade (for Trading Diagnostics). */
  manualBuyTrace: LiveOrderTrace | null;
  autoTradeTrace: LiveOrderTrace | null;
  executeManualBuy: (params: { pair: string; price: number; investment: number; amountUsdt: number; signal_id?: string }) => Promise<LiveOrderTrace>;

  executeManualSell: (params: {
    pair: string;
    price: number;
    signal_id?: string;
  }) => Promise<LiveOrderTrace>;
  /** Hent live USDT-saldo direkte fra Pionex (brukes av ManualBuyModal). */
  getBalance: () => Promise<{ usdt_available: number; usdt_total: number }>;
  /** Hent Pionex market-info for ett par (brukes av ManualBuyModal for filter-regler). */
  getMarketInfo: (pair: string) => Promise<import('@/lib/live-order-utils').ExchangeMarketInfo | null>;
  executeDemoBuy: (trade: {
    symbol: string;
    pair: string;
    coin_name: string;
    buy_price: number;
    investment: number;
    stop_loss?: number;
    take_profit?: number;
    signal_id?: string;
    signal_type?: 'BUY' | 'SELL';
    ai_confidence?: number;
  }) => Promise<DemoTrade | null>;
  executeDemoSell: (tradeId: string, reason?: 'manual' | 'take_profit' | 'stop_loss') => Promise<void>;
  resetDemo: () => Promise<void>;
  refillDemo: (amount: number) => Promise<void>;
  refreshMarketData: () => Promise<void>;
  refreshSignals: () => Promise<void>;
}

export interface LiveOrderTrace {
  mode: 'manual' | 'auto';
  signal_id?: string;
  pair?: string;
  timestamp: string;
  triggered: boolean;
  preflight: LiveOrderPreflight | null;
  place_order_called: boolean;
  pionex_request_sent: boolean;
  pionex_http_status?: number | 'NOT_SENT' | 'TIMEOUT';
  pionex_order_id?: string | null;
  live_orders_record_created?: boolean;
  order_status?: 'NEW' | 'FILLED' | 'REJECTED' | 'UNKNOWN' | string;
  error_code?: LiveOrderErrorCode;
  error_message?: string;
  dry_run: boolean;
}

const TradingContext = createContext<TradingContextValue>({} as TradingContextValue);

function computePerformance(
  account: DemoAccount | null,
  trades: DemoTrade[],
  history: DemoTradeHistory[],
  prices: Record<string, MarketData>
): DemoPerformance {
  if (!account) {
    return {
      account_value: 500, available_balance: 500, invested_amount: 0,
      unrealized_pnl: 0, realized_pnl: 0, total_return_pct: 0,
      total_trades: 0, winning_trades: 0, losing_trades: 0,
      win_rate: 0, avg_win: 0, avg_loss: 0, best_trade: 0, worst_trade: 0,
    };
  }
  const invested = trades.reduce((sum, t) => sum + t.investment, 0);
  const unrealized = trades.reduce((sum, t) => {
    const price = prices[t.pair]?.price ?? t.buy_price;
    return sum + (price - t.buy_price) * t.quantity;
  }, 0);
  const closedWins = history.filter(h => h.profit_loss > 0);
  const closedLosses = history.filter(h => h.profit_loss <= 0);
  const realized = history.reduce((sum, h) => sum + h.profit_loss, 0);
  const winRate = history.length > 0 ? (closedWins.length / history.length) * 100 : 0;
  const avgWin = closedWins.length > 0 ? closedWins.reduce((s, h) => s + h.profit_loss, 0) / closedWins.length : 0;
  const avgLoss = closedLosses.length > 0 ? Math.abs(closedLosses.reduce((s, h) => s + h.profit_loss, 0) / closedLosses.length) : 0;
  const allPnls = history.map(h => h.profit_loss);
  const accountValue = account.balance + invested + unrealized;
  const totalReturn = account.total_deposited > 0 ? ((accountValue - account.total_deposited) / account.total_deposited) * 100 : 0;
  return {
    account_value: accountValue, available_balance: account.balance,
    invested_amount: invested, unrealized_pnl: unrealized,
    realized_pnl: realized, total_return_pct: totalReturn,
    total_trades: history.length, winning_trades: closedWins.length,
    losing_trades: closedLosses.length, win_rate: winRate,
    avg_win: avgWin, avg_loss: avgLoss,
    best_trade: allPnls.length > 0 ? Math.max(...allPnls) : 0,
    worst_trade: allPnls.length > 0 ? Math.min(...allPnls) : 0,
  };
}

export function TradingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [demoAccount, setDemoAccount] = useState<DemoAccount | null>(null);
  const [openTrades, setOpenTrades] = useState<DemoTrade[]>([]);
  const [tradeHistory, setTradeHistory] = useState<DemoTradeHistory[]>([]);
  const [signalsCache, setSignalsCache] = useState<AISignalsCache | null>(null);
  const [liveSignals, setLiveSignals] = useState<AISignal[]>([]);
  const [marketPrices, setMarketPrices] = useState<Record<string, MarketData>>({});
  const [marketDataStatus, setMarketDataStatus] = useState<'live' | 'cached' | 'error'>('cached');
  const [pionexAccountStatus, setPionexAccountStatus] = useState<'connected' | 'disconnected' | 'error'>('disconnected');
  const [aiAnalysisStatus, setAiAnalysisStatus] = useState<'idle' | 'updating' | 'error'>('idle');
  const [aiAnalysisEnabled, setAiAnalysisEnabledState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('tmz_ai_analysis_enabled');
      return saved !== 'false';
    } catch {
      return true;
    }
  });
  const [lastAIUpdate, setLastAIUpdate] = useState<Date | null>(null);
  const [lastAnalysisError, setLastAnalysisError] = useState<string | null>(null);
  const [scanStats, setScanStats] = useState<{ pairsScanned: number; analyzedByAI: number; opportunities: number; openaiCount: number; groqCount: number; cachedCount: number; rotationCount: number } | null>(null);
  const [loadingDemo, setLoadingDemo] = useState(true);
  // Signal history state
  const [signalHistory, setSignalHistory] = useState<SignalHistory[]>([]);
  const [signalPerfSummary, setSignalPerfSummary] = useState<SignalPerformanceSummary | null>(null);
  const [signalPatternStats, setSignalPatternStats] = useState<SignalPatternStat[]>([]);
  const [signalPerfByAI, setSignalPerfByAI] = useState<SignalPerformanceByAI[]>([]);
  const [signalPerfByConfidence, setSignalPerfByConfidence] = useState<SignalPerformanceByConfidence[]>([]);
  const [loadingSignalHistory, setLoadingSignalHistory] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [loadingSchedulerStatus, setLoadingSchedulerStatus] = useState(false);
  const [schedulerCompletedAt, setSchedulerCompletedAt] = useState<string | null>(null);
  // Auto Trader state — global and persisted across tabs/remounts/refresh
  const [autoTraderEnabled, setAutoTraderEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('auto_trader_enabled') === 'true'; } catch { return false; }
  });
  const [autoTraderTradeId, setAutoTraderTradeId] = useState<string | null>(() => {
    try { return localStorage.getItem('auto_trader_trade_id'); } catch { return null; }
  });
  const [autoTraderTotalTrades, setAutoTraderTotalTrades] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('auto_trader_total_trades') ?? '0', 10);
      return Number.isNaN(v) ? 0 : v;
    } catch { return 0; }
  });
  const [autoTraderLastAction, setAutoTraderLastAction] = useState<string>('');
  const [autoTraderBestSetup, setAutoTraderBestSetup] = useState<ScoredSignal | null>(null);
  const [autoTraderBestOverallScore, setAutoTraderBestOverallScore] = useState<ScoredSignal | null>(null);
  const [autoTraderSelectedSignal, setAutoTraderSelectedSignal] = useState<ScoredSignal | null>(null);

  // ── FASE 3: Live trading state ─────────────────────────────────────────────
  // isPionexLive: true when server-side LIVE_TRADING_ENABLED=true AND Pionex connected.
  // Fetched once at mount via EF live_status action — never stored in frontend code.
  const [isPionexLive, setIsPionexLive]           = useState(false);
  // firstLiveTradeDone: persisted in localStorage so a page refresh keeps the guard.
  // FASE 3 rule: stop Auto Trader for new live entries after the first complete trade.
  const [firstLiveTradeDone, setFirstLiveTradeDone] = useState<boolean>(() => {
    try { return localStorage.getItem('first_live_trade_done') === 'true'; } catch { return false; }
  });
  // liveOrders: alle live_orders for brukeren — kun UI-visning, ingen trading-logikk.
  const [liveOrders, setLiveOrders] = useState<LiveOrder[]>([]);
  const isPionexLiveRef = useRef(false);
  isPionexLiveRef.current = isPionexLive;

  // Dry-run state for Manual Buy / Auto Trade tests
  const [dryRunMode, setDryRunModeState] = useState<boolean>(() => {
    try { return localStorage.getItem('tmz_dry_run_mode') === 'true'; } catch { return false; }
  });

  // Execution trace diagnostics
  const [manualBuyTrace, setManualBuyTrace] = useState<LiveOrderTrace | null>(null);
  const [autoTradeTrace, setAutoTradeTrace] = useState<LiveOrderTrace | null>(null);

  const autoTraderEntryLockRef = useRef(false);
  const lastSchedulerProcessedAtRef = useRef<string | null>(null);
  const marketPricesRef = useRef<Record<string, MarketData>>({});
  const openTradesRef = useRef<DemoTrade[]>([]);
  const demoAccountRef = useRef<DemoAccount | null>(null);
  const signalsCacheRef = useRef<AISignalsCache | null>(null);
  // Accumulated signal pool — NEVER cleared between refreshes; each signal lives its own 20-min lifecycle
  const allSignalsPoolRef = useRef<AISignal[]>([]);
  // Guards: pool must be seeded from DB before the first EF analysis call fires
  const poolSeededRef = useRef(false);
  // Deduplication refs
  const marketFetchingRef = useRef(false);
  const signalsFetchingRef = useRef(false);
  const expiryRunningRef = useRef(false);
  // Tracks the last scheduler last_success_at we processed so a new EF run
  // can be detected even when refreshSchedulerStatus is called multiple times.
  // schedulerInitializedRef is false until the first status read, preventing a
  // page refresh from being treated as a new completed analysis.
  const lastSchedulerSuccessRef = useRef<string | null>(null);
  const schedulerInitializedRef = useRef(false);
  // Stable callback refs — updated every render so polling closures always call
  // the latest version WITHOUT adding the callbacks to the useEffect dep array.
  // This prevents the effect from re-running (and re-calling load()) whenever
  // a callback identity changes due to a state update mid-analysis.
  const refreshSignalsRef      = useRef<() => Promise<void>>(() => Promise.resolve());
  const fetchMarketDataRef     = useRef<() => Promise<Record<string, MarketData>>>(() => Promise.resolve({}));
  const checkTPSLRef           = useRef<(p: Record<string, MarketData>) => Promise<void>>(() => Promise.resolve());
  const runExpiryCheckRef      = useRef<() => Promise<void>>(() => Promise.resolve());
  const checkPionexRef         = useRef<() => Promise<void>>(() => Promise.resolve());
  const refreshSignalHistoryRef= useRef<() => Promise<void>>(() => Promise.resolve());
  const mergeIntoPoolRef       = useRef<(s: AISignal[]) => void>(() => {});
  const recomputeLiveSignalsRef= useRef<() => void>(() => {});
  // Canonical scoring refs: Auto Trader reads these instead of closed-over state
  // so it always scores with the freshest signals+history loaded by the scheduler callback.
  const liveSignalsRef    = useRef<AISignal[]>([]);
  const signalHistoryRef  = useRef<SignalHistory[]>([]);

  marketPricesRef.current = marketPrices;
  openTradesRef.current = openTrades;
  demoAccountRef.current = demoAccount;
  signalsCacheRef.current = signalsCache;
  // Keep canonical refs up to date every render so runAutoTraderEntry always
  // reads the freshest data even across React re-renders.
  liveSignalsRef.current   = liveSignals;
  signalHistoryRef.current = signalHistory;

  // Persist Auto Trader enabled/trade-id whenever they change
  useEffect(() => {
    try { localStorage.setItem('auto_trader_enabled', String(autoTraderEnabled)); } catch { /* ignore */ }
  }, [autoTraderEnabled]);
  useEffect(() => {
    try {
      if (autoTraderTradeId) localStorage.setItem('auto_trader_trade_id', autoTraderTradeId);
      else localStorage.removeItem('auto_trader_trade_id');
    } catch { /* ignore */ }
  }, [autoTraderTradeId]);
  useEffect(() => {
    try { localStorage.setItem('auto_trader_total_trades', String(autoTraderTotalTrades)); } catch { /* ignore */ }
  }, [autoTraderTotalTrades]);
  // Persist firstLiveTradeDone
  useEffect(() => {
    try {
      if (firstLiveTradeDone) localStorage.setItem('first_live_trade_done', 'true');
    } catch { /* ignore */ }
  }, [firstLiveTradeDone]);

  // Persist dry-run mode
  const setAiAnalysisEnabled = useCallback((enabled: boolean) => {
    setAiAnalysisEnabledState(enabled);
    try { localStorage.setItem('tmz_ai_analysis_enabled', String(enabled)); } catch { /* ignore */ }
    setLastAnalysisError(null);
  }, []);

  const setDryRunMode = useCallback((enabled: boolean) => {
    setDryRunModeState(enabled);
    try { localStorage.setItem('tmz_dry_run_mode', String(enabled)); } catch { /* ignore */ }
  }, []);

  const startAutoTrader = useCallback(() => {
    setAutoTraderEnabled(true);
    setAutoTraderLastAction('Auto Trader startet. Venter på Scheduler-analyse.');
  }, []);

  const stopAutoTrader = useCallback(() => {
    autoTraderEntryLockRef.current = false;
    setAutoTraderEnabled(false);
    setAutoTraderLastAction('Auto Trader stoppet.');
  }, []);

  // ── Signal pool helpers ───────────────────────────────────────────────
  /**
   * Merge incoming signals into the in-memory pool.
   * - Deduplicates by id so the same signal is never added twice.
   * - NEVER removes existing signals (they age out via recomputeLiveSignals).
   */
  const mergeIntoPool = useCallback((incoming: AISignal[]) => {
    const existing = allSignalsPoolRef.current;

    // Canonical identity for live signals:
    // only one signal per pair + direction.
    const byPairDir = new Map<string, AISignal>();

    // Keep existing signals first.
    for (const signal of existing) {
      if (!signal.pair || !signal.signal_type) continue;

      const key =
        `${String(signal.pair).toUpperCase()}::${String(signal.signal_type).toUpperCase()}`;

      byPairDir.set(key, signal);
    }

    // Incoming signals replace the existing version for the same
    // pair + direction. This matches the backend dedup rule.
    for (const signal of incoming) {
      if (!signal.pair || !signal.signal_type) continue;

      const key =
        `${String(signal.pair).toUpperCase()}::${String(signal.signal_type).toUpperCase()}`;

      byPairDir.set(key, signal);
    }

    allSignalsPoolRef.current = Array.from(byPairDir.values());
  }, []);

  // ── Live signal filtering: keep only signals that are still LIVE ───────
  //
  // Reads from the in-memory pool, NOT from signalsCache directly.
  // This means a new cache fetch NEVER wipes signals that are still live.
  // A signal is also dropped if signal_history shows it has been closed (WIN/LOSS/EXPIRED).

  const recomputeLiveSignals = useCallback(() => {
    const now = Date.now();
    const closedIds = new Set(signalHistory.filter(h => h.status !== 'LIVE').map(h => h.id));
    const live = allSignalsPoolRef.current.filter(s => {
      if (closedIds.has(s.id)) return false;
      const age = now - new Date(s.generated_at).getTime();
      // UI-filter: signaler eldre enn 10 minutter (STALE) vises ikke i live-visningen.
      // De forblir i databasen og er tilgjengelige i Signal History.
      // Handelslogikk (Auto Trader, scoring, Gate 1–6) er ikke endret.
      if (age >= REC_AGING_MS) return false;
      const ttl = holdingTimeToMsFE((s as { holding_time?: string | null }).holding_time);
      return age < ttl;
    });
    setLiveSignals(live);
  }, [signalHistory]);

  // Re-filter every 30s so the countdown stays accurate without re-fetching
  useEffect(() => {
    recomputeLiveSignals();
    const t = setInterval(() => recomputeLiveSignals(), 30_000);
    return () => clearInterval(t);
  }, [recomputeLiveSignals]);

  // ── Signal history + performance ─────────────────────────────────────

  const refreshSignalHistory = useCallback(async () => {
    setLoadingSignalHistory(true);
    try {
      // First: trigger signal-expiry so any newly-expired LIVE rows get evaluated
      // before we fetch stats. This makes the Refresh button on the Performance tab
      // also evaluate pending signals immediately — no 5-min wait needed.
      if (!expiryRunningRef.current) {
        expiryRunningRef.current = true;
        try {
          await supabase.functions.invoke('signal-expiry', { method: 'POST', body: {} });
        } catch { /* non-fatal */ }
        expiryRunningRef.current = false;
      }

      const [hist, summary, patterns, byAI, byConf] = await Promise.all([
        getSignalHistory(200),
        getSignalPerformanceSummary(),
        getSignalPatternStats(),
        getSignalPerformanceByAI(),
        getSignalPerformanceByConfidence(),
      ]);
      setSignalHistory(hist);
      setSignalPerfSummary(summary);
      setSignalPatternStats(patterns);
      setSignalPerfByAI(byAI);
      setSignalPerfByConfidence(byConf);
    } catch { /* swallow */ }
    setLoadingSignalHistory(false);
  }, []);

  // ── Scheduler status (server-side) ─────────────────────────────────────
  const refreshSchedulerStatus = useCallback(async () => {
    setLoadingSchedulerStatus(true);
    try {
      const [analysis, expiry] = await Promise.all([
        getSchedulerStatus('ai-analysis'),
        getSchedulerStatus('signal-expiry'),
      ]);
      // Prefer the AI analysis scheduler; fall back to signal-expiry row
      const status = analysis ?? expiry;
      setSchedulerStatus(status);

      // Detect a completed AI analysis run. When a new last_success_at
      // arrives, refresh signals so liveSignals contains the new output,
      // then notify listeners (Auto Trader) via schedulerCompletedAt.
      const successAt = status?.last_success_at ?? null;
      if (successAt) {
        if (!schedulerInitializedRef.current) {
          // First status read after mount: just record the baseline, don't
          // treat it as a new completed analysis.
          lastSchedulerSuccessRef.current = successAt;
          schedulerInitializedRef.current = true;
        } else if (successAt !== lastSchedulerSuccessRef.current) {
          // A new scheduler run has completed since the last read.
          lastSchedulerSuccessRef.current = successAt;
          // Canonical scoring: refresh BOTH signals and signal_history before
          // notifying Auto Trader. This guarantees runAutoTraderEntry scores with
          // the same fresh data as the UI — eliminating UI=RECOMMENDED / AT=NO_TRADE.
          if (poolSeededRef.current) {
            await refreshSignalsRef.current();
          }
          await refreshSignalHistoryRef.current();
          setSchedulerCompletedAt(successAt);
        }
      }
    } catch {
      setSchedulerStatus(null);
    }
    setLoadingSchedulerStatus(false);
  }, []);

  // ── signal-expiry EF: manual refresh only
  // The automatic server-side evaluation runs every minute via pg_cron.
  // Frontend timers are NOT used to simulate background execution.
  const runExpiryCheck = useCallback(async () => {
    if (expiryRunningRef.current) return;
    expiryRunningRef.current = true;
    try {
      await supabase.functions.invoke('signal-expiry', { method: 'POST', body: {} });
      await refreshSignalHistory();
    } catch { /* swallow — non-critical */ }
    expiryRunningRef.current = false;
  }, [refreshSignalHistory]);

  // ── Market data from Pionex via Edge Function ──────────────────────────

  const fetchMarketData = useCallback(async () => {
    // Deduplicate: skip if a fetch is already in-flight
    if (marketFetchingRef.current) return marketPricesRef.current;
    marketFetchingRef.current = true;
    try {
      const { data, error } = await withTimeout(
        withRetry(() => supabase.functions.invoke('market-data', { method: 'POST', body: {} }), 2, 1000),
        12_000
      );
      if (error || !data || typeof data !== 'object') throw new Error(error?.message ?? 'No data');
      if ((data as Record<string, unknown>).error) throw new Error(String((data as Record<string, unknown>).error));

      // market-data v3 returns ALL Pionex USDT pairs — iterate every key,
      // not just the 8 hardcoded TRACKED_PAIRS. This ensures demo trades on
      // AI-signal pairs (DYM/USDT, OSMO/USDT, etc.) always get a live price.
      const priceMap: Record<string, MarketData> = {};
      const raw = data as Record<string, Record<string, unknown>>;
      for (const pair of Object.keys(raw)) {
        const item = raw[pair];
        if (!item || typeof item !== 'object') continue;
        const price = Number(item.price);
        if (isNaN(price) || price <= 0) continue;
        priceMap[pair] = {
          symbol: String(item.symbol ?? pair.replace('/USDT', '')),
          pair,
          price,
          change_24h: Number(item.change_24h ?? 0),
          change_pct_24h: Number(item.change_pct_24h ?? 0),
          volume_24h: Number(item.volume_24h ?? 0),
          high_24h: Number(item.high_24h ?? price),
          low_24h: Number(item.low_24h ?? price),
          sparkline: Array.isArray(item.sparkline) ? (item.sparkline as number[]) : [],
        };
      }

      if (Object.keys(priceMap).length > 0) {
        setMarketPrices(priceMap);
        setMarketDataStatus('live');
        return priceMap;
      }
      throw new Error('Empty price map from Pionex');
    } catch {
      // Keep last successful data — NEVER replace with empty/null on failure
      setMarketDataStatus(prev => prev === 'live' ? 'cached' : 'error');
      return marketPricesRef.current;
    } finally {
      marketFetchingRef.current = false;
    }
  }, []);

  // ── AI signals via Edge Function ─────────────────────────────────────────
  //
  // IMPORTANT: never call this before poolSeededRef.current === true.
  // The polling useEffect below enforces this guarantee.

  const refreshSignals = useCallback(async () => {
    // Block if pool hasn't been seeded from DB yet (prevents race on mount)
    if (!poolSeededRef.current) return;
    // Deduplicate: if already running, skip — but do NOT set 'updating' if blocked,
    // otherwise aiAnalysisStatus permanently shows 'updating' with no resolver.
    if (signalsFetchingRef.current) return;
    signalsFetchingRef.current = true;
    // Mark as updating WITHOUT clearing liveSignals — pool is the source of truth
    setAiAnalysisStatus('updating');
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('ai-analysis', {
          method: 'POST',
          body: { use_ai: aiAnalysisEnabled, source: 'frontend' },
        }),
        90_000
      );
      if (!error && data) {
        const d = data as AISignalsCache;
        setSignalsCache(d);
        setLastAIUpdate(new Date());
        setAiAnalysisStatus('idle');
        setLastAnalysisError(d.error_message ?? null);
        // Merge NEW signals from this run into the pool (never replace)
        if (Array.isArray(d.signals)) mergeIntoPool(d.signals);
        // Re-filter live signals from the full pool
        recomputeLiveSignals();
        setScanStats({
          pairsScanned: d.pairs_scanned ?? 0,
          analyzedByAI: d.analyzed_count ?? 0,
          // Opportunities = non-expired signals still within their TTL window.
          // This is the raw count used as a fallback; Dashboard overrides with
          // RECOMMENDED+WATCH from scoredSignals for the displayed number.
          opportunities: allSignalsPoolRef.current.filter(s => {
            const age = Date.now() - new Date(s.generated_at).getTime();
            const ttl = holdingTimeToMsFE((s as { holding_time?: string | null }).holding_time);
            return age < ttl;
          }).length,
          openaiCount:   (d.openai_count ?? d.gemini_count) ?? 0,
          groqCount:     d.groq_count     ?? 0,
          cachedCount:   d.cached_count   ?? 0,
          rotationCount: d.rotation_count ?? 0,
        });
      } else {
        throw new Error(error?.message ?? 'AI analysis failed');
      }
    } catch {
      setAiAnalysisStatus('error');
      // On EF failure, live signals already in pool are untouched — no fallback DB
      // re-seed needed here; pool was seeded on mount
    } finally {
      signalsFetchingRef.current = false;
    }
  }, [aiAnalysisEnabled, mergeIntoPool, recomputeLiveSignals]);

  // ── Check if Pionex account is connected ──────────────────────────────

  const checkPionexConnection = useCallback(async () => {
    if (!user) { setPionexAccountStatus('disconnected'); return; }
    try {
      const { data } = await supabase.from('pionex_connections')
        .select('is_connected, last_sync')
        .eq('user_id', user.id)
        .maybeSingle();
      setPionexAccountStatus(data?.is_connected ? 'connected' : 'disconnected');
    } catch {
      setPionexAccountStatus('error');
    }
  }, [user]);

  // ── TP/SL auto-trigger ────────────────────────────────────────────────
  //
  // Close-lock: closingTradesRef is a Set of trade IDs currently being closed.
  // If two concurrent safeFetch() intervals both call checkTPSL simultaneously,
  // the second call will find the trade id already in the Set and skip it —
  // guaranteeing exactly one close per trade regardless of concurrency.
  //
  // Direction logic is delegated to evaluateDemoTradeTPSL in lib/demo-trade-utils.
  // Side is determined EXPLICITLY from signal_type (BUY/SELL) and never inferred
  // from buy_price or TP/SL values.
  //
  // Price source: prefer live marketPrices[trade.pair]; fall back to the trade's
  // current_price (last known market price) so an open trade isn't silently skipped
  // if the latest market-data fetch is missing that pair. This prevents the UI
  // showing one price while the TP/SL engine uses none.

  const closingTradesRef = useRef<Set<string>>(new Set());
  // LIVE TP/SL close idempotency lock.
  // Prevents duplicate close_order requests while a close is in flight.
  const liveClosingOrdersRef = useRef<Set<string>>(new Set());


  // ── Keep stable callback refs in sync every render ────────────────────
  // Polling closures read from these refs so the useEffect dep array stays
  // [user]-only and NEVER re-runs load() due to callback identity changes.
  // NOTE: checkTPSLRef.current is assigned AFTER checkTPSL is declared below.
  refreshSignalsRef.current       = refreshSignals;
  fetchMarketDataRef.current      = fetchMarketData;
  runExpiryCheckRef.current       = runExpiryCheck;
  checkPionexRef.current          = checkPionexConnection;
  refreshSignalHistoryRef.current = refreshSignalHistory;
  mergeIntoPoolRef.current        = mergeIntoPool;
  recomputeLiveSignalsRef.current = recomputeLiveSignals;

  // ── Initial load + polling ─────────────────────────────────────────────
  //
  // SEQUENCE (enforced, runs exactly ONCE per user session):
  //   1. Load DB (account, trades, cache) in one await block
  //   2. Seed signal pool from cache → recomputeLiveSignals
  //      → liveSignals visible BEFORE any EF call fires
  //   3. poolSeededRef = true
  //   4. loadingDemo = false → UI renders signals immediately
  //   5. Start polling — safeSignals() reads refreshSignalsRef.current
  //
  // dep = [user] ONLY so this effect never re-runs due to callback churn.
  // All callbacks are accessed via stable refs updated above every render.

  useEffect(() => {
    if (!user) { setLoadingDemo(false); return; }

    let alive = true;
    let marketInterval: ReturnType<typeof setInterval>;
    let schedulerStatusInterval: ReturnType<typeof setInterval>;

    const load = async () => {
      setLoadingDemo(true);
      try {
        const [acc, trades, hist, cache] = await Promise.all([
          getDemoAccount(user.id),
          getOpenDemoTrades(user.id),
          getDemoTradeHistory(user.id),
          getAISignalsCache(),
        ]);
        if (!alive) return;

        setDemoAccount(acc);
        setOpenTrades(trades);
        setTradeHistory(hist);

        if (cache) {
          setSignalsCache(cache);
          setLastAIUpdate(new Date(cache.updated_at));
          // Seed pool from DB → signals visible immediately after page refresh
          if (Array.isArray(cache.signals)) mergeIntoPoolRef.current(cache.signals);
          setScanStats({
            pairsScanned: cache.pairs_scanned ?? 0,
            analyzedByAI: cache.analyzed_count ?? 0,
            opportunities: (cache.signals ?? []).filter(s => {
              const age = Date.now() - new Date(s.generated_at).getTime();
              const ttl = holdingTimeToMsFE((s as { holding_time?: string | null }).holding_time);
              return age < ttl;
            }).length,
            openaiCount:   (cache.openai_count ?? cache.gemini_count) ?? 0,
            groqCount:     cache.groq_count     ?? 0,
            cachedCount:   cache.cached_count   ?? 0,
            rotationCount: cache.rotation_count ?? 0,
          });
        }

        // Render existing live signals BEFORE any EF call can change state
        recomputeLiveSignalsRef.current();
      } catch { /* never crash on initial load */ }

      // Mark pool as seeded — refreshSignals() is now allowed to run
      poolSeededRef.current = true;
      setLoadingDemo(false);

      if (!alive) return;

      // ── Start polling AFTER DB restore is complete ───────────────────
      // AI analysis and signal expiry are now handled SERVER-SIDE via pg_cron.
      // The frontend only displays state and polls market data for demo-trade TP/SL.
      const safeFetch = async () => {
        try {
          const prices = await fetchMarketDataRef.current();
          if (alive && Object.keys(prices).length > 0) checkTPSLRef.current(prices);
        } catch { /* never crash the polling loop */ }
      };

      // Fire first market fetch immediately (no AI analysis on load)
      safeFetch();

      checkPionexRef.current();
      refreshSignalHistoryRef.current();
      refreshSchedulerStatus(); // load scheduler status once on mount

      marketInterval = setInterval(safeFetch, 30_000);
      // Refresh scheduler status more frequently (15s) so Auto Trader can
      // react to a completed server-side analysis as soon as possible.
      schedulerStatusInterval = setInterval(() => refreshSchedulerStatus(), 15_000);
    };

    load();

    return () => {
      alive = false;
      clearInterval(marketInterval);
      clearInterval(schedulerStatusInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]); // MUST stay [user]-only — callbacks accessed via stable refs above

  // ── Update open trade P/L from latest prices ─────────────────────────

  useEffect(() => {
    if (Object.keys(marketPrices).length === 0) return;
    setOpenTrades(prev => prev.map(t => {
      const price = marketPrices[t.pair]?.price ?? t.current_price ?? t.buy_price;
      const currentValue = price * t.quantity;
      const unrealizedPnl = currentValue - t.investment;
      const pnlPct = (unrealizedPnl / t.investment) * 100;
      let aiStatus = 'Holding';
      if (t.take_profit && price >= t.take_profit * 0.98) aiStatus = 'Take Profit Approaching';
      else if (t.stop_loss && price <= t.stop_loss * 1.02) aiStatus = 'Stop Loss Approaching';
      else if (pnlPct > 5) aiStatus = 'Bullish';
      else if (pnlPct < -5) aiStatus = 'Bearish';
      return { ...t, current_price: price, current_value: currentValue, unrealized_pnl: unrealizedPnl, pnl_pct: pnlPct, ai_status: aiStatus };
    }));
  }, [marketPrices]);

  // ── FASE 3: Exchange execution provider — switches to Pionex when live ───────
  // Typed as TradingExecutionProvider so both Mock and Pionex are assignable.
  const exchangeProviderRef = useRef<import('@/services/exchange').TradingExecutionProvider>(
    getMockProvider({ allowOrders: true, defaultOutcome: 'FILLED' })
  );

  // Switch provider whenever live status changes
  useEffect(() => {
    if (isPionexLive) {
      exchangeProviderRef.current = getPionexProvider();
      console.log('[PROVIDER_SWITCH] Pionex LIVE provider aktiv — ekte Pionex execution.');
    } else {
      exchangeProviderRef.current = getMockProvider({ allowOrders: true, defaultOutcome: 'FILLED' });
      console.log('[PROVIDER_SWITCH] Mock provider aktiv — ingen ekte Pionex-ordre.');
    }
  }, [isPionexLive]);

  // Fetch live_status from server once at mount (and whenever Pionex connection changes)
  const fetchLiveStatus = useCallback(async () => {
    try {
      const { data } = await supabase.functions.invoke('pionex-proxy', {
        method: 'POST',
        body: { action: 'live_status' },
      });
      const live = data?.live_enabled === true;
      setIsPionexLive(live);
      console.log('[LIVE_STATUS] live_enabled:', live, 'source:', data?.source);
    } catch (e) {
      // Non-fatal: fall back to safe defaults (live=false)
      console.warn('[LIVE_STATUS] could not fetch live_status — defaulting to live=false:', String(e));
      setIsPionexLive(false);
    }
  }, []);

  // Server-side toggle: kaller live_status_set og oppdaterer lokal state
  const toggleLiveTrading = useCallback(async (enable: boolean): Promise<boolean> => {
    const { data, error } = await supabase.functions.invoke('pionex-proxy', {
      method: 'POST',
      body: { action: 'live_status_set', enable },
    });
    if (error) throw new Error(error.message ?? String(error));
    if (data?.error) throw new Error(data.error);
    const newLive = data?.live_enabled === true;
    setIsPionexLive(newLive);
    console.log('[LIVE_STATUS_SET] live_trading_enabled =', newLive);
    return newLive;
  }, []);

  // Fetch once at mount, refresh when pionexAccountStatus changes
  useEffect(() => {
    if (user) fetchLiveStatus();
  }, [user, pionexAccountStatus, fetchLiveStatus]);

  // ── refreshLiveOrders: hent lokal status og synkroniser åpne ordre med Pionex.
  // READ-ONLY mot Pionex: vi oppretter/lukker ingen ordre her.
  const refreshLiveOrders = useCallback(async () => {
    if (!user) return;

    let orders = await getLiveOrders(user.id);

    if (isPionexLive) {
      try {
        // Finn alle lokale ordre som UI-et ellers ville regnet som åpne.
        const candidates = orders.filter(o =>
          ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(String(o.status).toUpperCase())
        );

        const provider = getPionexProvider();

        for (const localOrder of candidates) {
          if (!localOrder.pionex_order_id) continue;

          try {
            const remote = await provider.getOrderStatus(localOrder.pionex_order_id);

            console.log('[LIVE_STATUS_SYNC]', {
              id: localOrder.id,
              pionex_order_id: localOrder.pionex_order_id,
              local_status: localOrder.status,
              remote_status: remote.status,
            });

            // Synkroniser alle statuser som betyr at ordren ikke lenger
            // kan regnes som aktiv i UI-et.
            //
            // UNKNOWN betyr at Pionex ikke kunne bekrefte en aktiv ordre.
            // Vi setter da lokal status til UNKNOWN slik at en gammel
            // lokal NEW/OPEN-rad ikke blir stående som falskt åpen.
            if (['FILLED', 'CANCELLED', 'FAILED', 'UNKNOWN'].includes(remote.status)) {
              const newStatus =
                remote.status === 'FILLED' ? 'FILLED' :
                remote.status === 'CANCELLED' ? 'CANCELLED' :
                remote.status === 'FAILED' ? 'FAILED' :
                'UNKNOWN';

              await supabase
                .from('live_orders')
                .update({
                  status: newStatus,
                  updated_at: new Date().toISOString(),
                  closed_at: new Date().toISOString(),
                })
                .eq('user_id', user.id)
                .eq('id', localOrder.id);

              console.log('[LIVE_STATUS_SYNC] updated local order', {
                id: localOrder.id,
                remote_status: remote.status,
                newStatus,
              });
            }
          } catch (orderError) {
            // En enkelt feil skal ikke stoppe status-sync for resten.
            console.warn(
              '[LIVE_STATUS_SYNC] failed for order',
              localOrder.pionex_order_id,
              orderError
            );
          }
        }

        // Hent fersk lokal status etter eventuelle oppdateringer.
        orders = await getLiveOrders(user.id);
      } catch (error) {
        console.warn('[LIVE_STATUS_SYNC] reconciliation failed:', error);
      }
    }

    setLiveOrders(orders);
  }, [user, isPionexLive]);

  // Hent live_orders ved mount og når isPionexLive endres
  useEffect(() => {
    if (user && isPionexLive) refreshLiveOrders();
  }, [user, isPionexLive, refreshLiveOrders]);

  /**
   * executeViaProvider — kjøper via Mock execution layer.
   *
   * Flow:
   *   placeOrder() → orderId → getOrderStatus() → FILLED → ExecutionResult
   *
   * Kaster ved:
   *   FAILED / CANCELLED     → ingen OPEN trade registreres
   *   TIMEOUT (Error kastet) → ingen OPEN trade; ingen blind retry
   *   PARTIALLY_FILLED       → returnerer faktisk filled_qty og fill_price
   *   UNKNOWN                → kaster uten retry; kaller logg
   *
   * LIVE_TRADING=false: placeOrder() kaster OrderBlockedError hvis allowOrders=false.
   */
  const executeViaProvider = useCallback(async (params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    amountUsdt?: number;
    price: number;
    signal_id?: string;
    takeProfit?: number;
    stopLoss?: number;
  }): Promise<ExecutionResult> => {
    const provider = exchangeProviderRef.current;

    console.log('[EXEC] executeViaProvider placeOrder', params.symbol, params.side,
      'qty:', params.qty, 'price:', params.price);

    const order = await provider.placeOrder({
      symbol:    params.symbol,
      side:      params.side,
      qty:       params.qty,
      amountUsdt: params.amountUsdt,
      price:     params.price,
      type:       'MARKET',
      signal_id:  params.signal_id,
      takeProfit: params.takeProfit,
      stopLoss:   params.stopLoss,
    } as Parameters<typeof provider.placeOrder>[0]);

    console.log('[EXEC] placeOrder returnerte orderId:', order.order_id,
      'status:', order.status);

    // Hent bekreftet status (Mock returnerer med en gang; ekte exchange ville polles)
    const confirmed = await provider.getOrderStatus(order.order_id);

    console.log('[EXEC] getOrderStatus orderId:', confirmed.order_id,
      'status:', confirmed.status, 'filled_qty:', confirmed.filled_qty,
      'avg_fill_price:', confirmed.avg_fill_price);

    if (confirmed.status === 'FAILED' || confirmed.status === 'CANCELLED') {
      throw new Error(
        `[EXEC] Ordre ${confirmed.status} — ingen trade åpnet. orderId=${confirmed.order_id}`
      );
    }

    if (confirmed.status === 'UNKNOWN') {
      // Ikke retry automatisk — ukjent status på market order er farlig
      console.warn('[EXEC] Ukjent ordre-status etter placeOrder — ingen retry.',
        'orderId:', confirmed.order_id);
      throw new Error(
        `[EXEC] Ukjent ordre-status — ingen trade åpnet. orderId=${confirmed.order_id}`
      );
    }

    // ── USDT-M TP/SL HOOK ────────────────────────────────────────────────
    //
    // Entry er bekreftet av Pionex.
    //
    // BUY  -> LONG
    // SELL -> SHORT
    //
    // Bruk den faktiske Pionex order_id-en fra getOrderStatus().
    //
    // SAFE PHASE:
    // setFuturesTPSL() validerer/loggfører requesten i proxy.
    // Den oppretter IKKE ekte Pionex TP/SL-ordrer ennå.
    //
    // Hvis TP/SL setup feiler etter FILLED entry, retryes IKKE entry.
    if (
      confirmed.status === 'FILLED' &&
      (params.takeProfit !== undefined ||
        params.stopLoss !== undefined)
    ) {
      const positionSide: 'LONG' | 'SHORT' =
        params.side === 'BUY' ? 'LONG' : 'SHORT';

      try {
        const tpslResult = await provider.setFuturesTPSL({
          symbol: params.symbol,
          position_side: positionSide,
          entry_order_id: confirmed.order_id,
          take_profit: params.takeProfit,
          stop_loss: params.stopLoss,
          signal_id: params.signal_id,
        });

        console.log(
          '[EXEC] USDT-M TP/SL setup result:',
          tpslResult
        );
      } catch (tpslError) {
        console.error(
          '[EXEC] TP/SL setup failed after FILLED entry:',
          tpslError
        );
      }
    }

    const partiallyFilled = confirmed.status === 'PARTIALLY_FILLED';
    const fillPrice = confirmed.avg_fill_price > 0 ? confirmed.avg_fill_price : params.price;
    const filledQty = confirmed.filled_qty > 0 ? confirmed.filled_qty : params.qty;

    return {
      order_id:         confirmed.order_id,
      fill_price:       fillPrice,
      filled_qty:       filledQty,
      status:           confirmed.status,
      partially_filled: partiallyFilled,
    };
  }, []);

  /**
   * Shared live-order entry validation. Runs the same safety gates for both
   * Manual Buy and Auto Trade. In dry-run mode it returns the preflight without
   * sending any order to Pionex.
   */
  const validateLiveOrder = useCallback(async (params: {
    pair: string;
    side: 'BUY' | 'SELL';
    price: number;
    investment: number;
    signal_id?: string;
  }): Promise<LiveOrderPreflight> => {
    const pionexConnected = pionexAccountStatus === 'connected';
    const provider = exchangeProviderRef.current;

    return preflightLiveOrder({
      pair: params.pair,
      side: params.side,
      price: params.price,
      investment: params.investment,
      signal_id: params.signal_id,
      is_pionex_live: isPionexLive,
      is_pionex_connected: pionexConnected,
      getBalance: async () => {
        const bal = await provider.getBalance();
        return { usdt_available: bal.usdt_available, usdt_total: bal.usdt_total };
      },
      getMarketInfo: async (pair) => {
        // Resolve the canonical Pionex symbol from the pair string "XRP/USDT"
        // by matching base_asset + quote_asset against the full markets list.
        // NEVER strip "/" and assume that is the Pionex symbol format.
        const markets = await provider.getMarkets();
        const slashIdx = pair.indexOf('/');
        let m: typeof markets[number] | undefined;
        if (slashIdx !== -1) {
          const base  = pair.slice(0, slashIdx).toUpperCase();
          const quote = pair.slice(slashIdx + 1).toUpperCase();
          m = markets.find(
            x => x.base_asset.toUpperCase() === base && x.quote_asset.toUpperCase() === quote
          );
        }
        // Fallback: exact symbol match (case-insensitive)
        if (!m) {
          m = markets.find(x => x.symbol.toUpperCase() === pair.replace('/', '').toUpperCase());
        }
        if (!m) return null;
        return {
          symbol:             m.symbol,
          base_asset:         m.base_asset,
          quote_asset:        m.quote_asset,
          quantity_precision: m.quantity_precision,
          // amountPrecision: decimal places for USDT `amount` in MARKET BUY
          amount_precision:   (m as typeof m & { amount_precision?: number }).amount_precision,
          min_qty:            m.min_qty,
          min_value:          m.min_value,
        };
      },
      checkDuplicate: async (signalId) => {
        if (!user) return false;
        // Re-read from DB to avoid stale state
        const all = await getLiveOrders(user.id);
        return all.some(o => o.signal_id === signalId && !['CLOSED', 'CANCELLED', 'FAILED'].includes(o.status));
      },
      existing_open_orders: liveOrders.filter(o => ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(o.status)).length,
    });
  }, [isPionexLive, pionexAccountStatus, liveOrders, user]);

  /**
   * executeLiveOrder — shared execution path used by both Manual Buy and Auto Trade.
   * Validates, optionally sends to Pionex, refreshes live_orders, and records a trace.
   */
  const executeLiveOrder = useCallback(async (params: {
    pair: string;
    side: 'BUY' | 'SELL';
    price: number;
    investment: number;
    amountUsdt?: number;
    signal_id?: string;
    takeProfit?: number;
    stopLoss?: number;
    mode: 'manual' | 'auto';
  }): Promise<LiveOrderTrace> => {
    const now = new Date().toISOString();
    const trace: LiveOrderTrace = {
      mode: params.mode,
      signal_id: params.signal_id,
      pair: params.pair,
      timestamp: now,
      triggered: true,
      preflight: null,
      place_order_called: false,
      pionex_request_sent: false,
      pionex_http_status: 'NOT_SENT',
      pionex_order_id: null,
      live_orders_record_created: false,
      dry_run: dryRunMode,
    };

    console.log('[EXECUTE_LIVE_ORDER] start', {
      mode: params.mode,
      pair: params.pair,
      side: params.side,
      price: params.price,
      investment: params.investment,
      signal_id: params.signal_id,
      dryRunMode,
    });

    try {
      console.log('[EXECUTE_LIVE_ORDER] calling validateLiveOrder/preflight...');
      const preflight = await validateLiveOrder({
        ...params,
        investment: params.side === 'BUY' && params.amountUsdt !== undefined
          ? params.amountUsdt
          : params.investment,
      });
      trace.preflight = preflight;

      console.log('[EXECUTE_LIVE_ORDER] preflight result:', {
        all_pass: preflight.all_pass,
        error_code: preflight.error_code,
        error_message: preflight.error_message,
        symbol: preflight.symbol,
        quantity_final: preflight.quantity_final,
        price: preflight.price,
        investment_final: preflight.investment_final,
      });

      if (!preflight.all_pass) {
        trace.error_code = preflight.error_code;
        trace.error_message = preflight.error_message;
        console.log('[EXECUTE_LIVE_ORDER] preflight failed:', trace.error_code, trace.error_message);
        if (params.mode === 'manual') setManualBuyTrace(trace);
        else setAutoTradeTrace(trace);
        throw new Error(preflight.error_message ?? 'Preflight failed');
      }

      if (dryRunMode) {
        console.log('[EXECUTE_LIVE_ORDER] dry run mode — skipping real order');
        trace.pionex_http_status = 'NOT_SENT';
        trace.error_code = undefined;
        trace.error_message = undefined;
        if (params.mode === 'manual') setManualBuyTrace(trace);
        else setAutoTradeTrace(trace);
        return trace;
      }

      // Real execution path — use the canonical Pionex symbol resolved by preflight.
      // preflight.symbol is the exact string from /api/v1/common/symbols (e.g. "XRP_USDT").
      // NEVER re-derive the symbol by stripping "/" from the pair string.
      trace.place_order_called = true;
      trace.pionex_request_sent = true;

      const symbol = preflight.symbol;  // canonical Pionex symbol from getMarkets()
      const qty = preflight.quantity_final;
      const amountUsdt = params.side === 'BUY' ? preflight.amount_usdt_final : undefined;

      console.log('[EXECUTE_LIVE_ORDER] calling executeViaProvider with:', { symbol, side: params.side, qty, amountUsdt, price: params.price, signal_id: params.signal_id });

      let execResult: ExecutionResult;
      try {
        execResult = await executeViaProvider({
          symbol,
          side: params.side,
          qty,
          amountUsdt,
          price: params.price,
          signal_id: params.signal_id,
          takeProfit: params.takeProfit,
          stopLoss: params.stopLoss,
        });
      } catch (execErr) {
        trace.place_order_called = true;
        trace.pionex_request_sent = true;
        if (execErr instanceof OrderBlockedError) {
          trace.error_code = execErr.reason as LiveOrderErrorCode;
          trace.error_message = `Blocked by server: ${execErr.reason}`;
          trace.pionex_http_status = 403;
        } else {
          const msg = execErr instanceof Error ? execErr.message : String(execErr);
          trace.error_code = 'REJECTED';
          trace.error_message = msg;
          trace.pionex_http_status = 400;
        }
        if (params.mode === 'manual') setManualBuyTrace(trace);
        else setAutoTradeTrace(trace);
        throw execErr;
      }

      trace.pionex_order_id = execResult.order_id;
      trace.order_status = execResult.status;
      trace.pionex_http_status = 200;
      trace.live_orders_record_created = true;

      console.log('[EXECUTE_LIVE_ORDER] success:', {
        order_id: execResult.order_id,
        status: execResult.status,
        symbol,
        qty,
        price: params.price,
      });

      // pionex-proxy already created the live_orders record; refresh local list
      await refreshLiveOrders();
    } catch (e) {
      if (!trace.error_code) {
        trace.error_code = 'UNKNOWN';
        trace.error_message = e instanceof Error ? e.message : String(e);
      }
      console.log('[EXECUTE_LIVE_ORDER] caught exception:', {
        error_code: trace.error_code,
        error_message: trace.error_message,
        place_order_called: trace.place_order_called,
        pionex_request_sent: trace.pionex_request_sent,
        pionex_http_status: trace.pionex_http_status,
      });
    }

    console.log('[EXECUTE_LIVE_ORDER] returning trace:', {
      error_code: trace.error_code,
      error_message: trace.error_message,
      pionex_order_id: trace.pionex_order_id,
      order_status: trace.order_status,
      pionex_http_status: trace.pionex_http_status,
      live_orders_record_created: trace.live_orders_record_created,
    });

    if (params.mode === 'manual') setManualBuyTrace(trace);
    else setAutoTradeTrace(trace);
    return trace;
  }, [dryRunMode, validateLiveOrder, executeViaProvider, refreshLiveOrders]);

  /**
   * executeManualBuy — user-initiated live BUY. Uses the same shared execution path
   * as Auto Trade.
   */
  const executeManualBuy = useCallback(async (params: {
    pair: string;
    price: number;
    investment: number;
    amountUsdt: number;
    signal_id?: string;
  }): Promise<LiveOrderTrace> => {
    return executeLiveOrder({
      pair: params.pair,
      side: 'BUY',
      price: params.price,
      investment: params.investment,
      amountUsdt: params.amountUsdt,
      signal_id: params.signal_id,
      mode: 'manual',
    });
  }, [executeLiveOrder]);

  /**
   * executeManualSell
   *
   * LIVE SELL på spot skal lukke en eksisterende live BUY-posisjon.
   * Vi bruker derfor closeOrder() og den faktiske quantity fra live_orders.
   *
   * Viktig:
   * - Ingen tilfeldig SELL-quantity.
   * - Ingen shorting.
   * - Ingen SELL hvis vi ikke finner en åpen lokal live-order på samme pair.
   */
  const executeManualSell = useCallback(async (params: {
    pair: string;
    price: number;
    signal_id?: string;
  }): Promise<LiveOrderTrace> => {
    const trace: LiveOrderTrace = {
      mode: 'manual',
      signal_id: params.signal_id,
      pair: params.pair,
      timestamp: new Date().toISOString(),
      triggered: true,
      preflight: null,
      place_order_called: false,
      pionex_request_sent: false,
      pionex_http_status: 'NOT_SENT',
      pionex_order_id: null,
      live_orders_record_created: false,
      dry_run: dryRunMode,
    };

    console.log('[MANUAL_SELL] start', {
      pair: params.pair,
      price: params.price,
      signal_id: params.signal_id,
      dryRunMode,
    });

    try {
      if (!isPionexLive) {
        trace.error_code = 'LIVE_TRADING_DISABLED';
        trace.error_message = 'Live trading er deaktivert.';
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      }

      if (pionexAccountStatus !== 'connected') {
        trace.error_code = 'REJECTED';
        trace.error_message = 'Pionex er ikke tilkoblet.';
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      }

      // Hent fersk database-status direkte.
      // Ikke bruk liveOrders-state her, siden React-state kan være én render bak.
      const freshLiveOrders = user
        ? await getLiveOrders(user.id)
        : [];

      const normalizedPair = params.pair.toUpperCase();

      const openOrders = freshLiveOrders.filter(order =>
        ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(
          String(order.status).toUpperCase()
        ) &&
        String(order.pair ?? '').toUpperCase() === normalizedPair
      );

      if (openOrders.length === 0) {
        trace.error_code = 'REJECTED';
        trace.error_message =
          `Ingen åpen LIVE trade funnet for ${params.pair}. SELL ble ikke sendt.`;
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      }

      // Vi tillater kun én åpen live trade per bruker.
      const order = openOrders[0];

      if (!order.pionex_order_id) {
        trace.error_code = 'UNKNOWN';
        trace.error_message =
          `LIVE trade for ${params.pair} mangler Pionex order ID. SELL ble ikke sendt.`;
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      }

      const qty = Number(order.filled_qty ?? 0);

      if (!Number.isFinite(qty) || qty <= 0) {
        trace.error_code = 'REJECTED';
        trace.error_message =
          `LIVE trade for ${params.pair} har ugyldig quantity. SELL ble ikke sendt.`;
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      }

      console.log('[MANUAL_SELL] matched open live order', {
        local_id: order.id,
        pionex_order_id: order.pionex_order_id,
        pair: order.pair,
        quantity: qty,
        status: order.status,
      });

      if (dryRunMode) {
        trace.pionex_order_id = order.pionex_order_id;
        trace.order_status = 'NEW';
        trace.pionex_http_status = 'NOT_SENT';
        setManualBuyTrace(trace);

        console.log('[MANUAL_SELL] DRY RUN — no close order sent');

        return trace;
      }

      const provider = exchangeProviderRef.current;

      trace.place_order_called = true;
      trace.pionex_request_sent = true;

      console.log('[MANUAL_SELL] sending closeOrder', {
        order_id: order.pionex_order_id,
        symbol: order.symbol,
        side: 'SELL',
        qty,
        price: params.price,
      });

      const closeOrder = await provider.closeOrder({
        order_id: order.pionex_order_id,
        symbol: order.symbol,
        side: 'SELL',
        qty,
        price: params.price,
        type: 'MARKET',
      });

      trace.pionex_order_id = closeOrder.order_id;
      trace.order_status = closeOrder.status;

      console.log('[MANUAL_SELL] closeOrder response', {
        order_id: closeOrder.order_id,
        status: closeOrder.status,
        filled_qty: closeOrder.filled_qty,
        avg_fill_price: closeOrder.avg_fill_price,
      });

      if (
        closeOrder.status === 'FAILED' ||
        closeOrder.status === 'CANCELLED'
      ) {
        trace.error_code = 'REJECTED';
        trace.error_message =
          `SELL ble avvist: ${closeOrder.status}`;
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      }

      if (closeOrder.status === 'UNKNOWN') {
        trace.error_code = 'UNKNOWN';
        trace.error_message =
          'SELL-status kunne ikke bekreftes. Ingen retry ble sendt.';
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      }

      // Pionex close_order returnerer normalt NEW.
      // Hent derfor faktisk status på selve SELL-ordren.
      //
      // Bruk string her fordi getOrderStatus() kan returnere alle
      // standardiserte OrderStatus-verdier: NEW, PARTIALLY_FILLED,
      // FILLED, CANCELLED, FAILED og UNKNOWN.
      let sellStatus: string = String(closeOrder.status);
      let sellFilledQty = Number(closeOrder.filled_qty ?? 0);
      let sellFillPrice = Number(closeOrder.avg_fill_price ?? 0);

      if (closeOrder.order_id) {
        try {
          const confirmedSell = await provider.getOrderStatus(
            closeOrder.order_id
          );

          sellStatus = confirmedSell.status;
          sellFilledQty = Number(confirmedSell.filled_qty ?? 0);
          sellFillPrice = Number(confirmedSell.avg_fill_price ?? 0);

          trace.order_status = sellStatus;

          console.log('[MANUAL_SELL] confirmed close status', {
            close_order_id: closeOrder.order_id,
            status: sellStatus,
            filled_qty: sellFilledQty,
            avg_fill_price: sellFillPrice,
          });
        } catch (statusError) {
          console.warn(
            '[MANUAL_SELL] could not confirm close order status:',
            statusError
          );
        }
      }

      // Registrer close_order_id uansett.
      if (user?.id) {
        await supabase
          .from('live_orders')
          .update({
            close_order_id: closeOrder.order_id,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id)
          .eq('id', order.id);
      }

      // Kun FILLED gjør at den opprinnelige live-posisjonen faktisk er lukket.
      if (sellStatus === 'FILLED') {
        if (user?.id) {
          await supabase
            .from('live_orders')
            .update({
              status: 'CLOSED',
              filled_qty: sellFilledQty > 0
                ? sellFilledQty
                : qty,
              fill_price: sellFillPrice > 0
                ? sellFillPrice
                : params.price,
              close_order_id: closeOrder.order_id,
              closed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              exit_reason: 'manual_sell',
            })
            .eq('user_id', user.id)
            .eq('id', order.id);
        }

        console.log('[MANUAL_SELL] local live order CLOSED', {
          local_id: order.id,
          close_order_id: closeOrder.order_id,
          filled_qty: sellFilledQty,
          fill_price: sellFillPrice,
        });
      } else if (
        sellStatus === 'FAILED' ||
        sellStatus === 'CANCELLED'
      ) {
        trace.error_code = 'REJECTED';
        trace.error_message =
          `SELL ble ikke gjennomført: ${sellStatus}`;
        setManualBuyTrace(trace);
        throw new Error(trace.error_message);
      } else {
        // NEW / PARTIALLY_FILLED:
        // behold posisjonen som åpen. Ingen blind retry.
        console.log('[MANUAL_SELL] close order still active', {
          close_order_id: closeOrder.order_id,
          status: sellStatus,
        });
      }

      await refreshLiveOrders();

      setManualBuyTrace(trace);
      return trace;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (!trace.error_message) {
        trace.error_code = 'REJECTED';
        trace.error_message = msg;
      }

      console.error('[MANUAL_SELL] failed:', err);

      setManualBuyTrace(trace);
      throw err;
    }
  }, [
    dryRunMode,
    isPionexLive,
    pionexAccountStatus,
    liveOrders,
    refreshLiveOrders,
    user,
  ]);

  /**
   * executeCloseViaProvider — lukker posisjon via Mock execution layer.
   *
   * Brukes av TP/SL-motoren. CLOSED registreres KUN etter bekreftet FILLED.
   * Returnerer faktisk exit price fra execution result.
   */
  const executeCloseViaProvider = useCallback(async (params: {
    order_id: string;
    symbol:   string;
    side:     'BUY' | 'SELL';
    qty:      number;
    price:    number;
  }): Promise<ExecutionResult> => {
    const provider = exchangeProviderRef.current;

    console.log('[EXEC] executeCloseViaProvider closeOrder', params.symbol,
      'side:', params.side, 'qty:', params.qty, 'price:', params.price);

    const order = await provider.closeOrder({
      order_id: params.order_id,
      symbol:   params.symbol,
      side:     params.side,
      qty:      params.qty,
      price:    params.price,
      type:     'MARKET',
    });

    console.log('[EXEC] closeOrder returnerte orderId:', order.order_id,
      'status:', order.status, 'filled_qty:', order.filled_qty,
      'avg_fill_price:', order.avg_fill_price);

    if (order.status === 'FAILED' || order.status === 'CANCELLED') {
      throw new Error(
        `[EXEC] Close-ordre ${order.status} — trade ikke lukket. orderId=${order.order_id}`
      );
    }

    if (order.status === 'UNKNOWN') {
      console.warn('[EXEC] Ukjent close-ordre-status — ingen retry.',
        'orderId:', order.order_id);
      throw new Error(
        `[EXEC] Ukjent close-ordre-status — trade ikke lukket. orderId=${order.order_id}`
      );
    }

    // TP/SL close skal IKKE registreres som CLOSED før hele close-ordren
    // faktisk er FILLED. PARTIALLY_FILLED betyr at posisjonen fortsatt
    // kan være delvis åpen.
    if (order.status !== 'FILLED') {
      console.warn(
        '[EXEC] Close-ordre ikke FILLED — trade forblir åpen.',
        'orderId:', order.order_id,
        'status:', order.status,
        'filled_qty:', order.filled_qty
      );

      throw new Error(
        `[EXEC] Close-ordre ikke FILLED — trade ikke lukket. ` +
        `status=${order.status} orderId=${order.order_id}`
      );
    }

    // ============================================================
    // CONFIRMED FILLED CLOSE
    // ============================================================
    //
    // På dette tidspunktet har PionexExchangeProvider allerede
    // pollet Pionex og bekreftet status=FILLED.
    //
    // Først nå får resten av systemet lov til å registrere
    // posisjonen som CLOSED.
    // ============================================================

    console.log(
      '[EXEC] CONFIRMED FILLED CLOSE',
      {
        order_id: order.order_id,
        symbol: order.symbol,
        side: order.side,
        filled_qty: order.filled_qty,
        avg_fill_price: order.avg_fill_price,
        status: order.status,
        CLOSE_CONFIRMED: true,
      }
    );

    const fillPrice = order.avg_fill_price > 0 ? order.avg_fill_price : params.price;
    const filledQty = order.filled_qty > 0 ? order.filled_qty : params.qty;

    return {
      order_id:         order.order_id,
      fill_price:       fillPrice,
      filled_qty:       filledQty,
      status:           order.status,
      partially_filled: false,
    };
  }, []);

  // ── checkTPSL — TP/SL-motor (plassert etter executeCloseViaProvider) ──
  // Placed here so it can reference executeCloseViaProvider without
  // a "used before declaration" error.
  //
  // If two concurrent safeFetch() intervals both call checkTPSL simultaneously,
  // the second call will find the trade id already in the Set and skip it —
  // guaranteeing exactly one close per trade regardless of concurrency.
  //
  // Direction logic is delegated to evaluateDemoTradeTPSL in lib/demo-trade-utils.
  // Side is determined EXPLICITLY from signal_type (BUY/SELL) and never inferred
  // from buy_price or TP/SL values.
  //
  // Price source: prefer live marketPrices[trade.pair]; fall back to the trade's
  // current_price (last known market price) so an open trade isn't silently skipped
  // if the latest market-data fetch is missing that pair. This prevents the UI
  // showing one price while the TP/SL engine uses none.

  const checkTPSL = useCallback(async (prices: Record<string, MarketData>) => {

    // ================================================================
    // LIVE MODE
    // ================================================================
    //
    // Live Pionex trades live in `live_orders`, not `openTrades`.
    //
    // The existing manual SELL path already contains the correct
    // safety sequence:
    //
    //   live_orders
    //       -> closeOrder()
    //       -> getOrderStatus()
    //       -> FILLED
    //       -> live_orders CLOSED
    //
    // Therefore the demo TP/SL engine MUST NOT touch demo balance,
    // demo history or DemoTrade objects while Pionex LIVE is active.
    //
    // SAFE PHASE:
    // Do not create a second live close implementation here.
    // Do not send a Pionex order from this branch yet.
    //
    if (isPionexLiveRef.current) {

      // ==============================================================
      // LIVE TP/SL — SAFE DETECTION ONLY
      // ==============================================================
      //
      // Denne fasen:
      //
      //   1. Leser live_orders fra databasen.
      //   2. Finner åpne LIVE trades.
      //   3. Leser aktuell markedspris.
      //   4. Kontrollerer TP/SL.
      //   5. Logger triggeren.
      //
      // DENNE FASEN SENDER IKKE closeOrder().
      //
      // Ingen ekte Pionex ordre kan opprettes her.
      // ==============================================================

      if (!user) return;

      try {
        const freshLiveOrders = await getLiveOrders(user.id);

        const openLiveOrders = freshLiveOrders.filter(order =>
          ['NEW', 'FILLED', 'OPEN', 'PARTIALLY_FILLED'].includes(
            String(order.status).toUpperCase()
          )
        );

        for (const liveOrder of openLiveOrders) {

          const liveOrderData = liveOrder as LiveOrder & {
            take_profit?: number;
            stop_loss?: number;
            price?: number;
            signal_type?: 'BUY' | 'SELL';
            qty?: number;
          };

          const pair = String(liveOrder.pair ?? '').toUpperCase();

          const marketPrice = prices[pair]?.price;

          if (!marketPrice || marketPrice <= 0) {
            console.log(
              '[TPSL_LIVE_SKIP] ingen gyldig markedspris',
              {
                pair,
                marketPrice,
                orderId: liveOrder.pionex_order_id,
              }
            );
            continue;
          }

          const takeProfit = Number(
            liveOrder.take_profit ?? 0
          );

          const stopLoss = Number(
            liveOrder.stop_loss ?? 0
          );

          const entryPrice = Number(
            liveOrder.fill_price ??
            liveOrder.fill_price ??
            0
          );

          const signalType =
            String(
              liveOrder.signal_type ??
              liveOrder.side ??
              'BUY'
            ).toUpperCase();

          const isShort =
            signalType === 'SELL';

          let tpTriggered = false;
          let slTriggered = false;

          if (isShort) {

            if (
              takeProfit > 0 &&
              marketPrice <= takeProfit
            ) {
              tpTriggered = true;
            }

            if (
              stopLoss > 0 &&
              marketPrice >= stopLoss
            ) {
              slTriggered = true;
            }

          } else {

            if (
              takeProfit > 0 &&
              marketPrice >= takeProfit
            ) {
              tpTriggered = true;
            }

            if (
              stopLoss > 0 &&
              marketPrice <= stopLoss
            ) {
              slTriggered = true;
            }
          }

          if (!tpTriggered && !slTriggered) {
            continue;
          }

          const reason = tpTriggered
            ? 'take_profit'
            : 'stop_loss';

          console.warn(
            '[TPSL_LIVE_TRIGGER_SAFE]',
            {
              local_id: liveOrder.id,
              pionex_order_id: liveOrder.pionex_order_id,
              pair,
              signalType,
              entryPrice,
              marketPrice,
              takeProfit,
              stopLoss,
              reason,

              // IMPORTANT:
              // This must remain false until the real close
              // execution path is explicitly enabled.
              CLOSE_ORDER_SENT: false,
              REAL_PIONEX_ORDER_CREATED: false,
            }
          );

          // ==============================================================
          // LIVE TP/SL PRE-CLOSE VERIFICATION — SAFE ONLY
          // ==============================================================
          //
          // Verify the actual Pionex entry order before any close
          // implementation is allowed to run.
          //
          // This phase:
          //   1. Reads the real Pionex order status.
          //   2. Does NOT send closeOrder().
          //   3. Does NOT modify live_orders.
          //   4. Does NOT create a Pionex TP/SL order.
          //
          // If the original entry is no longer FILLED/OPEN, we abort.
          // ==============================================================

          if (!liveOrder.pionex_order_id) {
            console.warn(
              '[TPSL_LIVE_PRE_CLOSE_SAFE] Missing Pionex order ID — abort.',
              {
                local_id: liveOrder.id,
                pair,
              }
            );
            continue;
          }

          try {
            const provider = exchangeProviderRef.current;

            const entryStatus = await provider.getOrderStatus(
              liveOrder.pionex_order_id
            );

            console.log(
              '[TPSL_LIVE_PRE_CLOSE_SAFE]',
              {
                local_id: liveOrder.id,
                pionex_order_id: liveOrder.pionex_order_id,
                pair,
                reason,
                entry_status: entryStatus.status,
                filled_qty: entryStatus.filled_qty,
                avg_fill_price: entryStatus.avg_fill_price,

                // HARD SAFETY FLAGS
                CLOSE_ORDER_SENT: false,
                REAL_PIONEX_ORDER_CREATED: false,
              }
            );

            const status = String(entryStatus.status).toUpperCase();

            if (
              status === 'FAILED' ||
              status === 'CANCELLED' ||
              status === 'UNKNOWN'
            ) {
              console.warn(
                '[TPSL_LIVE_PRE_CLOSE_SAFE] Entry not safely closable.',
                {
                  pionex_order_id: liveOrder.pionex_order_id,
                  status,
                }
              );
              continue;
            }

            if (status !== 'FILLED' && status !== 'OPEN') {
              console.warn(
                '[TPSL_LIVE_PRE_CLOSE_SAFE] Unexpected entry status — abort.',
                {
                  pionex_order_id: liveOrder.pionex_order_id,
                  status,
                }
              );
              continue;
            }

            // Final SAFE marker.
            // No close order is sent in this phase.
            console.log(
              '[TPSL_LIVE_PRE_CLOSE_READY]',
              {
                local_id: liveOrder.id,
                pionex_order_id: liveOrder.pionex_order_id,
                pair,
                signalType,
                reason,
                marketPrice,
                entry_status: status,
                close_ready: true,

                // MUST remain false.
                CLOSE_ORDER_SENT: false,
                REAL_PIONEX_ORDER_CREATED: false,
              }
            );

            // ============================================================
            // LIVE TP/SL CLOSE GATE
            // ============================================================
            //
            // TP/SL følger eksisterende Pionex LIVE-status.
            // Når LIVE er aktiv, kan triggeren bruke den eksisterende
            // executeCloseViaProvider()-kjeden.
            //
            // Serverens live_trading_enabled-gate er fortsatt siste
            // kontroll før en ekte Pionex close-order sendes.
            // ============================================================

            const LIVE_TPSL_CLOSE_ENABLED = isPionexLiveRef.current;

            const closeSide: 'BUY' | 'SELL' =
              signalType === 'SELL'
                ? 'BUY'
                : 'SELL';

            const closeQty =
              Number(liveOrder.filled_qty ?? 0) > 0
                ? Number(liveOrder.filled_qty)
                : Number(liveOrder.quantity ?? 0);

            console.log(
              '[TPSL_LIVE_CLOSE_GATE]',
              {
                local_id: liveOrder.id,
                pionex_order_id: liveOrder.pionex_order_id,
                pair,
                signalType,
                reason,
                marketPrice,
                closeSide,
                closeQty,

                LIVE_TPSL_CLOSE_ENABLED,
                CLOSE_ORDER_SENT: false,
                REAL_PIONEX_ORDER_CREATED: false,
              }
            );

            if (!LIVE_TPSL_CLOSE_ENABLED) {
              console.log(
                '[TPSL_LIVE_CLOSE_BLOCKED_SAFE]',
                {
                  reason: 'live_tpsl_close_disabled',
                  local_id: liveOrder.id,
                  pionex_order_id: liveOrder.pionex_order_id,
                  closeSide,
                  closeQty,

                  CLOSE_ORDER_SENT: false,
                  REAL_PIONEX_ORDER_CREATED: false,
                }
              );

              continue;
            }

            // ============================================================
            // LIVE TPSL CLOSE REQUEST — PREPARED ONLY
            // ============================================================
            //
            // Denne blokken følger eksisterende Pionex LIVE-status.
            //
            // Den skal bruke den eksisterende
            // executeCloseViaProvider()-kjeden.
            //
            // Ingen direkte Pionex API-kall.
            // Ingen ny close-motor.
            //
            // SAFETY:
            // LIVE_TPSL_CLOSE_ENABLED følger eksisterende Pionex LIVE-status.
            // Derfor kan denne requesten ikke nås nå.
            // ============================================================

            // ============================================================
            // HARD LIVE CLOSE VALIDATION
            // ============================================================
            //
            // Før en eventuell fremtidig close kan sendes må følgende
            // være sant:
            //
            // 1. Pionex order ID finnes.
            // 2. Canonical Futures-symbol finnes.
            // 3. Filled quantity er > 0.
            // 4. Close-side er BUY eller SELL.
            // 5. Entry-status er verifisert ovenfor.
            //
            // Dette sender INGEN ordre.
            // ============================================================

            if (!liveOrder.pionex_order_id) {
              console.warn(
                '[TPSL_LIVE_CLOSE_VALIDATION_FAILED]',
                'Missing Pionex order ID.'
              );
              continue;
            }

            const canonicalCloseSymbol =
              String(liveOrder.symbol ?? '').trim().toUpperCase();

            if (!canonicalCloseSymbol) {
              console.warn(
                '[TPSL_LIVE_CLOSE_VALIDATION_FAILED]',
                'Missing canonical Pionex Futures symbol.',
                {
                  local_id: liveOrder.id,
                  pair,
                }
              );
              continue;
            }

            if (closeQty <= 0 || !Number.isFinite(closeQty)) {
              console.warn(
                '[TPSL_LIVE_CLOSE_VALIDATION_FAILED]',
                'Invalid close quantity.',
                {
                  local_id: liveOrder.id,
                  closeQty,
                }
              );
              continue;
            }

            if (closeSide !== 'BUY' && closeSide !== 'SELL') {
              console.warn(
                '[TPSL_LIVE_CLOSE_VALIDATION_FAILED]',
                'Invalid close side.',
                {
                  local_id: liveOrder.id,
                  closeSide,
                }
              );
              continue;
            }

            const preparedCloseRequest = {
              order_id: liveOrder.pionex_order_id,
              symbol: canonicalCloseSymbol,
              side: closeSide,
              qty: closeQty,
              price: marketPrice,
            };

            console.log(
              '[TPSL_LIVE_CLOSE_VALIDATED]',
              {
                local_id: liveOrder.id,
                order_id: preparedCloseRequest.order_id,
                symbol: preparedCloseRequest.symbol,
                side: preparedCloseRequest.side,
                qty: preparedCloseRequest.qty,
                reason,

                // Hard safety markers.
                CLOSE_ORDER_SENT: false,
                REAL_PIONEX_ORDER_CREATED: false,
              }
            );

            console.log(
              '[TPSL_LIVE_CLOSE_REQUEST_PREPARED]',
              {
                ...preparedCloseRequest,
                reason,

                // Hard safety markers.
                CLOSE_ORDER_SENT: false,
                REAL_PIONEX_ORDER_CREATED: false,
              }
            );

            // Close-requesten sendes gjennom den eksisterende
            // executeCloseViaProvider()-kjeden.
            // ============================================================
            // APP-SIDE LIVE TP/SL EXECUTION
            // ============================================================
            //
            // B-ARCHITECTURE:
            // TradeMindMZ watches live Pionex market prices.
            // When TP/SL triggers, the existing close execution layer
            // sends a USDT-M MARKET_QTY reduce-only close via the proxy.
            //
            // IMPORTANT:
            // - No direct Pionex API call from TradingContext.
            // - No automatic retry.
            // - Only FILLED closes the local live order.
            // - If the app is not running, this monitor is not active.
            // ============================================================

            if (liveClosingOrdersRef.current.has(liveOrder.id)) {
              console.log(
                '[TPSL_LIVE_CLOSE_SKIPPED_DUPLICATE]',
                {
                  local_id: liveOrder.id,
                  pionex_order_id: liveOrder.pionex_order_id,
                }
              );

              continue;
            }

            if (!closeQty || closeQty <= 0) {
              console.warn(
                '[TPSL_LIVE_CLOSE_BLOCKED]',
                {
                  reason: 'invalid_close_quantity',
                  local_id: liveOrder.id,
                  closeQty,
                }
              );

              continue;
            }

            liveClosingOrdersRef.current.add(liveOrder.id);

            try {
              console.log(
                '[TPSL_LIVE_CLOSE_EXECUTION_STARTED]',
                {
                  local_id: liveOrder.id,
                  pionex_order_id: liveOrder.pionex_order_id,
                  symbol: canonicalCloseSymbol,
                  side: closeSide,
                  qty: closeQty,
                  price: marketPrice,
                  reason,
                  CLOSE_ORDER_SENT: true,
                }
              );

              const closeResult = await executeCloseViaProvider(
                preparedCloseRequest
              );

              if (closeResult.status !== 'FILLED') {
                console.warn(
                  '[TPSL_LIVE_CLOSE_NOT_FILLED]',
                  {
                    local_id: liveOrder.id,
                    pionex_order_id: liveOrder.pionex_order_id,
                    status: closeResult.status,
                    filled_qty: closeResult.filled_qty,
                  }
                );

                continue;
              }

              const closedAt = new Date().toISOString();

              const { error: localCloseError } = await supabase
                .from('live_orders')
                .update({
                  status: 'CLOSED',
                  close_order_id: closeResult.order_id,
                  exit_price: closeResult.fill_price,
                  closed_at: closedAt,
                  updated_at: closedAt,
                })
                .eq('user_id', user.id)
                .eq('id', liveOrder.id);

              if (localCloseError) {
                console.error(
                  '[TPSL_LIVE_CLOSE_LOCAL_UPDATE_ERROR]',
                  localCloseError
                );
              } else {
                console.log(
                  '[TPSL_LIVE_CLOSE_CONFIRMED]',
                  {
                    local_id: liveOrder.id,
                    pionex_order_id: liveOrder.pionex_order_id,
                    close_order_id: closeResult.order_id,
                    exit_price: closeResult.fill_price,
                    filled_qty: closeResult.filled_qty,
                    status: closeResult.status,
                    CLOSED: true,
                  }
                );
              }

            } catch (liveCloseError) {
              console.error(
                '[TPSL_LIVE_CLOSE_EXECUTION_ERROR]',
                liveCloseError
              );
            } finally {
              liveClosingOrdersRef.current.delete(liveOrder.id);
            }
          } catch (preCloseError) {
            console.error(
              '[TPSL_LIVE_PRE_CLOSE_SAFE_ERROR]',
              preCloseError
            );
          }
        }

      } catch (liveTpslError) {

        console.error(
          '[TPSL_LIVE_SAFE_ERROR]',
          liveTpslError
        );
      }

      return;
    }

    // ================================================================
    // DEMO MODE
    // ================================================================

    const trades  = openTradesRef.current;
    const account = demoAccountRef.current;

    if (!user || !account) return;

    for (const trade of trades) {
      if (trade.status !== 'open') continue;

      // ── Idempotency lock — skip if close already in-flight ──────────
      if (closingTradesRef.current.has(trade.id)) continue;

      // Prefer live market price; fall back to trade.current_price (kept in sync
      // with marketPrices by the P/L useEffect) so TP/SL and UI use the same value.
      const marketPrice = prices[trade.pair]?.price;
      const price = marketPrice ?? trade.current_price ?? trade.buy_price;
      if (!price || price <= 0) {
        console.log(`[DEMO_TRADE_SKIP] ${trade.pair} no usable price (market=${marketPrice}, current=${trade.current_price})`);
        continue;
      }

      const { triggered, reason, side } = evaluateDemoTradeTPSL(trade, price);
      console.log(formatDemoTradeCheck(trade, price, { triggered, reason, side }));

      if (!triggered || !reason) continue;

      // ── Acquire close-lock before first await ────────────────────────
      closingTradesRef.current.add(trade.id);

      try {
        // ── FASE 2: Bekreft CLOSED via execution provider ─────────────
        // closeOrder() → FILLED → hent faktisk exit price.
        // Ikke marker CLOSED hvis close-execution feiler.
        const closeSide: 'BUY' | 'SELL' =
          (trade.signal_type === 'SELL') ? 'BUY' : 'SELL';

        let exitPrice = price;
        try {
          const closeResult = await executeCloseViaProvider({
            order_id: trade.id,
            symbol:   trade.symbol,
            side:     closeSide,
            qty:      trade.quantity,
            price,
          });
          exitPrice = closeResult.fill_price;
          console.log('[TPSL_EXEC] close FILLED orderId:', closeResult.order_id,
            'exitPrice:', exitPrice, 'filledQty:', closeResult.filled_qty,
            'pair:', trade.pair, 'reason:', reason);
        } catch (closeErr) {
          // Execution feilet — ikke registrer CLOSED
          console.error('[TPSL_EXEC] close execution feilet — hopper over CLOSED',
            trade.pair, closeErr instanceof Error ? closeErr.message : closeErr);
          closingTradesRef.current.delete(trade.id);
          continue;
        }

        const finalValue = exitPrice * trade.quantity;
        const pnl    = finalValue - trade.investment;
        const pnlPct = (pnl / trade.investment) * 100;

        await closeDemoTrade(trade.id);
        await recordTradeHistory({
          symbol: trade.symbol, pair: trade.pair, coin_name: trade.coin_name,
          buy_price: trade.buy_price, sell_price: exitPrice, quantity: trade.quantity,
          investment: trade.investment, final_value: finalValue, profit_loss: pnl,
          profit_loss_pct: pnlPct, stop_loss: trade.stop_loss ?? undefined,
          take_profit: trade.take_profit ?? undefined, signal_id: trade.signal_id ?? undefined,
          ai_confidence: trade.ai_confidence ?? undefined, exit_reason: reason,
          opened_at: trade.opened_at,
        });

        // Refresh balance from DB ref (account state may be stale across awaits)
        const latestBalance = demoAccountRef.current?.balance ?? account.balance;
        const newBalance = latestBalance + finalValue;
        await updateDemoBalance(user.id, newBalance);
        setDemoAccount(prev => prev ? { ...prev, balance: newBalance } : prev);

        // Remove from open trades immediately so the UI updates without waiting for a poll
        setOpenTrades(prev => prev.filter(t => t.id !== trade.id));
        // Also remove from the ref so subsequent checkTPSL calls in this same interval skip it
        openTradesRef.current = openTradesRef.current.filter(t => t.id !== trade.id);

        const newHistory = await getDemoTradeHistory(user.id);
        setTradeHistory(newHistory);

        console.log(`[TRADE_CLOSED] ${trade.pair} side=${side} reason=${reason} exitPrice=${exitPrice} pnl=${pnl.toFixed(4)} USDT (${pnlPct.toFixed(2)}%)`);

        // FASE 3: structured live log + firstLiveTradeDone guard
        if (isPionexLiveRef.current) {
          console.log('[LIVE_TRADE_CLOSED]', {
            tradeId:     trade.id,
            pair:        trade.pair,
            side,
            reason,
            entryPrice:  trade.buy_price,
            exitPrice,
            filledQty:   trade.quantity,
            investment:  trade.investment,
            finalValue,
            pnl:         parseFloat(pnl.toFixed(6)),
            pnlPct:      parseFloat(pnlPct.toFixed(4)),
            signal_id:   trade.signal_id ?? null,
            openedAt:    trade.opened_at,
            closedAt:    new Date().toISOString(),
          });
          // FASE 3 rule: stop Auto Trader for new entries after first complete live trade
          setFirstLiveTradeDone(true);
          setAutoTraderEnabled(false);
          setAutoTraderLastAction(
            `🔴 FASE 3: Første live trade LUKKET. ${reason.toUpperCase()} @ $${exitPrice.toLocaleString()} ` +
            `P/L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDT (${pnlPct.toFixed(2)}%). ` +
            'Auto Trader stoppet — rapporter resultat.'
          );
          toast.success(`🔴 LIVE TRADE LUKKET: ${reason.toUpperCase()} ${trade.pair} P/L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDT`);
        }
      } catch (err) {
        console.error(`[TPSL_ERROR] Failed to close trade ${trade.id}:`, err);
      } finally {
        // Always release close-lock so the trade can be retried on next poll if close failed
        closingTradesRef.current.delete(trade.id);
      }
    }
  }, [user, executeCloseViaProvider, setFirstLiveTradeDone, setAutoTraderEnabled, setAutoTraderLastAction]);

  // Assign checkTPSL ref here — after its declaration — so the stable-ref
  // sync block above can omit it without a "used before declaration" error.
  checkTPSLRef.current = checkTPSL;

  // ── Demo trade actions (never touch Pionex) ───────────────────────────

  const executeDemoBuy = useCallback(async (trade: {
    symbol: string; pair: string; coin_name: string; buy_price: number;
    investment: number; stop_loss?: number; take_profit?: number;
    signal_id?: string; signal_type?: 'BUY' | 'SELL'; ai_confidence?: number;
  }) => {
    if (!user || !demoAccount) {
      console.error('[DEMO_BUY_BLOCKED]', {
        reason: 'missing_user_or_demo_account',
        hasUser: !!user,
        hasDemoAccount: !!demoAccount,
      });
      throw new Error('Not authenticated');
    }

    const investment = Number(trade.investment);
    const currentBalance = Number(demoAccount.balance);

    if (!Number.isFinite(investment) || investment <= 0) {
      throw new Error('Invalid demo investment amount');
    }

    if (!Number.isFinite(currentBalance) || currentBalance < 0) {
      throw new Error('Invalid demo account balance');
    }

    if (investment > currentBalance) {
      throw new Error('Insufficient demo balance');
    }

    if (!Number.isFinite(trade.buy_price) || trade.buy_price <= 0) {
      throw new Error('Invalid demo market price');
    }

    const quantity = investment / trade.buy_price;
    const newBalance = currentBalance - investment;

    try {
      // Reserve the demo balance first. This prevents the UI/database
      // from showing a successful trade while the balance update fails.
      await updateDemoBalance(user.id, newBalance);

      try {
        await openDemoTrade({ ...trade, investment, quantity });
      } catch (e) {
        // Roll back the balance if creating the demo trade fails.
        try {
          await updateDemoBalance(user.id, currentBalance);
        } catch (rollbackError) {
          console.error('[DEMO_BALANCE_ROLLBACK_FAILED]', rollbackError);
        }

        // Preserve the real database error. Do not translate unrelated
        // UNIQUE/CONSTRAINT errors into a misleading open-trade conflict.
        throw e;
      }

      setDemoAccount(prev =>
        prev ? { ...prev, balance: newBalance } : prev
      );

      const updated = await getOpenDemoTrades(user.id);

      // Keep refs synchronized before React re-renders.
      openTradesRef.current = updated;
      setOpenTrades(updated);

      return updated.find(
        t => t.pair === trade.pair && t.signal_id === trade.signal_id
      ) ?? null;
    } catch (e) {
      console.error('[DEMO_BUY_FAILED]', e);
      throw e;
    }
  }, [user, demoAccount]);

  // ── Auto Trader: scheduler-triggered entry evaluation ─────────────────
  // This lives in TradingContext so it keeps running even when the
  // AIAutoTraderPanel component is unmounted (tab switch).
  const runAutoTraderEntry = useCallback(async (completedAt: string) => {
    const now = () => new Date().toISOString();
    // Guard 1 — disabled or no user
    if (!autoTraderEnabled) {
      setAutoTradeTrace({ mode: 'auto', timestamp: now(), triggered: false, preflight: null, place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT', dry_run: dryRunMode, error_message: 'Auto Trader disabled' });
      return;
    }
    if (!user) {
      setAutoTradeTrace({ mode: 'auto', timestamp: now(), triggered: false, preflight: null, place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT', dry_run: dryRunMode, error_message: 'No authenticated user' });
      return;
    }

    // Guard 2 — entry lock must be acquired BEFORE any open-trade check and BEFORE any async call
    if (autoTraderEntryLockRef.current) {
      setAutoTradeTrace({ mode: 'auto', timestamp: now(), triggered: true, preflight: null, place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT', dry_run: dryRunMode, error_message: 'Entry lock active' });
      console.log('ENTRY_BLOCKED', { reason: 'entry_lock_active', completedAt });
      return;
    }
    autoTraderEntryLockRef.current = true;
    console.log('ENTRY_LOCK_ACQUIRED', { completedAt });

    try {
      // Guard 3 — live trading keeps its one-open-order safety rule.
      // Demo trading intentionally allows multiple simultaneous open trades.
      const isLive = isPionexLiveRef.current;
      const liveOpenCount = liveOrders.filter(o => ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(o.status)).length;
      if (isLive) {
        if (liveOpenCount > 0) {
          setAutoTraderLastAction(`Venter på at eksisterende live-trade lukkes — Scheduler-entry blokkert.`);
          setAutoTradeTrace({ mode: 'auto', timestamp: now(), triggered: true, preflight: null, place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT', dry_run: dryRunMode, error_message: 'Open live trade exists' });
          console.log('ENTRY_BLOCKED', { reason: 'open_live_trade_exists', liveOpenCount });
          return;
        }
      }

      // Scan for BEST CURRENT SETUP and BEST OVERALL SCORE from the same
      // scoring/sorting as Recommended. BEST CURRENT SETUP is the highest-ranked
      // FRESH Recommended signal; BEST OVERALL SCORE is the top Recommended
      // signal regardless of freshness. Auto Trader uses BEST CURRENT SETUP.
      //
      // Canonical scoring: read from refs (not closed-over state) so Auto Trader
      // always uses the same freshly-loaded signals + history that the UI sees.
      setAutoTraderLastAction('Søker BEST CURRENT SETUP fra Recommended...');

    const tradable = liveSignalsRef.current.filter(s => s.signal_type === 'BUY' || s.signal_type === 'SELL');
    const scored = computeLiveSignalScores(tradable, signalHistoryRef.current, signalsCacheRef.current?.reset_at);
    const recommended = scored.filter(x => x.tier === 'RECOMMENDED');

    const bestOverall = recommended[0] ?? null;
    const bestSetup = recommended.find(x => x.freshnessLabel === 'FRESH') ?? null;

    // Always expose both to the UI so the user sees exactly what Auto Trader sees
    setAutoTraderBestOverallScore(bestOverall);
    setAutoTraderBestSetup(bestSetup);
    setAutoTraderSelectedSignal(bestSetup);

    // Runtime logging for the signal pool that Auto Trader just evaluated
    console.log('SIGNAL_FRESHNESS_POOL', {
      completedAt,
      evaluatedCount: scored.length,
      recommended: recommended.map(r => ({
        symbol: r.signal.symbol,
        pair: r.signal.pair,
        generatedAt: r.signal.generated_at,
        now: Date.now(),
        ageMs: r.signalAgeMs,
        ageMinutes: Math.round(r.signalAgeMs / 60_000),
        freshnessLabel: r.freshnessLabel,
        tradeable: r.freshnessLabel === 'FRESH' && (r.signal.signal_type === 'BUY' || r.signal.signal_type === 'SELL'),
        currentScore: r.currentScore,
      })),
      bestCurrentSetup: bestSetup ? {
        symbol: bestSetup.signal.symbol,
        pair: bestSetup.signal.pair,
        freshnessLabel: bestSetup.freshnessLabel,
        ageMinutes: Math.round(bestSetup.signalAgeMs / 60_000),
        currentScore: bestSetup.currentScore,
      } : null,
      bestOverallScore: bestOverall ? {
        symbol: bestOverall.signal.symbol,
        pair: bestOverall.signal.pair,
        freshnessLabel: bestOverall.freshnessLabel,
        ageMinutes: Math.round(bestOverall.signalAgeMs / 60_000),
        currentScore: bestOverall.currentScore,
      } : null,
    });

    // No qualifying signals at all
    if (!bestOverall) {
      setAutoTraderLastAction('Ingen kvalifiserte signaler etter siste analyse. Venter paa neste Scheduler-run.');
      setAutoTradeTrace({ mode: 'auto', timestamp: now(), triggered: true, preflight: null, place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT', dry_run: dryRunMode, error_message: 'No RECOMMENDED signals found' });
      console.log('ENTRY_WAIT', { reason: 'no_recommended_signals', completedAt });
      return;
    }

    // No FRESH Recommended signal -> WAIT, but stay enabled/idle
    if (!bestSetup) {
      setAutoTraderLastAction(
        `BEST OVERALL SCORE ${bestOverall.signal.pair} er ${bestOverall.freshnessLabel} (${fmtSignalAge(bestOverall.signalAgeMs)}). ` +
        'Ingen FRESH BEST CURRENT SETUP. Venter paa neste Scheduler-analyse.'
      );
      setAutoTradeTrace({
        mode: 'auto', timestamp: now(), triggered: true,
        preflight: {
          all_pass: false,
          gates: [
            { name: 'Signal selection', pass: false, detail: `bestOverall=${bestOverall.signal.pair}, freshness=${bestOverall.freshnessLabel}` },
          ],
          error_message: 'No FRESH RECOMMENDED signal found',
          symbol: bestOverall.signal.pair,  // UI pair — no Pionex lookup needed (trace only, no order)
          side: (bestOverall.signal.signal_type === 'SELL' ? 'SELL' : 'BUY'),
          pair: bestOverall.signal.pair,
          price: bestOverall.signal.current_price,
          investment_raw: 0, investment_final: 0, quantity_raw: 0, quantity_final: 0,
          amount_usdt_final: 0,
          base_precision: 0, min_order_value: 0, min_trade_amount: 0, estimated_fee: 0, estimated_total: 0,
          pionex_request: 'NOT_SENT',
        },
        place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT', dry_run: dryRunMode,
        error_message: 'No FRESH RECOMMENDED signal found',
      });
      console.log('ENTRY_WAIT', {
        reason: 'no_fresh_best_current_setup',
        bestOverallScore: bestOverall.signal.pair,
        freshnessLabel: bestOverall.freshnessLabel,
        ageMinutes: Math.round(bestOverall.signalAgeMs / 60_000),
      });
      return;
    }

    const sig = bestSetup.signal;

    // Guard 4: balance + investment calculation
    // LIVE: use the actual available USDT balance from the connected Pionex provider.
    // DEMO: use the local demo account balance.
    // No artificial 5/8/100 USDT cap here. Pionex market rules,
    // minimum order value, precision and available balance are enforced downstream.
    let balance = 0;

    if (isLive) {
      const liveBalance = await exchangeProviderRef.current.getBalance();
      balance = liveBalance.usdt_available;
    } else {
      balance = demoAccountRef.current?.balance ?? 0;
    }

    if (!Number.isFinite(balance) || balance <= 0) {
      setAutoTraderLastAction('Auto Trader blokkert: ingen tilgjengelig USDT-saldo.');
      setAutoTradeTrace({
        mode: 'auto', timestamp: now(), signal_id: sig.id, pair: sig.pair,
        triggered: true, preflight: null,
        place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT',
        dry_run: dryRunMode, error_message: 'No available USDT balance.',
      });
      console.log('ENTRY_BLOCKED', {
        reason: 'no_available_usdt',
        pair: sig.pair,
        balance,
        isLive,
      });
      return;
    }

    const invest = balance * AUTO_TRADER_INVESTMENT_PCT;

    // FASE 3 guard: first live trade done → block new live entries
    if (isLive && firstLiveTradeDone) {
      setAutoTraderLastAction('FASE 3: Første ekte trade er fullført. Auto Trader stoppet for nye live-entries. Rapporter resultat.');
      console.log('ENTRY_BLOCKED', { reason: 'first_live_trade_done', pair: sig.pair });
      setAutoTradeTrace({
        mode: 'auto', timestamp: now(), signal_id: sig.id, pair: sig.pair,
        triggered: true, preflight: null,
        place_order_called: false, pionex_request_sent: false, pionex_http_status: 'NOT_SENT',
        dry_run: dryRunMode, error_message: 'Auto Trader stopped: first live trade already completed.',
      });
      return;
    }

    if (!isLive && (invest < 5 || balance < 5)) {
      setAutoTraderLastAction('Utilstrekkelig demo-saldo (< $5).');
      console.log('ENTRY_BLOCKED', { reason: 'insufficient_balance', balance });
      return;
    }

    const modeLabel = isLive ? '🔴 LIVE' : '🔵 DEMO';
    setAutoTraderLastAction(`${modeLabel}: Forsoker aa apne ${sig.signal_type} ${sig.pair} - Score=${bestSetup.currentScore} - ${bestSetup.freshnessLabel}`);

    // Double-check stop / disabled after synchronous gap
    if (!autoTraderEnabled) {
      setAutoTraderLastAction('Auto Trader stoppet like foer entry - avbryter.');
      console.log('ENTRY_ABORT', { reason: 'auto_trader_disabled', pair: sig.pair });
      return;
    }
    // Double-check no trade appeared while we were scanning
    if (isLive) {
      const currentLiveOpen = liveOrders.filter(o => ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(o.status));
      if (currentLiveOpen.length > 0) {
        setAutoTraderLastAction(`Live trade allerede aapen (${currentLiveOpen[0].pair}) - hopper over entry.`);
        console.log('ENTRY_BLOCKED', { reason: 'open_live_trade_appeared', pair: currentLiveOpen[0].pair });
        return;
      }
    }

    console.log(isLive ? '[LIVE_ENTRY_REQUEST]' : 'ENTRY_OPENING', {
      mode:          isLive ? 'LIVE' : 'DEMO',
      pair:          sig.pair,
      symbol:        sig.symbol,
      signalType:    sig.signal_type,
      signal_id:     sig.id,
      score:         bestSetup.currentScore,
      freshnessLabel: bestSetup.freshnessLabel,
      ageMinutes:    Math.round(bestSetup.signalAgeMs / 60_000),
      investment:    invest,
      takeProfit:    sig.take_profit_1,
      stopLoss:      sig.stop_loss,
      maxLiveUsdt:   null,
      dryRun:        dryRunMode,
    });

    const side: 'BUY' | 'SELL' = (sig.signal_type === 'SELL') ? 'SELL' : 'BUY';

    if (isLive) {
      // ── LIVE: shared executeLiveOrder path (same as Manual Buy) ─────────
      // In dry-run mode, this runs all gates and returns a trace without sending to Pionex.
      let trace: LiveOrderTrace;
      try {
        trace = await executeLiveOrder({
          pair: sig.pair,
          side,
          price: sig.current_price,
          investment: invest,
          signal_id: sig.id,
          mode: 'auto',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setAutoTraderLastAction(`Live ordre ikke sendt: ${msg}`);
        console.log('ENTRY_EXEC_FAILED', { reason: msg, pair: sig.pair, mode: 'LIVE', dryRun: dryRunMode });
        toast.error(`Auto Trader: ${msg}`);
        return;
      }

      if (dryRunMode) {
        setAutoTraderLastAction(`DRY RUN: ${sig.pair} klar for live kjøp — Pionex request NOT SENT.`);
        console.log('ENTRY_DRY_RUN', { pair: sig.pair, trace });
        return;
      }

      if (!trace.preflight?.all_pass || trace.error_code) {
        const msg = trace.error_message ?? 'Preflight failed';
        setAutoTraderLastAction(`Live ordre blokkert: ${msg}`);
        console.log('ENTRY_EXEC_FAILED', { reason: msg, pair: sig.pair, mode: 'LIVE' });
        toast.error(`Auto Trader: ${msg}`);
        return;
      }

      const orderId = trace.pionex_order_id ?? 'unknown';
      const fillPrice = trace.preflight?.price ?? sig.current_price;
      const actualInvest = trace.preflight?.investment_final ?? invest;
      setAutoTraderLastAction(`🔴 LIVE TRADE ÅPNET: ${sig.signal_type} ${sig.pair} — order ${orderId}`);
      console.log('[LIVE_TRADE_OPEN]', {
        tradeId:    null,
        orderId,
        pair:       sig.pair,
        side,
        signal_id:  sig.id,
        fillPrice,
        investment: actualInvest,
        takeProfit: sig.take_profit_1,
        stopLoss:   sig.stop_loss,
      });
      toast.success(`🔴 LIVE TRADE ÅPNET: ${sig.signal_type} ${sig.pair} — order ${orderId}`);
      setAutoTraderTotalTrades(prev => prev + 1);
      return;
    }

    // ── DEMO: keep existing mock/demo flow (unchanged) ─────────────────
    // Demo mode uses MockExchangeProvider which accepts any symbol string;
    // strip "/" for legacy compatibility with the mock only.
    const qty = invest / sig.current_price;
    const orderSymbol = sig.pair.replace('/', '');

    let execResult: ExecutionResult;
    try {
      execResult = await executeViaProvider({
        symbol: orderSymbol,
        side,
        qty,
        price: sig.current_price,
        signal_id: sig.id,
      });
    } catch (execErr) {
      if (execErr instanceof OrderBlockedError) {
        console.log('ENTRY_BLOCKED', { reason: execErr.reason, code: execErr.code, pair: sig.pair });
        setAutoTraderLastAction(`Execution blokkert: ${execErr.reason}`);
        toast.error(`Auto Trader: ordre blokkert — ${execErr.reason}`);
        return;
      }
      const msg = execErr instanceof Error ? execErr.message : String(execErr);
      console.log('ENTRY_EXEC_FAILED', { reason: msg, pair: sig.pair, mode: 'DEMO' });
      setAutoTraderLastAction(`Ordre ikke fylt: ${msg}`);
      toast.error(`Auto Trader: ordre ikke fylt — ${msg}`);
      return;
    }

    console.log('ENTRY_EXEC_FILLED', {
      orderId:   execResult.order_id,
      fillPrice: execResult.fill_price,
      filledQty: execResult.filled_qty,
      status:    execResult.status,
      partial:   execResult.partially_filled,
      pair:      sig.pair,
    });

    const fillPrice    = execResult.fill_price;
    const filledQty    = execResult.filled_qty;
    const actualInvest = fillPrice * filledQty;

    const newTrade = await executeDemoBuy({
      symbol:        sig.symbol,
      pair:          sig.pair,
      coin_name:     sig.coin_name,
      buy_price:     fillPrice,
      investment:    actualInvest,
      stop_loss:     sig.stop_loss ?? undefined,
      take_profit:   sig.take_profit_1 ?? undefined,
      signal_id:     sig.id,
      signal_type:   side,
      ai_confidence: sig.confidence,
    });

    const newTradeId = newTrade?.id ?? null;
    setAutoTraderTradeId(newTradeId);
    setAutoTraderTotalTrades(prev => prev + 1);
    const openedMsg = `Apnet ${sig.signal_type} ${sig.pair} @ $${sig.current_price.toLocaleString()} - ${invest.toFixed(2)} USDT`;
    setAutoTraderLastAction(openedMsg);
    console.log('ENTRY_OPENED', { tradeId: newTradeId, pair: sig.pair, signalType: sig.signal_type, investment: invest });
    toast.success(`Auto Trader: Apnet ${sig.signal_type} ${sig.pair}`);
  } catch (e) {
    setAutoTraderLastAction(`Feil ved aapning: ${e instanceof Error ? e.message : String(e)}`);
    console.log('ENTRY_ERROR', { error: e instanceof Error ? e.message : String(e), completedAt });
    toast.error(`Auto Trader entry-feil: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    autoTraderEntryLockRef.current = false;
    console.log('ENTRY_LOCK_RELEASED', { completedAt });
  }
  // liveSignals/signalHistory/signalsCache.reset_at removed from deps:
  // runAutoTraderEntry now reads them via liveSignalsRef/signalHistoryRef/signalsCacheRef
  // so the canonical scoring always sees the freshest data without requiring a re-render.
  }, [autoTraderEnabled, autoTraderTradeId, user, executeDemoBuy, executeViaProvider, executeLiveOrder, liveOrders, firstLiveTradeDone, dryRunMode]);

  // ── Auto Trader: scheduler-triggered entry useEffect ───────────────────
  useEffect(() => {
    if (!autoTraderEnabled) return;
    if (!schedulerCompletedAt) return;
    if (schedulerCompletedAt === lastSchedulerProcessedAtRef.current) return;

    // Mark processed immediately so re-renders cannot re-enter
    lastSchedulerProcessedAtRef.current = schedulerCompletedAt;
    runAutoTraderEntry(schedulerCompletedAt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTraderEnabled, schedulerCompletedAt, runAutoTraderEntry]);

  // ── Auto Trader: status monitor ───────────────────────────────────────
  // Updates lastAction when the tracked trade changes or closes.
  useEffect(() => {
    if (!autoTraderEnabled) return;

    const currentOpen = openTradesRef.current;
    const trackedOpen = autoTraderTradeId
      ? currentOpen.find(t => t.id === autoTraderTradeId)
      : null;

    if (trackedOpen) {
      const pnl = trackedOpen.unrealized_pnl ?? 0;
      const pnlPct = trackedOpen.pnl_pct ?? 0;
      setAutoTraderLastAction(
        `Overvåker ${trackedOpen.pair} · P/L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} USDT (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`
      );
      return;
    }

    // Trade we were tracking has been closed (TP/SL or manual)
    if (autoTraderTradeId && currentOpen.every(t => t.id !== autoTraderTradeId)) {
      setAutoTraderTradeId(null);
      setAutoTraderLastAction('Trade lukket (TP/SL/manuell). Venter på neste Scheduler-analyse.');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTraderEnabled, autoTraderTradeId, openTrades]);

  const executeDemoSell = useCallback(async (tradeId: string, reason: 'manual' | 'take_profit' | 'stop_loss' = 'manual') => {
    if (!user || !demoAccount) throw new Error('Not authenticated');
    const trade = openTrades.find(t => t.id === tradeId);
    if (!trade) throw new Error('Trade not found');
    const sellPrice = trade.current_price ?? marketPrices[trade.pair]?.price ?? trade.buy_price;
    const finalValue = sellPrice * trade.quantity;
    const pnl = finalValue - trade.investment;
    const pnlPct = (pnl / trade.investment) * 100;
    await closeDemoTrade(tradeId);
    await recordTradeHistory({
      symbol: trade.symbol, pair: trade.pair, coin_name: trade.coin_name,
      buy_price: trade.buy_price, sell_price: sellPrice, quantity: trade.quantity,
      investment: trade.investment, final_value: finalValue, profit_loss: pnl,
      profit_loss_pct: pnlPct, stop_loss: trade.stop_loss ?? undefined,
      take_profit: trade.take_profit ?? undefined, signal_id: trade.signal_id ?? undefined,
      ai_confidence: trade.ai_confidence ?? undefined, exit_reason: reason, opened_at: trade.opened_at,
    });
    const newBalance = demoAccount.balance + finalValue;
    await updateDemoBalance(user.id, newBalance);
    setDemoAccount(prev => prev ? { ...prev, balance: newBalance } : prev);
    setOpenTrades(prev => prev.filter(t => t.id !== tradeId));
    setTradeHistory(await getDemoTradeHistory(user.id));
  }, [user, demoAccount, openTrades, marketPrices]);

  const resetDemo = useCallback(async () => {
    if (!user) return;
    await resetDemoAccount(user.id);
    await clearOpenTrades(user.id);
    await clearDemoHistory(user.id);
    setDemoAccount(prev => prev ? { ...prev, balance: 500, total_deposited: 500 } : prev);
    setOpenTrades([]);
    setTradeHistory([]);
  }, [user]);

  const refillDemo = useCallback(async (amount: number) => {
    if (!user) return;
    await refillDemoAccount(user.id, amount);
    setDemoAccount(prev => prev ? { ...prev, balance: prev.balance + amount, total_deposited: prev.total_deposited + amount } : prev);
  }, [user]);

  const performance = computePerformance(demoAccount, openTrades, tradeHistory, marketPrices);

  return (
    <TradingContext.Provider value={{
      demoAccount, openTrades, tradeHistory, signalsCache, liveSignals, marketPrices,
      marketDataStatus, pionexAccountStatus, aiAnalysisStatus, aiAnalysisEnabled, setAiAnalysisEnabled, lastAIUpdate, lastAnalysisError,
      scanStats, performance, loadingDemo,
      signalHistory, signalPerfSummary, signalPatternStats,
      signalPerfByAI, signalPerfByConfidence,
      loadingSignalHistory, refreshSignalHistory,
      schedulerStatus, loadingSchedulerStatus, refreshSchedulerStatus, schedulerCompletedAt,
      autoTraderEnabled, autoTraderTradeId, autoTraderTotalTrades, autoTraderLastAction,
      autoTraderBestSetup, autoTraderBestOverallScore, autoTraderSelectedSignal,
      startAutoTrader, stopAutoTrader,
      isPionexLive, firstLiveTradeDone,
      liveOrders,
      // Kun ordre med aktiv lokal status regnes som Open.
      // Terminal/UNKNOWN-status skal aldri vises som åpen trade.
      openLiveOrders: liveOrders.filter(o =>
        ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(String(o.status).toUpperCase())
      ),
      refreshLiveOrders,
      refreshLiveStatus: fetchLiveStatus,
      toggleLiveTrading,
      dryRunMode,
      setDryRunMode,
      manualBuyTrace,
      autoTradeTrace,
      executeManualBuy,
      executeManualSell,
      getBalance: async () => {
        const bal = await exchangeProviderRef.current.getBalance();
        return { usdt_available: bal.usdt_available, usdt_total: bal.usdt_total };
      },
      getMarketInfo: async (pair: string) => {
        const markets = await exchangeProviderRef.current.getMarkets();
        const slashIdx = pair.indexOf('/');
        let m: typeof markets[number] | undefined;
        if (slashIdx !== -1) {
          const base  = pair.slice(0, slashIdx).toUpperCase();
          const quote = pair.slice(slashIdx + 1).toUpperCase();
          m = markets.find(x => x.base_asset.toUpperCase() === base && x.quote_asset.toUpperCase() === quote);
        }
        if (!m) m = markets.find(x => x.symbol.toUpperCase() === pair.replace('/', '').toUpperCase());
        if (!m) return null;
        return {
          symbol:              m.symbol,
          base_asset:          m.base_asset,
          quote_asset:         m.quote_asset,
          quantity_precision:  m.quantity_precision,
          amount_precision:    (m as typeof m & { amount_precision?: number }).amount_precision,
          min_qty:             m.min_qty,
          min_value:           m.min_value,
        };
      },
      executeDemoBuy, executeDemoSell, resetDemo, refillDemo,
      refreshMarketData: async () => { await fetchMarketData(); },
      refreshSignals,
    }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTrading() {
  return useContext(TradingContext);
}
