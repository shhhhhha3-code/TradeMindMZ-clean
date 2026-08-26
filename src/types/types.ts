export type UserRole = 'user' | 'admin';

// ─── V2 Signal Status ─────────────────────────────────────────────────────────
export type SignalStatus =
  | 'LOCAL_SETUP'   // qualified by local analysis, not sent to AI
  | 'AI_REVIEW'     // currently being reviewed by AI
  | 'AI_VERIFIED'   // AI has reviewed (any AI verdict)
  | 'RECOMMENDED'   // server + AI both RECOMMENDED
  | 'WATCH'         // close to qualifying
  | 'NO_TRADE'      // rejected
  | 'EXPIRED'       // hold window elapsed
  | 'WIN'           // closed with profit
  | 'LOSS';         // closed with loss

// ─── V2 Setup Tier ────────────────────────────────────────────────────────────
export type SetupTier = 'STRONG_SETUP' | 'GOOD_SETUP' | 'WATCH' | 'EXPLORATION';

// ─── V2 Local Setup (coin scored locally, may not go to AI) ──────────────────
export interface LocalSetup {
  pair: string;
  symbol: string;
  coin_name: string;
  price: number;
  change_pct_24h: number;
  signal_type: 'BUY' | 'SELL';
  local_score: number;
  market_regime: string;
  estimated_rr: number;
  atr_pct: number;
  rsi_14: number;
  momentum: string;
  hist_win_rate: number | null;
  hist_avg_pl: number | null;
  hist_sample_n: number;
  setup_tier: SetupTier;
  server_verdict: 'RECOMMENDED' | 'WATCH' | 'NO_TRADE';
  sent_to_ai: boolean;
  score_breakdown: {
    trend: number;
    momentum: number;
    rsi: number;
    macd: number;
    volume: number;
    support_resist: number;
    historical_perf: number;
    mfe_mae: number;
    rr_estimate: number;
    staleness_bonus: number;
    total: number;
  };
  recommendation: {
    local_score: number;
    historical_score: number;
    win_rate: number | null;
    avg_pl_pct: number | null;
    mfe_mae_label: string;
    rr: number;
    confidence: number;
    strength: number;
    market_regime: string;
    server_verdict: string;
    reason: string;
  } | null;
}

export interface Profile {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface DemoAccount {
  id: string;
  user_id: string;
  balance: number;
  total_deposited: number;
  created_at: string;
  updated_at: string;
}

export interface DemoTrade {
  id: string;
  user_id: string;
  symbol: string;
  pair: string;
  coin_name: string;
  buy_price: number;
  quantity: number;
  investment: number;
  stop_loss: number | null;
  take_profit: number | null;
  signal_id: string | null;
  /** BUY or SELL — determines TP/SL trigger direction */
  signal_type: 'BUY' | 'SELL' | null;
  ai_confidence: number | null;
  status: 'open' | 'closed';
  opened_at: string;
  updated_at: string;
  // Computed fields (not in DB)
  current_price?: number;
  current_value?: number;
  unrealized_pnl?: number;
  pnl_pct?: number;
  ai_status?: string;
  ai_recommendation?: string;
}

export interface DemoTradeHistory {
  id: string;
  user_id: string;
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
  stop_loss: number | null;
  take_profit: number | null;
  signal_id: string | null;
  ai_confidence: number | null;
  exit_reason: 'manual' | 'take_profit' | 'stop_loss';
  opened_at: string;
  closed_at: string;
}

export type SignalType = 'BUY' | 'SELL' | 'HOLD' | 'WAIT';
export type RiskLevel = 'Low' | 'Medium' | 'High';
export type AISource = 'openai' | 'gemini' | 'groq';

export interface AISignal {
  id: string;
  symbol: string;
  pair: string;
  coin_name: string;
  coin_logo?: string;
  current_price: number;
  price_change_24h: number;
  signal_type: SignalType;
  confidence: number;
  risk_level: RiskLevel;
  entry_zone_low: number;
  entry_zone_high: number;
  take_profit_1: number;
  take_profit_2: number;
  stop_loss: number;
  risk_reward: string;
  holding_time: string;
  signal_strength: number;
  reasoning: {
    trend: string;
    momentum: string;
    rsi: number;
    macd: string;
    volume: string;
    support: string;
    conclusion: string;
  };
  generated_at: string;
  /** expires_at: ISO timestamp when the signal evaluation window closes (based on AI hold time) */
  expires_at?: string;
  /** Which AI generated this signal: 'openai' (primary) or 'groq' (fallback) */
  ai_source?: AISource;
  /** V2: server qualification verdict — set by recommendation_scorer */
  server_verdict?: 'RECOMMENDED' | 'WATCH' | 'NO_TRADE';
  /** V2: signal pipeline status */
  signal_status?: SignalStatus;
}

export interface MarketData {
  symbol: string;
  pair: string;
  price: number;
  change_24h: number;
  change_pct_24h: number;
  volume_24h: number;
  high_24h: number;
  low_24h: number;
  sparkline?: number[];
}

export interface MarketSentiment {
  score: number;
  label: string;
}

export type AIErrorCategory =
  | 'AUTH_ERROR'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'BAD_REQUEST'
  | 'GATEWAY_ERROR'
  | 'PARSING_ERROR'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | null;

/** @deprecated Use AIErrorCategory */
export type GeminiErrorCategory = AIErrorCategory;

export interface PipelineDiagnostics {
  total_duration_ms: number;
  market_fetch_ms: number;
  screening_ms: number;
  indicator_ms: number;
  klines_ms: number;
  selection_ms: number;
  ai_ms: number;
  openai_request_ms: number;
  openai_response_ms?: number;
  /** @deprecated renamed to openai_request_ms */
  gemini_request_ms?: number;
  /** @deprecated removed in V165 */
  gemini_stream_ms?: number;
  db_load_ms: number;
  db_write_ms: number;
  prompt_ms: number;
  total_pairs_available: number;
  pairs_prescreened: number;
  pairs_sent_to_ai: number;
  pairs_cached: number;
  pairs_new_analysis: number;
  pairs_exploration: number;
  openai_count: number;
  /** @deprecated renamed to openai_count */
  gemini_count?: number;
  groq_count: number;
  signals_generated: number;
  signals_created: number;
  fresh_signals: number;
  stale_signals: number;
  best_current_setup: string;
  ai_rate_limit: number;
  ai_timeout: number;
  ai_error: number;
  ai_success: number;
  ai_cache_hits: number;
  ai_cache_misses: number;
  ai_invalid_json: number;
  // Phase 4 counters
  market_pairs_scanned: number;
  candidates_filtered: number;
  candidates_sent_to_ai: number;
  // V2: local analysis counters
  local_setups_count?: number;
  qualified_count?: number;
  strong_setups_count?: number;
  ai_verified_count?: number;
  recommended_count?: number;
  local_analysis_ms?: number;
  // Exact failure category — null when OpenAI succeeded
  openai_error_category?: AIErrorCategory;
  openai_error_detail?: string;
  /** @deprecated renamed to openai_error_category */
  gemini_error_category?: AIErrorCategory;
  /** @deprecated renamed to openai_error_detail */
  gemini_error_detail?: string;
  groq_error_category?: AIErrorCategory;
  groq_error_detail?: string;
  /** V2: AI verdicts for WATCH/NO_TRADE candidates */
  ai_verdicts?: Array<{ pair?: string; verdict?: string; reason?: string }>;
}

export interface AISignalsCache {
  id: string;
  signals: AISignal[];
  market_data: Record<string, MarketData>;
  market_sentiment: MarketSentiment;
  // Real scan stats returned by the ai-analysis Edge Function
  pairs_scanned: number;
  analyzed_count: number;
  generated_at: string;
  updated_at: string;
  stale?: boolean;
  error_message?: string | null;
  /** Which AI produced the signals in this cache row */
  ai_source?: AISource | null;
  /** Human-readable model label e.g. "openai/gpt-5.6-luna" */
  model_used?: string | null;
  /** OpenAI status at time of last run — 'connected' or the exact AIErrorCategory string */
  gemini_status?: string | null;
  // v6 pipeline fields
  openai_count?: number | null;
  /** @deprecated renamed to openai_count */
  gemini_count?: number | null;
  groq_count?: number | null;
  cached_count?: number | null;
  rotation_count?: number | null;
  diagnostics?: PipelineDiagnostics | null;
  reset_at?: string | null;
  // V2: local analysis results
  local_setups?: LocalSetup[] | null;
}

export interface PionexConnection {
  id: string;
  user_id: string;
  api_key: string;
  is_connected: boolean;
  last_sync: string | null;
  permissions: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface PionexPosition {
  symbol: string;               // display-friendly, e.g. "RIF/USDT Perp"
  raw_symbol: string;           // Pionex API value, e.g. "RIF_USDT_PERP"
  side: 'LONG' | 'SHORT';
  margin_mode: 'Cross' | 'Isolated';
  leverage: number;
  quantity: number;             // absolute size (always positive)
  avg_price: number;            // average entry price
  mark_price: number | null;
  position_value: number | null;// notional in USDT
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
  occupied_margin: number | null;
  liquidation_price: number | null;
  // reserved for future AI signal linkage
  ai_signal_id?: string | null;
}

export interface PionexPortfolio {
  balances: PionexBalance[];
  open_orders: PionexOrder[];
  bots: PionexBot[];
  positions?: PionexPosition[];       // USDT-M futures positions (empty array = none open)
  positions_api_ok?: boolean;         // true = API responded; false = API error (don't show empty state)
  positions_api_error?: string | null;
}

export interface PionexBalance {
  coin: string;
  free: number;
  freeze: number;
  total: number;
  usd_value: number;
}

export interface PionexOrder {
  id: string;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  created_at: string;
}

export interface PionexBot {
  id: string;
  name: string;
  pair: string;
  investment: number;
  total_pnl: number;
  roi_pct: number;
  status: string;
  created_at: string;
}

export interface DemoPerformance {
  account_value: number;
  available_balance: number;
  invested_amount: number;
  unrealized_pnl: number;
  realized_pnl: number;
  total_return_pct: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  best_trade: number;
  worst_trade: number;
}

// ─── Signal History (AI signal outcome tracking) ──────────────────────────────
export type SignalResult = 'WIN' | 'LOSS' | 'EXPIRED';

/**
 * Sub-classification for EXPIRED signals — based on price movement at expiry.
 *   GOOD_DIRECTION : moved ≥50% of TP1 distance toward TP (good timing, too short hold)
 *   NEUTRAL        : little/no movement (signal had no follow-through)
 *   BAD_DIRECTION  : moved ≥50% of SL distance away from TP (wrong direction)
 */
export type ExpiredClass = 'GOOD_DIRECTION' | 'NEUTRAL' | 'BAD_DIRECTION';

export interface SignalHistory {
  id: string;
  pair: string;
  symbol: string;
  coin_name: string;
  signal_type: SignalType;
  confidence: number;
  entry_price: number;
  entry_zone_low: number | null;
  entry_zone_high: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  stop_loss: number | null;
  risk_reward: string | null;
  holding_time: string | null;
  signal_strength: number | null;
  ai_source: 'openai' | 'gemini' | 'groq' | null;
  // status: LIVE while within hold window; WIN/LOSS/EXPIRED after evaluation
  status: 'LIVE' | 'WIN' | 'LOSS' | 'EXPIRED';
  generated_at: string;
  expires_at: string;
  evaluated_at: string | null;
  exit_price: number | null;
  result: SignalResult | null;
  pl_pct: number | null;
  pl_usdt: number | null;
  /** Sub-classification for EXPIRED signals only — set by signal-expiry on evaluation */
  expired_class: ExpiredClass | null;
  reasoning: AISignal['reasoning'] | null;
  created_at: string;
}

export interface SignalPerformanceSummary {
  total_signals: number;
  live_signals: number;
  evaluated_signals: number;
  wins: number;
  losses: number;
  expired: number;
  /** EXPIRED sub-breakdown — computed from expired_class */
  expired_good_direction: number;
  expired_neutral: number;
  expired_bad_direction: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  total_pl_usdt: number | null;
  best_trade_pct: number | null;
  worst_trade_pct: number | null;
  expired_avg_pl_pct: number | null;
  best_signal_pair: string | null;
  worst_signal_pair: string | null;
  /** TP_FEASIBILITY: signals where TP1 exceeded historical MFE P75 (2.5%) */
  signals_with_aggressive_tp: number;
}

export interface SignalPatternStat {
  signal_type: string;
  total: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
  total_pl_usdt: number | null;
  avg_winning_confidence: number | null;
  avg_losing_confidence: number | null;
  avg_rsi_win: number | null;
  avg_rsi_loss: number | null;
}

export interface SignalPerformanceByAI {
  ai_source: string;
  total: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
  total_pl_usdt: number | null;
}

export interface SignalPerformanceByConfidence {
  confidence_range: string;
  sort_order: number;
  total: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
}

export interface UserSettings {
  id: string;
  user_id: string;
  email_notifications: boolean;
  signal_alerts: boolean;
  trade_alerts: boolean;
}

export interface SchedulerStatus {
  id: string;
  job_name: string;
  interval_minutes: number;
  is_active: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}
