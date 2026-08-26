/**
 * tpsl-engine — Data-driven TP/SL calculation library (Fase 1+2+3)
 *
 * Feature flag: DATA_DRIVEN_TPSL (default true — set env var to "false" to rollback)
 *
 * Fase 1 — Data foundation
 *   buildHistoricalStats()  builds per-pair/per-type stats from signal_history rows:
 *     mfe_pct, mae_pct, tp1_hit_rate, sl_hit_rate, expired_rate, sample_n, avg_pl_pct
 *   Minimum sample gates:
 *     COIN_MIN_SAMPLE  = 8   signals (pair+type) before coin-specific stats used
 *     TYPE_MIN_SAMPLE  = 15  signals (type) before type-level stats used
 *   Falls back to MARKET_FALLBACK constants when below gate.
 *
 * Fase 2 — Analysis
 *   computeVolatilityBucket()  classifies coin into LOW/MEDIUM/HIGH/EXTREME volatility
 *   computeAtr()               simple true-range ATR from kline data
 *   tpFeasibilityScore()       0–100 score driven by historical TP hit rate + MFE
 *
 * Fase 3 — Dynamic TP/SL
 *   computeDynamicTPSL()       returns { tp1, tp2, sl, rr, model, log }
 *     tp1 = clamp( historical_p50_mfe * CONFIDENCE_MULT,  floor, ceiling )
 *     tp2 = clamp( historical_p75_mfe * CONFIDENCE_MULT,  floor, ceiling )
 *     sl  = clamp( historical_p50_mae * ATR_MULT,         floor, ceiling )
 *     rr  = (tp1 − entry) / (entry − sl)
 *   BEST_CURRENT_SETUP scoring includes RR + TP feasibility + momentum + volatility
 *
 * Logging prefixes (all to console.log):
 *   [TP_MODEL]         — which model chosen (COIN / TYPE / FALLBACK)
 *   [SL_MODEL]         — which SL model chosen
 *   [TP_FEASIBILITY]   — feasibility score + reason
 *   [RR_CHECK]         — computed RR, pass/fail
 *   [TP_MODEL_FALLBACK]— reason fallback was triggered
 */

// ─── Feature flag ─────────────────────────────────────────────────────────────
export const DATA_DRIVEN_TPSL =
  (typeof Deno !== 'undefined'
    ? Deno.env.get('DATA_DRIVEN_TPSL')
    : undefined) !== 'false'; // default ON; set "false" to rollback

// ─── Minimum sample gates ─────────────────────────────────────────────────────
export const COIN_MIN_SAMPLE = 8;   // min signal_history rows (pair+type) for coin-level stats
export const TYPE_MIN_SAMPLE = 15;  // min signal_history rows (type) for type-level stats

// ─── Market-wide fallback constants (calibrated from 286 evaluated signals) ────
// Source: Fase 5 analysis — median MFE WIN=2.50%, MAE=2.00%, TP1 hit rate=15.7%, SL=15.4%
export const FALLBACK = {
  mfe_p25:      0.00,  // P25 MFE (max favorable excursion %)
  mfe_p50:      0.30,  // median MFE based on real exit P/L
  mfe_p60:      0.80,  // P60 MFE — conservative achievable target
  mfe_p75:      1.35,  // P75 MFE
  mfe_p90:      3.61,  // P90 MFE
  mae_p50:      0.50,  // median MAE (max adverse excursion %)
  mae_p75:      1.41,  // P75 MAE
  tp1_hit_rate: 0.157, // 15.7%
  sl_hit_rate:  0.192, // 19.2%
  expired_rate: 0.635, // 63.5%
  avg_pl_pct:   0.34,  // overall avg P/L including expired
};

// ─── TP/SL floor/ceiling limits ───────────────────────────────────────────────
export const TP1_FLOOR   = 1.5;   // TP1 minimum %
export const TP1_CEILING = 5.0;   // TP1 maximum %
export const TP2_FLOOR   = 3.0;   // TP2 minimum %
export const TP2_CEILING = 10.0;  // TP2 maximum %
export const SL_FLOOR    = 1.0;   // SL minimum % (avoids noise stops)
export const SL_CEILING  = 5.0;   // SL maximum % (avoids excessive risk)
export const MIN_RR      = 1.5;   // minimum acceptable Risk/Reward

// ─── Volatility bucket thresholds ────────────────────────────────────────────
export const VOL_BUCKET = {
  LOW:     { maxAtrPct: 1.5 },   // ATR/price < 1.5%
  MEDIUM:  { maxAtrPct: 3.0 },   // 1.5–3%
  HIGH:    { maxAtrPct: 6.0 },   // 3–6%
  EXTREME: { maxAtrPct: Infinity },// > 6%
} as const;

export type VolatilityBucket = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

// ─── TP/SL model source ───────────────────────────────────────────────────────
export type TPSLModel = 'COIN' | 'TYPE' | 'FALLBACK';

// ─── Historical stats shape ───────────────────────────────────────────────────
export interface HistoricalStats {
  mfe_p25:      number;
  mfe_p50:      number;
  mfe_p60:      number;
  mfe_p75:      number;
  mfe_p90:      number;
  mae_p50:      number;
  mae_p75:      number;
  tp1_hit_rate: number;
  sl_hit_rate:  number;
  expired_rate: number;
  avg_pl_pct:   number;
  sample_n:     number;
  model:        TPSLModel;
}

// ─── Signal history row shape (subset used here) ─────────────────────────────
export interface HistoryRow {
  pair:          string;
  signal_type:   string;
  result:        'WIN' | 'LOSS' | 'EXPIRED' | null;
  pl_pct:        number | null;
  entry_price:   number | null;
  take_profit_1: number | null;
  stop_loss:     number | null;
  exit_price:    number | null;
  expired_class: 'GOOD_DIRECTION' | 'NEUTRAL' | 'BAD_DIRECTION' | null;
}

// ─── Dynamic TP/SL result ────────────────────────────────────────────────────
export interface DynamicTPSL {
  tp1_pct:           number;   // TP1 as % from entry
  tp2_pct:           number;   // TP2 as % from entry
  sl_pct:            number;   // SL as % from entry (absolute)
  tp1:               number;   // absolute price
  tp2:               number;   // absolute price
  sl:                number;   // absolute price
  rr:                number;   // (tp1-entry)/(entry-sl)
  rr_pass:           boolean;  // rr >= MIN_RR
  model:             TPSLModel;
  tp_feasibility:    number;   // 0–100
  feasibility_label: string;
  volatility:        VolatilityBucket;
  log:               string[];
}

// ─── BEST_CURRENT_SETUP composite score extras ───────────────────────────────
export interface BCSScoreExtras {
  tp_feasibility_bonus: number;
  rr_bonus:             number;
  volatility_penalty:   number;
  total_bonus:          number;
  log:                  string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 1 — DATA FOUNDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute percentile of a sorted numeric array.
 * Requires the array to be sorted ascending before calling.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Fase 1: Build HistoricalStats from raw signal_history rows.
 *
 * Priority:
 *   1. Coin-specific (pair + signal_type) if n >= COIN_MIN_SAMPLE
 *   2. Type-level   (signal_type)         if n >= TYPE_MIN_SAMPLE
 *   3. Market fallback
 *
 * MFE/MAE is derived from the actual exit P/L, which is the observable
 * minimum bound for max favourable / adverse excursion:
 *   - WIN:           MFE = pl_pct (they hit TP), MAE = 0
 *   - LOSS:          MFE = 0, MAE = |pl_pct| (they hit SL)
 *   - EXPIRED ↑ (GOOD_DIRECTION): MFE = max(0, directional_pl), MAE = max(0, -directional_pl)
 *   - EXPIRED ~ (NEUTRAL):          MFE = max(0, directional_pl), MAE = max(0, -directional_pl)
 *   - EXPIRED ↓ (BAD_DIRECTION):    MFE = max(0, directional_pl), MAE = max(0, -directional_pl)
 *
 * This avoids the previous bias of using the original AI TP1/SL distance
 * for EXPIRED signals, which inflated the historical MFE/MAE percentiles.
 */
export function buildHistoricalStats(
  rows: HistoryRow[],
  pair: string,
  signalType: string,
): HistoricalStats {
  const coinRows = rows.filter(
    r => r.pair === pair && r.signal_type === signalType
  );
  const typeRows = rows.filter(r => r.signal_type === signalType);

  // Pick best available bucket
  const bucket =
    coinRows.length >= COIN_MIN_SAMPLE ? coinRows :
    typeRows.length >= TYPE_MIN_SAMPLE ? typeRows  :
    null;

  const model: TPSLModel =
    coinRows.length >= COIN_MIN_SAMPLE ? 'COIN' :
    typeRows.length >= TYPE_MIN_SAMPLE ? 'TYPE' :
    'FALLBACK';

  if (!bucket || bucket.length === 0) {
    console.log(`[TP_MODEL_FALLBACK] pair=${pair} type=${signalType} coin_n=${coinRows.length} type_n=${typeRows.length} → using FALLBACK constants`);
    return { ...FALLBACK, sample_n: 0, model: 'FALLBACK' };
  }

  // MFE/MAE from actual exit P/L — observable lower bound on max excursion
  const mfeValues: number[] = [];
  const maeValues: number[] = [];
  let tp1Hits  = 0;
  let slHits   = 0;
  let expired  = 0;
  let plSum    = 0;
  let plCount  = 0;

  for (const r of bucket) {
    const pl = r.pl_pct ?? 0;
    const isBuy = r.signal_type === 'BUY';

    if (r.result === 'WIN') {
      mfeValues.push(pl > 0 ? pl : 0.5);
      maeValues.push(0);
      tp1Hits++;
      plSum += pl;
      plCount++;
    } else if (r.result === 'LOSS') {
      mfeValues.push(0);
      maeValues.push(Math.abs(pl) > 0 ? Math.abs(pl) : 0.5);
      slHits++;
      plSum += pl;
      plCount++;
    } else if (r.result === 'EXPIRED') {
      expired++;
      plSum += pl;
      plCount++;
      // Use directional P/L as conservative MFE/MAE proxy
      if (isBuy) {
        mfeValues.push(Math.max(0, pl));
        maeValues.push(Math.max(0, -pl));
      } else {
        mfeValues.push(Math.max(0, -pl));
        maeValues.push(Math.max(0, pl));
      }
    }
  }

  mfeValues.sort((a, b) => a - b);
  maeValues.sort((a, b) => a - b);

  const total = bucket.length;
  const tp1HitRate = total > 0 ? tp1Hits  / total : FALLBACK.tp1_hit_rate;
  const slHitRate  = total > 0 ? slHits   / total : FALLBACK.sl_hit_rate;
  const expiredRate= total > 0 ? expired  / total : FALLBACK.expired_rate;
  const avgPlPct   = plCount > 0 ? plSum   / plCount : FALLBACK.avg_pl_pct;

  const stats: HistoricalStats = {
    mfe_p25:      percentile(mfeValues, 25),
    mfe_p50:      percentile(mfeValues, 50),
    mfe_p60:      percentile(mfeValues, 60),
    mfe_p75:      percentile(mfeValues, 75),
    mfe_p90:      percentile(mfeValues, 90),
    mae_p50:      percentile(maeValues, 50),
    mae_p75:      percentile(maeValues, 75),
    tp1_hit_rate: tp1HitRate,
    sl_hit_rate:  slHitRate,
    expired_rate: expiredRate,
    avg_pl_pct:   avgPlPct,
    sample_n:     total,
    model,
  };

  console.log(`[TP_MODEL] pair=${pair} type=${signalType} model=${model} n=${total} mfe_p50=${stats.mfe_p50.toFixed(2)}% mae_p50=${stats.mae_p50.toFixed(2)}% tp1_hit=${(stats.tp1_hit_rate * 100).toFixed(1)}%`);
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 2 — ANALYSIS MODULE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute a simple ATR from kline high/low data.
 * klines: array of { high: number, low: number, close: number }
 * Returns ATR as percentage of current price.
 */
export function computeAtrPct(
  klines: Array<{ high: number; low: number; close: number }>,
  period = 14,
): number {
  if (klines.length < 2) return 2.0; // default medium volatility
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1].close;
    const curr = klines[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev),
      Math.abs(curr.low  - prev),
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const atr   = slice.reduce((s, v) => s + v, 0) / slice.length;
  const price = klines[klines.length - 1].close;
  return price > 0 ? (atr / price) * 100 : 2.0;
}

/**
 * Classify ATR% into volatility bucket.
 */
export function computeVolatilityBucket(atrPct: number): VolatilityBucket {
  if (atrPct < VOL_BUCKET.LOW.maxAtrPct)    return 'LOW';
  if (atrPct < VOL_BUCKET.MEDIUM.maxAtrPct) return 'MEDIUM';
  if (atrPct < VOL_BUCKET.HIGH.maxAtrPct)   return 'HIGH';
  return 'EXTREME';
}

/**
 * Fase 2: TP feasibility score (0–100).
 *
 * Combines:
 *   - Historical TP1 hit rate (primary: 0–50 pts)
 *   - MFE vs proposed TP1 distance (secondary: 0–30 pts)
 *   - Sample confidence (0–20 pts)
 *
 * Returns score + label (EXCELLENT/GOOD/FAIR/POOR).
 */
export function tpFeasibilityScore(
  stats: HistoricalStats,
  proposedTp1Pct: number,
): { score: number; label: string } {
  // Component 1: historical TP1 hit rate (0–50)
  const hitRateScore = Math.min(50, stats.tp1_hit_rate * 200); // 25% hit → 50 pts max scaled

  // Component 2: proposed TP1 vs historical MFE (0–30)
  // TP1 at or below P50 MFE → best; above P90 → worst
  let mfeScore = 30;
  if (proposedTp1Pct > stats.mfe_p90)       mfeScore = 0;
  else if (proposedTp1Pct > stats.mfe_p75)  mfeScore = 10;
  else if (proposedTp1Pct > stats.mfe_p60)  mfeScore = 15;
  else if (proposedTp1Pct > stats.mfe_p50)  mfeScore = 20;

  // Component 3: sample confidence (0–20)
  const sampleScore =
    stats.model === 'COIN'     ? 20 :
    stats.model === 'TYPE'     ? 12 :
    /* FALLBACK */                4;

  const total = Math.min(100, Math.round(hitRateScore + mfeScore + sampleScore));

  const label =
    total >= 70 ? 'EXCELLENT' :
    total >= 50 ? 'GOOD'      :
    total >= 30 ? 'FAIR'      :
    'POOR';

  console.log(`[TP_FEASIBILITY] tp1_pct=${proposedTp1Pct.toFixed(2)}% mfe_p50=${stats.mfe_p50.toFixed(2)}% hit_rate=${(stats.tp1_hit_rate * 100).toFixed(1)}% score=${total} label=${label}`);
  return { score: total, label };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 3 — DYNAMIC TP/SL ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

// Multipliers to convert raw MFE/MAE percentiles to TP/SL distances
// TP1 uses a percentile of historical MFE, scaled to avoid overfitting.
const TP1_MFE_PCTILE = 60;  // TP1 base = P60 MFE (captures achievable movement for ~40% of signals)
const TP1_MFE_MULT   = 0.90; // 90% of that percentile — conservative safety margin
const TP2_MFE_PCTILE = 75;
const TP2_MFE_MULT   = 0.80; // TP2 = 80% of P75 MFE
const SL_MAE_MULT    = 1.10; // SL  = 110% of P50 MAE (small buffer above median adversity)

// Volatility-bucket adjustments applied to TP/SL percentages
const VOL_ADJ: Record<VolatilityBucket, { tp: number; sl: number }> = {
  LOW:     { tp: -0.20, sl: -0.20 }, // tighten both on low-volatility coins
  MEDIUM:  { tp:  0.00, sl:  0.00 }, // no adjustment
  HIGH:    { tp:  0.30, sl:  0.40 }, // widen on high volatility
  EXTREME: { tp:  0.60, sl:  0.80 }, // widen more on extreme volatility
};

/**
 * Fase 3: Compute dynamic TP/SL for a signal.
 *
 * @param entry       Signal entry price
 * @param signalType  'BUY' | 'SELL'
 * @param stats       HistoricalStats from buildHistoricalStats()
 * @param atrPct      ATR as % of price (from computeAtrPct)
 * @param pair        For logging
 */
export function computeDynamicTPSL(
  entry:      number,
  signalType: 'BUY' | 'SELL',
  stats:      HistoricalStats,
  atrPct:     number,
  pair:       string,
): DynamicTPSL {
  const log: string[] = [];
  const volBucket = computeVolatilityBucket(atrPct);
  const adj       = VOL_ADJ[volBucket];

  // ── Raw TP/SL percentages from historical data ───────────────────────────
  const tp1BaseMfe = stats[`mfe_p${TP1_MFE_PCTILE}` as keyof HistoricalStats] as number;
  const tp2BaseMfe = stats[`mfe_p${TP2_MFE_PCTILE}` as keyof HistoricalStats] as number;
  const rawTp1Pct = Math.max(tp1BaseMfe, 0.5) * TP1_MFE_MULT + adj.tp;
  const rawTp2Pct = Math.max(tp2BaseMfe, 1.0) * TP2_MFE_MULT + adj.tp;
  const rawSlPct  = Math.max(stats.mae_p50, 0.5) * SL_MAE_MULT  + adj.sl;

  // ── Clamp within hard limits ──────────────────────────────────────────────
  let tp1Pct = Math.min(TP1_CEILING, Math.max(TP1_FLOOR, rawTp1Pct));
  let tp2Pct = Math.min(TP2_CEILING, Math.max(TP2_FLOOR, rawTp2Pct));
  let slPct  = Math.min(SL_CEILING,  Math.max(SL_FLOOR,  rawSlPct));

  // ── Enforce RR floor by adjusting TP1 upward if needed ─────────────────────
  if (slPct > 0 && tp1Pct / slPct < MIN_RR) {
    tp1Pct = slPct * MIN_RR;
  }
  // TP2 should always be >= TP1 and within hard limits
  if (tp2Pct < tp1Pct) {
    tp2Pct = tp1Pct * 1.5;
  }
  tp2Pct = Math.min(TP2_CEILING, Math.max(TP2_FLOOR, tp2Pct));

  log.push(`[TP_MODEL] pair=${pair} type=${signalType} model=${stats.model} raw_tp1=${rawTp1Pct.toFixed(2)}% → clamped=${tp1Pct.toFixed(2)}%`);
  log.push(`[SL_MODEL] pair=${pair} type=${signalType} model=${stats.model} raw_sl=${rawSlPct.toFixed(2)}% → clamped=${slPct.toFixed(2)}%  volatility=${volBucket} atr=${atrPct.toFixed(2)}%`);

  // ── Absolute price levels ─────────────────────────────────────────────────
  let tp1: number, tp2: number, sl: number;
  if (signalType === 'BUY') {
    tp1 = entry * (1 + tp1Pct / 100);
    tp2 = entry * (1 + tp2Pct / 100);
    sl  = entry * (1 - slPct  / 100);
  } else {
    // SELL: profit when price falls
    tp1 = entry * (1 - tp1Pct / 100);
    tp2 = entry * (1 - tp2Pct / 100);
    sl  = entry * (1 + slPct  / 100);
  }

  // ── Risk/Reward — computed from percentage distances to avoid float precision loss ─
  const rr     = slPct > 0 ? tp1Pct / slPct : 0;
  const rrPass = rr >= MIN_RR;

  log.push(`[RR_CHECK] pair=${pair} tp1_pct=${tp1Pct.toFixed(2)}% sl_pct=${slPct.toFixed(2)}% rr=${rr.toFixed(2)} min_rr=${MIN_RR} pass=${rrPass}`);

  if (!rrPass) {
    log.push(`[RR_CHECK] WARN rr=${rr.toFixed(2)} < min ${MIN_RR} — consider reducing SL or increasing TP1`);
  }

  // ── TP Feasibility ────────────────────────────────────────────────────────
  const { score: feasScore, label: feasLabel } = tpFeasibilityScore(stats, tp1Pct);

  return {
    tp1_pct:           tp1Pct,
    tp2_pct:           tp2Pct,
    sl_pct:            slPct,
    tp1:               parseFloat(tp1.toFixed(8)),
    tp2:               parseFloat(tp2.toFixed(8)),
    sl:                parseFloat(sl.toFixed(8)),
    rr:                parseFloat(rr.toFixed(3)),
    rr_pass:           rrPass,
    model:             stats.model,
    tp_feasibility:    feasScore,
    feasibility_label: feasLabel,
    volatility:        volBucket,
    log,
  };
}

/**
 * Fase 3: BEST_CURRENT_SETUP composite score extras.
 *
 * Returns bonus/penalty points to add on top of signal_strength for
 * BEST_CURRENT_SETUP ranking. Covers:
 *   TP feasibility bonus   (-20 to +5)
 *   RR bonus               (-10 to +5)
 *   Volatility penalty     (0 to -5)
 */
export function bestSetupScoreExtras(
  entry:       number,
  tp1:         number | null,
  sl:          number | null,
  atrPct:      number,
  stats:       HistoricalStats,
  pair:        string,
): BCSScoreExtras {
  const log: string[] = [];
  const volBucket = computeVolatilityBucket(atrPct);

  // ── TP feasibility bonus ─────────────────────────────────────────────────
  let tpBonus = 0;
  if (entry > 0 && tp1 != null) {
    const tp1Pct = Math.abs(tp1 - entry) / entry * 100;
    const { score } = tpFeasibilityScore(stats, tp1Pct);
    // Map feasibility score to bonus: EXCELLENT→+5, GOOD→+2, FAIR→-5, POOR→-20
    if      (score >= 70) tpBonus =  5;
    else if (score >= 50) tpBonus =  2;
    else if (score >= 30) tpBonus = -5;
    else                  tpBonus = -20;
    log.push(`[TP_FEASIBILITY] pair=${pair} feasibility_score=${score} tp_bonus=${tpBonus}`);
  }

  // ── RR bonus ─────────────────────────────────────────────────────────────
  let rrBonus = 0;
  if (entry > 0 && tp1 != null && sl != null) {
    const reward = Math.abs(tp1 - entry);
    const risk   = Math.abs(entry - sl);
    const rr     = risk > 0 ? reward / risk : 0;
    if      (rr >= 2.5) rrBonus =  5;
    else if (rr >= 1.8) rrBonus =  2;
    else if (rr >= MIN_RR) rrBonus = 0;
    else if (rr >= 1.0) rrBonus = -5;
    else                rrBonus = -10;
    log.push(`[RR_CHECK] pair=${pair} rr=${rr.toFixed(2)} rr_bonus=${rrBonus}`);
  }

  // ── Volatility penalty ────────────────────────────────────────────────────
  let volPenalty = 0;
  if (volBucket === 'EXTREME') volPenalty = -5;
  if (volBucket === 'HIGH')    volPenalty = -2;
  if (volBucket === 'LOW')     volPenalty = -1; // slightly favour medium setups

  const total = tpBonus + rrBonus + volPenalty;
  log.push(`[TP_MODEL] pair=${pair} tp_feasibility_bonus=${tpBonus} rr_bonus=${rrBonus} vol_penalty=${volPenalty} total_bonus=${total}`);

  return {
    tp_feasibility_bonus: tpBonus,
    rr_bonus:             rrBonus,
    volatility_penalty:   volPenalty,
    total_bonus:          total,
    log,
  };
}
