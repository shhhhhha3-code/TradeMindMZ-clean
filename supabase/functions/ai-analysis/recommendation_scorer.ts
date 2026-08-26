/**
 * recommendation_scorer.ts — V158 SERVER-FIRST INTELLIGENCE + SMART HISTORICAL SCORING
 *
 * This module is the SINGLE source of truth for the final recommendation score.
 * It does NOT rely on AI to compute historical stats, win rate, P/L, MFE/MAE, RR
 * or technical indicators. All of that is computed deterministically on the server.
 *
 * AI's only role is the final qualitative setup filter (RECOMMENDED / WATCH / NO_TRADE).
 * The server provides a transparent breakdown so every signal's verdict can be explained.
 *
 * Historical evidence is the heaviest component of the final score.
 */

import { buildHistoricalStats, type HistoryRow } from './tpsl_engine.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EvidenceLevel = 'STRONG' | 'FAIR' | 'WEAK' | 'INSUFFICIENT';
export type RecommendationVerdict = 'RECOMMENDED' | 'WATCH' | 'NO_TRADE';
export type MfeMaeLabel = 'GOOD' | 'FAIR' | 'POOR' | 'UNKNOWN';

/** Historical evidence for the exact same pair + signal_type, last 30 days. */
export interface HistoricalEvidence {
  sampleN: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number | null;
  avgPlPct: number | null;
  mfeP50: number | null;
  maeP50: number | null;
  evidenceLevel: EvidenceLevel;
  reason: string;
}

/** Transparent breakdown of the final recommendation score. */
export interface RecommendationBreakdown {
  local_score: number;          // 0–100, server technical score
  historical_score: number;     // 0–100, evidence-based score
  win_rate: number | null;      // % (null if insufficient sample)
  avg_pl_pct: number | null;    // % (null if insufficient sample)
  mfe_mae_label: MfeMaeLabel;   // GOOD / FAIR / POOR / UNKNOWN
  rr: number;                   // computed risk/reward
  confidence: number;           // 0–100, derived from final score
  strength: number;             // 0–100, derived from final score
  fresh: boolean;               // whether signal is within holding window
  market_regime: string;        // e.g. BULL_TREND / BEAR_TREND / RANGING / VOLATILE
  server_verdict: RecommendationVerdict; // server objective recommendation
  ai_verdict: RecommendationVerdict | 'PENDING'; // AI confirmation (if available)
  final: RecommendationVerdict; // final verdict used by the pipeline
  reason: string;               // concrete reason for WATCH / NO_TRADE
}

/** Input for computing a recommendation score. */
export interface RecommendationInput {
  pair: string;
  signal_type: 'BUY' | 'SELL';
  local_score: number;
  estimated_rr: number;
  market_regime: string;
  price: number;
  atr_pct: number;
  fresh: boolean;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

// We consider only the last 30 days of history for same-pair/same-type evidence.
const HISTORY_WINDOW_DAYS = 30;
// Minimum sample size before a pair+type bucket is considered statistically useful.
const MIN_PAIR_TYPE_SAMPLES = 5;
// Minimum sample size before we report concrete numbers in the breakdown.
const MIN_REPORT_SAMPLES = 3;

// Weight of historical evidence in the final score. Historical evidence is the
// dominant component (50%). The remaining 50% is split between local technical
// score, RR quality, market-regime fit, and freshness.
const WEIGHTS = {
  historical: 0.50,
  local:      0.25,
  rr:         0.10,
  regime:     0.10,
  fresh:      0.05,
} as const;

// Verdict thresholds for the final 0–100 score.
const VERDICT = {
  RECOMMENDED: 75,
  WATCH:       55,
} as const;

// ─── Historical Evidence Builder ─────────────────────────────────────────────

/**
 * Build historical evidence for a specific pair + signal_type using the last
 * HISTORY_WINDOW_DAYS of signal_history rows.
 *
 * MFE/MAE is derived from actual exit P/L:
 *   - WIN:  MFE = pl_pct, MAE = 0
 *   - LOSS: MFE = 0, MAE = abs(pl_pct)
 *   - EXPIRED: directional P/L proxy (positive = favorable, negative = adverse)
 */
export function buildHistoricalEvidence(
  rows: HistoryRow[],
  pair: string,
  signalType: 'BUY' | 'SELL',
): HistoricalEvidence {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - HISTORY_WINDOW_DAYS);

  const bucket = rows.filter(r =>
    r.pair === pair &&
    r.signal_type === signalType &&
    r.generated_at != null &&
    new Date(r.generated_at).getTime() >= cutoff.getTime()
  );

  const sampleN = bucket.length;
  if (sampleN === 0) {
    return {
      sampleN: 0, wins: 0, losses: 0, expired: 0,
      winRate: null, avgPlPct: null, mfeP50: null, maeP50: null,
      evidenceLevel: 'INSUFFICIENT',
      reason: 'Ingen historikk siste 30 dager',
    };
  }

  let wins = 0;
  let losses = 0;
  let expired = 0;
  let plSum = 0;
  const mfeValues: number[] = [];
  const maeValues: number[] = [];

  for (const r of bucket) {
    const pl = r.pl_pct ?? 0;
    plSum += pl;

    if (r.result === 'WIN') {
      wins++;
      mfeValues.push(pl > 0 ? pl : 0.5);
      maeValues.push(0);
    } else if (r.result === 'LOSS') {
      losses++;
      mfeValues.push(0);
      maeValues.push(Math.abs(pl) > 0 ? Math.abs(pl) : 0.5);
    } else if (r.result === 'EXPIRED') {
      expired++;
      if (signalType === 'BUY') {
        mfeValues.push(Math.max(0, pl));
        maeValues.push(Math.max(0, -pl));
      } else {
        mfeValues.push(Math.max(0, -pl));
        maeValues.push(Math.max(0, pl));
      }
    }
  }

  const winRate = sampleN > 0 ? (wins / sampleN) * 100 : null;
  const avgPlPct = sampleN > 0 ? plSum / sampleN : null;

  mfeValues.sort((a, b) => a - b);
  maeValues.sort((a, b) => a - b);
  const mfeP50 = percentile(mfeValues, 50);
  const maeP50 = percentile(maeValues, 50);

  const evidenceLevel = classifyEvidenceLevel(sampleN, winRate, avgPlPct, mfeP50, maeP50);
  const reason = buildEvidenceReason(sampleN, winRate, avgPlPct, mfeP50, maeP50, evidenceLevel);

  return {
    sampleN, wins, losses, expired,
    winRate: roundNullable(winRate, 1),
    avgPlPct: roundNullable(avgPlPct, 2),
    mfeP50: roundNullable(mfeP50, 2),
    maeP50: roundNullable(maeP50, 2),
    evidenceLevel,
    reason,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function roundNullable(n: number | null, digits: number): number | null {
  return n === null ? null : parseFloat(n.toFixed(digits));
}

function classifyEvidenceLevel(
  n: number,
  winRate: number | null,
  avgPlPct: number | null,
  mfeP50: number | null,
  maeP50: number | null,
): EvidenceLevel {
  if (n < MIN_PAIR_TYPE_SAMPLES) return 'INSUFFICIENT';

  const wr = winRate ?? 0;
  const pl = avgPlPct ?? 0;
  const mfe = mfeP50 ?? 0;
  const mae = maeP50 ?? 0;
  const mfeMaeOk = mfe > 0 && mae > 0 && mfe >= mae * 1.5;

  let score = 0;
  if (wr >= 55) score += 3;
  else if (wr >= 45) score += 2;
  else if (wr >= 35) score += 1;

  if (pl >= 1.0) score += 3;
  else if (pl >= 0.3) score += 2;
  else if (pl >= 0) score += 1;

  if (mfeMaeOk) score += 2;
  else if (mfe >= 0.8) score += 1;

  if (score >= 6) return 'STRONG';
  if (score >= 3) return 'FAIR';
  return 'WEAK';
}

function buildEvidenceReason(
  n: number,
  winRate: number | null,
  avgPlPct: number | null,
  mfeP50: number | null,
  maeP50: number | null,
  level: EvidenceLevel,
): string {
  if (n === 0) return 'Ingen historikk siste 30 dager';
  if (n < MIN_PAIR_TYPE_SAMPLES) {
    return `Utilstrekkelig historisk sample (${n} trades siste 30 dager)`;
  }

  const parts: string[] = [];
  parts.push(`${n} trades`);
  if (winRate !== null) parts.push(`win rate ${winRate.toFixed(0)}%`);
  if (avgPlPct !== null) parts.push(`avg P/L ${avgPlPct > 0 ? '+' : ''}${avgPlPct.toFixed(2)}%`);
  if (mfeP50 !== null && maeP50 !== null) {
    parts.push(`MFE/MAE ${mfeP50.toFixed(2)}% / ${maeP50.toFixed(2)}%`);
  }

  switch (level) {
    case 'STRONG':
      return `Sterk historisk evidens: ${parts.join(', ')}`;
    case 'FAIR':
      return `Middels historisk evidens: ${parts.join(', ')}`;
    case 'WEAK':
      return `Svak historisk evidens: ${parts.join(', ')}`;
    default:
      return parts.join(', ');
  }
}

// ─── Historical Score ────────────────────────────────────────────────────────

/**
 * Convert historical evidence into a 0–100 score.
 * Historical evidence is the heaviest component of the final recommendation.
 */
export function computeHistoricalScore(ev: HistoricalEvidence): number {
  // With zero samples, score is neutral-to-slightly-penalized so the signal
  // cannot rely on unknown history.
  if (ev.sampleN === 0) return 45;
  if (ev.sampleN < MIN_PAIR_TYPE_SAMPLES) {
    // Few samples: score is reduced but not zero; we still reward a small
    // positive sample if it exists.
    return 40;
  }

  let score = 0;

  // Win rate component (0–35)
  const wr = ev.winRate ?? 0;
  if (wr >= 60) score += 35;
  else if (wr >= 50) score += 28;
  else if (wr >= 45) score += 22;
  else if (wr >= 35) score += 14;
  else if (wr >= 25) score += 6;
  else score += 0;

  // Avg P/L component (0–30)
  const pl = ev.avgPlPct ?? 0;
  if (pl >= 2.0) score += 30;
  else if (pl >= 1.0) score += 24;
  else if (pl >= 0.5) score += 18;
  else if (pl >= 0.2) score += 12;
  else if (pl >= 0.0) score += 6;
  else if (pl >= -0.5) score += 2;
  else score += 0;

  // MFE/MAE component (0–25)
  const mfe = ev.mfeP50 ?? 0;
  const mae = ev.maeP50 ?? 0;
  if (mfe > 0 && mae > 0) {
    const ratio = mfe / mae;
    if (ratio >= 2.0) score += 25;
    else if (ratio >= 1.5) score += 20;
    else if (ratio >= 1.0) score += 12;
    else if (ratio >= 0.5) score += 5;
  } else if (mfe >= 1.0) {
    score += 15;
  } else if (mfe >= 0.5) {
    score += 8;
  }

  // Sample confidence component (0–10)
  // More samples = higher confidence, but cap to avoid one pair dominating.
  if (ev.sampleN >= 30) score += 10;
  else if (ev.sampleN >= 15) score += 8;
  else if (ev.sampleN >= 8) score += 5;
  else score += 2;

  return Math.min(100, Math.max(0, score));
}

function mfeMaeLabel(mfeP50: number | null, maeP50: number | null): MfeMaeLabel {
  if (mfeP50 === null || maeP50 === null) return 'UNKNOWN';
  if (mfeP50 >= 1.5 && maeP50 <= 1.0) return 'GOOD';
  if (mfeP50 >= 0.8 && maeP50 <= 1.5) return 'FAIR';
  return 'POOR';
}

// ─── Final Recommendation Score ────────────────────────────────────────────────

/**
 * Compute the transparent final recommendation score and verdict.
 *
 * Final score (0–100) =
 *   historical_score * 0.50
 *   + local_score     * 0.25
 *   + rr_quality      * 0.10
 *   + regime_fit      * 0.10
 *   + freshness       * 0.05
 */
export function computeRecommendation(
  input: RecommendationInput,
  historyRows: HistoryRow[],
  serverOverrideVerdict?: RecommendationVerdict | null,
): RecommendationBreakdown {
  const ev = buildHistoricalEvidence(historyRows, input.pair, input.signal_type);
  const historicalScore = computeHistoricalScore(ev);
  const mmLabel = mfeMaeLabel(ev.mfeP50, ev.maeP50);

  // RR quality: reward RR >= 1.5, penalize RR < 1.2
  const rr = input.estimated_rr;
  let rrQuality = 0;
  if (rr >= 2.0) rrQuality = 100;
  else if (rr >= 1.5) rrQuality = 80;
  else if (rr >= 1.2) rrQuality = 50;
  else if (rr >= 1.0) rrQuality = 25;
  else rrQuality = 0;

  // Market regime fit: reward setups aligned with the regime.
  let regimeFit = 50;
  if (input.signal_type === 'BUY' && input.market_regime === 'BULL_TREND') regimeFit = 95;
  else if (input.signal_type === 'SELL' && input.market_regime === 'BEAR_TREND') regimeFit = 95;
  else if (input.signal_type === 'BUY' && input.market_regime === 'RANGING') regimeFit = 70;
  else if (input.signal_type === 'SELL' && input.market_regime === 'RANGING') regimeFit = 70;
  else if (input.market_regime === 'VOLATILE') regimeFit = 40; // volatile = harder
  else if (input.signal_type === 'BUY' && input.market_regime === 'BEAR_TREND') regimeFit = 25;
  else if (input.signal_type === 'SELL' && input.market_regime === 'BULL_TREND') regimeFit = 25;

  // Freshness: reward fresh signals; stale reduces score slightly.
  const freshScore = input.fresh ? 100 : 60;

  const finalScore = Math.round(
    historicalScore * WEIGHTS.historical +
    input.local_score * WEIGHTS.local +
    rrQuality * WEIGHTS.rr +
    regimeFit * WEIGHTS.regime +
    freshScore * WEIGHTS.fresh
  );

  const serverVerdict = serverOverrideVerdict ?? deriveServerVerdict(finalScore);

  // Confidence and strength are derived from the final score so the whole
  // system is transparent and deterministic.
  const confidence = finalScore;
  const strength = Math.round(finalScore * 0.95);

  const breakdown: RecommendationBreakdown = {
    local_score: input.local_score,
    historical_score: historicalScore,
    win_rate: ev.winRate,
    avg_pl_pct: ev.avgPlPct,
    mfe_mae_label: mmLabel,
    rr: input.estimated_rr,
    confidence,
    strength,
    fresh: input.fresh,
    market_regime: input.market_regime,
    server_verdict: serverVerdict,
    ai_verdict: 'PENDING',
    final: serverVerdict,
    reason: buildWatchReason(input.pair, input.signal_type, finalScore, ev, mmLabel, input.estimated_rr),
  };

  return breakdown;
}

function deriveServerVerdict(finalScore: number): RecommendationVerdict {
  if (finalScore >= VERDICT.RECOMMENDED) return 'RECOMMENDED';
  if (finalScore >= VERDICT.WATCH) return 'WATCH';
  return 'NO_TRADE';
}

/** Build a concrete, human-readable reason for WATCH or NO_TRADE. */
export function buildWatchReason(
  pair: string,
  signalType: string,
  finalScore: number,
  ev: HistoricalEvidence,
  mfeMaeLabel: MfeMaeLabel,
  rr: number,
): string {
  if (finalScore >= VERDICT.RECOMMENDED) {
    return 'Tilfredsstillende score fra serverens objektive historiske og tekniske vurdering.';
  }

  const verdict = finalScore >= VERDICT.WATCH ? 'WATCH' : 'NO_TRADE';
  const reasons: string[] = [];

  if (ev.sampleN === 0) {
    reasons.push('mangler historisk evidens');
  } else if (ev.sampleN < MIN_PAIR_TYPE_SAMPLES) {
    reasons.push(`utilstrekkelig historisk sample (${ev.sampleN} trades)`);
  } else {
    if (ev.winRate !== null && ev.winRate < 40) {
      reasons.push(`win rate ${ev.winRate.toFixed(0)}%`);
    }
    if (ev.avgPlPct !== null && ev.avgPlPct < 0.3) {
      reasons.push(`avg P/L ${ev.avgPlPct.toFixed(2)}%`);
    }
  }

  if (mfeMaeLabel === 'POOR') reasons.push('MFE/MAE dårlig');
  if (mfeMaeLabel === 'UNKNOWN') reasons.push('MFE/MAE ukjent');
  if (rr < 1.5) reasons.push(`RR ${rr.toFixed(2)} < 1.50`);
  if (finalScore < VERDICT.WATCH) reasons.push('lav totalscore');

  const reasonText = reasons.length > 0 ? reasons.join(', ') : 'svak totalscore';
  return `${pair} ${signalType} ${verdict} — Reason: ${reasonText} — Historical score: ${computeHistoricalScore(ev)}/100`;
}

/**
 * Apply the AI's verdict to a server-computed breakdown.
 * AI can confirm, upgrade, or downgrade the server verdict, but the historical
 * score is always preserved and visible in the breakdown.
 */
export function applyAIVerdict(
  breakdown: RecommendationBreakdown,
  aiVerdict: RecommendationVerdict,
): RecommendationBreakdown {
  return {
    ...breakdown,
    ai_verdict: aiVerdict,
    final: aiVerdict,
  };
}

// ─── Convenience: stats for prompt / pre-computed signals ──────────────────────

/** Generate a compact one-line summary of the historical evidence for prompts. */
export function historicalEvidenceSummary(ev: HistoricalEvidence): string {
  if (ev.sampleN === 0) return 'no history';
  if (ev.sampleN < MIN_PAIR_TYPE_SAMPLES) return `${ev.sampleN} samples (insufficient)`;
  return `${ev.sampleN} trades, WR ${ev.winRate?.toFixed(0) ?? 'n/a'}%, avgPL ${ev.avgPlPct?.toFixed(2) ?? 'n/a'}%, MFE/MAE ${ev.mfeP50?.toFixed(2) ?? 'n/a'}/${ev.maeP50?.toFixed(2) ?? 'n/a'}`;
}
