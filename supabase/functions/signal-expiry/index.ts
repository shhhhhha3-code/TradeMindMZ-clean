/**
 * signal-expiry Edge Function
 *
 * Server-side evaluation engine for active signals.
 * Runs every minute via pg_cron (independent of browsers).
 *
 * 1. Reads all signal_history rows with status='LIVE'
 * 2. Fetches one Pionex tickers call for current prices
 * 3. For each signal, checks TP/SL first; if neither hit and expires_at passed,
 *    marks EXPIRED. TP/SL always take priority over the AI-recommended hold time.
 * 4. Persists exit_price, result, pl_pct, pl_usdt, evaluated_at, exit_timestamp,
 *    status to signal_history
 * 5. Removes completed signals from the ai_signals_cache 'signals' array so they
 *    disappear from the frontend Live Signals list on the next cache refresh.
 * 6. Upserts scheduler_status row so the frontend can show BACKGROUND execution
 *
 * LIFECYCLE:
 *   ai-analysis EF → writes signal_history row with status='LIVE'
 *   signal-expiry  → updates row to status='WIN'|'LOSS'|'EXPIRED' as soon as
 *                    TP/SL is hit or the AI hold time expires.
 *   History is PERMANENT — rows are never deleted or overwritten.
 *   If both TP and SL are crossed in the same observation, TP wins deterministically.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PIONEX_BASE    = 'https://api.pionex.com';

const SCHEDULER_ID = 'signal-expiry';
const SCHEDULER_INTERVAL_MIN = 1;

interface DBSignalRow {
  id: string;
  pair: string;
  symbol: string;
  signal_type: string;
  entry_price: number;
  take_profit_1: number | null;
  take_profit_2: number | null;
  stop_loss: number | null;
  generated_at: string;
  expires_at: string;
  holding_time: string | null;
}

interface EvaluationResult {
  id: string;
  pair: string;
  result: 'WIN' | 'LOSS' | 'EXPIRED';
  exit_price: number | null;
  pl_pct: number;
  pl_usdt: number;
  exit_timestamp: string;
  evaluated_at: string;
  /** Sub-classification set only for EXPIRED; null for WIN/LOSS */
  expired_class: 'GOOD_DIRECTION' | 'NEUTRAL' | 'BAD_DIRECTION' | null;
}

/** Fetch ALL Pionex tickers in one call; return a symbol→price map */
async function fetchAllPionexPrices(): Promise<Record<string, number>> {
  try {
    const res = await fetch(
      `${PIONEX_BASE}/api/v1/market/tickers`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      console.warn(`[signal-expiry] Pionex HTTP ${res.status}`);
      return {};
    }
    const body = await res.json();
    const tickers: Array<{ symbol: string; close: string }> = body?.data?.tickers ?? [];
    const map: Record<string, number> = {};
    for (const t of tickers) {
      const p = parseFloat(t.close);
      if (!isNaN(p) && p > 0) map[t.symbol] = p;
    }
    return map;
  } catch (err) {
    console.warn('[signal-expiry] Pionex fetch error:', err);
    return {};
  }
}

/**
 * Parse a holding_time string such as "3-6 hours", "6-12 hours", "1-3 days",
 * "1 week", "2-4 weeks" etc. and return the upper bound in milliseconds.
 * Falls back to 6 hours if the string cannot be parsed.
 */
function holdingTimeToMs(holdingTime: string | null | undefined): number {
  if (!holdingTime) return 6 * 60 * 60 * 1000; // 6h default
  const s = holdingTime.toLowerCase().trim();

  // Match patterns like "3-6 hours", "6-12 hours", "2-4 hours"
  const rangeHoursMatch = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*h/);
  if (rangeHoursMatch) return parseFloat(rangeHoursMatch[2]) * 60 * 60 * 1000;

  // Match "3-6 days", "1-3 days"
  const rangeDaysMatch = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*d/);
  if (rangeDaysMatch) return parseFloat(rangeDaysMatch[2]) * 24 * 60 * 60 * 1000;

  // Match "3-6 weeks"
  const rangeWeeksMatch = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*w/);
  if (rangeWeeksMatch) return parseFloat(rangeWeeksMatch[2]) * 7 * 24 * 60 * 60 * 1000;

  // Match single values: "6 hours", "12h", "2 days", "1 week"
  const singleHoursMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (singleHoursMatch) return parseFloat(singleHoursMatch[1]) * 60 * 60 * 1000;

  const singleDaysMatch = s.match(/(\d+(?:\.\d+)?)\s*d/);
  if (singleDaysMatch) return parseFloat(singleDaysMatch[1]) * 24 * 60 * 60 * 1000;

  const singleWeeksMatch = s.match(/(\d+(?:\.\d+)?)\s*w/);
  if (singleWeeksMatch) return parseFloat(singleWeeksMatch[1]) * 7 * 24 * 60 * 60 * 1000;

  return 6 * 60 * 60 * 1000; // fallback: 6 hours
}

/**
 * Evaluate a single signal against the current price.
 * Priority:
 *   1. If current price reaches take_profit_1 → WIN
 *   2. If current price reaches stop_loss → LOSS
 *   3. If full AI-recommended hold time has elapsed and neither hit → EXPIRED (P/L at current price)
 */
function evaluateSignal(
  signal: DBSignalRow,
  exitPrice: number,
  nowMs: number
): { result: 'WIN' | 'LOSS' | 'EXPIRED'; pl_pct: number; pl_usdt: number } {
  const entryPrice = signal.entry_price || 0;
  if (entryPrice === 0) return { result: 'EXPIRED', pl_pct: 0, pl_usdt: 0 };

  const direction = signal.signal_type === 'SELL' ? -1 : 1;
  const pl_pct = direction * ((exitPrice - entryPrice) / entryPrice) * 100;
  // pl_usdt: standardised to a 100 USDT notional position (no position_size in schema).
  // This avoids extreme raw price-diff values for high-priced coins (e.g. BTC, ZEC).
  // Formula: pl_pct / 100 * 100 USDT = pl_pct (numeric USDT on a 100 USDT position).
  const pl_usdt = parseFloat((pl_pct).toFixed(6));

  // TP/SL priority check (use stored levels if present)
  const tp = signal.take_profit_1;
  const sl = signal.stop_loss;

  if (signal.signal_type === 'SELL') {
    // SELL: profit when price falls to or below TP; loss when price rises to or above SL
    if (tp != null && exitPrice <= tp) return { result: 'WIN', pl_pct, pl_usdt };
    if (sl != null && exitPrice >= sl) return { result: 'LOSS', pl_pct, pl_usdt };
  } else {
    // BUY: profit when price rises to or above TP; loss when price falls to or below SL
    if (tp != null && exitPrice >= tp) return { result: 'WIN', pl_pct, pl_usdt };
    if (sl != null && exitPrice <= sl) return { result: 'LOSS', pl_pct, pl_usdt };
  }

  // No TP/SL hit: if full hold time elapsed → EXPIRED with actual P/L; otherwise still LIVE
  // Use expires_at as the hold-time deadline (set from holding_time at write time)
  const expiresMs = new Date(signal.expires_at).getTime();
  if (nowMs >= expiresMs) return { result: 'EXPIRED', pl_pct, pl_usdt };

  // Still within hold period — remain LIVE
  return { result: 'EXPIRED', pl_pct: 0, pl_usdt: 0 };
}

/**
 * Classify an EXPIRED signal based on how far price moved at expiry.
 *
 * GOOD_DIRECTION : directional_pl ≥ 50% of TP1 distance → price moved toward TP
 * BAD_DIRECTION  : |directional_pl| ≥ 50% of SL distance AND away from TP → moved toward SL
 * NEUTRAL        : otherwise — little/no movement, or TP/SL data missing
 *
 * NEVER called for WIN or LOSS — only for EXPIRED signals.
 */
function classifyExpired(
  signal: DBSignalRow,
  exitPrice: number,
): 'GOOD_DIRECTION' | 'NEUTRAL' | 'BAD_DIRECTION' {
  const entry = signal.entry_price || 0;
  if (entry === 0 || exitPrice <= 0) return 'NEUTRAL';

  const tp = signal.take_profit_1;
  const sl = signal.stop_loss;
  if (tp == null || sl == null) return 'NEUTRAL';

  // Directional P&L: positive = moved toward TP, negative = moved away
  const dirPct = signal.signal_type === 'SELL'
    ? (entry - exitPrice) / entry * 100
    : (exitPrice - entry) / entry * 100;

  const tp1Dist = Math.abs(tp - entry) / entry * 100;
  const slDist  = Math.abs(entry - sl) / entry * 100;

  if (dirPct >= 0.5 * tp1Dist && dirPct > 0) return 'GOOD_DIRECTION';
  if (dirPct < 0 && Math.abs(dirPct) >= 0.5 * slDist) return 'BAD_DIRECTION';
  return 'NEUTRAL';
}

async function updateSchedulerStatus(
  db: ReturnType<typeof createClient>,
  success: boolean,
  error: string | null,
  processed: number
) {
  const now = new Date();
  const nextRun = new Date(now.getTime() + SCHEDULER_INTERVAL_MIN * 60_000);
  try {
    await db
      .from('scheduler_status')
      .upsert({
        id: SCHEDULER_ID,
        job_name: 'Signal TP/SL/expiry',
        interval_minutes: SCHEDULER_INTERVAL_MIN,
        is_active: true,
        last_run_at: now.toISOString(),
        last_success_at: success ? now.toISOString() : undefined,
        last_error: error,
        next_run_at: nextRun.toISOString(),
        updated_at: now.toISOString(),
      }, { onConflict: 'id' });
    console.log(`[signal-expiry] scheduler status updated: success=${success} processed=${processed}`);
  } catch (err) {
    console.warn('[signal-expiry] failed to update scheduler_status:', err);
  }
}

/** Remove completed signal IDs from the ai_signals_cache JSON array */
async function removeCompletedFromCache(
  db: ReturnType<typeof createClient>,
  completedIds: Set<string>
): Promise<void> {
  if (completedIds.size === 0) return;
  try {
    const { data: cacheRow } = await db
      .from('ai_signals_cache')
      .select('id, signals')
      .eq('id', 'global')
      .maybeSingle();
    if (!cacheRow || !Array.isArray(cacheRow.signals)) return;

    const filtered = cacheRow.signals.filter((s: { id?: string }) => s?.id && !completedIds.has(s.id));
    if (filtered.length === cacheRow.signals.length) return;

    const { error } = await db
      .from('ai_signals_cache')
      .update({ signals: filtered, updated_at: new Date().toISOString() })
      .eq('id', 'global');
    if (error) console.warn('[signal-expiry] cache cleanup failed:', error.message);
    else console.log(`[signal-expiry] removed ${completedIds.size} completed signals from ai_signals_cache`);
  } catch (err) {
    console.warn('[signal-expiry] cache cleanup error:', err);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const runStart = Date.now();
  let processed = 0;
  let errorMsg: string | null = null;

  try {
    // ── 1. Load ALL LIVE signals (not just expired) ─────────────────────────
    const { data: liveRows, error: fetchErr } = await db
      .from('signal_history')
      .select('id, pair, symbol, signal_type, entry_price, take_profit_1, take_profit_2, stop_loss, generated_at, expires_at, holding_time')
      .eq('status', 'LIVE');

    if (fetchErr) {
      errorMsg = fetchErr.message;
      console.error('[signal-expiry] failed to query signal_history:', errorMsg);
      await updateSchedulerStatus(db, false, errorMsg, 0);
      return new Response(
        JSON.stringify({ processed: 0, error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const toProcess: DBSignalRow[] = liveRows ?? [];
    console.log(`[signal-expiry] found ${toProcess.length} LIVE signals`);

    if (toProcess.length === 0) {
      await updateSchedulerStatus(db, true, null, 0);
      return new Response(
        JSON.stringify({ processed: 0, message: 'No LIVE signals to evaluate' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Fetch all current Pionex prices in one call ─────────────────────
    const priceMap = await fetchAllPionexPrices();
    const priceCount = Object.keys(priceMap).length;
    console.log(`[signal-expiry] fetched ${priceCount} Pionex prices`);

    if (priceCount === 0) {
      errorMsg = 'Pionex price fetch returned empty map';
      await updateSchedulerStatus(db, false, errorMsg, 0);
      return new Response(
        JSON.stringify({ processed: 0, error: errorMsg }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 3. Evaluate each signal (TP/SL priority, then expiry) ───────────────
    const nowMs = Date.now();
    const evaluatedAt = new Date().toISOString();
    const results: EvaluationResult[] = [];

    for (const signal of toProcess) {
      const pionexSym = signal.pair.replace('/', '_');
      const exitPrice = priceMap[pionexSym];
      if (exitPrice == null || exitPrice <= 0) {
        console.warn(`[signal-expiry] no price for ${signal.pair}`);
        continue;
      }

      const { result, pl_pct, pl_usdt } = evaluateSignal(signal, exitPrice, nowMs);
      // If evaluateSignal returns EXPIRED but expiry not yet reached (no TP/SL, still in hold window)
      // the sentinel pl_usdt=0 + pl_pct=0 with nowMs < expires_at means "still LIVE, skip"
      if (result === 'EXPIRED' && pl_pct === 0 && pl_usdt === 0 && nowMs < new Date(signal.expires_at).getTime()) {
        continue;
      }

      // Classify EXPIRED into sub-category (GOOD_DIRECTION / NEUTRAL / BAD_DIRECTION)
      // WIN and LOSS never get an expired_class
      const expired_class = result === 'EXPIRED' ? classifyExpired(signal, exitPrice) : null;

      results.push({
        id: signal.id,
        pair: signal.pair,
        result,
        exit_price: exitPrice,
        pl_pct,
        pl_usdt,
        exit_timestamp: evaluatedAt,
        evaluated_at: evaluatedAt,
        expired_class,
      });
    }

    // ── 4. Persist evaluated results ───────────────────────────────────────
    for (const row of results) {
      const updatePayload: Record<string, unknown> = {
        exit_price:      row.exit_price,
        exit_timestamp:  row.exit_timestamp,
        result:          row.result,
        pl_pct:          row.pl_pct,
        pl_usdt:         row.pl_usdt,
        evaluated_at:    row.evaluated_at,
        status:          row.result,
      };
      // Write expired_class for EXPIRED signals (NULL for WIN/LOSS — never classify those)
      if (row.result === 'EXPIRED' && row.expired_class != null) {
        updatePayload.expired_class = row.expired_class;
      }

      const { error } = await db
        .from('signal_history')
        .update(updatePayload)
        .eq('id', row.id)
        .eq('status', 'LIVE'); // never overwrite already-evaluated rows

      if (error) {
        console.warn(`[signal-expiry] update failed for ${row.pair}:`, error.message);
      } else {
        processed++;
        if (row.result === 'EXPIRED') {
          console.log(`[signal-expiry] ${row.pair} EXPIRED → ${row.expired_class ?? 'NEUTRAL'} pl=${row.pl_pct?.toFixed(2)}%`);
        }
      }
    }

    const durationMs = Date.now() - runStart;
    console.log(`[signal-expiry] evaluated ${processed}/${results.length} signals in ${durationMs}ms`);

    // Remove completed signals from the frontend cache so they disappear from Live Signals.
    await removeCompletedFromCache(db, new Set(results.map(r => r.id)));

    await updateSchedulerStatus(db, true, null, processed);

    return new Response(
      JSON.stringify({
        processed,
        duration_ms: durationMs,
        results: results.map(r => ({ pair: r.pair, result: r.result, pl_pct: r.pl_pct, exit_price: r.exit_price })),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    errorMsg = String(err);
    console.error('[signal-expiry] error:', err);
    await updateSchedulerStatus(db, false, errorMsg, processed);
    return new Response(
      JSON.stringify({ error: errorMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
