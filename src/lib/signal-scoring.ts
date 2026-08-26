import type { AISignal, SignalHistory } from '@/types/types';

// ── Scoring constants ──────────────────────────────────────────────────────
export const GATE_TYPE_SAMPLE = 15;   // min evaluated signals of same type
export const GATE_WIN_RATE    = 45;   // min type win rate % (kalibrert mot 30-dagers rullende vindu, WIN/LOSS kun)
export const GATE_AVG_PL       = 0;   // min type avg P/L % (must be positive)
export const GATE_CONFIDENCE   = 65;  // min signal confidence
export const GATE_STRENGTH     = 65;  // min signal strength
export const GATE_RR           = 1.5; // min risk/reward
export const MIN_PAIR_RELIABLE = 5;   // pair sample below this → heavily discounted
export const RECENT_DAYS       = 7;

// Gate 2 rullerende vindu: beregn typeWinRate fra kun WIN/LOSS-rader generert
// innenfor de siste 30 dagene. Ekskluderer EXPIRED fra nevneren slik at utfall
// som aldri ble avgjort ikke kunstig senker vinn-raten.
// Fallback: all-time WIN/LOSS WR brukes dersom vinduet har < GATE_TYPE_SAMPLE evaluerte rader.
export const GATE2_WINDOW_DAYS = 30;

export const REC_FRESH_MS =  10 * 60 * 1_000; // 0–10 min  → FRESH
export const REC_AGING_MS =  60 * 60 * 1_000; // 10–60 min → AGING (signals still visible until TTL expires)
// > holding_time TTL → STALE (dropped from liveSignals by recomputeLiveSignals)

export const MAX_RECOMMENDED = 5;
export const AUTO_TRADER_INVESTMENT_PCT = 0.25; // 25% of available balance per trade

export type TradeTier = 'RECOMMENDED' | 'WATCH' | 'NO_TRADE';

export interface FailedGate {
  label: string;
  value: string;
  required: string;
}

export interface ScoredSignal {
  signal: AISignal;
  score: number;
  currentScore: number;
  freshnessLabel: 'FRESH' | 'AGING' | 'STALE';
  signalAgeMs: number;
  tier: TradeTier;
  typeWinRate: number | null;
  typeSampleSize: number;
  typeAvgPL: number | null;
  pairWinRate: number | null;
  pairSampleSize: number;
  pairAvgPL: number | null;
  effectiveAvgPL: number | null;
  recentWinRate: number | null;
  recentSampleSize: number;
  recentAvgPL: number | null;
  comparableWinRate: number | null;
  comparableSampleSize: number;
  comparableAvgPL: number | null;
  comparableExpiredRate: number | null;
  expiredRate: number | null;
  expiredAvgPL: number | null;
  expiredSampleSize: number;
  failedGates: FailedGate[];
  reason: string;
}

/**
 * Format signal age in a compact human string: "11s ago", "2m 3s ago", "45m ago".
 */
export function fmtSignalAge(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  const m = Math.floor(ageMs / 60_000);
  const s = Math.floor((ageMs % 60_000) / 1_000);
  return s > 0 ? `${m}m ${s}s ago` : `${m}m ago`;
}

/**
 * Parse a holding_time string like "3-6 hours", "1-3 days", "1 week", "15m"
 * and return the UPPER-BOUND duration in milliseconds (= signal evaluation window).
 * Falls back to 6 hours when unparseable.
 */
export function holdingTimeToMsFE(holdingTime: string | null | undefined): number {
  if (!holdingTime) return 6 * 60 * 60 * 1000;
  const s = holdingTime.toLowerCase().trim();
  const rH = s.match(/(\d+(?:\.\d+)?)\s*[-\u2013]\s*(\d+(?:\.\d+)?)\s*h/);
  if (rH) return parseFloat(rH[2]) * 3_600_000;
  const rD = s.match(/(\d+(?:\.\d+)?)\s*[-\u2013]\s*(\d+(?:\.\d+)?)\s*d/);
  if (rD) return parseFloat(rD[2]) * 86_400_000;
  const rW = s.match(/(\d+(?:\.\d+)?)\s*[-\u2013]\s*(\d+(?:\.\d+)?)\s*w/);
  if (rW) return parseFloat(rW[2]) * 7 * 86_400_000;
  const sH = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (sH) return parseFloat(sH[1]) * 3_600_000;
  const sD = s.match(/(\d+(?:\.\d+)?)\s*d/);
  if (sD) return parseFloat(sD[1]) * 86_400_000;
  const sW = s.match(/(\d+(?:\.\d+)?)\s*w/);
  if (sW) return parseFloat(sW[1]) * 7 * 86_400_000;
  const m = s.match(/(\d+(?:\.\d+)?)\s*m/);
  if (m) return parseFloat(m[1]) * 60_000;
  return 6 * 3_600_000;
}

/**
 * Compute live signal scores and tiers from historical performance.
 * Extracted from AISignalsPage so it can be reused by the persistent Auto Trader
 * engine in TradingContext.
 */
export function computeLiveSignalScores(
  liveSignals: AISignal[],
  history: SignalHistory[],
  resetAt: string | null | undefined,
): ScoredSignal[] {
  const resetMs = resetAt ? new Date(resetAt).getTime() : 0;
  const useBoundary = resetMs > 0 && !isNaN(resetMs);
  const filteredHistory = useBoundary
    ? history.filter(h => new Date(h.generated_at).getTime() >= resetMs)
    : history;

  const evaluated = filteredHistory.filter(h => h.result === 'WIN' || h.result === 'LOSS');
  const expired = filteredHistory.filter(h => h.result === 'EXPIRED');
  const now = Date.now();
  const recentCutoff   = now - RECENT_DAYS   * 24 * 60 * 60 * 1000;
  // Gate 2: kun WIN/LOSS generert de siste GATE2_WINDOW_DAYS dagene
  const gate2Cutoff    = now - GATE2_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const pairTypeMap: Record<string, { wins: number; losses: number; plSum: number }> = {};
  const typeMap: Record<string, { wins: number; losses: number; plSum: number }> = {};
  // Gate 2: 30-dagers rullende vindu, kun WIN/LOSS, EXPIRED ekskludert fra nevner
  const typeMap30d: Record<string, { wins: number; losses: number; plSum: number }> = {};
  const recentTypeMap: Record<string, { wins: number; losses: number; plSum: number }> = {};
  const pairExpiredMap: Record<string, { count: number; plSum: number }> = {};
  const typeExpiredMap: Record<string, { count: number; plSum: number }> = {};

  for (const h of evaluated) {
    const pKey = `${h.pair}:${h.signal_type}`;
    if (!pairTypeMap[pKey]) pairTypeMap[pKey] = { wins: 0, losses: 0, plSum: 0 };
    if (!typeMap[h.signal_type]) typeMap[h.signal_type] = { wins: 0, losses: 0, plSum: 0 };

    const isWin = h.result === 'WIN';
    const pl = h.pl_pct ?? 0;

    if (isWin) { pairTypeMap[pKey].wins++; typeMap[h.signal_type].wins++; }
    else { pairTypeMap[pKey].losses++; typeMap[h.signal_type].losses++; }
    pairTypeMap[pKey].plSum += pl;
    typeMap[h.signal_type].plSum += pl;

    // Gate 2: legg til i 30-dagers vindu hvis generert innenfor cutoff
    const genMs = new Date(h.generated_at).getTime();
    if (genMs >= gate2Cutoff) {
      if (!typeMap30d[h.signal_type]) typeMap30d[h.signal_type] = { wins: 0, losses: 0, plSum: 0 };
      if (isWin) typeMap30d[h.signal_type].wins++;
      else typeMap30d[h.signal_type].losses++;
      typeMap30d[h.signal_type].plSum += pl;
    }

    const evalMs = new Date(h.evaluated_at ?? h.generated_at).getTime();
    if (evalMs >= recentCutoff) {
      if (!recentTypeMap[h.signal_type]) recentTypeMap[h.signal_type] = { wins: 0, losses: 0, plSum: 0 };
      if (isWin) recentTypeMap[h.signal_type].wins++;
      else recentTypeMap[h.signal_type].losses++;
      recentTypeMap[h.signal_type].plSum += pl;
    }
  }

  for (const h of expired) {
    const pKey = `${h.pair}:${h.signal_type}`;
    if (!pairExpiredMap[pKey]) pairExpiredMap[pKey] = { count: 0, plSum: 0 };
    if (!typeExpiredMap[h.signal_type]) typeExpiredMap[h.signal_type] = { count: 0, plSum: 0 };
    const pl = h.pl_pct ?? 0;
    pairExpiredMap[pKey].count++;
    pairExpiredMap[pKey].plSum += pl;
    typeExpiredMap[h.signal_type].count++;
    typeExpiredMap[h.signal_type].plSum += pl;
  }

  const winRateOf = (wins: number, losses: number) => {
    const t = wins + losses;
    return t === 0 ? null : (wins / t) * 100;
  };
  const avgPlOf = (d: { wins: number; losses: number; plSum: number }) => {
    const t = d.wins + d.losses;
    return t === 0 ? null : d.plSum / t;
  };

  const isSimilar = (live: AISignal, hist: SignalHistory): boolean => {
    if (live.pair !== hist.pair) return false;
    if (live.signal_type !== hist.signal_type) return false;
    if (live.ai_source && hist.ai_source && live.ai_source !== hist.ai_source) return false;

    const conf = live.confidence ?? 0;
    const hConf = hist.confidence ?? 0;
    if (Math.abs(conf - hConf) > 15) return false;

    const str = live.signal_strength ?? 0;
    const hStr = hist.signal_strength ?? 0;
    if (Math.abs(str - hStr) > 15) return false;

    const rr = parseFloat(live.risk_reward ?? '1.5');
    const hRR = parseFloat(hist.risk_reward ?? '1.5');
    if (Math.abs(rr - hRR) > 0.5) return false;

    const levels: [number | undefined, number | null][] = [
      [live.entry_zone_low, hist.entry_zone_low],
      [live.take_profit_1, hist.take_profit_1],
      [live.stop_loss, hist.stop_loss],
    ];
    for (const [l, r] of levels) {
      const a = typeof l === 'number' ? l : 0;
      const b = typeof r === 'number' ? r : 0;
      if (a === 0 && b === 0) continue;
      if (a === 0 || b === 0) return false;
      if (Math.abs(a - b) / Math.max(a, b) > 0.05) return false;
    }

    return true;
  };

  const scored: ScoredSignal[] = liveSignals
    .filter(s => s.signal_type === 'BUY' || s.signal_type === 'SELL')
    .map(signal => {
      const pKey = `${signal.pair}:${signal.signal_type}`;
      const pData = pairTypeMap[pKey];
      const tData = typeMap[signal.signal_type];
      const rData = recentTypeMap[signal.signal_type];
      const teData = typeExpiredMap[signal.signal_type];

      const pTotal = pData ? pData.wins + pData.losses : 0;
      const tTotal = tData ? tData.wins + tData.losses : 0;

      // ── Gate 2: rullerende 30-dagers vindu (kun WIN/LOSS, EXPIRED ekskludert) ──
      // Kilde:   typeMap30d hvis vinduet har ≥ GATE_TYPE_SAMPLE evaluerte rader
      // Fallback: typeMap (all-time) dersom vinduet mangler nok data
      const t30d    = typeMap30d[signal.signal_type];
      const t30dTotal = t30d ? t30d.wins + t30d.losses : 0;
      const useWindow = t30dTotal >= GATE_TYPE_SAMPLE;
      const gate2Source = useWindow ? 'WINDOW_30D' : 'FALLBACK_ALLTIME';
      const typeWRSource = useWindow ? t30d! : tData;
      const typeWR = typeWRSource ? winRateOf(typeWRSource.wins, typeWRSource.losses) : null;

      // All-time WR og avgPL brukes i scoring/display; Gate 2 bruker typeWR (valgt kilde over)
      const typeAvgPL = tData ? avgPlOf(tData) : null;
      const pairWR = pData ? winRateOf(pData.wins, pData.losses) : null;
      const pairAvgPL = pData ? avgPlOf(pData) : null;
      const recentWR = rData ? winRateOf(rData.wins, rData.losses) : null;
      const recentAvgPL = rData ? avgPlOf(rData) : null;

      const comparable = evaluated.filter(h => isSimilar(signal, h));
      const compWins = comparable.filter(h => h.result === 'WIN').length;
      const compLoss = comparable.filter(h => h.result === 'LOSS').length;
      const compTotal = compWins + compLoss;
      const compPL = compTotal > 0
        ? comparable.reduce((sum, h) => sum + (h.pl_pct ?? 0), 0) / compTotal
        : null;
      const compWR = compTotal > 0 ? (compWins / compTotal) * 100 : null;
      const compExpired = expired.filter(h => isSimilar(signal, h));
      const compExpTotal = compExpired.length;
      const compExpiredRate = compTotal + compExpTotal > 0
        ? (compExpTotal / (compTotal + compExpTotal)) * 100
        : null;

      const typeTotalWithExpired = tTotal + (teData?.count ?? 0);
      const typeExpiredRate = typeTotalWithExpired > 0
        ? ((teData?.count ?? 0) / typeTotalWithExpired) * 100
        : null;
      const typeExpiredAvgPL = teData?.count ? teData.plSum / teData.count : null;

      const pairWeight = Math.min(1, pTotal / MIN_PAIR_RELIABLE);
      const typeBasePL = typeAvgPL ?? 0;
      const effectiveAvgPL = pairAvgPL !== null
        ? pairWeight * pairAvgPL + (1 - pairWeight) * typeBasePL
        : typeAvgPL;

      const rr = parseFloat(signal.risk_reward ?? '1.5');
      const conf = signal.confidence ?? 0;
      const str = signal.signal_strength ?? 0;

      const failedGates: FailedGate[] = [];

      // Gate 1: all-time sample size (uendret)
      if (tTotal < GATE_TYPE_SAMPLE)
        failedGates.push({ label: 'Evaluated signals', value: `${tTotal}`, required: `≥${GATE_TYPE_SAMPLE}` });
      // Gate 2: 30-dagers WR (WIN/LOSS kun); fallback til all-time hvis vinduet < 15 rader
      if ((typeWR ?? 0) < GATE_WIN_RATE)
        failedGates.push({
          label: 'Type win rate',
          value: typeWR != null ? `${typeWR.toFixed(0)}% (${gate2Source === 'WINDOW_30D' ? `${t30dTotal} rader, siste 30d` : `fallback all-time`})` : '—',
          required: `≥${GATE_WIN_RATE}%`,
        });
      if ((typeAvgPL ?? -1) <= GATE_AVG_PL)
        failedGates.push({ label: 'Type avg P/L', value: typeAvgPL != null ? `${typeAvgPL >= 0 ? '+' : ''}${typeAvgPL.toFixed(1)}%` : '—', required: `>${GATE_AVG_PL}%` });
      if (conf < GATE_CONFIDENCE)
        failedGates.push({ label: 'Confidence', value: `${conf}%`, required: `≥${GATE_CONFIDENCE}%` });
      if (str < GATE_STRENGTH)
        failedGates.push({ label: 'Signal strength', value: `${str}`, required: `≥${GATE_STRENGTH}` });
      if (rr < GATE_RR)
        failedGates.push({ label: 'Risk/Reward', value: `1:${rr}`, required: `≥1:${GATE_RR}` });

      const sWR = Math.max(0, Math.min(1, ((typeWR ?? 50) - 35) / 45));
      const sAvgPL = effectiveAvgPL != null
        ? Math.max(0, Math.min(1, (effectiveAvgPL + 3) / 8))
        : 0.5;
      const sConf = Math.max(0, Math.min(1, (conf - 55) / 30));
      const sStr = Math.max(0, Math.min(1, (str - 50) / 50));
      const sRR = Math.max(0, Math.min(1, (rr - 1.0) / 2.0));
      const sRecent = recentWR != null ? Math.max(0, Math.min(1, (recentWR - 35) / 45)) : sWR;
      const blendedWR = sWR * 0.6 + sRecent * 0.4;

      const compSampleBonus = compTotal >= 10 ? 0.05 : compTotal >= 5 ? 0.025 : 0;
      const compWRScore = compWR != null ? Math.max(0, Math.min(1, (compWR - 35) / 45)) : sWR;
      const compPLScore = compPL != null ? Math.max(0, Math.min(1, (compPL + 3) / 8)) : sAvgPL;
      const finalWR = compTotal >= 5 ? compWRScore * 0.7 + sWR * 0.3 : blendedWR;
      const finalPL = compTotal >= 5 ? compPLScore * 0.6 + sAvgPL * 0.4 : sAvgPL;

      const expiredPenalty = typeExpiredRate != null && typeExpiredRate > 30
        ? Math.min(0.15, (typeExpiredRate - 30) / 100)
        : 0;

      const score = Math.max(0, Math.round(
        finalWR * 35 + finalPL * 20 + sConf * 15 + sStr * 10 + sRR * 10 + compSampleBonus * 100
      ) - Math.round(expiredPenalty * 100));

      let tier: TradeTier;
      let reason: string;

      if (failedGates.length === 0) {
        tier = 'RECOMMENDED';
        const wrSrc = gate2Source === 'WINDOW_30D' ? ` (siste 30d, ${t30dTotal} eval.)` : ` (all-time fallback)`;
        reason = `${typeWR!.toFixed(0)}%${wrSrc} type win rate, avg ${typeAvgPL! >= 0 ? '+' : ''}${typeAvgPL!.toFixed(1)}% P/L across ${tTotal} evaluated ${signal.signal_type} signals.`;
        if (compTotal >= 3) {
          reason += ` Similar setups: ${compWins}W/${compLoss}L (${compWR!.toFixed(0)}% WR${compPL != null ? `, avg ${compPL >= 0 ? '+' : ''}${compPL.toFixed(1)}%` : ''}).`;
        }
        if (typeExpiredRate != null && typeExpiredRate > 0) {
          reason += ` Expired ${typeExpiredRate.toFixed(0)}% of the time.`;
        }
      } else if (failedGates.length <= 2 && tTotal >= GATE_TYPE_SAMPLE) {
        tier = 'WATCH';
        const missedNames = failedGates.map(g => g.label).join(', ');
        reason = `Close to qualifying — not meeting: ${missedNames}.`;
      } else {
        tier = 'NO_TRADE';
        if (tTotal < GATE_TYPE_SAMPLE) {
          reason = `Insufficient historical data: only ${tTotal} ${signal.signal_type} signal${tTotal !== 1 ? 's' : ''} evaluated (need ${GATE_TYPE_SAMPLE}).`;
        } else {
          const missedNames = failedGates.map(g => g.label).join(', ');
          reason = `Does not qualify: ${missedNames}.`;
        }
      }

      const signalAgeMs = now - new Date(signal.generated_at).getTime();
      const freshnessLabel: 'FRESH' | 'AGING' | 'STALE' =
        signalAgeMs <= REC_FRESH_MS ? 'FRESH' :
        signalAgeMs <= REC_AGING_MS ? 'AGING' : 'STALE';

      const freshnessMult =
        freshnessLabel === 'FRESH' ? 1.0 :
        freshnessLabel === 'AGING' ? 0.7 : 0.3;

      const currentScore = Math.round(score * freshnessMult);

      // Runtime freshness logging: enables tracing across Recommended, BEST
      // CURRENT SETUP and Auto Trader from a single source of truth.
      console.log('SIGNAL_FRESHNESS', {
        symbol: signal.symbol,
        pair: signal.pair,
        generatedAt: signal.generated_at,
        now,
        ageMs: signalAgeMs,
        ageMinutes: Math.round(signalAgeMs / 60_000),
        freshnessLabel,
        tradeable: freshnessLabel === 'FRESH' && (signal.signal_type === 'BUY' || signal.signal_type === 'SELL'),
        score,
        currentScore,
        tier,
        gate2Source,
        typeWinRate30d: useWindow ? typeWR : null,
        typeWinRateAllTime: tData ? winRateOf(tData.wins, tData.losses) : null,
        t30dTotal,
      });

      return {
        signal, score, currentScore, freshnessLabel, signalAgeMs, tier,
        typeWinRate: typeWR, typeSampleSize: tTotal, typeAvgPL,
        pairWinRate: pairWR, pairSampleSize: pTotal, pairAvgPL,
        effectiveAvgPL, recentWinRate: recentWR, recentSampleSize: rData ? rData.wins + rData.losses : 0, recentAvgPL,
        comparableWinRate: compWR, comparableSampleSize: compTotal, comparableAvgPL: compPL,
        comparableExpiredRate: compExpiredRate,
        expiredRate: typeExpiredRate, expiredAvgPL: typeExpiredAvgPL, expiredSampleSize: teData?.count ?? 0,
        failedGates, reason,
      };
    });

  const resolveExpiresAtMs = (signal: AISignal): number => {
    if (signal.expires_at) {
      const t = new Date(signal.expires_at).getTime();
      if (!isNaN(t)) return t;
    }
    return new Date(signal.generated_at).getTime() + holdingTimeToMsFE(signal.holding_time);
  };
  const nowMs = Date.now();
  const live = scored.filter(x => resolveExpiresAtMs(x.signal) > nowMs);

  const tierOrder: Record<TradeTier, number> = { RECOMMENDED: 0, WATCH: 1, NO_TRADE: 2 };
  const sorted = live.sort((a, b) => {
    if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
    if (a.tier === 'RECOMMENDED') return b.currentScore - a.currentScore;
    return b.score - a.score;
  });

  const recommended = sorted.filter(x => x.tier === 'RECOMMENDED').slice(0, MAX_RECOMMENDED);
  const rest = sorted.filter(x => x.tier !== 'RECOMMENDED');
  return [...recommended, ...rest];
}
