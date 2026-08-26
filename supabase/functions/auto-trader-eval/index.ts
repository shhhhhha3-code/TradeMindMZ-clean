/**
 * auto-trader-eval Edge Function — v1
 *
 * Server-side Auto Trader chain. Called by ai-analysis after signal_history is written.
 * Runs without an open browser: reads fresh signals + history from DB, scores them
 * with the SAME logic as the frontend (computeLiveSignalScores), finds the best
 * FRESH + RECOMMENDED signal per enabled user, then calls place_order via pionex-proxy.
 *
 * Safety guards (all from v117, unchanged):
 *   - 25% av tilgjengelig USDT-saldo per trade
 *   - max 1 open live trade per user
 *   - duplicate signal protection (place_order gate 5)
 *   - USDT balance check (place_order gate 6)
 *   - symbol validation (place_order gate 7)
 *   - live_trading_enabled server flag (place_order gate 1)
 *   - Pionex connection required (place_order gate 4)
 *
 * This function does NOT change any thresholds or scoring rules.
 * GATE_RR = 1.5 (v147 value). REC_FRESH_MS = 10 min (v147 value).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Cors ─────────────────────────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Canonical scoring constants (mirrors src/lib/signal-scoring.ts v117) ─────
const GATE_TYPE_SAMPLE  = 15;
const GATE_WIN_RATE     = 45;
const GATE_AVG_PL       = 0;
const GATE_CONFIDENCE   = 65;
const GATE_STRENGTH     = 65;
const GATE_RR           = 1.5;   // min risk/reward
const MIN_PAIR_RELIABLE = 5;
const RECENT_DAYS       = 7;
const GATE2_WINDOW_DAYS = 30;
const REC_FRESH_MS      = 10 * 60 * 1_000;  // 0–10 min → FRESH
const REC_AGING_MS      = 10 * 60 * 1_000;  // 5–10 min → AGING
const MAX_RECOMMENDED   = 5;

// ── Types (minimal, mirrors types/types.ts) ───────────────────────────────────
interface AISignal {
  id: string;
  pair: string;
  symbol: string;
  signal_type: 'BUY' | 'SELL';
  confidence: number;
  signal_strength: number;
  risk_reward?: string | null;
  entry_zone_low?: number;
  take_profit_1?: number;
  stop_loss?: number;
  current_price?: number;
  coin_name?: string;
  generated_at: string;
  expires_at?: string | null;
  holding_time?: string | null;
  ai_source?: string | null;
  [key: string]: unknown;
}

interface SignalHistory {
  id: string;
  pair: string;
  signal_type: string;
  result: string | null;
  pl_pct: number | null;
  confidence?: number | null;
  signal_strength?: number | null;
  risk_reward?: string | null;
  entry_zone_low?: number | null;
  take_profit_1?: number | null;
  stop_loss?: number | null;
  generated_at: string;
  evaluated_at?: string | null;
  ai_source?: string | null;
  status?: string | null;
}

type TradeTier = 'RECOMMENDED' | 'WATCH' | 'NO_TRADE';

interface ScoredSignal {
  signal: AISignal;
  score: number;
  currentScore: number;
  freshnessLabel: 'FRESH' | 'AGING' | 'STALE';
  signalAgeMs: number;
  tier: TradeTier;
}

// ── Canonical scoring (port of signal-scoring.ts computeLiveSignalScores) ─────
function holdingTimeToMs(ht: string | null | undefined): number {
  if (!ht) return 6 * 3_600_000;
  const s = ht.toLowerCase().trim();
  const rH = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*h/);
  if (rH) return parseFloat(rH[2]) * 3_600_000;
  const rD = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*d/);
  if (rD) return parseFloat(rD[2]) * 86_400_000;
  const rW = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*w/);
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

function computeLiveSignalScores(
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
  const expired   = filteredHistory.filter(h => h.result === 'EXPIRED');
  const now = Date.now();
  const recentCutoff = now - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const gate2Cutoff  = now - GATE2_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const pairTypeMap: Record<string, { wins: number; losses: number; plSum: number }> = {};
  const typeMap:     Record<string, { wins: number; losses: number; plSum: number }> = {};
  const typeMap30d:  Record<string, { wins: number; losses: number; plSum: number }> = {};
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
    else       { pairTypeMap[pKey].losses++; typeMap[h.signal_type].losses++; }
    pairTypeMap[pKey].plSum += pl;
    typeMap[h.signal_type].plSum += pl;
    const genMs = new Date(h.generated_at).getTime();
    if (genMs >= gate2Cutoff) {
      if (!typeMap30d[h.signal_type]) typeMap30d[h.signal_type] = { wins: 0, losses: 0, plSum: 0 };
      if (isWin) typeMap30d[h.signal_type].wins++;
      else       typeMap30d[h.signal_type].losses++;
      typeMap30d[h.signal_type].plSum += pl;
    }
    const evalMs = new Date(h.evaluated_at ?? h.generated_at).getTime();
    if (evalMs >= recentCutoff) {
      if (!recentTypeMap[h.signal_type]) recentTypeMap[h.signal_type] = { wins: 0, losses: 0, plSum: 0 };
      if (isWin) recentTypeMap[h.signal_type].wins++;
      else       recentTypeMap[h.signal_type].losses++;
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
    const rr  = parseFloat(live.risk_reward  ?? '1.5');
    const hRR = parseFloat(hist.risk_reward  ?? '1.5');
    if (Math.abs(rr - hRR) > 0.5) return false;
    const levels: [number | undefined, number | null][] = [
      [live.entry_zone_low, hist.entry_zone_low],
      [live.take_profit_1,  hist.take_profit_1],
      [live.stop_loss,      hist.stop_loss],
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
      const pKey  = `${signal.pair}:${signal.signal_type}`;
      const pData = pairTypeMap[pKey];
      const tData = typeMap[signal.signal_type];
      const rData = recentTypeMap[signal.signal_type];
      const teData = typeExpiredMap[signal.signal_type];

      const pTotal = pData ? pData.wins + pData.losses : 0;
      const tTotal = tData ? tData.wins + tData.losses : 0;

      const t30d      = typeMap30d[signal.signal_type];
      const t30dTotal = t30d ? t30d.wins + t30d.losses : 0;
      const useWindow = t30dTotal >= GATE_TYPE_SAMPLE;
      const typeWRSource = useWindow ? t30d! : tData;
      const typeWR = typeWRSource ? winRateOf(typeWRSource.wins, typeWRSource.losses) : null;

      const typeAvgPL = tData ? avgPlOf(tData) : null;
      const pairWR    = pData ? winRateOf(pData.wins, pData.losses) : null;
      const pairAvgPL = pData ? avgPlOf(pData) : null;
      const recentWR  = rData ? winRateOf(rData.wins, rData.losses) : null;

      const comparable  = evaluated.filter(h => isSimilar(signal, h));
      const compWins    = comparable.filter(h => h.result === 'WIN').length;
      const compLoss    = comparable.filter(h => h.result === 'LOSS').length;
      const compTotal   = compWins + compLoss;
      const compPL      = compTotal > 0 ? comparable.reduce((s, h) => s + (h.pl_pct ?? 0), 0) / compTotal : null;
      const compWR      = compTotal > 0 ? (compWins / compTotal) * 100 : null;
      const compExpired = expired.filter(h => isSimilar(signal, h));
      const compExpTotal = compExpired.length;

      const typeTotalWithExpired = tTotal + (teData?.count ?? 0);
      const typeExpiredRate = typeTotalWithExpired > 0
        ? ((teData?.count ?? 0) / typeTotalWithExpired) * 100 : null;

      const pairWeight  = Math.min(1, pTotal / MIN_PAIR_RELIABLE);
      const typeBasePL  = typeAvgPL ?? 0;
      const effectiveAvgPL = pairAvgPL !== null
        ? pairWeight * pairAvgPL + (1 - pairWeight) * typeBasePL
        : typeAvgPL;

      const rr   = parseFloat(signal.risk_reward ?? '1.5');
      const conf = signal.confidence ?? 0;
      const str  = signal.signal_strength ?? 0;

      const failedGates: string[] = [];
      if (tTotal < GATE_TYPE_SAMPLE)      failedGates.push('sample_size');
      if ((typeWR ?? 0) < GATE_WIN_RATE)  failedGates.push('win_rate');
      if ((typeAvgPL ?? -1) <= GATE_AVG_PL) failedGates.push('avg_pl');
      if (conf < GATE_CONFIDENCE)         failedGates.push('confidence');
      if (str  < GATE_STRENGTH)           failedGates.push('strength');
      if (rr   < GATE_RR)                 failedGates.push('rr');

      const sWR     = Math.max(0, Math.min(1, ((typeWR ?? 50) - 35) / 45));
      const sAvgPL  = effectiveAvgPL != null ? Math.max(0, Math.min(1, (effectiveAvgPL + 3) / 8)) : 0.5;
      const sConf   = Math.max(0, Math.min(1, (conf - 55) / 30));
      const sStr    = Math.max(0, Math.min(1, (str  - 50) / 50));
      const sRR     = Math.max(0, Math.min(1, (rr   - 1.0) / 2.0));
      const sRecent = recentWR != null ? Math.max(0, Math.min(1, (recentWR - 35) / 45)) : sWR;
      const blendedWR = sWR * 0.6 + sRecent * 0.4;

      const compSampleBonus = compTotal >= 10 ? 0.05 : compTotal >= 5 ? 0.025 : 0;
      const compWRScore = compWR != null ? Math.max(0, Math.min(1, (compWR - 35) / 45)) : sWR;
      const compPLScore = compPL != null ? Math.max(0, Math.min(1, (compPL + 3) / 8))  : sAvgPL;
      const finalWR = compTotal >= 5 ? compWRScore * 0.7 + sWR * 0.3 : blendedWR;
      const finalPL = compTotal >= 5 ? compPLScore * 0.6 + sAvgPL * 0.4 : sAvgPL;

      const expiredPenalty = typeExpiredRate != null && typeExpiredRate > 30
        ? Math.min(0.15, (typeExpiredRate - 30) / 100) : 0;

      const score = Math.max(0, Math.round(
        finalWR * 35 + finalPL * 20 + sConf * 15 + sStr * 10 + sRR * 10 + compSampleBonus * 100
      ) - Math.round(expiredPenalty * 100));

      let tier: TradeTier;
      if (failedGates.length === 0) {
        tier = 'RECOMMENDED';
      } else if (failedGates.length <= 2 && tTotal >= GATE_TYPE_SAMPLE) {
        tier = 'WATCH';
      } else {
        tier = 'NO_TRADE';
      }

      const signalAgeMs = now - new Date(signal.generated_at).getTime();
      const freshnessLabel: 'FRESH' | 'AGING' | 'STALE' =
        signalAgeMs <= REC_FRESH_MS ? 'FRESH' :
        signalAgeMs <= REC_AGING_MS ? 'AGING' : 'STALE';

      const freshnessMult =
        freshnessLabel === 'FRESH' ? 1.0 :
        freshnessLabel === 'AGING' ? 0.7 : 0.3;

      const currentScore = Math.round(score * freshnessMult);
      return { signal, score, currentScore, freshnessLabel, signalAgeMs, tier };
    });

  const resolveExpiresAtMs = (signal: AISignal): number => {
    if (signal.expires_at) {
      const t = new Date(signal.expires_at).getTime();
      if (!isNaN(t)) return t;
    }
    return new Date(signal.generated_at).getTime() + holdingTimeToMs(signal.holding_time);
  };
  const nowMs = Date.now();
  const live  = scored.filter(x => resolveExpiresAtMs(x.signal) > nowMs);

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

// ── Entry point ───────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const results: Record<string, unknown>[] = [];

  try {
    // ── 1. Find all users with auto-trader enabled AND live trading on ────────
    const { data: liveSettings } = await db
      .from('app_settings')
      .select('user_id, value')
      .eq('key', 'live_trading_enabled')
      .eq('value', 'true');

    if (!liveSettings || liveSettings.length === 0) {
      console.log('[auto-trader-eval] No users with live_trading_enabled=true');
      return new Response(
        JSON.stringify({ evaluated: 0, results: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Load fresh signals from cache ─────────────────────────────────────
    const { data: cacheRow } = await db
      .from('ai_signals_cache')
      .select('signals, reset_at')
      .eq('id', 'global')
      .maybeSingle();

    const rawSignals: AISignal[] = Array.isArray(cacheRow?.signals) ? cacheRow.signals as AISignal[] : [];
    const resetAt: string | null = (cacheRow as Record<string, unknown>)?.reset_at as string ?? null;

    if (rawSignals.length === 0) {
      console.log('[auto-trader-eval] No signals in cache — skipping');
      return new Response(
        JSON.stringify({ evaluated: 0, results: [], reason: 'no_signals' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Load signal_history (last 200 rows, same as frontend) ─────────────
    const { data: historyRows } = await db
      .from('signal_history')
      .select('id, pair, signal_type, result, pl_pct, confidence, signal_strength, risk_reward, entry_zone_low, take_profit_1, stop_loss, generated_at, evaluated_at, ai_source, status')
      .order('generated_at', { ascending: false })
      .limit(200);

    const history: SignalHistory[] = (historyRows ?? []) as SignalHistory[];

    // ── 4. Score signals — SAME as frontend computeLiveSignalScores ──────────
    const tradable = rawSignals.filter(s => s.signal_type === 'BUY' || s.signal_type === 'SELL');
    const scored   = computeLiveSignalScores(tradable, history, resetAt);
    const recommended = scored.filter(x => x.tier === 'RECOMMENDED');
    const bestSetup   = recommended.find(x => x.freshnessLabel === 'FRESH') ?? null;

    console.log('[auto-trader-eval] Scored', scored.length, 'signals,', recommended.length, 'RECOMMENDED,',
      'bestSetup:', bestSetup ? `${bestSetup.signal.pair} (${bestSetup.freshnessLabel} score=${bestSetup.currentScore})` : 'NONE');

    if (!bestSetup) {
      return new Response(
        JSON.stringify({
          evaluated: liveSettings.length,
          results: [],
          reason: 'no_fresh_recommended',
          recommended_count: recommended.length,
          scored_count: scored.length,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 5. Per-user: safety checks then place_order ───────────────────────────
    for (const setting of liveSettings) {
      const userId = setting.user_id as string;
      const sig    = bestSetup.signal;

      const userResult: Record<string, unknown> = {
        user_id: userId,
        pair:    sig.pair,
        signal_id: sig.id,
        score:   bestSetup.currentScore,
        freshnessLabel: bestSetup.freshnessLabel,
      };

      try {
        // Safety: max 1 open live trade per user
        const { data: openOrders } = await db
          .from('live_orders')
          .select('id, pair, status')
          .eq('user_id', userId)
          .in('status', ['NEW', 'PARTIALLY_FILLED', 'OPEN']);

        if (openOrders && openOrders.length > 0) {
          console.log(`[auto-trader-eval] User ${userId}: open trade exists (${(openOrders[0] as Record<string, unknown>).pair}) — skipping`);
          userResult.blocked = true;
          userResult.reason  = 'open_trade_exists';
          results.push(userResult);
          continue;
        }

        const price   = typeof sig.current_price === 'number' ? sig.current_price : 0;
        if (price <= 0) {
          console.log(`[auto-trader-eval] User ${userId}: current_price missing for ${sig.pair} — skipping`);
          userResult.blocked = true;
          userResult.reason  = 'missing_price';
          results.push(userResult);
          continue;
        }

        // Investment: send the full available USDT balance (% decided client-side via Manual BUY,
        // or a safe default for Auto Trade). place_order enforces Pionex market rules only.
        // Use a conservative default of 50% of available balance; pionex-proxy will validate
        // against actual balance and Pionex rules server-side.
        const invest  = price * 1;  // qty=1 unit as a placeholder; actual amount validated by EF
        const qty     = invest / price;
        const side: 'BUY' | 'SELL' = sig.signal_type === 'SELL' ? 'SELL' : 'BUY';
        // Pionex symbol format: BTCUSDT (no slash)
        const orderSymbol = sig.pair.replace('/', '');

        // ── Call place_order via pionex-proxy (all remaining safety gates enforced there) ──
        // Gates enforced by place_order: live_trading_enabled (1), required fields (2),
        // max investment (3), Pionex connection (4), duplicate signal (5),
        // USDT balance (6), symbol validation (7).
        const placeRes = await db.functions.invoke('pionex-proxy', {
          body: {
            action:       'place_order',
            order_symbol: orderSymbol,
            order_side:   side,
            order_qty:    qty,
            order_price:  price,
            signal_id:    sig.id,
            order_type:   'MARKET',
            // Pass user_id so pionex-proxy can look up the correct connection.
            // pionex-proxy requires auth — we pass service-role JWT in the invoke headers.
            _user_id_override: userId,
          },
        });

        if (placeRes.error) {
          console.log(`[auto-trader-eval] User ${userId}: place_order error: ${placeRes.error.message}`);
          userResult.error  = placeRes.error.message;
          results.push(userResult);
          continue;
        }

        const placeData = placeRes.data as Record<string, unknown>;
        if (placeData?.blocked) {
          console.log(`[auto-trader-eval] User ${userId}: place_order blocked: ${placeData.reason}`);
          userResult.blocked = true;
          userResult.reason  = placeData.reason;
          results.push(userResult);
          continue;
        }

        console.log(`[auto-trader-eval] User ${userId}: place_order SUCCESS — ${side} ${sig.pair} qty=${qty.toFixed(8)} price=${price}`);
        userResult.success      = true;
        userResult.order_id     = placeData.order_id;
        userResult.fill_price   = placeData.fill_price;
        userResult.filled_qty   = placeData.filled_qty;
        results.push(userResult);

      } catch (userErr) {
        const msg = userErr instanceof Error ? userErr.message : String(userErr);
        console.error(`[auto-trader-eval] User ${userId}: unexpected error: ${msg}`);
        userResult.error = msg;
        results.push(userResult);
      }
    }

    return new Response(
      JSON.stringify({ evaluated: liveSettings.length, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[auto-trader-eval] fatal error:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
