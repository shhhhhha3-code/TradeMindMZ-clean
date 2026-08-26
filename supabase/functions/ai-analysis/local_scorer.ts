/**
 * local_scorer.ts — V158 Server-Side Local Market Analysis Engine
 *
 * Performs ALL heavy numerical analysis BEFORE AI is called.
 * Analyses all N coins locally and ranks them. Only TOP 5 candidates
 * are forwarded to Gemini/Groq for a final qualitative confirmation.
 *
 * Analyses performed per coin:
 *   - Trend direction (EMA alignment, price vs EMA9/21)
 *   - Momentum score (24h change, MACD, rate-of-change)
 *   - RSI regime (oversold / neutral / overbought with strength)
 *   - MACD signal quality (histogram direction, cross detection)
 *   - Volume analysis (volume vs 20-period SMA, surge detection)
 *   - Volatility bucket (LOW / MEDIUM / HIGH / EXTREME via ATR %)
 *   - Support / Resistance proximity (price within actionable zone)
 *   - Market regime (BULL_TREND / BEAR_TREND / RANGING / VOLATILE)
 *   - Historical BUY/SELL performance (win rate, avg P/L, from signal_history)
 *   - Historical MFE/MAE calibration (feasibility of TP1/SL levels)
 *   - Historical confidence/strength correlation with outcome
 *   - Risk/Reward estimate (based on ATR + historical MFE/MAE)
 *   - Composite LOCAL_SCORE (0–100) across all dimensions
 *   - V158: transparent RECOMMENDATION SCORE with historical evidence as dominant
 *     component and server-side objective RECOMMENDED / WATCH / NO_TRADE verdict.
 *
 * Outputs:
 *   localScoreCoins(): scores all coins and returns them sorted descending.
 *   selectAICandidates(): takes scored coins + limit → TOP N for AI.
 */

import { type HistoryRow } from './tpsl_engine.ts';
import { type RecommendationBreakdown, computeRecommendation } from './recommendation_scorer.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MarketRegime = 'BULL_TREND' | 'BEAR_TREND' | 'RANGING' | 'VOLATILE';
export type SignalBias   = 'BUY_BIAS' | 'SELL_BIAS' | 'NEUTRAL';

export interface LocalScoreBreakdown {
  trend:           number;  // 0–20 pts
  momentum:        number;  // 0–20 pts
  rsi:             number;  // 0–20 pts
  macd:            number;  // 0–10 pts
  volume:          number;  // 0–10 pts
  support_resist:  number;  // 0–10 pts
  historical_perf: number;  // 0–20 pts  (win rate + avg P/L from signal_history)
  mfe_mae:         number;  // 0–10 pts  (TP1 feasibility from historical MFE)
  rr_estimate:     number;  // 0–10 pts  (estimated RR from ATR)
  staleness_bonus: number;  // 0–5  pts  (rotation / exploration bonus)
  total:           number;  // 0–100 pts (sum, clamped)
}

export interface LocalScoredCoin {
  pair:            string;
  symbol:          string;
  price:           number;
  rsi_14:          number;
  ema_9:           number;
  ema_21:          number;
  macd_histogram:  number;
  change_pct_24h:  number;
  volume_24h_usdt: number;
  support_level:   number;
  resistance_level:number;
  momentum:        string;
  atr_pct:         number;
  market_regime:   MarketRegime;
  signal_bias:     SignalBias;
  estimated_rr:    number;
  local_score:     number;
  score_breakdown: LocalScoreBreakdown;
  // Pass-through fields needed by buildBatchPrompt
  coin_name:       string;
  open_24h:        number;
  high_24h:        number;
  low_24h:         number;
  change_24h:      number;
  macd_line:       number;
  macd_signal:     number;
  price_vs_ema9:   string;
  price_vs_ema21:  string;
  recent_closes:   number[];
  sparkline:       number[];
  state_hash:      string;
  candidate_score: number;
  is_exploration:  boolean;
  technical_score: number;
  // Historical context injected by scorer
  hist_win_rate:   number | null;  // type-level win rate (null if < 5 samples)
  hist_avg_pl:     number | null;  // type-level avg P/L (null if < 5 samples)
  hist_mfe_p50:    number | null;  // P50 MFE for this pair+type (null if no data)
  hist_sample_n:   number;         // how many history rows used
  // V158: server-first recommendation score and objective verdict
  recommendation:  RecommendationBreakdown | null;
}

/** Minimal shape of signal_history row needed for local scoring */
export interface LocalHistoryRow {
  pair:          string;
  signal_type:   string;
  result:        'WIN' | 'LOSS' | 'EXPIRED' | null;
  pl_pct:        number | null;
  confidence:    number | null;
  signal_strength: number | null;
  take_profit_1: number | null;
  entry_price:   number | null;
}

/** Input coin shape (matches CoinAnalysisData in index.ts) */
export interface CoinInput {
  pair:            string;
  symbol:          string;
  coin_name:       string;
  price:           number;
  open_24h:        number;
  high_24h:        number;
  low_24h:         number;
  volume_24h_usdt: number;
  change_24h:      number;
  change_pct_24h:  number;
  rsi_14:          number;
  ema_9:           number;
  ema_21:          number;
  macd_line:       number;
  macd_signal:     number;
  macd_histogram:  number;
  support_level:   number;
  resistance_level:number;
  price_vs_ema9:   string;
  price_vs_ema21:  string;
  momentum:        string;
  recent_closes:   number[];
  sparkline:       number[];
  state_hash:      string;
  candidate_score: number;
  is_exploration:  boolean;
  technical_score: number;
}

/** pair_analysis_history row shape (minimal, for staleness scoring) */
export interface PairHistoryMeta {
  pair:              string;
  last_analyzed_at:  string | null;
  times_analyzed:    number;
  recent_win_count:  number;
  recent_loss_count: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Minimum samples before historical stats influence scoring
const MIN_HIST_SAMPLES  = 5;
// Annulus around support/resistance considered "actionable"
const SR_ZONE_PCT       = 0.015;  // 1.5% from level = in-zone
// Minimum estimated RR to score RR component positively
const LOCAL_MIN_RR      = 1.5;
// Staleness thresholds (hours)
const STALE_H           = 6;
const VERY_STALE_H      = 24;

// ─── Market Regime Detection ──────────────────────────────────────────────────

/**
 * Classifies the coin's current market regime based on EMA alignment,
 * RSI range, and 24h price change magnitude.
 *
 *   BULL_TREND  : EMA9 > EMA21, price > EMA21, RSI 45–75, change > 0.5%
 *   BEAR_TREND  : EMA9 < EMA21, price < EMA21, RSI 25–55, change < -0.5%
 *   VOLATILE    : ATR % > 4%, or |change| > 8%
 *   RANGING     : none of the above
 */
export function detectMarketRegime(coin: CoinInput, atrPct: number): MarketRegime {
  const bullEma    = coin.ema_9 > coin.ema_21 && coin.price > coin.ema_21;
  const bearEma    = coin.ema_9 < coin.ema_21 && coin.price < coin.ema_21;
  const rsiBull    = coin.rsi_14 >= 45 && coin.rsi_14 <= 75;
  const rsiBear    = coin.rsi_14 >= 25 && coin.rsi_14 <= 55;
  const absMom     = Math.abs(coin.change_pct_24h);
  const isVolatile = atrPct > 4.0 || absMom > 8.0;

  if (isVolatile) return 'VOLATILE';
  if (bullEma && rsiBull && coin.change_pct_24h > 0.5) return 'BULL_TREND';
  if (bearEma && rsiBear && coin.change_pct_24h < -0.5) return 'BEAR_TREND';
  return 'RANGING';
}

/**
 * Derives the most likely trade direction bias from local technical indicators.
 */
export function detectSignalBias(coin: CoinInput): SignalBias {
  let bullPoints = 0;
  let bearPoints = 0;

  // EMA alignment
  if (coin.ema_9 > coin.ema_21) bullPoints += 2;
  else if (coin.ema_9 < coin.ema_21) bearPoints += 2;

  // Price vs EMAs
  if (coin.price > coin.ema_9) bullPoints += 1;
  else bearPoints += 1;

  // RSI
  if (coin.rsi_14 < 35) bullPoints += 2;       // oversold → buy bias
  else if (coin.rsi_14 > 65) bearPoints += 2;  // overbought → sell bias
  else if (coin.rsi_14 > 55) bullPoints += 1;  // mild bullish
  else if (coin.rsi_14 < 45) bearPoints += 1;  // mild bearish

  // MACD histogram direction
  if (coin.macd_histogram > 0) bullPoints += 1;
  else if (coin.macd_histogram < 0) bearPoints += 1;

  // 24h change direction
  if (coin.change_pct_24h > 1) bullPoints += 1;
  else if (coin.change_pct_24h < -1) bearPoints += 1;

  if (bullPoints >= bearPoints + 2) return 'BUY_BIAS';
  if (bearPoints >= bullPoints + 2) return 'SELL_BIAS';
  return 'NEUTRAL';
}

// ─── ATR estimation from 24h High/Low ────────────────────────────────────────
// When full klines are not available we use the daily range as ATR proxy.

export function estimateAtrPct(coin: CoinInput): number {
  if (coin.price <= 0) return 2.0;
  const hl = coin.high_24h - coin.low_24h;
  return (hl / coin.price) * 100;
}

// ─── Individual Scoring Components ───────────────────────────────────────────

/** Trend score 0–20: rewards strong EMA alignment with price confirmation */
function scoreTrend(coin: CoinInput): number {
  let pts = 0;
  const bullishEma = coin.ema_9 > coin.ema_21;
  const bearishEma = coin.ema_9 < coin.ema_21;

  // EMA cross direction (10 pts)
  if (bullishEma || bearishEma) pts += 10;

  // Price above/below both EMAs (strong trend)
  if (coin.price > coin.ema_9 && coin.price > coin.ema_21) pts += 5;
  else if (coin.price < coin.ema_9 && coin.price < coin.ema_21) pts += 5;

  // EMA separation magnitude — wider gap = stronger trend
  if (coin.ema_9 > 0 && coin.ema_21 > 0) {
    const emaSep = Math.abs(coin.ema_9 - coin.ema_21) / coin.ema_21 * 100;
    if (emaSep > 1.0) pts += 5;
    else if (emaSep > 0.3) pts += 2;
  }

  return Math.min(20, pts);
}

/** Momentum score 0–20: rewards directional 24h move + MACD confirmation */
function scoreMomentum(coin: CoinInput): number {
  let pts = 0;
  const absChg = Math.abs(coin.change_pct_24h);

  // 24h change magnitude
  if      (absChg >= 5.0) pts += 12;
  else if (absChg >= 3.0) pts += 9;
  else if (absChg >= 1.5) pts += 6;
  else if (absChg >= 0.5) pts += 3;

  // MACD line direction (momentum confirmation)
  if (coin.macd_line !== 0) {
    const macdMag = Math.abs(coin.macd_histogram / Math.max(coin.price, 0.000001)) * 10000;
    if (macdMag > 0.3) pts += 5;
    else if (macdMag > 0.1) pts += 3;
    else pts += 1;
  }

  // Rate-of-change: if recent_closes has enough points, measure last-3 slope
  const rc = coin.recent_closes;
  if (rc.length >= 4) {
    const older = rc[rc.length - 4];
    const newer = rc[rc.length - 1];
    if (older > 0) {
      const roc = Math.abs((newer - older) / older) * 100;
      if (roc > 2.0) pts += 3;
      else if (roc > 0.5) pts += 1;
    }
  }

  return Math.min(20, pts);
}

/** RSI score 0–20: rewards tradeable extremes (oversold/overbought with setup context) */
function scoreRsi(coin: CoinInput): number {
  const r = coin.rsi_14;
  // Strong oversold / overbought extremes — highest signal quality
  if (r < 25 || r > 75) return 20;
  if (r < 30 || r > 70) return 17;
  if (r < 35 || r > 65) return 13;
  // Mid-range with directional lean
  if (r < 40 || r > 60) return 8;
  // Neutral — low opportunity
  return 3;
}

/** MACD score 0–10: rewards clean histogram direction + signal cross */
function scoreMacd(coin: CoinInput): number {
  let pts = 0;
  const hist = coin.macd_histogram;
  const line = coin.macd_line;
  const sig  = coin.macd_signal;

  // Histogram has meaningful size (not noise)
  const threshold = coin.price * 0.0005;
  if (Math.abs(hist) > threshold) pts += 4;
  else if (Math.abs(hist) > 0) pts += 1;

  // MACD line above/below zero (trend confirmation)
  if (line > 0 || line < 0) pts += 3;

  // Signal line cross: line just crossed signal (strong)
  if ((line > 0 && sig <= 0) || (line < 0 && sig >= 0)) pts += 3;

  return Math.min(10, pts);
}

/** Volume score 0–10: rewards high absolute volume and volume relative to typical */
function scoreVolume(coin: CoinInput): number {
  let pts = 0;
  const vol = coin.volume_24h_usdt;

  // Absolute volume tiers
  if      (vol >= 50_000_000) pts += 7;
  else if (vol >= 10_000_000) pts += 5;
  else if (vol >= 2_000_000)  pts += 3;
  else if (vol >= 500_000)    pts += 1;

  // High volume relative to typical crypto ranges
  if (vol >= 20_000_000) pts += 3;
  else if (vol >= 5_000_000) pts += 2;
  else if (vol >= 1_000_000) pts += 1;

  return Math.min(10, pts);
}

/** Support/Resistance score 0–10: rewards proximity to actionable S/R level */
function scoreSupportResistance(coin: CoinInput): number {
  let pts = 0;
  const price = coin.price;
  const sup   = coin.support_level;
  const res   = coin.resistance_level;

  if (price <= 0 || sup <= 0 || res <= 0) return 3;

  // Distance from support (BUY zone)
  const distFromSup = (price - sup) / price;
  if (distFromSup >= 0 && distFromSup <= SR_ZONE_PCT) pts += 10;
  else if (distFromSup >= 0 && distFromSup <= SR_ZONE_PCT * 2) pts += 7;
  else if (distFromSup < 0) pts += 3; // price below support — broken support

  // Distance from resistance (SELL zone)
  const distFromRes = (res - price) / price;
  if (distFromRes >= 0 && distFromRes <= SR_ZONE_PCT) {
    pts = Math.max(pts, 9);   // near resistance is also high-quality (SELL setup)
  } else if (distFromRes >= 0 && distFromRes <= SR_ZONE_PCT * 2) {
    pts = Math.max(pts, 6);
  }

  // Middle of range — low edge quality
  if (pts === 0) pts = 2;
  return Math.min(10, pts);
}

/** Historical performance score 0–20: win rate + avg P/L from signal_history */
function scoreHistoricalPerf(
  histRows: LocalHistoryRow[],
  pair: string,
  signalBias: SignalBias,
): { pts: number; winRate: number | null; avgPl: number | null; sampleN: number } {
  // Prefer coin+type specific rows
  const biasType = signalBias === 'BUY_BIAS' ? 'BUY' : signalBias === 'SELL_BIAS' ? 'SELL' : null;
  const pairTypeRows = biasType
    ? histRows.filter(r => r.pair === pair && r.signal_type === biasType && (r.result === 'WIN' || r.result === 'LOSS'))
    : histRows.filter(r => r.pair === pair && (r.result === 'WIN' || r.result === 'LOSS'));
  const typeRows = biasType
    ? histRows.filter(r => r.signal_type === biasType && (r.result === 'WIN' || r.result === 'LOSS'))
    : histRows.filter(r => r.result === 'WIN' || r.result === 'LOSS');

  const bucket = pairTypeRows.length >= MIN_HIST_SAMPLES ? pairTypeRows
    : typeRows.length >= MIN_HIST_SAMPLES ? typeRows
    : null;

  if (!bucket || bucket.length === 0) {
    return { pts: 8, winRate: null, avgPl: null, sampleN: 0 }; // neutral when no data
  }

  const wins  = bucket.filter(r => r.result === 'WIN').length;
  const total = bucket.length;
  const winRate = total > 0 ? (wins / total) * 100 : null;
  const avgPl   = total > 0 ? bucket.reduce((s, r) => s + (r.pl_pct ?? 0), 0) / total : null;

  let pts = 0;
  // Win rate component (0–12)
  if (winRate !== null) {
    if      (winRate >= 60) pts += 12;
    else if (winRate >= 50) pts += 9;
    else if (winRate >= 40) pts += 6;
    else if (winRate >= 30) pts += 3;
    else                    pts += 0; // poor history — no pts
  } else {
    pts += 5; // neutral
  }

  // Avg P/L component (0–8)
  if (avgPl !== null) {
    if      (avgPl >= 2.0)  pts += 8;
    else if (avgPl >= 1.0)  pts += 6;
    else if (avgPl >= 0.5)  pts += 4;
    else if (avgPl >= 0.0)  pts += 2;
    else                    pts += 0; // negative avg P/L
  } else {
    pts += 3; // neutral
  }

  return { pts: Math.min(20, pts), winRate, avgPl, sampleN: bucket.length };
}

/** MFE/MAE feasibility score 0–10: checks if TP1 is achievable given history */
function scoreMfeMae(
  histRows: LocalHistoryRow[],
  pair: string,
  signalBias: SignalBias,
  atrPct: number,
): { pts: number; mfeP50: number | null } {
  const biasType = signalBias === 'BUY_BIAS' ? 'BUY' : signalBias === 'SELL_BIAS' ? 'SELL' : null;
  const bucket = (biasType
    ? histRows.filter(r => r.pair === pair && r.signal_type === biasType && r.result === 'WIN')
    : histRows.filter(r => r.pair === pair && r.result === 'WIN'))
    .filter(r => r.pl_pct !== null && (r.pl_pct ?? 0) > 0);

  if (bucket.length < MIN_HIST_SAMPLES) {
    // Fallback: use ATR to estimate feasibility — higher ATR → more potential
    if (atrPct >= 3.0) return { pts: 7, mfeP50: null };
    if (atrPct >= 1.5) return { pts: 5, mfeP50: null };
    return { pts: 3, mfeP50: null };
  }

  const plVals = bucket.map(r => r.pl_pct!).sort((a, b) => a - b);
  const mfeP50 = plVals[Math.floor(plVals.length * 0.5)];

  // Score: P50 MFE ≥ 1.5% (above MIN_RR × SL floor 1%) is very feasible
  let pts: number;
  if      (mfeP50 >= 3.0) pts = 10;
  else if (mfeP50 >= 2.0) pts = 8;
  else if (mfeP50 >= 1.5) pts = 6;
  else if (mfeP50 >= 1.0) pts = 4;
  else                    pts = 2;

  return { pts: Math.min(10, pts), mfeP50 };
}

/** Estimated RR score 0–10: ATR-based RR estimate rewards high-quality setups */
function scoreEstimatedRR(atrPct: number, regime: MarketRegime): { pts: number; estimatedRR: number } {
  // Use ATR to estimate TP1 (1.0×ATR) and SL (0.6×ATR) → RR ≈ ATR / (0.6×ATR) ≈ 1.67
  // Adjust by regime
  const regimeMult = regime === 'VOLATILE' ? 1.2 : regime === 'RANGING' ? 0.8 : 1.0;
  const tp1Est  = Math.min(5.0, atrPct * regimeMult);
  const slEst   = Math.min(5.0, atrPct * 0.6 * regimeMult);
  const rrEst   = slEst > 0 ? tp1Est / slEst : 0;

  let pts: number;
  if      (rrEst >= 2.5) pts = 10;
  else if (rrEst >= 2.0) pts = 8;
  else if (rrEst >= LOCAL_MIN_RR) pts = 6;
  else if (rrEst >= 1.2) pts = 3;
  else                   pts = 0;

  return { pts, estimatedRR: parseFloat(rrEst.toFixed(2)) };
}

/** Staleness bonus 0–5: rotation guarantee for unseen / stale pairs */
function scoreStaleness(hist: PairHistoryMeta | null): number {
  if (!hist || hist.times_analyzed === 0) return 5; // never seen
  const hoursAgo = (Date.now() - new Date(hist.last_analyzed_at ?? 0).getTime()) / 3_600_000;
  if (hoursAgo >= VERY_STALE_H) return 5;
  if (hoursAgo >= STALE_H)      return 3;
  if (hoursAgo >= 2)            return 1;
  return 0;
}

// ─── Main Scoring Entry Point ─────────────────────────────────────────────────

/**
 * Scores a single coin across all local analysis dimensions.
 * Returns a LocalScoredCoin with a total local_score 0–100 and a
 * V158 recommendation breakdown (historical evidence + final score).
 */
export function scoreCoin(
  coin: CoinInput,
  historyRows: HistoryRow[],
  pairHist: PairHistoryMeta | null,
): LocalScoredCoin {
  const atrPct  = estimateAtrPct(coin);
  const regime  = detectMarketRegime(coin, atrPct);
  const bias    = detectSignalBias(coin);

  // LocalHistoryRow subset used by legacy historical perf/MFE/MAE scoring
  const histRows: LocalHistoryRow[] = historyRows.map(r => ({
    pair:            r.pair,
    signal_type:     r.signal_type,
    result:          r.result,
    pl_pct:          r.pl_pct,
    confidence:      null,
    signal_strength: null,
    take_profit_1:   r.take_profit_1,
    entry_price:     r.entry_price,
  }));

  const trend      = scoreTrend(coin);
  const momentum   = scoreMomentum(coin);
  const rsiScore   = scoreRsi(coin);
  const macd       = scoreMacd(coin);
  const volume     = scoreVolume(coin);
  const sr         = scoreSupportResistance(coin);
  const { pts: histPerf, winRate, avgPl, sampleN } = scoreHistoricalPerf(histRows, coin.pair, bias);
  const { pts: mfeMae, mfeP50 }   = scoreMfeMae(histRows, coin.pair, bias, atrPct);
  const { pts: rrPts, estimatedRR } = scoreEstimatedRR(atrPct, regime);
  const staleness  = scoreStaleness(pairHist);

  const rawTotal = trend + momentum + rsiScore + macd + volume + sr + histPerf + mfeMae + rrPts + staleness;
  const total    = Math.min(100, Math.max(0, rawTotal));

  const breakdown: LocalScoreBreakdown = {
    trend, momentum, rsi: rsiScore, macd, volume,
    support_resist: sr, historical_perf: histPerf,
    mfe_mae: mfeMae, rr_estimate: rrPts,
    staleness_bonus: staleness, total,
  };

  // V158: server-first recommendation score. The signal direction is derived
  // from the local bias so the server can compute an objective verdict before
  // AI is called. If bias is NEUTRAL, no recommendation is produced.
  let recommendation: RecommendationBreakdown | null = null;
  if (bias === 'BUY_BIAS' || bias === 'SELL_BIAS') {
    const signalType = bias === 'BUY_BIAS' ? 'BUY' : 'SELL';
    recommendation = computeRecommendation({
      pair: coin.pair,
      signal_type: signalType,
      local_score: total,
      estimated_rr: estimatedRR,
      market_regime: regime,
      price: coin.price,
      atr_pct: atrPct,
      fresh: true, // new signals are fresh by definition
    }, historyRows);
  }

  return {
    ...coin,
    atr_pct:         parseFloat(atrPct.toFixed(2)),
    market_regime:   regime,
    signal_bias:     bias,
    estimated_rr:    estimatedRR,
    local_score:     total,
    score_breakdown: breakdown,
    hist_win_rate:   winRate,
    hist_avg_pl:     avgPl,
    hist_mfe_p50:    mfeP50,
    hist_sample_n:   sampleN,
    recommendation,
  };
}

/**
 * Score ALL coins locally using the full analysis engine.
 *
 * @param coins     All coins with computed indicators (from buildCoinData)
 * @param historyRows  signal_history rows for historical performance + recommendation scoring
 * @param pairHistMap pair_analysis_history map for staleness scoring
 * @returns coins sorted by local_score descending
 */
export function localScoreCoins(
  coins: CoinInput[],
  historyRows: HistoryRow[],
  pairHistMap: Map<string, PairHistoryMeta>,
): LocalScoredCoin[] {
  const scored = coins.map(coin => scoreCoin(
    coin,
    historyRows,
    pairHistMap.get(coin.pair) ?? null,
  ));
  scored.sort((a, b) => b.local_score - a.local_score);
  return scored;
}

/**
 * Select the TOP N candidates to send to AI.
 *
 * Strategy:
 *   - Always include top-scored coins (highest local_score first)
 *   - Ensure at least 1 exploration candidate (rotation guarantee)
 *   - Cap at maxCandidates
 *
 * @param scoredCoins  Output of localScoreCoins() (sorted desc)
 * @param maxCandidates  Default 10 (AI_CANDIDATE_LIMIT from index.ts)
 * @param exploreSlots  How many exploration slots to reserve (default 2)
 */
export function selectAICandidates(
  scoredCoins: LocalScoredCoin[],
  maxCandidates: number,
  exploreSlots = 2,
): LocalScoredCoin[] {
  // Separate exploration (unseen / stale) from quality candidates
  const exploration = scoredCoins.filter(c => c.is_exploration || c.score_breakdown.staleness_bonus >= 5);
  const quality     = scoredCoins.filter(c => !exploration.some(e => e.pair === c.pair));

  // Fill slots: (maxCandidates - exploreSlots) top quality + exploreSlots exploration
  const qualSlots   = Math.max(0, maxCandidates - Math.min(exploreSlots, exploration.length));
  const topQuality  = quality.slice(0, qualSlots);
  const topExplore  = exploration.slice(0, Math.min(exploreSlots, maxCandidates - topQuality.length));

  const selected = [...topQuality, ...topExplore].slice(0, maxCandidates);

  console.log(
    `[local_scorer] selectAICandidates: ${scoredCoins.length} scored → ` +
    `${topQuality.length} quality + ${topExplore.length} exploration = ${selected.length} AI candidates ` +
    `(limit=${maxCandidates})`
  );
  selected.forEach((c, i) => {
    console.log(
      `[local_scorer] #${i + 1} ${c.pair} score=${c.local_score} ` +
      `regime=${c.market_regime} bias=${c.signal_bias} rr≈${c.estimated_rr} ` +
      `breakdown: trend=${c.score_breakdown.trend} mom=${c.score_breakdown.momentum} ` +
      `rsi=${c.score_breakdown.rsi} macd=${c.score_breakdown.macd} ` +
      `vol=${c.score_breakdown.volume} sr=${c.score_breakdown.support_resist} ` +
      `histPerf=${c.score_breakdown.historical_perf} mfe=${c.score_breakdown.mfe_mae} ` +
      `rr=${c.score_breakdown.rr_estimate} stale=${c.score_breakdown.staleness_bonus}`
    );
  });

  return selected;
}
