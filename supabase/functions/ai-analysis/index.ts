/**
 * ai-analysis Edge Function — V165 (OPENAI PRIMARY + GROQ FALLBACK)
 *
 * Changed in V165:
 *   - PRIMARY AI provider switched from Gemini to OpenAI (Responses API, gpt-5.6-luna).
 *   - Groq remains as fallback when OpenAI fails/rate-limits.
 *   - INTEGRATIONS_API_KEY (Gemini gateway) no longer used.
 *   - OPENAI_API_KEY is the new primary secret.
 *   - All other logic, scoring, signals, TP/SL, Auto Trader unchanged.
 *
 * Preserved from V158:
 *   - GATE_RR = 1.50, MIN_RR = 1.50
 *   - FRESH = 10 minutes
 *   - Confidence >= 65, Strength >= 65 (via final recommendation score)
 *   - TP/SL and 5% cap (MAX_TPSL_DISTANCE_PCT)
 *   - signal-expiry, Auto Trader, Pionex execution
 *   - Max 5 USDT, max 1 open trade, all safety guards
 *   - OpenAI → Groq fallback
 *   - DATA_DRIVEN_TPSL engine (tpsl_engine.ts)
 *   - BEST_CURRENT_SETUP, FRESHNESS guard, pair_analysis_history cache
 *   - All existing diagnostics counters
 *   - RATE-LIMIT SAFETY: if both OpenAI and Groq fail, existing LIVE signals
 *     are preserved as-is (signals=[] is NEVER written to cache on AI failure)
 *
 * Pipeline:
 *   1.  Fetch ALL Pionex USDT tickers once → cache in memory
 *   2.  Filter: volume ≥ MIN_VOLUME_USDT → ALL eligible pairs (no prescreening cap)
 *   3.  Fetch klines + compute full indicators (parallel, CONCURRENCY batches)
 *   4.  Load pair_analysis_history + signal_history from DB
 *   5.  LOCAL SCORING: score ALL coins across 10 dimensions (local_scorer.ts)
 *   6.  RECOMMENDATION SCORING: server computes final score + verdict (recommendation_scorer.ts)
 *       → historical evidence is the dominant component
 *   7.  selectAICandidates(): pick TOP 5 by local_score (+ exploration slots)
 *   8.  FRESHNESS GUARD: pairs with live signal + unchanged state_hash → cache hit
 *   9.  Phase 1 cache gate: state-hash TTL check → skip AI if all cached
 *  10.  ONE OpenAI batch (minimal confirmation prompt) → Groq fallback
 *  11.  AI errors: logged + pipeline continues — existing signals preserved
 *  12.  Override AI prices with real Pionex values
 *  13.  Apply DATA_DRIVEN_TPSL adjustment (if flag ON)
 *  14.  Inject recommendation score breakdown into each signal
 *  15.  Update pair_analysis_history (rotation tracker)
 *  16.  Merge new signals with still-live existing signals
 *  17.  Persist diagnostics in cache row; return to frontend
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  DATA_DRIVEN_TPSL,
  buildHistoricalStats,
  computeAtrPct,
  computeDynamicTPSL,
  bestSetupScoreExtras,
  type HistoryRow,
} from './tpsl_engine.ts';
import {
  localScoreCoins,
  selectAICandidates,
  type CoinInput,
  type PairHistoryMeta,
  type LocalScoredCoin,
} from './local_scorer.ts';
import { type RecommendationBreakdown } from './recommendation_scorer.ts';

// ── v10: Hard server-side TP1/SL cap — 5% max distance from entry ────────────
// Applies unconditionally AFTER all dynamic/AI TP/SL logic.
// Guarantees no signal is ever stored with TP1 or SL > MAX_TPSL_DISTANCE_PCT
// from entry, regardless of rr_pass, AI output, or TPSL model used.
const MAX_TPSL_DISTANCE_PCT = 5.0;

/**
 * Clamp take_profit_1 and stop_loss on `sig` to ≤ MAX_TPSL_DISTANCE_PCT from entry.
 * Retains direction (BUY: tp above entry, sl below; SELL: tp below entry, sl above).
 * Logs [TPSL_AI_CAP_APPLIED] only when a value is actually corrected.
 * Returns the (possibly mutated) sig object.
 */
function applyTPSLCap(
  sig: Record<string, unknown>,
  entry: number,
  pair: string,
  sigType: 'BUY' | 'SELL',
): void {
  if (entry <= 0) return;

  const maxDist = entry * (MAX_TPSL_DISTANCE_PCT / 100);
  const origTp1 = typeof sig.take_profit_1 === 'number' ? sig.take_profit_1 : null;
  const origSl  = typeof sig.stop_loss     === 'number' ? sig.stop_loss     : null;

  let corrected = false;
  const reasons: string[] = [];

  // ── TP1 cap ──────────────────────────────────────────────────────────────
  if (origTp1 !== null) {
    const tp1Dist = Math.abs(origTp1 - entry);
    if (tp1Dist > maxDist) {
      // Clamp to exactly MAX_TPSL_DISTANCE_PCT in the correct direction
      sig.take_profit_1 = sigType === 'BUY'
        ? parseFloat((entry * (1 + MAX_TPSL_DISTANCE_PCT / 100)).toFixed(8))
        : parseFloat((entry * (1 - MAX_TPSL_DISTANCE_PCT / 100)).toFixed(8));
      const tp1DistPct = (tp1Dist / entry * 100).toFixed(2);
      reasons.push(`tp1=${origTp1}(${tp1DistPct}%)→${sig.take_profit_1}(${MAX_TPSL_DISTANCE_PCT}%)`);
      corrected = true;
    }
  }

  // ── SL cap ───────────────────────────────────────────────────────────────
  if (origSl !== null) {
    const slDist = Math.abs(origSl - entry);
    if (slDist > maxDist) {
      sig.stop_loss = sigType === 'BUY'
        ? parseFloat((entry * (1 - MAX_TPSL_DISTANCE_PCT / 100)).toFixed(8))
        : parseFloat((entry * (1 + MAX_TPSL_DISTANCE_PCT / 100)).toFixed(8));
      const slDistPct = (slDist / entry * 100).toFixed(2);
      reasons.push(`sl=${origSl}(${slDistPct}%)→${sig.stop_loss}(${MAX_TPSL_DISTANCE_PCT}%)`);
      corrected = true;
    }
  }

  if (corrected) {
    console.log(
      `[TPSL_AI_CAP_APPLIED] pair=${pair} dir=${sigType} entry=${entry}` +
      ` max_dist=${MAX_TPSL_DISTANCE_PCT}%` +
      ` corrections=[${reasons.join(', ')}]` +
      ` model=${String(sig._tpsl_model ?? 'unknown')}`,
    );
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PIONEX_BASE = 'https://api.pionex.com';

const SCHEDULER_ID = 'ai-analysis';
const SCHEDULER_INTERVAL_MIN = 7;

// ── Pipeline constants ────────────────────────────────────────────────────────
const MIN_VOLUME_USDT    = 200_000;   // minimum 24h volume to be eligible
// V149: No prescreening cap — ALL eligible coins are scored locally first.
// Previously MAX_PRESCREENED=60 was the hard cap. Now all ~68 coins get klines+indicators.
const MAX_PRESCREENED    = 120;       // raised cap — local scorer handles all eligible coins
const TOP_CANDIDATES     = 15;        // best-quality scored candidates (pre-local-scorer legacy)
const EXPLORE_CANDIDATES = 5;         // rotation/exploration candidates (pre-local-scorer legacy)
const MAX_AI_SLOTS       = TOP_CANDIDATES + EXPLORE_CANDIDATES; // legacy — not used in V149 path
const MAX_SIGNALS        = 8;         // max signals from AI per cycle
const KLINE_INTERVAL     = '15M';
const KLINE_LIMIT        = 80;
const CONCURRENCY        = 12;        // parallel kline fetches

// ── V158: AI candidate limit (after local scoring) ───────────────────────────
// Local scorer + recommendation scorer ranks ALL coins; only TOP 5 are sent to AI.
// AI does qualitative confirmation only — not full market analysis.
// 5 candidates balances token economy with sufficient coverage.
const AI_CANDIDATE_LIMIT = 5;

// ── V158: Exploration slots reserved within AI_CANDIDATE_LIMIT ────────────────
// Ensures rotation: stale/unseen pairs can still reach AI within the TOP 5.
const EXPLORE_AI_SLOTS = 1;

// ── Phase 1 cache thresholds ───────────────────────────────────────────────────
// Relaxed from v6 to maximise cache hits on 7-min follow-up scheduler runs.
// A 22-min TTL means valid results survive ≥3 scheduler cycles.
// 4% price / 15 RSI-pt thresholds stop minor oscillations from busting the cache.
// Only genuinely changed market state (EMA cross, volume spike, real breakout) forces re-analysis.

// State change thresholds — trigger re-analysis even for recently analyzed pairs
const THRESHOLD_PRICE_CHG  = 4.0;    // % price move since last analysis (v6: 3.0%)
const THRESHOLD_RSI_CHG    = 15.0;   // RSI points change (v6: 12.0)
const THRESHOLD_VOL_CHG    = 2.0;    // volume multiplier (unchanged)
const THRESHOLD_EMA_CROSS  = true;   // EMA9/EMA21 cross since last analysis (unchanged)

// Staleness: pairs not analyzed for this long get an exploration bonus
const STALE_HOURS          = 6;      // hours before a pair is considered stale (unchanged)
const VERY_STALE_HOURS     = 24;     // extra bonus for very stale pairs (unchanged)

// AI result cache: reuse if market state unchanged within this window
const AI_CACHE_TTL_MS      = 22 * 60 * 1000; // 22 minutes (v6: 15 min) — covers ≥3 scheduler runs

// Short backoff for Gemini retries
const BACKOFF_MS = [4_000, 8_000, 12_000];

/**
 * Parse a holding_time string like "3-6 hours", "6-12 hours", "1-3 days", "1 week"
 * and return the upper-bound duration in milliseconds.
 * Falls back to 6 hours if the string cannot be parsed.
 */
function holdingTimeToMs(holdingTime: string | null | undefined): number {
  if (!holdingTime) return 6 * 60 * 60 * 1000;
  const s = holdingTime.toLowerCase().trim();
  const rangeHoursMatch = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*h/);
  if (rangeHoursMatch) return parseFloat(rangeHoursMatch[2]) * 60 * 60 * 1000;
  const rangeDaysMatch  = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*d/);
  if (rangeDaysMatch)  return parseFloat(rangeDaysMatch[2])  * 24 * 60 * 60 * 1000;
  const rangeWeeksMatch = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*w/);
  if (rangeWeeksMatch) return parseFloat(rangeWeeksMatch[2]) * 7 * 24 * 60 * 60 * 1000;
  const singleHoursMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (singleHoursMatch) return parseFloat(singleHoursMatch[1]) * 60 * 60 * 1000;
  const singleDaysMatch  = s.match(/(\d+(?:\.\d+)?)\s*d/);
  if (singleDaysMatch)  return parseFloat(singleDaysMatch[1])  * 24 * 60 * 60 * 1000;
  const singleWeeksMatch = s.match(/(\d+(?:\.\d+)?)\s*w/);
  if (singleWeeksMatch) return parseFloat(singleWeeksMatch[1]) * 7 * 24 * 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000; // fallback: 6 hours
}

// ─── Scheduler status helper ─────────────────────────────────────────────────
async function updateSchedulerStatus(
  db: ReturnType<typeof createClient>,
  success: boolean,
  error: string | null,
) {
  const now = new Date();
  const nextRun = new Date(now.getTime() + SCHEDULER_INTERVAL_MIN * 60_000);
  try {
    await db
      .from('scheduler_status')
      .upsert({
        id: SCHEDULER_ID,
        job_name: 'AI market analysis',
        interval_minutes: SCHEDULER_INTERVAL_MIN,
        is_active: true,
        last_run_at: now.toISOString(),
        last_success_at: success ? now.toISOString() : undefined,
        last_error: error,
        next_run_at: nextRun.toISOString(),
        updated_at: now.toISOString(),
      }, { onConflict: 'id' });
    console.log(`[ai-analysis] scheduler status updated: success=${success}`);
  } catch (err) {
    console.warn('[ai-analysis] failed to update scheduler_status:', err);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PionexTicker {
  symbol: string; open: string; close: string;
  high: string; low: string; volume: string; amount: string;
}

interface TickerMeta {
  pair: string; symbol: string; coin_name: string; pionex_symbol: string;
  price: number; open: number; high: number; low: number;
  volume_usdt: number; change_pct: number; momentum_score: number;
}

interface CoinAnalysisData {
  pair: string; symbol: string; coin_name: string;
  price: number; open_24h: number; high_24h: number; low_24h: number;
  volume_24h_usdt: number; change_24h: number; change_pct_24h: number;
  rsi_14: number; ema_9: number; ema_21: number;
  macd_line: number; macd_signal: number; macd_histogram: number;
  support_level: number; resistance_level: number;
  price_vs_ema9: string; price_vs_ema21: string; momentum: string;
  technical_score: number;
  candidate_score: number;     // weighted rotation-aware score used for selection
  is_exploration: boolean;     // flagged as an exploration/rotation candidate
  recent_closes: number[];
  sparkline: number[];
  state_hash: string;          // fingerprint of current market state for cache check
  // V158: server-side local score + recommendation breakdown attached to AI candidates
  local_score?: number;
  market_regime?: string;
  signal_bias?: string;
  estimated_rr?: number;
  recommendation?: RecommendationBreakdown | null;
}

interface PairHistory {
  pair: string;
  last_analyzed_at: string | null;
  last_signal_type: string | null;
  last_signal_score: number | null;
  last_ai_confidence: number | null;
  last_result: string | null;
  times_analyzed: number;
  recent_win_count: number;
  recent_loss_count: number;
  last_rsi: number | null;
  last_price: number | null;
  last_ema9: number | null;
  last_ema21: number | null;
  last_volume_usdt: number | null;
  last_momentum: string | null;
  cached_signal_json: Record<string, unknown> | null;
  cache_state_hash: string | null;
  cache_expires_at: string | null;
}

interface Diagnostics {
  // ── Timing ───────────────────────────────────────────────────────────────────
  total_duration_ms: number;
  market_fetch_ms: number;
  screening_ms: number;
  indicator_ms: number;       // total klines fetch + indicator compute
  klines_ms: number;          // pure kline HTTP time (sub-timer)
  db_load_ms: number;         // pair_analysis_history SELECT
  selection_ms: number;
  prompt_ms: number;          // buildBatchPrompt time
  ai_ms: number;              // total AI stage (cache check + OpenAI/Groq + parse)
  openai_request_ms: number;  // time until HTTP response headers received
  openai_response_ms: number; // time reading response body
  db_write_ms: number;        // final cache + signal_history upserts
  // ── Phase 4 pipeline counters ────────────────────────────────────────────────
  market_pairs_scanned: number;    // MARKET_PAIRS_SCANNED: all USDT pairs seen
  candidates_filtered: number;     // CANDIDATES_FILTERED: removed by fast deterministic filter
  candidates_sent_to_ai: number;   // CANDIDATES_SENT_TO_AI: after filter + AI_CANDIDATE_LIMIT
  ai_cache_hits: number;           // AI_CACHE_HITS: served from pair_analysis_history cache
  ai_cache_misses: number;         // AI_CACHE_MISSES: sent to actual AI call
  ai_success: number;              // AI_SUCCESS: 1 if batch call returned valid JSON
  ai_timeout: number;              // AI_TIMEOUT: 1 if OpenAI or Groq timed out
  ai_rate_limit: number;           // AI_RATE_LIMIT: 1 if 429 received
  ai_error: number;                // AI_ERROR: other errors (auth, network, gateway)
  ai_invalid_json: number;         // AI_INVALID_JSON: response received but JSON invalid
  ai_verdicts?: unknown[];         // V158: AI WATCH/NO_TRADE verdicts with reasons
  signals_created: number;         // SIGNALS_CREATED: new unique signals added this run
  fresh_signals: number;           // FRESH_SIGNALS: signals still within holding window
  stale_signals: number;           // STALE_SIGNALS: signals past holding window (not errors)
  best_current_setup: string;      // BEST_CURRENT_SETUP: pair of winning signal or NONE
  // V2 local analysis counters
  local_setups_count?: number;
  qualified_count?: number;
  strong_setups_count?: number;
  ai_verified_count?: number;
  recommended_count?: number;
  local_analysis_ms?: number;
  ai_verdicts?: unknown[];
  // ── Legacy counters (kept for backwards compat with frontend DiagnosticPanel) ──
  total_pairs_available: number;
  pairs_prescreened: number;
  pairs_sent_to_ai: number;
  pairs_cached: number;
  pairs_new_analysis: number;
  pairs_exploration: number;
  openai_count: number;
  groq_count: number;
  signals_generated: number;
  // OpenAI error — null when AI succeeded
  openai_error_category: OpenAIErrorCategory;
  openai_error_detail: string;
  // Groq error — null when Groq not used or Groq succeeded
  groq_error_category: GroqErrorCategory;
  groq_error_detail: string;
}

// ─── Technical Indicators ─────────────────────────────────────────────────────

function calcEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const avgGain = changes.slice(-period).map(c => Math.max(c, 0)).reduce((a, b) => a + b, 0) / period;
  const avgLoss = changes.slice(-period).map(c => Math.abs(Math.min(c, 0))).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Composite technical score 0–100 to rank which coins to send to Gemini. */
function technicalScore(c: Omit<CoinAnalysisData, 'technical_score'>): number {
  let score = 0;
  // RSI oversold/overbought — both are tradeable extremes
  if (c.rsi_14 < 30 || c.rsi_14 > 70) score += 30;
  else if (c.rsi_14 < 40 || c.rsi_14 > 60) score += 15;
  // MACD histogram direction
  if (Math.abs(c.macd_histogram) > 0) score += Math.min(Math.abs(c.macd_histogram / c.price) * 10000, 20);
  // EMA cross
  if (c.price_vs_ema9 === 'ABOVE' && c.price_vs_ema9 === c.price_vs_ema21) score += 10;
  if (c.price_vs_ema9 === 'BELOW' && c.price_vs_ema9 === c.price_vs_ema21) score += 10;
  // Momentum
  const absChg = Math.abs(c.change_pct_24h);
  score += absChg < 0.5 ? 0 : absChg < 3 ? 10 : absChg < 8 ? 20 : 15;
  // Volume bonus
  if (c.volume_24h_usdt > 5_000_000) score += 10;
  else if (c.volume_24h_usdt > 1_000_000) score += 5;
  return Math.min(score, 100);
}

function quickMomentumScore(t: PionexTicker): number {
  const price = parseFloat(t.close), open = parseFloat(t.open);
  const high  = parseFloat(t.high),  low  = parseFloat(t.low);
  if (!price || !open || price <= 0 || open <= 0) return 0;
  const changePct = ((price - open) / open) * 100;
  const range = high - low;
  const rangePos = range > 0 ? (price - low) / range : 0.5;
  const vol = parseFloat(t.amount);
  const volScore = Math.min(vol / 10_000_000, 1) * 20;
  const abs = Math.abs(changePct);
  const mom = abs < 0.5 ? abs * 8 : abs < 1.5 ? 4 + abs * 12 : abs < 6 ? 22 + abs * 8 : abs < 10 ? 70 + (abs - 6) * 3 : 82;
  return rangePos * 20 + volScore + mom;
}

function deriveCoinName(sym: string): string {
  const base = sym.split('_')[0];
  const map: Record<string, string> = {
    BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB',
    XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', DOT: 'Polkadot',
    AVAX: 'Avalanche', MATIC: 'Polygon', LINK: 'Chainlink', LTC: 'Litecoin',
    UNI: 'Uniswap', ATOM: 'Cosmos', TRX: 'TRON', NEAR: 'NEAR Protocol',
    APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', INJ: 'Injective',
    SUI: 'Sui', TON: 'Toncoin', PEPE: 'Pepe', WIF: 'Dogwifhat',
    BONK: 'Bonk', SHIB: 'Shiba Inu', ETC: 'Ethereum Classic',
    BCH: 'Bitcoin Cash', MKR: 'Maker', AAVE: 'Aave', FTM: 'Fantom',
    ALGO: 'Algorand', HBAR: 'Hedera', VET: 'VeChain',
  };
  return map[base] ?? base;
}

// ─── Setup Fingerprint ───────────────────────────────────────────────────────
// Deterministic hash for a trading setup. Used as the conflict key when
// writing to signal_history so concurrent cron runs never insert duplicate rows.
//
// Bucket strategy (matches DB migration):
//   entry  → rounded to nearest 1% bucket (e.g. 2250 @ 1% = 22.5 → bucket 100)
//   tp1    → same 1% bucket relative to entry
//   sl     → same 1% bucket relative to entry
//
// Two signals whose entry, TP, and SL land in the same 1% bucket are treated as
// the same setup. This absorbs small TPSL-engine drift across successive cron runs
// while still distinguishing genuinely different setups.
async function computeSetupFingerprint(
  pair: string,
  direction: string,
  entryPrice: number,
  tp1: number | null,
  sl: number | null,
): Promise<string> {
  const bucket = (v: number | null) =>
    v == null ? 'null' : String(Math.round(v / Math.max(entryPrice * 0.01, 0.000001)));
  const raw = `${pair}|${direction}|${bucket(entryPrice)}|${bucket(tp1)}|${bucket(sl)}`;
  const bytes  = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32); // 32 hex chars (128 bits) — same length as md5 for consistency
}

// ─── Market State Hash ────────────────────────────────────────────────────────
// Produces a short fingerprint of current market conditions.
// Used to detect meaningful state changes and invalidate AI result cache.
// Phase 1: coarser buckets → fewer false-miss hash changes on minor oscillations.

function marketStateHash(c: {
  rsi_14: number; price: number; ema_9: number; ema_21: number;
  volume_24h_usdt: number; momentum: string;
}): string {
  // Phase 1: RSI bucket widened from 3 → 4 pts — RSI 42/43/44 now same bucket
  const rBucket  = Math.round(c.rsi_14 / 4) * 4;
  // Phase 1: price rounded to nearest 0.05-unit grid on a log scale to avoid
  // trivial float differences busting the cache (e.g. 3200.01 vs 3200.05)
  const pMagnitude = Math.pow(10, Math.floor(Math.log10(Math.max(c.price, 0.000001))));
  const pBucket  = Math.round(c.price / (pMagnitude * 0.05)) * (pMagnitude * 0.05);
  const emaCross = c.ema_9 > c.ema_21 ? 'bullish' : 'bearish';
  const volBucket = Math.round(Math.log10(Math.max(c.volume_24h_usdt, 1)) * 2) / 2; // unchanged
  return `${rBucket}|${pBucket}|${emaCross}|${volBucket}|${c.momentum}`;
}

// ─── Market State Change Detection ───────────────────────────────────────────
// Returns true if the pair's current state differs enough from last analysis
// to justify re-running AI despite being recently analyzed.

function hasMarketStateChanged(
  coin: CoinAnalysisData,
  hist: PairHistory,
): boolean {
  if (!hist.last_analyzed_at) return false; // never analyzed — not a state change

  // Price change since last analysis
  if (hist.last_price && hist.last_price > 0) {
    const priceDelta = Math.abs((coin.price - hist.last_price) / hist.last_price) * 100;
    if (priceDelta >= THRESHOLD_PRICE_CHG) return true;
  }

  // RSI change
  if (hist.last_rsi !== null) {
    if (Math.abs(coin.rsi_14 - hist.last_rsi) >= THRESHOLD_RSI_CHG) return true;
  }

  // EMA cross direction changed
  if (THRESHOLD_EMA_CROSS && hist.last_ema9 !== null && hist.last_ema21 !== null) {
    const wasBull = hist.last_ema9 > hist.last_ema21;
    const isBull  = coin.ema_9 > coin.ema_21;
    if (wasBull !== isBull) return true;
  }

  // Volume spike
  if (hist.last_volume_usdt && hist.last_volume_usdt > 0) {
    const volRatio = coin.volume_24h_usdt / hist.last_volume_usdt;
    if (volRatio >= THRESHOLD_VOL_CHG || volRatio <= (1 / THRESHOLD_VOL_CHG)) return true;
  }

  // Momentum regime changed
  if (hist.last_momentum && hist.last_momentum !== coin.momentum) return true;

  return false;
}

// ─── Candidate Scoring ───────────────────────────────────────────────────────
// Weighted score used to rank ALL prescreened coins and select AI candidates.
// Prevents same top-20 from being repeated every cycle.

function candidateScore(
  coin: CoinAnalysisData,
  hist: PairHistory | null,
  stateChanged: boolean,
): number {
  // A) Market opportunity (0–35): technical score normalised
  const aOpportunity = coin.technical_score * 0.35;

  // B) Historical AI performance (0–20): win rate bonus/penalty
  let bHistPerf = 10; // neutral baseline (no history)
  if (hist && (hist.recent_win_count + hist.recent_loss_count) >= 3) {
    const totalH = hist.recent_win_count + hist.recent_loss_count;
    const wr = hist.recent_win_count / totalH;
    bHistPerf = wr * 20; // 0–20
  }

  // C) Staleness bonus (0–25): longer since last analysis → higher priority
  let cStaleness = 12; // neutral (not yet tracked)
  if (hist?.last_analyzed_at) {
    const hoursAgo = (Date.now() - new Date(hist.last_analyzed_at).getTime()) / 3_600_000;
    if (hoursAgo >= VERY_STALE_HOURS) cStaleness = 25;
    else if (hoursAgo >= STALE_HOURS) cStaleness = 18;
    else if (hoursAgo >= 2)            cStaleness = 10;
    else                               cStaleness = 2;  // very recent → low priority
  }

  // D) Market-state change bonus (0–15): recently analyzed but state flipped
  const dStateChange = stateChanged ? 15 : 0;

  // E) Exploration bonus (0–10): never analyzed pairs get a small push
  const eExplore = (!hist || hist.times_analyzed === 0) ? 10 : 0;

  const total = aOpportunity + bHistPerf + cStaleness + dStateChange + eExplore;
  return Math.min(Math.round(total), 100);
}

// ─── Phase 4: Fast Deterministic Pre-Filter ──────────────────────────────────
// Applied AFTER candidateScore ranking and BEFORE sending coins to AI.
// A coin passes if it satisfies at least one clear technical opportunity gate.
// Purpose: remove obviously weak setups so AI only sees meaningful candidates.
// RULES:
//   - Does NOT change trading logic, TP/SL, scoring formulas, or signal quality.
//   - Does NOT invent new indicators — uses RSI/EMA/MACD/volume/momentum already computed.
//   - STALE coins (unseen pairs needing rotation) pass unconditionally.
//   - Exploration coins pass unconditionally (rotation guarantee).
//   - Filtered-out coins are simply skipped for AI; their cache/history is unchanged.

function fastDeterministicFilter(
  coin: CoinAnalysisData,
  hist: PairHistory | null,
): boolean {
  // Always pass exploration candidates (rotation guarantee)
  if (coin.is_exploration) return true;

  // Always pass if never analyzed (cold start / new pair)
  if (!hist || hist.times_analyzed === 0) return true;

  // Gate 1: RSI oversold/overbought zone — meaningful reversal territory
  if (coin.rsi_14 < 35 || coin.rsi_14 > 65) return true;

  // Gate 2: EMA alignment with price confirmation — trend following setup
  const priceAboveEma9  = coin.price > coin.ema_9;
  const ema9AboveEma21  = coin.ema_9 > coin.ema_21;
  const priceBelowEma9  = coin.price < coin.ema_9;
  const ema9BelowEma21  = coin.ema_9 < coin.ema_21;
  if ((priceAboveEma9 && ema9AboveEma21) || (priceBelowEma9 && ema9BelowEma21)) return true;

  // Gate 3: MACD histogram showing momentum (non-trivial signal)
  // Use 0.2% of price as significance threshold to avoid noise
  const macdThreshold = coin.price * 0.002;
  if (Math.abs(coin.macd_histogram) > macdThreshold) return true;

  // Gate 4: Strong directional move (>2% in 24h) — worth AI attention
  if (Math.abs(coin.change_pct_24h) > 2.0) return true;

  // Gate 5: Strong momentum label already computed by indicator pipeline
  if (coin.momentum === 'Bullish' || coin.momentum === 'Bearish') return true;

  // Coin passed none of the gates — filter out
  return false;
}

// ─── Pionex Data Fetching ─────────────────────────────────────────────────────

async function fetchAllTickers(): Promise<{ tickers: PionexTicker[]; fetchMs: number }> {
  const t0 = Date.now();
  // 429-aware retry: up to 3 attempts with exponential backoff (1s → 2s → 4s).
  // Public endpoint — no auth cost. Prevents a single burst from killing the whole pipeline.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${PIONEX_BASE}/api/v1/market/tickers`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const body = await res.json();
      return { tickers: body?.data?.tickers ?? [], fetchMs: Date.now() - t0 };
    }
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const waitMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s
      console.warn(`[ai-analysis] fetchAllTickers 429 — attempt ${attempt}/${MAX_ATTEMPTS}, retry in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`Pionex tickers HTTP ${res.status}`);
  }
  throw new Error('fetchAllTickers: exhausted retries');
}

function screenTickers(tickers: PionexTicker[], maxCandidates: number): { candidates: TickerMeta[]; totalPairs: number } {
  const usdtPairs = tickers.filter(t => {
    if (!t.symbol.endsWith('_USDT')) return false;
    const price = parseFloat(t.close), vol = parseFloat(t.amount);
    return price > 0 && vol >= MIN_VOLUME_USDT;
  });

  const candidates: TickerMeta[] = usdtPairs.map(t => {
    const base = t.symbol.replace('_USDT', '');
    const price = parseFloat(t.close), open = parseFloat(t.open);
    return {
      pair: `${base}/USDT`, symbol: base,
      coin_name: deriveCoinName(t.symbol), pionex_symbol: t.symbol,
      price, open, high: parseFloat(t.high), low: parseFloat(t.low),
      volume_usdt: parseFloat(t.amount),
      change_pct: open > 0 ? ((price - open) / open) * 100 : 0,
      momentum_score: quickMomentumScore(t),
    };
  });
  candidates.sort((a, b) => b.momentum_score - a.momentum_score);
  return { candidates: candidates.slice(0, maxCandidates), totalPairs: usdtPairs.length };
}

async function fetchKlines(sym: string): Promise<number[]> {
  try {
    const url = `${PIONEX_BASE}/api/v1/market/klines?symbol=${sym}&interval=${KLINE_INTERVAL}&limit=${KLINE_LIMIT}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.data?.klines ?? []).map((k: { close: string }) => parseFloat(k.close)).filter((n: number) => !isNaN(n) && n > 0);
  } catch { return []; }
}

async function buildCoinData(meta: TickerMeta): Promise<CoinAnalysisData | null> {
  const closes = await fetchKlines(meta.pionex_symbol);
  const working = closes.length >= 14 ? closes : [meta.open, meta.price];

  const rsi    = calcRSI(working);
  const ema9   = calcEMA(working, 9);
  const ema21  = calcEMA(working, 21);
  const ema12  = calcEMA(working, Math.min(12, working.length));
  const ema26  = calcEMA(working, Math.min(26, working.length));
  const macdLine      = ema12 - ema26;
  const macdSignal    = macdLine * (2 / 10);
  const macdHistogram = macdLine - macdSignal;
  const recent20      = working.slice(-20);
  const support       = Math.min(meta.low, ...recent20) * 0.999;
  const resistance    = Math.max(meta.high, ...recent20) * 1.001;
  const sparkline     = working.slice(-20).map(c => Math.round(c * 10000) / 10000);
  const momentum      = meta.change_pct > 1 ? 'Bullish' : meta.change_pct < -1 ? 'Bearish' : 'Neutral';

  const partial = {
    pair: meta.pair, symbol: meta.symbol, coin_name: meta.coin_name,
    price: meta.price, open_24h: meta.open, high_24h: meta.high, low_24h: meta.low,
    volume_24h_usdt: meta.volume_usdt,
    change_24h: meta.price - meta.open, change_pct_24h: meta.change_pct,
    rsi_14: Math.round(rsi * 100) / 100,
    ema_9:  Math.round(ema9  * 100) / 100,
    ema_21: Math.round(ema21 * 100) / 100,
    macd_line:      Math.round(macdLine * 10000) / 10000,
    macd_signal:    Math.round(macdSignal * 10000) / 10000,
    macd_histogram: Math.round(macdHistogram * 10000) / 10000,
    support_level:    Math.round(support    * 100) / 100,
    resistance_level: Math.round(resistance * 100) / 100,
    price_vs_ema9:  meta.price > ema9  ? 'ABOVE' : 'BELOW',
    price_vs_ema21: meta.price > ema21 ? 'ABOVE' : 'BELOW',
    momentum,
    recent_closes: working.slice(-6).map(c => Math.round(c * 100) / 100),
    sparkline,
  };

  const techScore = technicalScore(partial);
  const hash = marketStateHash({ rsi_14: partial.rsi_14, price: meta.price, ema_9: ema9, ema_21: ema21, volume_24h_usdt: meta.volume_usdt, momentum });

  return {
    ...partial,
    technical_score: techScore,
    candidate_score: 0,   // filled in by selection step
    is_exploration: false,
    state_hash: hash,
  };
}

// ─── Error Categories ─────────────────────────────────────────────────────────
// Exact error category exposed in diagnostics and DiagnosticPanel.

type OpenAIErrorCategory =
  | 'AUTH_ERROR'       // 401 / 403 / missing key
  | 'RATE_LIMIT'       // 429 / 402
  | 'TIMEOUT'          // AbortError / timeout
  | 'BAD_REQUEST'      // 400 / malformed request
  | 'SERVER_ERROR'     // 5xx from OpenAI
  | 'PARSING_ERROR'    // response received but JSON invalid
  | 'NETWORK_ERROR'    // fetch threw (DNS / connection refused)
  | 'INVALID_RESPONSE' // 200 but no parseable content
  | null;              // success

// ─── OpenAI Responses API config ─────────────────────────────────────────────

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL   = 'gpt-5.6-luna';

// ─── OpenAI batch call: ONE request for all coins ─────────────────────────────
// CRITICAL: We send ONE batch prompt covering all AI candidates.
// The batch prompt asks for 0–MAX_SIGNALS signals across ALL coins.
// Uses OpenAI Responses API (non-streaming JSON response).

async function callOpenAIBatch(
  prompt: string,
  apiKey: string,
): Promise<{
  parsed: { signals?: unknown[]; market_sentiment?: { score: number; label: string } } | null;
  rawPreview: string;
  errorCategory: OpenAIErrorCategory;
  errorDetail: string;
  requestMs: number;
  streamMs: number;   // kept for interface compat (always 0 — not streaming)
}> {
  let lastDetail  = '';
  let errorCat: OpenAIErrorCategory = null;
  let totalRequestMs = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      console.warn(`[ai-analysis] OpenAI attempt ${attempt + 1}, backoff ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    console.log(`[ai-analysis] OpenAI attempt ${attempt + 1} — POST ${OPENAI_API_URL} model=${OPENAI_MODEL}`);

    const tReq = Date.now();
    let res: Response;
    try {
      res = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: prompt,
          // temperature not supported by gpt-5.6-luna (Responses API)
          max_output_tokens: 1500,
        }),
        signal: AbortSignal.timeout(90_000),  // 90 s — single batch, generous
      });
    } catch (fetchErr) {
      const msg = String(fetchErr);
      if (msg.includes('Timeout') || msg.includes('timeout') || msg.includes('AbortError')) {
        errorCat   = 'TIMEOUT';
        lastDetail = `Timeout after 90s: ${msg}`;
      } else {
        errorCat   = 'NETWORK_ERROR';
        lastDetail = `Network error: ${msg}`;
      }
      console.warn(`[ai-analysis] OpenAI ${errorCat}: ${lastDetail}`);
      continue; // retry
    }
    totalRequestMs = Date.now() - tReq;

    console.log(`[ai-analysis] OpenAI HTTP ${res.status} in ${totalRequestMs}ms`);

    if (res.status === 401 || res.status === 403) {
      const txt = await res.text();
      errorCat   = 'AUTH_ERROR';
      lastDetail = `HTTP ${res.status}: ${txt.slice(0, 300)}`;
      console.error(`[ai-analysis] OpenAI AUTH_ERROR: ${lastDetail}`);
      break; // no point retrying — fall through to Groq immediately
    }
    if (res.status === 429 || res.status === 402) {
      const txt = await res.text();
      errorCat   = 'RATE_LIMIT';
      lastDetail = `HTTP ${res.status}: ${txt.slice(0, 300)}`;
      console.warn(`[ai-analysis] OpenAI RATE_LIMIT: ${lastDetail}`);
      break; // CRITICAL: do NOT retry — fall through to Groq immediately
    }
    if (res.status === 400) {
      const txt = await res.text();
      errorCat   = 'BAD_REQUEST';
      lastDetail = `HTTP 400: ${txt.slice(0, 300)}`;
      console.error(`[ai-analysis] OpenAI BAD_REQUEST: ${lastDetail}`);
      break; // bad prompt — no point retrying
    }
    if (res.status >= 500) {
      const txt = await res.text();
      errorCat   = 'SERVER_ERROR';
      lastDetail = `HTTP ${res.status}: ${txt.slice(0, 300)}`;
      console.warn(`[ai-analysis] OpenAI SERVER_ERROR: ${lastDetail}`);
      continue; // retry 5xx
    }
    if (!res.ok) {
      const txt = await res.text();
      errorCat   = 'SERVER_ERROR';
      lastDetail = `HTTP ${res.status}: ${txt.slice(0, 300)}`;
      console.warn(`[ai-analysis] OpenAI unexpected HTTP: ${lastDetail}`);
      continue;
    }

    // Parse JSON response body (Responses API returns full JSON, not SSE)
    let body: Record<string, unknown>;
    try {
      body = await res.json();
    } catch (jsonErr) {
      errorCat   = 'PARSING_ERROR';
      lastDetail = `Response JSON parse failed: ${String(jsonErr)}`;
      console.warn(`[ai-analysis] OpenAI ${lastDetail}`);
      continue;
    }

    // Extract text from Responses API output array
    // Shape: { output: [{ type: 'message', content: [{ type: 'output_text', text: '...' }] }] }
    let fullText = '';
    const output = body?.output;
    if (Array.isArray(output)) {
      for (const item of output as Record<string, unknown>[]) {
        const content = item?.content;
        if (Array.isArray(content)) {
          for (const part of content as Record<string, unknown>[]) {
            if (part?.type === 'output_text' && typeof part?.text === 'string') {
              fullText += part.text;
            }
          }
        }
      }
    }

    console.log(`[ai-analysis] OpenAI response: ${fullText.length} chars in ${totalRequestMs}ms`);

    if (fullText.length === 0) {
      errorCat   = 'INVALID_RESPONSE';
      lastDetail = 'Empty output text — model returned nothing';
      console.warn(`[ai-analysis] OpenAI INVALID_RESPONSE: ${lastDetail}`);
      continue;
    }

    const rawPreview = fullText.slice(0, 200);
    const clean = fullText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    try {
      const parsed = JSON.parse(clean);
      console.log(`[ai-analysis] OpenAI OK — signals=${Array.isArray(parsed.signals) ? parsed.signals.length : 0}`);
      return { parsed, rawPreview, errorCategory: null, errorDetail: '', requestMs: totalRequestMs, streamMs: 0 };
    } catch (parseErr) {
      errorCat   = 'PARSING_ERROR';
      lastDetail = `JSON parse failed: ${String(parseErr)} | raw[0:200]: ${rawPreview}`;
      console.warn(`[ai-analysis] OpenAI PARSING_ERROR: ${lastDetail}`);
      continue; // retry
    }
  }

  console.error(`[ai-analysis] OpenAI failed — category=${errorCat} detail=${lastDetail}`);
  return { parsed: null, rawPreview: '', errorCategory: errorCat ?? 'SERVER_ERROR', errorDetail: lastDetail, requestMs: totalRequestMs, streamMs: 0 };
}

// ─── Groq error categories ────────────────────────────────────────────────────
type GroqErrorCategory =
  | 'AUTH_ERROR'       // 401 / 403
  | 'RATE_LIMIT'       // 429
  | 'TIMEOUT'          // AbortError / timeout
  | 'BAD_REQUEST'      // 400
  | 'SERVER_ERROR'     // 5xx
  | 'PARSING_ERROR'    // 200 but JSON invalid
  | 'NETWORK_ERROR'    // fetch threw
  | null;              // success

// ─── Groq Fallback (full batch) ───────────────────────────────────────────────
// Used when Gemini fails globally. Receives the SAME batch prompt as Gemini.
// Never throws — always returns structured result so diagnostics are complete.

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'openai/gpt-oss-20b';

async function callGroqBatch(
  prompt: string,
  groqKey: string,
): Promise<{
  parsed: { signals?: unknown[]; market_sentiment?: { score: number; label: string } } | null;
  modelUsed: string;
  errorCategory: GroqErrorCategory;
  errorDetail: string;
}> {
  console.log(`[ai-analysis] Groq fallback — POST ${GROQ_API_URL}`);

  let res: Response;
  try {
    res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a quantitative crypto trading analyst. Return only valid JSON — no markdown fences, no explanations.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (fetchErr) {
    const msg = String(fetchErr);
    const cat: GroqErrorCategory = (msg.includes('Timeout') || msg.includes('timeout') || msg.includes('AbortError'))
      ? 'TIMEOUT' : 'NETWORK_ERROR';
    console.error(`[ai-analysis] Groq ${cat}: ${msg}`);
    return { parsed: null, modelUsed: `groq/${GROQ_MODEL}`, errorCategory: cat, errorDetail: msg.slice(0, 300) };
  }

  if (!res.ok) {
    const txt = await res.text();
    let cat: GroqErrorCategory = 'SERVER_ERROR';
    if (res.status === 401 || res.status === 403) cat = 'AUTH_ERROR';
    else if (res.status === 429)                   cat = 'RATE_LIMIT';
    else if (res.status === 400)                   cat = 'BAD_REQUEST';
    const detail = `HTTP ${res.status}: ${txt.slice(0, 300)}`;
    console.error(`[ai-analysis] Groq ${cat}: ${detail}`);
    return { parsed: null, modelUsed: `groq/${GROQ_MODEL}`, errorCategory: cat, errorDetail: detail };
  }

  const body = await res.json();
  const rawText: string = body?.choices?.[0]?.message?.content ?? '';
  console.log(`[ai-analysis] Groq raw text length: ${rawText.length} chars`);
  const clean = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    console.log(`[ai-analysis] Groq OK — signals=${Array.isArray(parsed.signals) ? parsed.signals.length : 0}`);
    return { parsed, modelUsed: `groq/${GROQ_MODEL}`, errorCategory: null, errorDetail: '' };
  } catch (parseErr) {
    const detail = `Parse failed: ${String(parseErr)} | raw[0:200]: ${rawText.slice(0, 200)}`;
    console.warn(`[ai-analysis] Groq PARSING_ERROR: ${detail}`);
    return { parsed: null, modelUsed: `groq/${GROQ_MODEL}`, errorCategory: 'PARSING_ERROR', errorDetail: detail };
  }
}



interface CoinAIResult {
  pair: string;
  signals: Record<string, unknown>[];
  sentiment: { score: number; label: string };
  aiSource: 'openai' | 'groq' | 'cache';
}

// ─── Batch AI execution: ONE OpenAI call → Groq fallback ─────────────────────
// Strategy:
//   1. Separate cache hits (skip AI entirely)
//   2. Build ONE batch prompt covering all non-cached coins
//   3. Send ONE OpenAI request (not 20 individual calls)
//   4. If OpenAI fails → send same batch to Groq
//   5. Map AI signals back to per-coin results

async function runParallelAI(
  coins: CoinAnalysisData[],
  histMap: Map<string, PairHistory>,
  perfFeedback: string,
  openaiKey: string,
  groqKey: string | null,
  // Phase 4: live signals from current cache row for FRESHNESS guard
  liveSignals: Record<string, unknown>[],
  // v9: signal_history rows for DATA_DRIVEN_TPSL prompt + post-AI adjustment
  signalHistoryRows: HistoryRow[],
): Promise<{
  results: CoinAIResult[];
  cachedResults: CoinAIResult[];
  aiVerdicts: unknown[];
  diagnostics: {
    openaiCount: number;
    groqCount: number;
    cachedCount: number;
    freshnessHits: number;
    openaiErrorCategory: OpenAIErrorCategory;
    openaiErrorDetail: string;
    openaiRequestMs: number;
    promptMs: number;
    groqErrorCategory: GroqErrorCategory;
    groqErrorDetail: string;
    aiSuccess: number;
    aiTimeout: number;
    aiRateLimit: number;
    aiError: number;
    aiInvalidJson: number;
    aiVerdicts: unknown[];
  };
}> {
  const now = Date.now();
  const toAnalyze: CoinAnalysisData[] = [];
  const cachedResults: CoinAIResult[] = [];

  // Build a lookup of currently-FRESH (non-expired) live signals: pair → signal_type[]
  // Only signals still within their holding window count for the FRESHNESS guard.
  // STALE signals (past expires_at) are intentionally excluded — they do NOT block re-analysis.
  const liveSignalIndex = new Map<string, Set<string>>();
  const nowForIndex = Date.now();
  for (const sig of liveSignals) {
    const pair   = String(sig.pair ?? '');
    const dir    = String(sig.signal_type ?? '');
    const expStr = sig.expires_at ? String(sig.expires_at) : null;
    if (!pair || !dir) continue;
    // Only index FRESH signals (still within holding window)
    if (expStr && new Date(expStr).getTime() <= nowForIndex) continue; // STALE — skip
    if (!liveSignalIndex.has(pair)) liveSignalIndex.set(pair, new Set());
    liveSignalIndex.get(pair)!.add(dir);
  }

  // ── Step A: Separate cache hits + FRESHNESS guard ────────────────────────
  // Order of precedence (highest → lowest):
  //   1. FRESHNESS guard (Phase 4): pair has a still-LIVE signal of any direction
  //      AND the market state hash is unchanged → no new AI needed; preserve generatedAt.
  //   2. Phase 1 state-hash TTL cache: same hash, cache not expired, JSON stored.
  //   3. Otherwise: needs AI.
  for (const coin of coins) {
    const hist = histMap.get(coin.pair);

    // FRESHNESS guard: if we already have a live signal for this pair with the
    // same market state hash, skip re-analysis entirely. The existing signal's
    // generatedAt is preserved (not overwritten). STALE ≠ error; it simply means
    // the signal's holding window has elapsed naturally.
    const hasFreshLiveSignal = liveSignalIndex.has(coin.pair)
      && hist?.cache_state_hash === coin.state_hash;

    if (hasFreshLiveSignal && hist?.cached_signal_json) {
      const cached = hist.cached_signal_json;
      cachedResults.push({
        pair:      coin.pair,
        signals:   Array.isArray(cached.signals) ? (cached.signals as Record<string, unknown>[]) : [],
        sentiment: (cached.sentiment as { score: number; label: string }) ?? { score: 50, label: 'Neutral' },
        aiSource:  'cache',
      });
      console.log(`[ai-analysis] FRESHNESS hit: ${coin.pair} — live signal exists, state unchanged`);
      continue;
    }

    // Phase 1 TTL cache gate
    const cacheValid = hist?.cache_state_hash === coin.state_hash
      && hist?.cache_expires_at
      && new Date(hist.cache_expires_at).getTime() > now
      && hist?.cached_signal_json != null;

    if (cacheValid && hist!.cached_signal_json) {
      const cached = hist!.cached_signal_json;
      cachedResults.push({
        pair:      coin.pair,
        signals:   Array.isArray(cached.signals) ? (cached.signals as Record<string, unknown>[]) : [],
        sentiment: (cached.sentiment as { score: number; label: string }) ?? { score: 50, label: 'Neutral' },
        aiSource:  'cache',
      });
      console.log(`[ai-analysis] Cache hit: ${coin.pair}`);
    } else {
      toAnalyze.push(coin);
    }
  }

  console.log(`[ai-analysis] AI queue: ${toAnalyze.length} coins need analysis, ${cachedResults.length} from cache (incl. freshness hits)`);

  // ── Phase 1: PIPELINE_CACHE_FULL — skip AI entirely when all coins are cached ──
  // This is the primary optimization: on a 7-min follow-up scheduler run where market
  // state is stable, the AI call is completely avoided.
  if (toAnalyze.length === 0) {
    console.log(
      `[ai-analysis] PIPELINE_CACHE_FULL: all ${cachedResults.length} candidates served from cache — ` +
      `Gemini/Groq skipped entirely. AI_CACHE_TTL=22min THRESHOLD_PRICE=4% THRESHOLD_RSI=15pts`
    );
    // PHASE1_SUMMARY: before/after comparison (cache-full case)
    console.log(JSON.stringify({
      event: 'PHASE1_SUMMARY',
      ai_requested: false,
      ai_requests_sent: 0,
      cache_hits: cachedResults.length,
      cache_misses: 0,
      ai_ms: 0,
      note: 'Full cache hit — Gemini/Groq completely skipped this run',
    }));
    return {
      results: [],
      cachedResults,
      aiVerdicts: [],
      diagnostics: {
        openaiCount: 0, groqCount: 0, cachedCount: cachedResults.length,
        freshnessHits: cachedResults.length,
        openaiErrorCategory: null, openaiErrorDetail: '',
        openaiRequestMs: 0, promptMs: 0,
        groqErrorCategory: null, groqErrorDetail: '',
        aiSuccess: 0, aiTimeout: 0, aiRateLimit: 0, aiError: 0, aiInvalidJson: 0,
        aiVerdicts: [],
      },
    };
  }

  // ── Step B: Build ONE batch prompt covering all non-cached coins ─────────
  // This is the V5-proven approach: one request, one response, fast.
  const tPrompt = Date.now();
  const batchPrompt = buildBatchPrompt(toAnalyze, perfFeedback, signalHistoryRows);
  const promptMs = Date.now() - tPrompt;
  // Phase 1+4: show cache gate metrics before every AI call
  console.log(
    `[ai-analysis] Phase4 gate: ${cachedResults.length} cache/freshness hits, ${toAnalyze.length} misses → ` +
    `sending ${toAnalyze.length}/${coins.length} coins to AI (${batchPrompt.length} chars, ~${Math.round(batchPrompt.length/4)} tokens, built in ${promptMs}ms)`
  );
  // Phase 2: prompt token measurement
  console.log(JSON.stringify({
    event: 'PHASE2_PROMPT_STATS',
    coins_in_batch: toAnalyze.length,
    prompt_chars: batchPrompt.length,
    prompt_tokens_est: Math.round(batchPrompt.length / 4),
    prompt_build_ms: promptMs,
    note: 'Phase2: -recent_closes(-265tok) -MACD_verbose(-85tok) -reasoning_schema(-65tok) -perf_verbose(-69tok)',
  }));
  console.log(`[ai-analysis] Sending batch prompt for ${toAnalyze.length} coins to OpenAI`);

  // ── Step C: Try OpenAI (single batch call) ───────────────────────────────
  const { parsed: openaiParsed, errorCategory: openaiErrCat, errorDetail: openaiErrDetail,
    requestMs: openaiRequestMs } =
    await callOpenAIBatch(batchPrompt, openaiKey);

  let aiSignals: unknown[] = [];
  let aiVerdicts: unknown[] = [];
  let aiSentiment: { score: number; label: string } = { score: 50, label: 'Neutral' };
  let batchSource: 'openai' | 'groq' = 'openai';
  let openaiSucceeded = false;
  let groqSucceeded   = false;
  let groqErrCat: GroqErrorCategory = null;
  let groqErrDetail   = '';
  // Phase 4 error type tracking (each is 0 or 1 for this run)
  let aiTimeout    = 0;
  let aiRateLimit  = 0;
  let aiError      = 0;
  let aiInvalidJson = 0;

  if (openaiParsed !== null) {
    aiSignals      = Array.isArray(openaiParsed.signals) ? openaiParsed.signals : [];
    aiVerdicts     = Array.isArray((openaiParsed as Record<string, unknown>).verdicts) ? (openaiParsed as Record<string, unknown>).verdicts as unknown[] : [];
    aiSentiment    = openaiParsed.market_sentiment ?? { score: 50, label: 'Neutral' };
    batchSource    = 'openai';
    openaiSucceeded = true;
    console.log(`[ai-analysis] OpenAI produced ${aiSignals.length} signals, ${aiVerdicts.length} verdicts`);
  } else {
    // Track OpenAI error type for Phase 4 diagnostics
    if (openaiErrCat === 'TIMEOUT')        aiTimeout   = 1;
    else if (openaiErrCat === 'RATE_LIMIT') aiRateLimit = 1;
    else if (openaiErrCat === 'PARSING_ERROR' || openaiErrCat === 'INVALID_RESPONSE') aiInvalidJson = 1;
    else if (openaiErrCat !== null)         aiError     = 1;

    // ── Step D: OpenAI failed → whole batch to Groq immediately ─────────
    // CRITICAL: For RATE_LIMIT/AUTH_ERROR/BAD_REQUEST, OpenAI already broke out of its
    // retry loop — so we arrive here immediately with 0 delay (no 4+8+12s wasted).
    // A single AI failure NEVER stops the pipeline — Groq is tried, and if Groq also
    // fails the pipeline continues with cache-only results (zero signals is valid output).
    console.warn(`[ai-analysis] OpenAI failed (${openaiErrCat}) — trying Groq for full batch immediately`);
    if (groqKey) {
      const groqResult = await callGroqBatch(batchPrompt, groqKey);
      groqErrCat    = groqResult.errorCategory;
      groqErrDetail = groqResult.errorDetail;
      if (groqResult.parsed !== null) {
        aiSignals    = Array.isArray(groqResult.parsed.signals) ? groqResult.parsed.signals : [];
        aiVerdicts   = Array.isArray((groqResult.parsed as Record<string, unknown>).verdicts) ? (groqResult.parsed as Record<string, unknown>).verdicts as unknown[] : [];
        aiSentiment  = groqResult.parsed.market_sentiment ?? { score: 50, label: 'Neutral' };
        batchSource  = 'groq';
        groqSucceeded = true;
        // Groq success resets the error counters (OpenAI failed but Groq recovered)
        aiTimeout = 0; aiRateLimit = 0; aiError = 0; aiInvalidJson = 0;
        console.log(`[ai-analysis] Groq produced ${aiSignals.length} signals, ${aiVerdicts.length} verdicts`);
      } else {
        // Track Groq error type too (overrides OpenAI if different)
        if (groqErrCat === 'TIMEOUT')        aiTimeout   = 1;
        else if (groqErrCat === 'RATE_LIMIT') aiRateLimit = 1;
        else if (groqErrCat === 'PARSING_ERROR') aiInvalidJson = 1;
        else if (groqErrCat !== null)         aiError     = 1;
        console.error(`[ai-analysis] Groq also failed (${groqErrCat}): ${groqErrDetail}`);
        console.warn(`[ai-analysis] Both AI providers failed — pipeline continues with cache-only results`);
      }
    } else {
      console.warn('[ai-analysis] No GROQ_API_KEY configured — cannot fall back to Groq');
      groqErrCat    = 'AUTH_ERROR';
      groqErrDetail = 'GROQ_API_KEY not set';
    }
  }

  // ── Step E: Map batch signals back to per-coin CoinAIResult ─────────────
  // Build a lookup from pair → signals from the batch response
  const pairSignalMap = new Map<string, Record<string, unknown>[]>();
  for (const sig of aiSignals) {
    const s   = sig as Record<string, unknown>;
    const pair = String(s.pair ?? '');
    if (!pair) continue;
    if (!pairSignalMap.has(pair)) pairSignalMap.set(pair, []);
    pairSignalMap.get(pair)!.push(s);
  }

  const results: CoinAIResult[] = toAnalyze.map(coin => ({
    pair:      coin.pair,
    signals:   pairSignalMap.get(coin.pair) ?? [],
    sentiment: aiSentiment,
    aiSource:  batchSource,
  }));

  const openaiCount = openaiSucceeded ? toAnalyze.length : 0;
  // groqCount = number of candidates that Groq actually analyzed
  const groqCount   = groqSucceeded   ? toAnalyze.length : 0;

  // Phase 1+4 combined summary log
  console.log(JSON.stringify({
    event: 'PHASE1_SUMMARY',
    ai_requested: true,
    ai_requests_sent: 1,  // always 1 batch call
    cache_hits: cachedResults.length,
    cache_misses: toAnalyze.length,
    total_candidates: coins.length,
    openai_succeeded: openaiSucceeded,
    groq_fallback: groqSucceeded,
    openai_request_ms: openaiRequestMs,
    signals_from_ai: aiSignals.length,
    ai_timeout: aiTimeout,
    ai_rate_limit: aiRateLimit,
    ai_error: aiError,
    ai_invalid_json: aiInvalidJson,
    note: cachedResults.length > 0
      ? `Partial cache: ${cachedResults.length} coins skipped AI, ${toAnalyze.length} sent to AI`
      : `No cache hits: all ${toAnalyze.length} coins sent to AI`,
  }));

  return {
    results,
    cachedResults,
    aiVerdicts,
    diagnostics: {
      openaiCount,
      groqCount,
      cachedCount:              cachedResults.length,
      freshnessHits:            cachedResults.length,
      openaiErrorCategory:      openaiSucceeded ? null : openaiErrCat,
      openaiErrorDetail:        openaiSucceeded ? '' : openaiErrDetail,
      openaiRequestMs,
      promptMs,
      groqErrorCategory:        groqErrCat,
      groqErrorDetail:          groqErrDetail,
      aiSuccess:                (openaiSucceeded || groqSucceeded) ? 1 : 0,
      aiTimeout,
      aiRateLimit,
      aiError,
      aiInvalidJson,
      aiVerdicts,
    },
  };
}

interface PatternStat {
  signal_type: string;
  total: number;
  wins: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
  avg_winning_confidence: number | null;
  avg_losing_confidence: number | null;
  avg_rsi_win: number | null;
  avg_rsi_loss: number | null;
}

async function loadPerformanceFeedback(db: ReturnType<typeof createClient>): Promise<string> {
  try {
    const [
      { data: summary },
      { data: patterns },
      { data: byAI },
      { data: byConf },
    ] = await Promise.all([
      db.from('signal_performance_summary').select('*').maybeSingle(),
      db.from('signal_pattern_performance').select('*'),
      db.from('signal_performance_by_ai_source').select('*'),
      db.from('signal_performance_by_confidence').select('*'),
    ]);

    // Require at least 10 resolved signals before influencing prompts
    const total = (summary as { total_signals?: number } | null)?.total_signals ?? 0;
    if (total < 10) return '';

    const s = summary as {
      total_signals: number; wins: number; losses: number;
      win_rate_pct: number; avg_return_pct: number | null;
      best_trade_pct: number | null; total_pl_usdt: number | null;
    };

    const patternLines = ((patterns ?? []) as PatternStat[])
      .filter(p => p.total >= 5)
      .map(p =>
        `  ${p.signal_type}: ${p.total} signals, ${p.win_rate_pct}% win rate, ` +
        `avg return ${p.avg_return_pct ?? 'n/a'}%, ` +
        `winning RSI avg=${p.avg_rsi_win ?? 'n/a'}, losing RSI avg=${p.avg_rsi_loss ?? 'n/a'}, ` +
        `winning confidence avg=${p.avg_winning_confidence ?? 'n/a'}`
      ).join('\n');

    type AIStat = { ai_source: string; total: number; win_rate_pct: number; avg_return_pct: number | null };
    const aiLines = ((byAI ?? []) as AIStat[])
      .filter(a => a.total >= 3)
      .map(a => `  ${a.ai_source}: ${a.total} signals, ${a.win_rate_pct}% win rate, avg return ${a.avg_return_pct ?? 'n/a'}%`)
      .join('\n');

    type ConfStat = { confidence_range: string; total: number; win_rate_pct: number; avg_return_pct: number | null };
    const confLines = ((byConf ?? []) as ConfStat[])
      .filter(c => c.total >= 3)
      .map(c => `  Confidence ${c.confidence_range}: ${c.total} signals, ${c.win_rate_pct}% win rate, avg return ${c.avg_return_pct ?? 'n/a'}%`)
      .join('\n');

    // Phase 2: removed "By AI source" block (AI doesn't need to know which model generated past signals).
    // Condensed NOTE to a single line. Saves ~30–40 tokens per run.
    return `
PERF(${total}): wins=${s.wins} losses=${s.losses} wr=${s.win_rate_pct}% avgReturn=${s.avg_return_pct ?? 'n/a'}%
${patternLines ? `Patterns:\n${patternLines}` : ''}
${confLines   ? `ByConf:\n${confLines}` : ''}
Use patterns to calibrate confidence/TP/SL. Do NOT copy past signals.
`;
  } catch {
    return '';
  }
}

// ─── V158: Batch prompt — AI confirmation of pre-scored candidates ────────────
//
// V158 CHANGE: The server has already computed ALL quantitative analysis across
// 71 coins. Only TOP 5 candidates reach AI. AI's job is ONLY the final setup
// filter:
//   1. Return RECOMMENDED / WATCH / NO_TRADE per candidate
//   2. Provide a concise reason for WATCH / NO_TRADE
//   3. Provide entry/TP/SL/RR for RECOMMENDED signals
//
// AI does NOT compute: historical stats, win rate, avg P/L, MFE/MAE, RR,
// technical indicators, or final score. All of that is in the provided breakdown.
//
// Rules preserved:
//   - RECOMMENDED requires server final score >= 75
//   - confidence >= 65 and strength >= 65 (server-derived from final score)
//   - RR >= 1.5
//   - Entry ±1.5% of price, SL 1.5–2.5%, TP1 2–3% (or use TPSL engine)
//   - 0–MAX_SIGNALS signals per batch
//   - "pair" field MUST match label exactly

// ─── V158: Dynamic TP/SL block (used in prompt) ───────────────────────────────
function buildDynamicTpSlBlock(
  mfeP50: number,
  mfeP90: number,
  tp1HitRate: number,
  slHitRate:  number,
  expiredRate: number,
  sampleN:    number,
): string {
  const tp1Cap     = Math.min(5.0, Math.max(2.0, mfeP90)).toFixed(1);
  const hitPct     = (tp1HitRate * 100).toFixed(0);
  const slHitPct   = (slHitRate  * 100).toFixed(0);
  const expiredPct = (expiredRate * 100).toFixed(0);
  return `TP/SL RULES(n=${sampleN}): MFE_P50=${mfeP50.toFixed(2)}% MFE_P90=${mfeP90.toFixed(2)}% TP1hit=${hitPct}% SLhit=${slHitPct}% Exp=${expiredPct}%
TP1≤${tp1Cap}% unless ATR justifies. SL=1.5–2.5%. SL<1%→-5str. SL>5%→-3str.
TP1≤${mfeP50.toFixed(1)}%→+3str. TP1≤${mfeP90.toFixed(1)}%→+0. TP1≤5%→-5. TP1≤10%→-10. TP1>10%→-20. Apply to signal_strength.`;
}

// V158: Accept LocalScoredCoin (superset of CoinAnalysisData) so the prompt can
// include the transparent recommendation breakdown for each candidate.
function buildBatchPrompt(
  coins: CoinAnalysisData[],
  perfFeedback = '',
  historyRows: HistoryRow[] = [],
): string {
  const coinDataBlock = coins.map((c, i) => {
    const rec = c.recommendation;
    const recCtx = rec
      ? ` | FinalScore:${rec.confidence} ServerVerdict:${rec.server_verdict} Local:${rec.local_score} Historical:${rec.historical_score} WR:${rec.win_rate ?? 'n/a'}% AvgPL:${rec.avg_pl_pct ?? 'n/a'}% MFE/MAE:${rec.mfe_mae_label} RR:${rec.rr} Conf:${rec.confidence} Str:${rec.strength} Fresh:${rec.fresh ? 'YES' : 'NO'} Regime:${rec.market_regime}`
      : ` | LocalScore:${c.local_score ?? 'n/a'} Regime:${c.market_regime ?? 'UNKNOWN'} Bias:${c.signal_bias ?? 'NEUTRAL'} RR≈${c.estimated_rr ?? '?'}`;
    return `[${i + 1}]${c.pair} ${c.coin_name}${recCtx}
P:$${c.price} O:$${c.open_24h} H:$${c.high_24h} L:$${c.low_24h} Chg:${c.change_pct_24h.toFixed(2)}% Vol:$${(c.volume_24h_usdt / 1e6).toFixed(2)}M
RSI:${c.rsi_14} EMA9:$${c.ema_9}(${c.price_vs_ema9}) EMA21:$${c.ema_21}(${c.price_vs_ema21}) MACD:${c.macd_line}/${c.macd_signal}/${c.macd_histogram}
Sup:$${c.support_level} Res:$${c.resistance_level} Mom:${c.momentum}`;
  }).join('\n');

  // TP_FEASIBILITY: build dynamically from live history or fall back to hard-coded constants
  let tpFeasibilityBlock: string;
  if (DATA_DRIVEN_TPSL && historyRows.length >= 10) {
    const allRows = historyRows;
    const mfeVals: number[] = [];
    for (const r of allRows) {
      if (r.result === 'WIN' && r.pl_pct != null && r.pl_pct > 0) mfeVals.push(r.pl_pct);
    }
    mfeVals.sort((a, b) => a - b);
    const mfeP50All = mfeVals.length > 0 ? mfeVals[Math.floor(mfeVals.length * 0.50)] : 2.50;
    const mfeP90All = mfeVals.length > 0 ? mfeVals[Math.floor(mfeVals.length * 0.90)] : 3.03;
    const marketStats = buildHistoricalStats(historyRows, '__ALL__', '__ALL__');
    tpFeasibilityBlock = buildDynamicTpSlBlock(
      mfeP50All, mfeP90All,
      marketStats.tp1_hit_rate, marketStats.sl_hit_rate, marketStats.expired_rate,
      historyRows.length,
    );
  } else {
    tpFeasibilityBlock = `TP/SL RULES(n=286): MFE_P50=2.50% MFE_P90=3.03% TP1hit=30% SLhit=21% Exp=49%
TP1≤3.0% unless ATR justifies. SL=1.5–2.5%. SL<1%→-5str. SL>5%→-3str.
TP1≤2.5%→+3str. TP1≤3.0%→+0. TP1≤5%→-5. TP1≤10%→-10. TP1>10%→-20. Apply to signal_strength.`;
  }

  // V149 PROMPT: AI confirms pre-scored candidates only.
  // Each candidate has already passed local numerical scoring (LocalScore shown above).
  // AI adds qualitative judgment: pattern quality, setup strength, market context.
  // AI returns RECOMMENDED / WATCH / NO_TRADE per coin + full signal JSON for tradeable ones.
  return `Crypto trading analyst. These ${coins.length} coins were PRE-SELECTED and PRE-SCORED by the server from a universe of 71 coins. The server has already computed ALL technical indicators, historical stats, win rate, P/L, MFE/MAE, RR, and a final recommendation score. Do NOT recompute these. Your job is ONLY final setup filter: confirm or reject each candidate.

RULES:
- For each coin, return ONLY a verdict: "RECOMMENDED", "WATCH", or "NO_TRADE".
- Only produce a full signal entry for RECOMMENDED coins.
- If server verdict is RECOMMENDED but you disagree, you may set WATCH or NO_TRADE with a reason.
- If server verdict is NO_TRADE, you MUST NOT set RECOMMENDED.
- Minimum server final score for RECOMMENDED is 75.
- For WATCH/NO_TRADE, include a concise reason based on the breakdown below.
- "pair" MUST match label exactly.
${tpFeasibilityBlock}
${perfFeedback}CANDIDATES(${coins.length}):
${coinDataBlock}

JSON only (no markdown):
{"signals":[{"symbol":"ETH","pair":"ETH/USDT","signal_type":"BUY","verdict":"RECOMMENDED","confidence":72,"entry_zone_low":3180.00,"entry_zone_high":3210.00,"take_profit_1":3280.00,"stop_loss":3120.00,"holding_time":"6-12 hours","signal_strength":71,"reasoning":{"conclusion":"ETH setup confirmed."}}],"verdicts":[{"pair":"BTC/USDT","verdict":"WATCH","reason":"Server historical score 42/100, weak win rate 35%, 63 samples"},{"pair":"SOL/USDT","verdict":"NO_TRADE","reason":"RR 1.2 below 1.5 minimum"}],"market_sentiment":{"score":58,"label":"Greed"}}`;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  const apiKeyHeader = req.headers.get('apikey');
  if (!authHeader && !apiKeyHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── V192: parse request body for source + live-trigger user_id ───────────
  let reqSource = 'unknown';
  let reqUserId: string | null = null;
  let reqDryRun = false;
  try {
    if (req.method === 'POST') {
      const rb = await req.clone().json().catch(() => ({}));
      reqSource  = String(rb?.source  ?? 'unknown');
      reqUserId  = rb?._user_id ? String(rb._user_id) : null;
      reqDryRun  = rb?.dry_run === true;
    }
  } catch { /* ignore */ }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const getCached = async () => {
    const { data } = await db.from('ai_signals_cache').select('*').eq('id', 'global').maybeSingle();
    return data;
  };

  const diag: Diagnostics = {
    total_duration_ms: 0, market_fetch_ms: 0, screening_ms: 0,
    indicator_ms: 0, klines_ms: 0, db_load_ms: 0,
    selection_ms: 0, prompt_ms: 0,
    ai_ms: 0, openai_request_ms: 0, openai_response_ms: 0, db_write_ms: 0,
    // Phase 4 counters
    market_pairs_scanned: 0,
    candidates_filtered: 0,
    candidates_sent_to_ai: 0,
    ai_cache_hits: 0,
    ai_cache_misses: 0,
    ai_success: 0,
    ai_timeout: 0,
    ai_rate_limit: 0,
    ai_error: 0,
    ai_invalid_json: 0,
    signals_created: 0,
    fresh_signals: 0,
    stale_signals: 0,
    best_current_setup: 'NONE',
    // Legacy counters (backwards compat)
    total_pairs_available: 0, pairs_prescreened: 0, pairs_sent_to_ai: 0,
    pairs_cached: 0, pairs_new_analysis: 0, pairs_exploration: 0,
    openai_count: 0, groq_count: 0, signals_generated: 0,
    openai_error_category: null, openai_error_detail: '',
    groq_error_category: null, groq_error_detail: '',
  };
  const t0 = Date.now();

  try {
    // ── Step 1: Fetch ALL Pionex tickers once ────────────────────────────
    const tFetch0 = Date.now();
    const { tickers, fetchMs } = await fetchAllTickers();
    diag.market_fetch_ms = fetchMs;
    console.log(`[ai-analysis] Fetched ${tickers.length} tickers in ${fetchMs}ms`);

    // ── Step 2: Local pre-screening (momentum filter → top MAX_PRESCREENED) ──
    const tScreen0 = Date.now();
    const { candidates, totalPairs } = screenTickers(tickers, MAX_PRESCREENED);
    diag.total_pairs_available = totalPairs;
    diag.market_pairs_scanned  = totalPairs;
    diag.pairs_prescreened     = candidates.length;
    diag.screening_ms          = Date.now() - tScreen0;
    console.log(`[ai-analysis] Pre-screened: ${candidates.length}/${totalPairs} USDT pairs passed`);

    if (candidates.length === 0) throw new Error('No valid Pionex USDT pairs found after filtering');

    // ── Step 3: Fetch klines + compute full indicators (parallel batches) ─
    // CONCURRENCY=12 means 60 candidates complete in 5 rounds (~20-25s vs ~50-60s at CONCURRENCY=5)
    const tInd0 = Date.now();
    const tKlines0 = Date.now();
    const settledCoins: PromiseSettledResult<CoinAnalysisData | null>[] = [];
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = await Promise.allSettled(candidates.slice(i, i + CONCURRENCY).map(buildCoinData));
      settledCoins.push(...batch);
    }
    diag.klines_ms = Date.now() - tKlines0;
    const allCoins = settledCoins
      .filter((r): r is PromiseFulfilledResult<CoinAnalysisData> => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);
    diag.indicator_ms = Date.now() - tInd0;
    console.log(`[ai-analysis] Klines+indicators: ${diag.indicator_ms}ms (klines: ${diag.klines_ms}ms) for ${allCoins.length} coins`);
    if (allCoins.length === 0) throw new Error('Could not build indicator data from Pionex klines');

    // ── Step 4: Load pair history for rotation + cache checks ────────────
    const tSel0 = Date.now();
    const pairKeys = allCoins.map(c => c.pair);
    const tDbLoad = Date.now();
    const { data: histRows } = await db
      .from('pair_analysis_history')
      .select('*')
      .in('pair', pairKeys);
    diag.db_load_ms = Date.now() - tDbLoad;
    const histMap = new Map<string, PairHistory>(
      ((histRows ?? []) as PairHistory[]).map(h => [h.pair, h])
    );

    // ── Step 5: V149 LOCAL SCORING ENGINE ────────────────────────────────
    // Score ALL coins across 10 dimensions using local_scorer.ts.
    // This replaces the old candidateScore + fastDeterministicFilter combo.
    // All coins get indicators computed and a LocalScore 0–100.
    // Legacy candidateScore still runs for pair_analysis_history bookkeeping.
    const tLocalScore0 = Date.now();

    // Build pairHistMap for local scorer staleness dimension
    const pairHistMap = new Map<string, PairHistoryMeta>();
    for (const [pair, h] of histMap) {
      pairHistMap.set(pair, {
        pair,
        last_analyzed_at:  h.last_analyzed_at ?? null,
        times_analyzed:    h.times_analyzed   ?? 0,
        recent_win_count:  h.recent_win_count  ?? 0,
        recent_loss_count: h.recent_loss_count ?? 0,
      });
    }

    // Load signal_history for local scoring (historical perf + MFE/MAE dimensions)
    // This is the SAME query used later for DATA_DRIVEN_TPSL — do it once here.
    let signalHistoryForTPSL: HistoryRow[] = [];
    try {
      const { data: shRows } = await db
        .from('signal_history')
        .select('pair,signal_type,result,pl_pct,confidence,signal_strength,take_profit_1,entry_price,entry_zone_low,stop_loss,exit_price,expired_class,generated_at')
        .in('result', ['WIN', 'LOSS', 'EXPIRED'])
        .order('generated_at', { ascending: false })
        .limit(500);
      signalHistoryForTPSL = (shRows ?? []) as HistoryRow[];
      // V158: local_scorer now uses the full HistoryRow[] directly so it can compute
      // both the legacy local history dimensions and the new recommendation score.
      console.log(`[ai-analysis] V158: loaded ${signalHistoryForTPSL.length} history rows for local scoring + TPSL + recommendation scoring`);
    } catch (e) {
      console.warn('[ai-analysis] V158: history load failed, using fallback', String(e));
    }

    // Also update legacy candidateScore for pair_analysis_history bookkeeping
    const scoredCoins = allCoins.map(coin => {
      const hist     = histMap.get(coin.pair) ?? null;
      const stateChg = hist ? hasMarketStateChanged(coin, hist) : false;
      const score    = candidateScore(coin, hist, stateChg);
      return { ...coin, candidate_score: score };
    });

    // V158: Run full local scoring + recommendation scoring engine on ALL coins
    const localScored: LocalScoredCoin[] = localScoreCoins(
      scoredCoins as CoinInput[],
      signalHistoryForTPSL,
      pairHistMap,
    );
    const localScoreMs = Date.now() - tLocalScore0;
    console.log(`[ai-analysis] V158 local scoring: ${localScored.length} coins in ${localScoreMs}ms`);
    console.log(
      `[ai-analysis] V158 top-5 local scores: ` +
      localScored.slice(0, 5).map(c => `${c.pair}=${c.local_score}(${c.market_regime}/${c.signal_bias})`).join(' ')
    );
    console.log(
      `[ai-analysis] V158 top-5 recommendation scores: ` +
      localScored.slice(0, 5).map(c => `${c.pair}=${c.recommendation?.server_verdict ?? 'NONE'}(hist=${c.recommendation?.historical_score ?? 0})`).join(' ')
    );

    // V158: lookup map for server-side recommendation breakdown per AI candidate
    const recommendationMap = new Map<string, RecommendationBreakdown | null>();
    for (const c of localScored) {
      recommendationMap.set(c.pair, c.recommendation ?? null);
    }

    // ── V2: Build local_setups snapshot ────────────────────────────────────
    // Classify ALL scored coins into setup tiers; emit ALL qualified setups.
    // Only AI candidates are marked sent_to_ai=true.
    type SetupTier = 'STRONG_SETUP' | 'GOOD_SETUP' | 'WATCH' | 'EXPLORATION';
    function classifySetupTier(coin: LocalScoredCoin): SetupTier {
      const verdict = coin.recommendation?.server_verdict ?? 'NO_TRADE';
      const score   = coin.local_score;
      if (verdict === 'RECOMMENDED' && score >= 70) return 'STRONG_SETUP';
      if (verdict === 'RECOMMENDED' || (verdict === 'WATCH' && score >= 60)) return 'GOOD_SETUP';
      if (verdict === 'WATCH') return 'WATCH';
      return 'EXPLORATION';
    }

    const aiCandidatePairs = new Set<string>();
    // We'll fill this after selectAICandidates below; for now collect all qualified coins.
    const qualifiedSetups = localScored.filter(c => {
      const verdict = c.recommendation?.server_verdict ?? 'NO_TRADE';
      return verdict !== 'NO_TRADE' || c.local_score >= 55;
    });

    diag.local_setups_count  = localScored.length;
    diag.qualified_count     = qualifiedSetups.length;
    diag.strong_setups_count = qualifiedSetups.filter(c =>
      (c.recommendation?.server_verdict ?? '') === 'RECOMMENDED' && c.local_score >= 70
    ).length;

    // ── Step 6: V158 — Select TOP 5 candidates for AI ─────────────────────
    // selectAICandidates() picks highest local_score coins + ensures exploration slots.
    // This replaces Phase 4 fastDeterministicFilter + split logic entirely.
    const tSel6 = Date.now();
    const aiCandidatesLocal: LocalScoredCoin[] = selectAICandidates(
      localScored,
      AI_CANDIDATE_LIMIT,
      EXPLORE_AI_SLOTS,
    );

    // Mark exploration coins (those from explore slots) for pair_analysis_history
    const exploreSet = new Set(
      aiCandidatesLocal
        .filter(c => c.is_exploration || c.score_breakdown.staleness_bonus >= 5)
        .map(c => c.pair)
    );
    const aiCandidates: CoinAnalysisData[] = aiCandidatesLocal.map(c => ({
      ...c,
      is_exploration: exploreSet.has(c.pair),
    }));

    // Mark which pairs were sent to AI for local_setups snapshot
    for (const c of aiCandidates) aiCandidatePairs.add(c.pair);

    // Build local_setups array (ALL qualified coins, AI candidates flagged)
    const localSetupsSnapshot = qualifiedSetups.map(c => ({
      pair:            c.pair,
      symbol:          c.symbol,
      coin_name:       c.coin_name,
      price:           c.price,
      change_pct_24h:  c.change_pct_24h,
      signal_type:     (c.signal_bias === 'SELL_BIAS' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
      local_score:     c.local_score,
      market_regime:   c.market_regime,
      estimated_rr:    c.estimated_rr,
      atr_pct:         c.atr_pct,
      rsi_14:          c.rsi_14,
      momentum:        c.momentum,
      hist_win_rate:   c.hist_win_rate,
      hist_avg_pl:     c.hist_avg_pl,
      hist_sample_n:   c.hist_sample_n,
      setup_tier:      classifySetupTier(c),
      server_verdict:  (c.recommendation?.server_verdict ?? 'NO_TRADE') as 'RECOMMENDED' | 'WATCH' | 'NO_TRADE',
      sent_to_ai:      aiCandidatePairs.has(c.pair),
      score_breakdown: c.score_breakdown,
      recommendation:  c.recommendation ? {
        local_score:       c.recommendation.local_score,
        historical_score:  c.recommendation.historical_score,
        win_rate:          c.recommendation.win_rate,
        avg_pl_pct:        c.recommendation.avg_pl_pct,
        mfe_mae_label:     c.recommendation.mfe_mae_label,
        rr:                c.recommendation.rr,
        confidence:        c.recommendation.confidence,
        strength:          c.recommendation.strength,
        market_regime:     c.recommendation.market_regime,
        server_verdict:    c.recommendation.server_verdict,
        reason:            c.recommendation.reason,
      } : null,
    }));

    diag.pairs_exploration     = aiCandidates.filter(c => c.is_exploration).length;
    diag.candidates_filtered   = localScored.length - aiCandidates.length;
    diag.pairs_sent_to_ai      = aiCandidates.length;
    diag.candidates_sent_to_ai = aiCandidates.length;
    diag.selection_ms          = Date.now() - tSel0;

    console.log(
      `[ai-analysis] V149 candidate selection: ${localScored.length} scored → ` +
      `${aiCandidates.length} sent to AI (${Date.now() - tSel6}ms)`
    );
    console.log(`[ai-analysis] AI pairs: ${aiCandidates.filter(c => !c.is_exploration).map(c => c.pair).join(', ')}`);
    const expPairs = aiCandidates.filter(c => c.is_exploration).map(c => c.pair);
    if (expPairs.length) console.log(`[ai-analysis] Exploration AI pairs: ${expPairs.join(', ')}`);

    // ── Step 7: Build market data snapshot ───────────────────────────────
    const now = new Date().toISOString();
    const marketDataSnapshot: Record<string, unknown> = {};
    for (const c of allCoins) {
      marketDataSnapshot[c.pair] = {
        symbol: c.symbol, pair: c.pair, coin_name: c.coin_name,
        price: c.price, change_24h: c.change_24h, change_pct_24h: c.change_pct_24h,
        volume_24h: c.volume_24h_usdt, high_24h: c.high_24h, low_24h: c.low_24h,
        rsi_14: c.rsi_14, ema_9: c.ema_9, ema_21: c.ema_21,
        macd_histogram: c.macd_histogram, momentum: c.momentum,
        support_level: c.support_level, resistance_level: c.resistance_level,
        sparkline: c.sparkline, source: 'pionex',
      };
    }

    // Persist scan stats before AI (so frontend sees progress even on AI failure)
    // Also capture this as our "existing cache" — reuse in Step 11 to avoid a second DB read.
    const tDbPre = Date.now();
    await db.from('ai_signals_cache').upsert({
      id: 'global',
      pairs_scanned: totalPairs,
      analyzed_count: aiCandidates.length,
      market_data: marketDataSnapshot,
      updated_at: now,
    }, { onConflict: 'id' });
    console.log(`[ai-analysis] Pre-AI cache upsert: ${Date.now() - tDbPre}ms`);

    // Fetch existing cached signals once here — reused in Step 11 (no second DB call)
    const tCacheRead = Date.now();
    const existingCacheRow = await getCached();
    console.log(`[ai-analysis] Existing cache read: ${Date.now() - tCacheRead}ms`);

    // ── Step 8: Parallel AI analysis with OpenAI → Groq fallback ───────────────
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? null;
    if (!openaiKey) {
      console.error('[ai-analysis] OPENAI_API_KEY not configured — cannot call primary AI');
    }
    const groqKey = Deno.env.get('GROQ_API_KEY') ?? null;
    const perfFeedback = await loadPerformanceFeedback(db);
    const tAI0 = Date.now();

    // Phase 4: pass currently-live signals for FRESHNESS guard
    const currentLiveSignals: Record<string, unknown>[] = Array.isArray(existingCacheRow?.signals)
      ? (existingCacheRow.signals as Record<string, unknown>[])
      : [];

    // V149: signal_history already loaded in Step 5 (localHistRows / signalHistoryForTPSL)
    // No need for a second DB query here.

    // V158: Pass local-scored candidates to runParallelAI.
    // aiCandidates already contains local_score, recommendation breakdown, and server verdict.
    // buildBatchPrompt will include the server-computed breakdown and AI returns verdicts.
    const { results: aiResults, cachedResults, aiVerdicts, diagnostics: aiDiag } =
      await runParallelAI(aiCandidates, histMap, perfFeedback, openaiKey ?? '', groqKey, currentLiveSignals, signalHistoryForTPSL);

    diag.ai_ms              = Date.now() - tAI0;
    diag.openai_count       = aiDiag.openaiCount;
    diag.groq_count         = aiDiag.groqCount;
    diag.pairs_cached       = aiDiag.cachedCount;
    diag.pairs_new_analysis = aiResults.length;
    diag.openai_error_category = aiDiag.openaiErrorCategory;
    diag.openai_error_detail   = aiDiag.openaiErrorDetail;
    diag.openai_request_ms     = aiDiag.openaiRequestMs;
    diag.openai_response_ms    = 0; // not streaming
    diag.prompt_ms             = aiDiag.promptMs;
    diag.groq_error_category   = aiDiag.groqErrorCategory;
    diag.groq_error_detail     = aiDiag.groqErrorDetail;
    // Phase 4 AI-stage counters
    diag.ai_cache_hits   = aiDiag.cachedCount;
    diag.ai_cache_misses = aiResults.length;
    diag.ai_success      = aiDiag.aiSuccess;
    diag.ai_timeout      = aiDiag.aiTimeout;
    diag.ai_rate_limit   = aiDiag.aiRateLimit;
    diag.ai_error        = aiDiag.aiError;
    diag.ai_invalid_json = aiDiag.aiInvalidJson;
    diag.ai_verdicts = aiVerdicts;
    console.log(`[ai-analysis] AI stage: ${diag.ai_ms}ms openai_err=${diag.openai_error_category ?? 'none'} groq_err=${diag.groq_error_category ?? 'none'}`);

    const allAIResults = [...aiResults, ...cachedResults];

    // Determine overall ai_source (primary source used in this run)
    const aiSource: 'openai' | 'groq' =
      aiDiag.openaiCount > 0 ? 'openai' : 'groq';
    const modelUsed = aiDiag.openaiCount > 0
      ? `openai/${OPENAI_MODEL}`
      : `groq/${GROQ_MODEL}`;

    // openai_status maps to exact error category or 'connected'
    const geminiStatus: string = aiDiag.openaiCount > 0
      ? 'connected'
      : (aiDiag.openaiErrorCategory ?? 'error');

    // ── Step 9: Collect + validate signals ───────────────────────────────
    const priceMap: Record<string, number> = {};
    const changeMap: Record<string, number> = {};
    // Build ATR map from kline data for volatility-aware TP/SL
    const atrMap: Record<string, number> = {};
    for (const c of allCoins) {
      priceMap[c.pair]  = c.price;
      changeMap[c.pair] = c.change_24h;
      // ATR approximation from 24h High/Low when full klines not available
      if (c.price > 0) {
        const hl = c.high_24h - c.low_24h;
        atrMap[c.pair] = (hl / c.price) * 100;
      }
    }

    const rawSignals: Record<string, unknown>[] = [];
    for (const result of allAIResults) {
      for (const sig of result.signals) {
        const pair       = String(sig.pair ?? '');
        const sigType    = String(sig.signal_type ?? 'BUY') as 'BUY' | 'SELL';
        const entryPrice = priceMap[pair] ?? (typeof sig.current_price === 'number' ? sig.current_price : 0);

        if (priceMap[pair] !== undefined) {
          sig.current_price    = priceMap[pair];
          sig.price_change_24h = changeMap[pair] ?? 0;
        }

        // ── v9: DATA_DRIVEN_TPSL post-AI adjustment ───────────────────────
        if (DATA_DRIVEN_TPSL && entryPrice > 0 && signalHistoryForTPSL.length > 0) {
          try {
            const stats  = buildHistoricalStats(signalHistoryForTPSL, pair, sigType);
            const atrPct = atrMap[pair] ?? 2.0;
            const dynTPSL = computeDynamicTPSL(entryPrice, sigType, stats, atrPct, pair);

            // Log the adjustment
            for (const line of dynTPSL.log) console.log(line);
            console.log(`[TP_MODEL] pair=${pair} old_tp1=${sig.take_profit_1} old_sl=${sig.stop_loss} → new_tp1=${dynTPSL.tp1} new_sl=${dynTPSL.sl} rr=${dynTPSL.rr} model=${dynTPSL.model}`);

            // Only apply if RR passes — otherwise keep AI-suggested levels
            if (dynTPSL.rr_pass) {
              sig.take_profit_1 = dynTPSL.tp1;
              sig.take_profit_2 = dynTPSL.tp2;
              sig.stop_loss     = dynTPSL.sl;
              sig.risk_reward   = dynTPSL.rr.toFixed(2);
              sig._tpsl_model   = dynTPSL.model;
              sig._tp_feasibility = dynTPSL.tp_feasibility;
            } else {
              console.log(`[RR_CHECK] pair=${pair} RR=${dynTPSL.rr} below min ${1.5} — keeping AI levels`);
              sig._tpsl_model = 'AI_OVERRIDE';
            }
          } catch (e) {
            console.warn(`[TP_MODEL_FALLBACK] pair=${pair} dynamic TP/SL failed: ${String(e)}`);
          }
        }

        // ── v10: Hard cap — always runs, regardless of rr_pass or DATA_DRIVEN_TPSL ─
        if (entryPrice > 0) {
          applyTPSLCap(sig, entryPrice, pair, sigType);
        }

        // V158: Inject server-computed recommendation breakdown into the signal.
        // AI must not compute historical stats/RR/confidence; the server provides
        // the transparent breakdown and the objective server verdict.
        const serverRec = recommendationMap.get(pair);
        if (serverRec) {
          sig.recommendation_score = serverRec.confidence;
          sig.recommendation_breakdown = serverRec;
          sig.server_verdict = serverRec.server_verdict;
          // AI confidence/strength no longer overrides the server score; if AI
          // verdict differs, the reason is still based on the server breakdown.
          if (sig.confidence === undefined || sig.confidence === null || Number(sig.confidence) < 1) {
            sig.confidence = serverRec.confidence;
          }
          if (sig.signal_strength === undefined || sig.signal_strength === null || Number(sig.signal_strength) < 1) {
            sig.signal_strength = serverRec.strength;
          }
          // Concrete reason for WATCH/NO_TRADE
          if (sig.verdict === 'WATCH' || sig.verdict === 'NO_TRADE') {
            const reason = serverRec.reason;
            sig.reasoning = typeof sig.reasoning === 'object' && sig.reasoning !== null
              ? { ...(sig.reasoning as Record<string, unknown>), conclusion: reason }
              : { conclusion: reason };
          }
        }

        rawSignals.push({
          ...sig,
          id: `sig_${pair.replace('/', '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          generated_at: now,
          expires_at:   new Date(Date.now() + holdingTimeToMs(sig.holding_time != null ? String(sig.holding_time) : null)).toISOString(),
          ai_source: result.aiSource,
        });
      }
    }
    const signals = rawSignals.slice(0, MAX_SIGNALS);
    diag.signals_generated = signals.length;
    diag.signals_created   = signals.length;

    // ── Step 10: Update AI result cache in pair_analysis_history ─────────
    const nowTs = Date.now();
    const historyUpdates = aiCandidates.map(coin => {
      const result    = allAIResults.find(r => r.pair === coin.pair);
      const coinSigs  = result?.signals ?? [];
      const firstSig  = coinSigs[0] as Record<string, unknown> | undefined;
      const hist      = histMap.get(coin.pair);

      const cachePayload = coinSigs.length > 0
        ? { signals: coinSigs, sentiment: result?.sentiment }
        : null;

      return {
        pair:                coin.pair,
        symbol:              coin.symbol,
        last_analyzed_at:    new Date(nowTs).toISOString(),
        last_signal_at:      firstSig ? new Date(nowTs).toISOString() : (hist?.last_signal_at ?? null),
        last_signal_type:    firstSig ? String(firstSig.signal_type ?? '') : (hist?.last_signal_type ?? null),
        last_signal_score:   firstSig ? Number(firstSig.signal_strength ?? 0) : (hist?.last_signal_score ?? null),
        last_ai_confidence:  firstSig ? Number(firstSig.confidence ?? 0) : (hist?.last_ai_confidence ?? null),
        last_result:         null, // evaluated by signal-expiry later
        times_analyzed:      (hist?.times_analyzed ?? 0) + 1,
        times_with_signal:   (hist?.times_with_signal ?? 0) + (coinSigs.length > 0 ? 1 : 0),
        recent_win_count:    hist?.recent_win_count ?? 0,
        recent_loss_count:   hist?.recent_loss_count ?? 0,
        last_rsi:            coin.rsi_14,
        last_price:          coin.price,
        last_ema9:           coin.ema_9,
        last_ema21:          coin.ema_21,
        last_volume_usdt:    coin.volume_24h_usdt,
        last_momentum:       coin.momentum,
        cached_signal_json:  cachePayload,
        cache_state_hash:    cachePayload ? coin.state_hash : null,
        cache_expires_at:    cachePayload
          ? new Date(nowTs + AI_CACHE_TTL_MS).toISOString()
          : null,
        updated_at:          new Date(nowTs).toISOString(),
      };
    });

    // Upsert pair history in background (non-fatal)
    db.from('pair_analysis_history')
      .upsert(historyUpdates, { onConflict: 'pair' })
      .then(({ error }) => {
        if (error) console.warn('[ai-analysis] pair_analysis_history upsert warn:', error.message);
        else console.log(`[ai-analysis] Updated rotation history for ${historyUpdates.length} pairs`);
      });

    // ── Step 11: Merge with still-live existing signals ───────────────────
    // Reuse existingCacheRow fetched in Step 7 — no second DB read needed.
    const existingSignals: Record<string, unknown>[] = Array.isArray(existingCacheRow?.signals)
      ? (existingCacheRow.signals as Record<string, unknown>[])
      : [];

    // Keep only signals whose AI-recommended hold window has not yet elapsed.
    // Back-fill expires_at for any cached signal that was written before this fix.
    const stillLive = existingSignals
      .map(s => {
        if (!s.expires_at) {
          const genMs  = s.generated_at ? new Date(String(s.generated_at)).getTime() : 0;
          const holdMs = holdingTimeToMs(s.holding_time != null ? String(s.holding_time) : null);
          return { ...s, expires_at: new Date(genMs + holdMs).toISOString() };
        }
        return s;
      })
      .filter(s => {
        const exp = new Date(String(s.expires_at)).getTime();
        return nowTs < exp;
      });

    // Dedup: if a new signal targets the same pair+direction as a still-LIVE signal
    // with a nearly identical entry price (within 0.5%), refresh the existing one
    // in-place instead of appending a duplicate.
    const dedupedNew: Record<string, unknown>[] = [];

    // ── V149 RATE-LIMIT SAFETY ────────────────────────────────────────────────
    // If AI produced 0 new signals (rate-limit, timeout, both Gemini+Groq failed),
    // do NOT overwrite existing live signals with an empty list.
    // Only merge when AI actually returned at least one valid signal.
    const aiReturnedSignals = signals.length > 0;
    const isAIFailure = !aiReturnedSignals && (
      diag.ai_rate_limit > 0 || diag.ai_timeout > 0 || diag.ai_error > 0
    );

    if (isAIFailure) {
      // AI failed — preserve all still-live signals unchanged, log and continue.
      // This ensures existing valid LIVE signals are never erased by a transient AI failure.
      console.warn(
        `[ai-analysis] V149 RATE-LIMIT/AI-FAILURE GUARD: AI returned 0 signals ` +
        `(rate_limit=${diag.ai_rate_limit} timeout=${diag.ai_timeout} error=${diag.ai_error}). ` +
        `Preserving ${stillLive.length} existing live signals — NOT writing signals=[] to cache.`
      );
      const mergedSignals = stillLive; // preserve only; no new signals appended
      // Skip signal_history write — nothing new to persist.
      // Jump directly to Step 13 cache upsert with preserved signals.
      diag.total_duration_ms = Date.now() - t0;
      console.log(`[ai-analysis] Done (AI failure preserved) in ${diag.total_duration_ms}ms | signals=${mergedSignals.length}`);

      const cacheRowPreserved = {
        id: 'global',
        signals: mergedSignals,
        market_data: marketDataSnapshot,
        market_sentiment: allAIResults[0]?.sentiment ?? existingCacheRow?.market_sentiment ?? { score: 50, label: 'Neutral' },
        pairs_scanned:   totalPairs,
        analyzed_count:  aiCandidates.length,
        generated_at:    existingCacheRow?.generated_at ?? now,
        updated_at:      now,
        ai_source:       aiSource,
        model_used:      modelUsed,
        gemini_status:   geminiStatus,
        error_message:   `AI unavailable: rate_limit=${diag.ai_rate_limit} timeout=${diag.ai_timeout} — existing signals preserved`,
        gemini_count:    diag.openai_count,
        groq_count:      diag.groq_count,
        cached_count:    diag.pairs_cached,
        rotation_count:  diag.pairs_exploration,
        diagnostics:     diag,
        reset_at:        existingCacheRow?.reset_at ?? null,
        // V2: local setups visible even when AI is unavailable
        local_setups:    localSetupsSnapshot,
      };
      const { error: cacheErrP } = await db.from('ai_signals_cache').upsert(cacheRowPreserved, { onConflict: 'id' });
      if (cacheErrP) console.error('[ai-analysis] cache upsert error (preserved):', cacheErrP.message);
      await updateSchedulerStatus(db, true, null);
      return new Response(JSON.stringify(cacheRowPreserved), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const updatedLive = stillLive.map(existing => {
      const existingPair = String(existing.pair ?? '');
      const existingDir  = String(existing.signal_type ?? '');

      // In-memory dedup: if a new signal targets the same pair+direction as a
      // still-LIVE signal, refresh the existing one in-place (keep its id and
      // generated_at). The DB partial unique index on setup_fingerprint is the
      // authoritative race-condition guard — this is a best-effort cache-layer dedup
      // so we use pair+direction (no entry tolerance) to be maximally defensive.
      const duplicate = signals.find(s =>
        String(s.pair ?? '') === existingPair &&
        String(s.signal_type ?? '') === existingDir
      );

      if (duplicate) {
        console.log(`[ai-analysis] Dedup (in-memory): refreshing existing ${existingPair} ${existingDir} signal`);
        // Merge: preserve canonical id + generated_at; accept new levels from AI
        return {
          ...duplicate,
          id: existing.id,
          generated_at: existing.generated_at,
        };
      }
      return existing;
    });

    // Signals that are truly new (not a duplicate of any still-live signal)
    const usedPairDirs = new Set(
      updatedLive.map(s => `${String(s.pair ?? '')}::${String(s.signal_type ?? '')}`)
    );
    for (const s of signals) {
      const key = `${String(s.pair ?? '')}::${String(s.signal_type ?? '')}`;
      if (!usedPairDirs.has(key)) {
        dedupedNew.push(s);
        usedPairDirs.add(key); // prevent two new signals for same pair+dir in one batch
      }
    }

    const existingIds = new Set(updatedLive.map(s => String(s.id)));
    const newUnique   = dedupedNew.filter(s => !existingIds.has(String(s.id)));
    const mergedSignals = [...updatedLive, ...newUnique];

    console.log(`[ai-analysis] Signal pool: ${updatedLive.length} still-live + ${newUnique.length} new = ${mergedSignals.length} total`);

    // ── Step 12: Persist new signals to signal_history ───────────────────
    if (newUnique.length > 0) {
      const historyRows = await Promise.all(newUnique.map(async sig => {
        const genAt  = String(sig.generated_at ?? now);
        const holdMs = holdingTimeToMs(sig.holding_time != null ? String(sig.holding_time) : null);
        const expAt  = new Date(new Date(genAt).getTime() + holdMs).toISOString();
        const ezLow  = typeof sig.entry_zone_low  === 'number' ? sig.entry_zone_low  : null;
        const ezHigh = typeof sig.entry_zone_high === 'number' ? sig.entry_zone_high : null;
        const entryPrice = (ezLow != null && ezHigh != null)
          ? (ezLow + ezHigh) / 2
          : (typeof sig.current_price === 'number' ? sig.current_price : 0);
        const sigAiSource = (sig.ai_source === 'gemini' || sig.ai_source === 'groq') ? sig.ai_source : aiSource;

        // Compute deterministic setup fingerprint — same 1% bucket algorithm as DB migration.
        // The DB partial unique index (uix_signal_history_live_fingerprint) enforces
        // exactly one LIVE row per fingerprint. Using it as the conflict key here means
        // two concurrent cron runs targeting the same setup will safely no-op on the second.
        const tp1Val = typeof sig.take_profit_1 === 'number' ? sig.take_profit_1 : null;
        const slVal  = typeof sig.stop_loss     === 'number' ? sig.stop_loss     : null;
        const setupFingerprint = entryPrice > 0
          ? await computeSetupFingerprint(
              String(sig.pair ?? ''),
              String(sig.signal_type ?? 'BUY'),
              entryPrice,
              tp1Val,
              slVal,
            )
          : null;

        return {
          pair:            String(sig.pair          ?? ''),
          symbol:          String(sig.symbol        ?? ''),
          coin_name:       String(sig.coin_name     ?? ''),
          signal_type:     String(sig.signal_type   ?? 'BUY'),
          confidence:      Number(sig.confidence    ?? 0),
          entry_price:     entryPrice,
          entry_zone_low:  ezLow,
          entry_zone_high: ezHigh,
          take_profit_1:   tp1Val,
          take_profit_2:   typeof sig.take_profit_2 === 'number' ? sig.take_profit_2 : null,
          stop_loss:       slVal,
          risk_reward:     sig.risk_reward   != null ? String(sig.risk_reward)   : null,
          holding_time:    sig.holding_time  != null ? String(sig.holding_time)  : null,
          signal_strength:          typeof sig.signal_strength === 'number' ? sig.signal_strength : null,
          ai_source:                sigAiSource,
          status:                   'LIVE',
          generated_at:             genAt,
          expires_at:               expAt,
          exit_price:               null, result: null, pl_pct: null,
          reasoning:                sig.reasoning ?? null,
          setup_fingerprint:        setupFingerprint,
          // V158: server-computed recommendation fields
          server_verdict:           typeof sig.server_verdict === 'string' ? sig.server_verdict : null,
          recommendation_score:     typeof sig.recommendation_score === 'number' ? sig.recommendation_score : null,
          recommendation_breakdown: sig.recommendation_breakdown ?? null,
        };
      }));

      // Use setup_fingerprint as the conflict key.
      // ON CONFLICT DO NOTHING: if a LIVE row with this fingerprint already exists
      // (race condition: second concurrent cron run), silently skip — no duplicate inserted.
      // Falls back to pair,generated_at for rows without a fingerprint (edge case: entryPrice=0).
      const { error: histErr } = await db
        .from('signal_history')
        .upsert(historyRows, { onConflict: 'setup_fingerprint', ignoreDuplicates: true });
      if (histErr) {
        // Fallback: if fingerprint conflict fails (e.g. null fingerprints), try pair+generated_at
        console.warn('[ai-analysis] signal_history upsert (fingerprint) warning:', histErr.message);
        const { error: histErr2 } = await db
          .from('signal_history')
          .upsert(historyRows, { onConflict: 'pair,generated_at', ignoreDuplicates: true });
        if (histErr2) console.warn('[ai-analysis] signal_history upsert (fallback) warning:', histErr2.message);
        else console.log(`[ai-analysis] Wrote ${historyRows.length} signals to signal_history (fallback key)`);
      } else {
        console.log(`[ai-analysis] Wrote ${historyRows.length} signals to signal_history (fingerprint key)`);
      }

      // ── v128: Server-side Auto Trader chain ───────────────────────────────
      // Fire-and-forget: invoke auto-trader-eval after signal_history is written
      // so it scores with fresh data. Non-blocking — never delays the response.
      db.functions.invoke('auto-trader-eval', { body: {} }).catch((e: unknown) => {
        console.warn('[ai-analysis] auto-trader-eval invoke error (non-fatal):', e instanceof Error ? e.message : String(e));
      });
    }

    // ── Step 13: Final cache upsert with diagnostics ──────────────────────
    diag.total_duration_ms = Date.now() - t0;
    console.log(`[ai-analysis] Done in ${diag.total_duration_ms}ms | fetch:${diag.market_fetch_ms}ms klines:${diag.klines_ms}ms dbload:${diag.db_load_ms}ms prompt:${diag.prompt_ms}ms ai:${diag.ai_ms}ms(req:${diag.openai_request_ms}ms) openai=${diag.openai_count} groq=${diag.groq_count} cached=${diag.pairs_cached} signals=${diag.signals_generated}`);

    // ── v9: Compute FRESH/STALE + BEST_CURRENT_SETUP (data-driven scoring) ──
    // FRESH  = signal still within its holding window (expires_at in future)
    // STALE  = signal past its holding window — NOT an error, NOT a blocker
    //          STALE never becomes BEST_CURRENT_SETUP; AutoTrader stays ENABLED/WAITING.
    //
    // BEST_CURRENT_SETUP = highest-scoring FRESH+LIVE signal.
    // v9: score = signal_strength + bestSetupScoreExtras() when DATA_DRIVEN_TPSL=true
    //     (TP feasibility + RR bonus + volatility penalty)
    // v8 fallback: score = signal_strength + hard-coded TP1% bonus
    const nowForFreshness = Date.now();
    let freshCount = 0;
    let staleCount = 0;
    let bestSetupPair  = 'NONE';
    let bestSetupScore = -Infinity;

    for (const sig of mergedSignals) {
      const expMs = sig.expires_at ? new Date(String(sig.expires_at)).getTime() : 0;
      if (expMs > nowForFreshness) {
        freshCount++;

        const entry    = typeof sig.current_price  === 'number' ? sig.current_price  : 0;
        const tp1      = typeof sig.take_profit_1  === 'number' ? sig.take_profit_1  : null;
        const sl       = typeof sig.stop_loss      === 'number' ? sig.stop_loss      : null;
        const strength = typeof sig.signal_strength === 'number' ? sig.signal_strength : 50;
        const pairStr  = String(sig.pair ?? 'NONE');
        const sigType  = String(sig.signal_type ?? 'BUY') as 'BUY' | 'SELL';

        let compositeScore: number;

        if (DATA_DRIVEN_TPSL && signalHistoryForTPSL.length > 0 && entry > 0) {
          // v9: data-driven scoring
          const stats  = buildHistoricalStats(signalHistoryForTPSL, pairStr, sigType);
          const atrPct = atrMap[pairStr] ?? 2.0;
          const extras = bestSetupScoreExtras(entry, tp1, sl, atrPct, stats, pairStr);
          for (const line of extras.log) console.log(line);
          compositeScore = strength + extras.total_bonus;
        } else {
          // v8 fallback: hard-coded TP1% bonus
          let tpBonus = 0;
          if (entry > 0 && tp1 != null) {
            const tp1Pct = Math.abs(tp1 - entry) / entry * 100;
            if      (tp1Pct <= 2.5)  tpBonus =  3;
            else if (tp1Pct <= 3.0)  tpBonus =  0;
            else if (tp1Pct <= 5.0)  tpBonus = -5;
            else if (tp1Pct <= 10.0) tpBonus = -10;
            else                     tpBonus = -20;
          }
          if (entry > 0 && sl != null) {
            const slPct = Math.abs(entry - sl) / entry * 100;
            if      (slPct < 1.0) tpBonus -= 5;
            else if (slPct > 5.0) tpBonus -= 3;
          }
          compositeScore = strength + tpBonus;
        }

        if (compositeScore > bestSetupScore) {
          bestSetupScore = compositeScore;
          bestSetupPair  = pairStr;
        }
      } else {
        staleCount++;
      }
    }
    diag.fresh_signals       = freshCount;
    diag.stale_signals       = staleCount;
    diag.best_current_setup  = bestSetupPair;

    // Phase 4: full pipeline diagnostics log — all 14 counters
    console.log(JSON.stringify({
      event: 'PHASE4_PIPELINE_RESULT',
      // Timing
      total_ms: diag.total_duration_ms,
      klines_ms: diag.klines_ms,
      ai_ms: diag.ai_ms,
      // Pipeline flow counters
      MARKET_PAIRS_SCANNED:    diag.market_pairs_scanned,
      CANDIDATES_FILTERED:     diag.candidates_filtered,
      CANDIDATES_SENT_TO_AI:   diag.candidates_sent_to_ai,
      AI_CACHE_HITS:           diag.ai_cache_hits,
      AI_CACHE_MISSES:         diag.ai_cache_misses,
      AI_SUCCESS:              diag.ai_success,
      AI_TIMEOUT:              diag.ai_timeout,
      AI_RATE_LIMIT:           diag.ai_rate_limit,
      AI_ERROR:                diag.ai_error,
      AI_INVALID_JSON:         diag.ai_invalid_json,
      SIGNALS_CREATED:         diag.signals_created,
      FRESH_SIGNALS:           diag.fresh_signals,
      STALE_SIGNALS:           diag.stale_signals,
      BEST_CURRENT_SETUP:      diag.best_current_setup,
      // Settings snapshot
      ai_candidate_limit: AI_CANDIDATE_LIMIT,
      ai_cache_ttl_min: 22,
      threshold_price_pct: THRESHOLD_PRICE_CHG,
      threshold_rsi_pts: THRESHOLD_RSI_CHG,
      gemini_error: diag.openai_error_category ?? 'none',
      groq_error:   diag.groq_error_category   ?? 'none',
    }));

    const tDbWrite = Date.now();

    // V2 final diagnostics counters
    // ai_verified_count = actual number of AI verdicts returned (RECOMMENDED + WATCH + NO_TRADE),
    // i.e. how many candidates the AI actually reviewed this run.
    diag.ai_verified_count  = Array.isArray(aiVerdicts) ? aiVerdicts.length : 0;
    // Also count signals that have an AI verdict (RECOMMENDED signal == AI returned RECOMMENDED)
    diag.recommended_count  = signals.filter(s => s.server_verdict === 'RECOMMENDED').length;
    diag.local_analysis_ms  = diag.selection_ms; // local scoring time already in selection_ms

    const cacheRow = {
      id: 'global',
      signals: mergedSignals,
      market_data: marketDataSnapshot,
      market_sentiment: allAIResults[0]?.sentiment ?? { score: 50, label: 'Neutral' },
      pairs_scanned:   totalPairs,
      analyzed_count:  aiCandidates.length,
      generated_at:    now,
      updated_at:      now,
      ai_source:       aiSource,
      model_used:      modelUsed,
      gemini_status:   geminiStatus,
      error_message:   null,
      // Pipeline diagnostics returned to frontend
      gemini_count:    diag.openai_count,
      groq_count:      diag.groq_count,
      cached_count:    diag.pairs_cached,
      rotation_count:  diag.pairs_exploration,
      diagnostics:     diag,
      reset_at:        existingCacheRow?.reset_at ?? null,
      // V2: local setups for the full local analysis view
      local_setups:    localSetupsSnapshot,
    };
    const { error: cacheErr } = await db.from('ai_signals_cache').upsert(cacheRow, { onConflict: 'id' });
    if (cacheErr) console.error('[ai-analysis] cache upsert error:', cacheErr.message);
    diag.db_write_ms = Date.now() - tDbWrite;
    cacheRow.diagnostics = diag; // patch in final db_write_ms

    await updateSchedulerStatus(db, true, null);

    // ── V192: live-trigger — if called with source=v192_live_trigger, invoke
    // live-order-test immediately passing the in-memory cacheRow.signals directly.
    // This means live-order-test does NOT need to call ai-analysis again —
    // it receives injected_signals from the body and skips the force_analysis branch.
    if (reqSource === 'v192_live_trigger' && reqUserId) {
      console.log(`[V192] live-trigger: invoking live-order-test for user ${reqUserId} dry_run=${reqDryRun} signals=${(cacheRow.signals as unknown[]).length}`);
      let liveTestResult: Record<string, unknown> = {};
      try {
        const lotRes = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/live-order-test`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type':  'application/json',
            },
            body: JSON.stringify({
              dry_run:           reqDryRun,
              force_analysis:    false,         // signals injected directly — no second AI call
              injected_signals:  cacheRow.signals, // pass in-memory signals from this run
              injected_reset_at: cacheRow.reset_at ?? null,
              _user_id:          reqUserId,
            }),
            signal: AbortSignal.timeout(90_000),
          }
        );
        liveTestResult = await lotRes.json() as Record<string, unknown>;
        console.log('[V192] live-order-test verdict:', liveTestResult.verdict);
      } catch (lotErr) {
        liveTestResult = { error: String(lotErr), verdict: 'LIVE TEST: FAIL' };
        console.error('[V192] live-order-test call failed:', String(lotErr));
      }
      return new Response(JSON.stringify({
        v192_force_analysis: cacheRow,
        v192_live_test:      liveTestResult,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify(cacheRow), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const errorMessage = String(err);
    console.error('[ai-analysis] pipeline error:', errorMessage);
    diag.total_duration_ms = Date.now() - t0;
    await updateSchedulerStatus(db, false, errorMessage);

    const cached = await getCached();
    // CRITICAL FIX: preserve existing signals on any pipeline error (including 429 ticker fetch).
    // Only update error_message + updated_at — NEVER wipe signals on failure.
    // A partial upsert with only {id, error_message, updated_at} would null-out the signals
    // column because Supabase upsert replaces the full row on conflict.
    // Using .update() instead of .upsert() guarantees signals are never touched.
    await db.from('ai_signals_cache')
      .update({ error_message: errorMessage, updated_at: new Date().toISOString() })
      .eq('id', 'global');

    if (cached) {
      return new Response(JSON.stringify({ ...cached, stale: true, error_message: errorMessage, diagnostics: diag }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      error: errorMessage, signals: [], pairs_scanned: 0, analyzed_count: 0,
      market_sentiment: { score: 50, label: 'Neutral' }, diagnostics: diag,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
