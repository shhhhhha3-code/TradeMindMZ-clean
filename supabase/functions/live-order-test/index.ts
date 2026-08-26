/**
 * live-order-test — V189 Controlled Live Order Test
 *
 * Executes ONE controlled live order through the full safety-gate pipeline.
 * This function is the orchestrator for V189 verification:
 *
 *   1. Validate live_trading_enabled = true for caller
 *   2. Load ai_signals_cache — pick BEST CURRENT SETUP (RECOMMENDED + FRESH + TRADEABLE)
 *   3. Run full pre-flight checklist (10 gates) — log every gate result
 *   4. If all gates pass and dry_run=false: call place_order via pionex-proxy
 *   5. If orderId returned: call get_order_status once to confirm NEW/OPEN/FILLED/UNKNOWN
 *   6. Return structured V189 report
 *
 * SAFETY RULES:
 *   - Never retries create-order (TIMEOUT → ORDER_STATUS_UNKNOWN)
 *   - Never sends parallel orders
 *   - dry_run=true (default) skips the actual POST but runs all pre-flight checks
 *   - Stops completely after one order attempt (pass or fail)
 *
 * Caller: POST { dry_run?: boolean }  (default: dry_run = true)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PIONEX_BASE = 'https://api.pionex.com';

// ── Scoring constants — mirrors auto-trader-eval / signal-scoring.ts ──────────
const GATE_CONFIDENCE   = 65;
const GATE_STRENGTH     = 65;
const GATE_RR           = 1.5;
const REC_FRESH_MS      = 10 * 60 * 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────
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
  generated_at: string;
  expires_at?: string | null;
}

interface PreflightGate {
  gate:    string;
  pass:    boolean;
  detail:  string;
  value?:  unknown;
}

interface V189Report {
  test_version:          string;
  dry_run:               boolean;
  real_order:            boolean;
  timestamp:             string;
  signal:                Record<string, unknown> | null;
  preflight:             PreflightGate[];
  preflight_pass:        boolean;
  force_analysis_diag?:  Record<string, unknown> | null;
  create_order?:         Record<string, unknown>;
  order_status?:         Record<string, unknown>;
  request_log:           string[];
  summary:               Record<string, unknown>;
  verdict:               'LIVE TEST: PASS' | 'LIVE TEST: FAIL' | 'DRY RUN COMPLETE' | 'PREFLIGHT FAILED';
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Score freshness — same logic as auto-trader-eval ─────────────────────────
function isFreshEnough(sig: AISignal, resetAt: string | null): boolean {
  const generatedMs = new Date(sig.generated_at).getTime();
  const nowMs       = Date.now();
  const refMs       = resetAt ? Math.max(generatedMs, new Date(resetAt).getTime()) : generatedMs;
  return (nowMs - refMs) <= REC_FRESH_MS;
}

function parseRR(rr?: string | null): number {
  if (!rr) return 0;
  const n = parseFloat(String(rr));
  return isNaN(n) ? 0 : n;
}

function isRecommended(sig: AISignal): boolean {
  return (
    sig.confidence     >= GATE_CONFIDENCE &&
    sig.signal_strength >= GATE_STRENGTH  &&
    parseRR(sig.risk_reward) >= GATE_RR
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Auth ─────────────────────────────────────────────────────────────────
  // V192: service-role bypass — if the caller passes the service role key as Bearer
  // AND provides _user_id in the request body, skip getUser() and use that user_id
  // directly. This allows agent-level invocation without a user JWT while maintaining
  // the same security boundary (service role key is never exposed to clients).
  const authHeader    = req.headers.get('Authorization') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const isServiceRole  = authHeader === `Bearer ${serviceRoleKey}`;

  const body          = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const dry_run       = body.dry_run !== false;   // default = true (safe)
  const force_analysis = body.force_analysis === true;

  let user: { id: string; email?: string } | null = null;

  if (isServiceRole && body._user_id) {
    // Service-role direct invocation — trust the _user_id from body
    user = { id: String(body._user_id) };
    console.log('[V192] service-role auth — user_id from body:', user.id);
  } else {
    const { data: { user: authUser }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (authErr || !authUser) return respond({ error: 'Unauthorized' }, 401);
    user = authUser;
  }

  const report: V189Report = {
    test_version:   'V192',
    dry_run,
    real_order:     !dry_run,
    timestamp:      new Date().toISOString(),
    signal:         null,
    preflight:      [],
    preflight_pass: false,
    request_log:    [],
    summary:        {},
    verdict:        'PREFLIGHT FAILED',
  };

  const requestLog: string[] = [];
  function logReq(label: string): void {
    const entry = `[${new Date().toISOString()}] ${label}`;
    requestLog.push(entry);
    console.log('[V189]', entry);
  }

  const gates: PreflightGate[] = [];
  function addGate(gate: string, pass: boolean, detail: string, value?: unknown): void {
    gates.push({ gate, pass, detail, value });
    console.log(`[V189] GATE ${pass ? '✅' : '❌'} ${gate}: ${detail}`);
  }

  try {
    // ── GATE 1: live_trading_enabled ─────────────────────────────────────
    const { data: liveSetting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'live_trading_enabled')
      .maybeSingle();
    const liveEnabled = liveSetting !== null
      ? liveSetting.value === 'true'
      : Deno.env.get('LIVE_TRADING_ENABLED') === 'true';

    addGate('live_trading_enabled', liveEnabled || dry_run,
      dry_run
        ? `DRY RUN — live flag check bypassed (flag=${liveEnabled})`
        : liveEnabled ? 'live_trading_enabled=true' : 'BLOCKED: live_trading_enabled=false',
      liveEnabled);

    if (!liveEnabled && !dry_run) {
      report.preflight      = gates;
      report.preflight_pass = false;
      report.verdict        = 'PREFLIGHT FAILED';
      report.summary        = {
        blocked_reason: 'live_trading_disabled',
        message: 'Aktiver LIVE TRADING i innstillinger før live-test.',
      };
      return respond(report);
    }

    // ── GATE 2: no existing open live trade ──────────────────────────────
    const { data: openOrders } = await supabase
      .from('live_orders')
      .select('id, symbol, status, created_at')
      .eq('user_id', user.id)
      .in('status', ['NEW', 'PARTIALLY_FILLED', 'OPEN'])
      .limit(1);

    const hasOpenTrade = (openOrders?.length ?? 0) > 0;
    addGate('no_open_live_trade', !hasOpenTrade,
      hasOpenTrade
        ? `BLOCKED: existing open trade exists — ${(openOrders![0] as Record<string, unknown>).symbol} (${(openOrders![0] as Record<string, unknown>).status})`
        : 'No open live trade found',
      openOrders?.[0] ?? null);

    if (hasOpenTrade) {
      report.preflight      = gates;
      report.preflight_pass = false;
      report.verdict        = 'PREFLIGHT FAILED';
      report.summary        = { blocked_reason: 'open_trade_exists', open_order: openOrders![0] };
      return respond(report);
    }

    // ── GATE 3: load signals — find BEST CURRENT SETUP ──────────────────
    // V192 priority order:
    //   1. injected_signals from body (passed by ai-analysis v192_live_trigger — no DB race)
    //   2. force_analysis=true → call ai-analysis inline
    //   3. default → read from DB cache
    let rawSignals: AISignal[] = [];
    let resetAt: string | null = null;
    let forceAnalysisDiag: Record<string, unknown> | null = null;

    if (Array.isArray(body.injected_signals) && body.injected_signals.length > 0) {
      // Path 1: signals injected directly from ai-analysis live-trigger (no second AI call)
      rawSignals = body.injected_signals as AISignal[];
      resetAt    = body.injected_reset_at as string ?? null;
      forceAnalysisDiag = {
        source:              'injected_from_ai_analysis',
        signals_in_response: rawSignals.length,
      };
      logReq(`injected_signals: ${rawSignals.length} signals passed directly (no DB read, no second AI call)`);
    } else if (force_analysis) {
      logReq('ai-analysis FORCE RUN (inline, bypasses DB cache race)');
      try {
        // Supabase gateway requires the anon key in 'apikey' header for routing,
        // while Authorization: Bearer <service_role> provides elevated auth inside the EF.
        // The anon key is the publishable key stored in vault.
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
        const faRes = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-analysis`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type':  'application/json',
              'apikey':        anonKey,
            },
            body: JSON.stringify({ scheduled: true, source: 'live_order_test_v192_force' }),
            signal: AbortSignal.timeout(60_000),
          }
        );
        const faJson = await faRes.json() as Record<string, unknown>;
        rawSignals = Array.isArray(faJson.signals) ? (faJson.signals as AISignal[]) : [];
        resetAt    = (faJson.reset_at as string) ?? null;
        forceAnalysisDiag = {
          http_status:     faRes.status,
          pairs_scanned:   (faJson.diagnostics as Record<string,unknown>)?.market_pairs_scanned ?? faJson.pairs_scanned,
          local_setups:    (faJson.diagnostics as Record<string,unknown>)?.candidates_filtered,
          sent_to_ai:      (faJson.diagnostics as Record<string,unknown>)?.candidates_sent_to_ai,
          ai_success:      (faJson.diagnostics as Record<string,unknown>)?.ai_success,
          signals_created: (faJson.diagnostics as Record<string,unknown>)?.signals_created,
          cache_hits:      (faJson.diagnostics as Record<string,unknown>)?.ai_cache_hits,
          fresh_signals:   (faJson.diagnostics as Record<string,unknown>)?.fresh_signals,
          best_setup:      (faJson.diagnostics as Record<string,unknown>)?.best_current_setup,
          total_ms:        (faJson.diagnostics as Record<string,unknown>)?.total_duration_ms,
          error_message:   faJson.error_message ?? null,
          signals_in_response: rawSignals.length,
          source:          'force_v192_inline',
        };
        console.log('[V192] force_analysis result:', JSON.stringify(forceAnalysisDiag));
      } catch (faErr) {
        console.error('[V192] force_analysis call failed:', String(faErr));
        forceAnalysisDiag = { error: String(faErr) };
        // Fall through to DB read as fallback
        logReq('force_analysis FAILED — falling back to DB cache read');
        const { data: cacheRow } = await supabase
          .from('ai_signals_cache').select('signals, reset_at').eq('id', 'global').maybeSingle();
        rawSignals = Array.isArray(cacheRow?.signals) ? (cacheRow!.signals as AISignal[]) : [];
        resetAt    = (cacheRow as Record<string, unknown>)?.reset_at as string ?? null;
      }
    } else {
      logReq('GET ai_signals_cache (DB read)');
      const { data: cacheRow } = await supabase
        .from('ai_signals_cache')
        .select('signals, reset_at')
        .eq('id', 'global')
        .maybeSingle();
      rawSignals = Array.isArray(cacheRow?.signals) ? (cacheRow!.signals as AISignal[]) : [];
      resetAt    = (cacheRow as Record<string, unknown>)?.reset_at as string ?? null;
    }

    // Filter: TRADEABLE = BUY/SELL + has price + not expired
    const tradeable = rawSignals.filter(s => {
      if (s.signal_type !== 'BUY' && s.signal_type !== 'SELL') return false;
      if (!s.current_price || s.current_price <= 0) return false;
      if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return false;
      return true;
    });

    // Score: RECOMMENDED + FRESH (same criteria as auto-trader-eval bestSetup)
    const freshRecommended = tradeable.filter(s =>
      isRecommended(s) && isFreshEnough(s, resetAt)
    );

    // Pick best: highest RR among fresh recommended
    const bestSignal = freshRecommended.sort((a, b) =>
      parseRR(b.risk_reward) - parseRR(a.risk_reward)
    )[0] ?? null;

    addGate('best_signal_found', bestSignal !== null,
      bestSignal
        ? `${bestSignal.pair} ${bestSignal.signal_type} — confidence=${bestSignal.confidence}% RR=${bestSignal.risk_reward} score=RECOMMENDED+FRESH`
        : `No RECOMMENDED+FRESH signal. Total=${rawSignals.length} tradeable=${tradeable.length} fresh_rec=${freshRecommended.length}`,
      bestSignal ? {
        pair:        bestSignal.pair,
        signal_type: bestSignal.signal_type,
        confidence:  bestSignal.confidence,
        rr:          bestSignal.risk_reward,
      } : null);

    // Attach force_analysis diagnostics to report immediately after gate evaluation
    if (forceAnalysisDiag) report.force_analysis_diag = forceAnalysisDiag;

    if (!bestSignal) {
      report.preflight      = gates;
      report.preflight_pass = false;
      report.verdict        = 'PREFLIGHT FAILED';
      report.summary = {
        blocked_reason:       'no_best_signal',
        total_signals:        rawSignals.length,
        tradeable_signals:    tradeable.length,
        fresh_recommended:    freshRecommended.length,
        force_analysis_diag:  forceAnalysisDiag,
        message: 'Ingen RECOMMENDED+FRESH signal tilgjengelig. Vent på neste AI-analyse.',
      };
      return respond(report);
    }

    // ── Populate signal info in report ────────────────────────────────────
    report.signal = {
      signal_id:      bestSignal.id,
      pair:           bestSignal.pair,
      symbol:         bestSignal.symbol,
      direction:      bestSignal.signal_type,
      entry_zone_low: bestSignal.entry_zone_low,
      current_price:  bestSignal.current_price,
      take_profit:    bestSignal.take_profit_1,
      stop_loss:      bestSignal.stop_loss,
      risk_reward:    bestSignal.risk_reward,
      confidence:     bestSignal.confidence,
      signal_strength: bestSignal.signal_strength,
      generated_at:   bestSignal.generated_at,
      expires_at:     bestSignal.expires_at,
    };

    // ── GATE 4: symbol format ─────────────────────────────────────────────
    const orderSymbol = bestSignal.pair.replace('/', '');
    const hasSlash    = orderSymbol.includes('/');
    addGate('symbol_no_slash', !hasSlash,
      `"${bestSignal.pair}" → "${orderSymbol}" (sent to Pionex)`,
      { input: bestSignal.pair, output: orderSymbol });

    // ── GATE 5: Pionex symbol exists (public endpoint) ───────────────────
    logReq(`GET ${PIONEX_BASE}/api/v1/common/symbols (public)`);
    let marketInfo: Record<string, unknown> | null = null;
    let basePrecision = 8;
    let minOrderValue = 0;
    let minQty        = 0;

    try {
      const symRes  = await fetch(`${PIONEX_BASE}/api/v1/common/symbols`, {
        signal: AbortSignal.timeout(8000),
      });
      const symJson = await symRes.json();
      const symbols: Record<string, unknown>[] =
        (symJson?.data?.symbols ?? symJson?.symbols ?? []) as Record<string, unknown>[];
      marketInfo = symbols.find(
        (s: Record<string, unknown>) =>
          String(s.symbol ?? '').toUpperCase() === orderSymbol.toUpperCase()
      ) ?? null;
    } catch (e) {
      console.warn('[V189] common/symbols fetch failed:', String(e));
    }

    if (marketInfo) {
      basePrecision = parseInt(String(marketInfo.basePrecision ?? marketInfo.amountPrecision ?? 8), 10);
      minOrderValue = parseFloat(String(marketInfo.minOrderValue ?? marketInfo.minNotional ?? 0));
      minQty        = parseFloat(String(marketInfo.minTradeAmount ?? marketInfo.minQty ?? 0));
    }

    addGate('symbol_on_pionex', marketInfo !== null,
      marketInfo !== null
        ? `Found: basePrecision=${basePrecision} minOrderValue=${minOrderValue} minQty=${minQty}`
        : `BLOCKED: "${orderSymbol}" not found in Pionex symbol list`,
      { basePrecision, minOrderValue, minQty });

    if (!marketInfo) {
      report.preflight      = gates;
      report.preflight_pass = false;
      report.verdict        = 'PREFLIGHT FAILED';
      report.summary        = { blocked_reason: 'symbol_not_on_pionex', symbol: orderSymbol };
      return respond(report);
    }

    // ── GATE 6: available USDT + investment calculation ─────────────────
    // LIVE: invest 25% of the actual available Pionex USDT balance.
    // DRY RUN: use the market minimum as a validation baseline.
    // Pionex market rules remain authoritative for min value, min quantity
    // and quantity precision.

    const price = bestSignal.current_price!;

    let usdtFree = 0;
    let usdtFrozen = 0;
    let usdtTotal = 0;

    if (dry_run) {
      // Dry-run does not authenticate against the user's Pionex account.
      usdtFree = Math.max(minOrderValue, 0);
      usdtFrozen = 0;
      usdtTotal = usdtFree;
    } else {
      logReq('pionex-proxy: action=portfolio (balance check)');

      try {
        const balRes = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/pionex-proxy`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type': 'application/json',
              'x-user-id': user.id,
            },
            body: JSON.stringify({
              action: 'portfolio',
              _user_id_override: user.id,
            }),
            signal: AbortSignal.timeout(12000),
          }
        );

        const balJson = await balRes.json() as Record<string, unknown>;
        const balances =
          (balJson?.balances as Record<string, unknown>[]) ?? [];

        const usdtRow = balances.find(
          b => String(b.coin ?? b.coinType ?? '').toUpperCase() === 'USDT'
        );

        usdtFree = parseFloat(
          String(usdtRow?.free ?? usdtRow?.available ?? 0)
        );

        usdtFrozen = parseFloat(
          String(usdtRow?.frozen ?? usdtRow?.freeze ?? 0)
        );

        usdtTotal = usdtFree + usdtFrozen;
      } catch (balErr) {
        console.error('[LIVE_ORDER_TEST] balance fetch failed:', String(balErr));
        usdtFree = -1;
      }
    }

    const availableUsdt = Math.max(usdtFree, 0);

    // 25% of currently available USDT.
    const testInvestment = dry_run
      ? Math.max(minOrderValue, 0)
      : availableUsdt * 0.25;

    const rawQty =
      testInvestment > 0
        ? testInvestment / price
        : 0;

    const precisionFactor = Math.pow(10, basePrecision);

    const roundedQty =
      Math.floor(rawQty * precisionFactor) / precisionFactor;

    const roundedInvestment = roundedQty * price;

    // ── GATE 7: quantity precision / minimum quantity ───────────────────
    const qtyAboveMin =
      minQty <= 0 || roundedQty >= minQty;

    addGate(
      'quantity_precision',
      qtyAboveMin,
      `raw=${rawQty.toFixed(10)} basePrecision=${basePrecision} rounded=${roundedQty} ${qtyAboveMin ? '≥' : '<'} minQty=${minQty}`,
      {
        raw_qty: rawQty,
        rounded_qty: roundedQty,
        base_precision: basePrecision,
        min_qty: minQty,
      }
    );

    // ── GATE 8: Pionex minimum order value ───────────────────────────────
    const aboveMinOrder =
      minOrderValue <= 0 || roundedInvestment >= minOrderValue;

    addGate(
      'min_order_value',
      aboveMinOrder,
      `investment=${roundedInvestment.toFixed(6)} USDT ${aboveMinOrder ? '≥' : '<'} minOrderValue=${minOrderValue} USDT`,
      {
        investment: roundedInvestment,
        min_order_value: minOrderValue,
      }
    );

    // ── GATE 9: available balance ────────────────────────────────────────
    const withinBalance =
      dry_run
        ? true
        : usdtFree > 0 && roundedInvestment <= usdtFree;

    addGate(
      'available_balance',
      withinBalance,
      dry_run
        ? 'DRY RUN — real Pionex balance not fetched'
        : `investment=${roundedInvestment.toFixed(6)} USDT ≤ available=${usdtFree.toFixed(6)} USDT`,
      {
        investment: roundedInvestment,
        available_usdt: dry_run ? 'DRY RUN' : usdtFree,
      }
    );

    // ── GATE 10: duplicate signal check (DB) ─────────────────────────────
    logReq('DB: live_orders duplicate signal_id check');

    const { data: existingOrder } = await supabase
      .from('live_orders')
      .select('id, status, created_at')
      .eq('user_id', user.id)
      .eq('signal_id', bestSignal.id)
      .maybeSingle();

    const noDuplicate = existingOrder === null;

    addGate(
      'duplicate_signal_check',
      noDuplicate,
      noDuplicate
        ? `No existing order for signal_id=${bestSignal.id}`
        : `BLOCKED: order already exists (id=${(existingOrder as Record<string, unknown>).id} status=${(existingOrder as Record<string, unknown>).status})`,
      existingOrder ?? null
    );

    if (!noDuplicate) {
      report.preflight = gates;
      report.preflight_pass = false;
      report.verdict = 'PREFLIGHT FAILED';
      report.summary = {
        blocked_reason: 'duplicate_signal',
        existing_order: existingOrder,
      };
      return respond(report);
    }

    // ── GATE 11: final USDT balance validation ───────────────────────────
    const balanceGatePass =
      dry_run
        ? true
        : usdtFree > 0 && usdtFree >= roundedInvestment;

    addGate(
      'usdt_balance',
      balanceGatePass,
      dry_run
        ? 'DRY RUN — balance not fetched'
        : balanceGatePass
          ? `available=${usdtFree.toFixed(6)} frozen=${usdtFrozen.toFixed(6)} total=${usdtTotal.toFixed(6)} needed=${roundedInvestment.toFixed(6)} ✅`
          : usdtFree < 0
            ? 'BLOCKED: balance fetch failed'
            : `BLOCKED: insufficient — available=${usdtFree.toFixed(6)} < needed=${roundedInvestment.toFixed(6)}`,
      {
        usdt_available: dry_run ? 'DRY RUN' : usdtFree,
        usdt_frozen: dry_run ? 'DRY RUN' : usdtFrozen,
        usdt_total: dry_run ? 'DRY RUN' : usdtTotal,
        needed: roundedInvestment,
      }
    );

    // ── Pre-flight summary ────────────────────────────────────────────────
    const allGatesPass =
      gates.every(g => g.pass) &&
      qtyAboveMin &&
      aboveMinOrder &&
      balanceGatePass;

    report.preflight      = gates;
    report.preflight_pass = allGatesPass;

    // Signal block for report
    report.signal = {
      ...report.signal,
      score:            'RECOMMENDED+FRESH',
      test_investment_pct: 0.25,
      available_usdt:      availableUsdt,
      investment_usdt:  roundedInvestment,
      rounded_qty:      roundedQty,
      raw_qty:          rawQty,
      final_order_value: roundedInvestment,
      base_precision:   basePrecision,
      min_qty:          minQty,
      min_order_value:  minOrderValue,
      estimated_fee_usdt: (roundedInvestment * 0.0005),
      total_cost:       roundedInvestment * 1.0005,
      order_symbol:     orderSymbol,
      order_side:       bestSignal.signal_type,
      available_balance: dry_run ? 'DRY RUN (not fetched)' : usdtFree,
      balance_after_est: dry_run ? 'DRY RUN' : (usdtFree - roundedInvestment * 1.0005),
    };

    if (!allGatesPass) {
      report.verdict = 'PREFLIGHT FAILED';
      report.summary = {
        failed_gates: gates.filter(g => !g.pass).map(g => g.gate),
        message: 'Pre-flight sjekk feilet — ingen ordre sendt.',
      };
      report.request_log = requestLog;
      return respond(report);
    }

    // ── DRY RUN STOP ─────────────────────────────────────────────────────
    if (dry_run) {
      report.verdict = 'DRY RUN COMPLETE';
      report.summary = {
        dry_run:          true,
        real_order:       false,
        message:          'Alle pre-flight tester bestått. Send med dry_run=false for faktisk ordre.',
        signal:           bestSignal.pair,
        symbol:           orderSymbol,
        side:             bestSignal.signal_type,
        signal_id:        bestSignal.id,
        investment_usdt:  roundedInvestment,
        quantity:         roundedQty,
        order_value_usdt: roundedInvestment,
        pionex_order_id:  null,
        create_order_http: 'SKIPPED (dry_run=true)',
        final_status:      'NOT SENT',
        requests_total:    requestLog.length,
        authenticated_req: 0,
        public_req:        requestLog.length,
        rate_limited_429:  'N/A',
        duplicate_blocked: 'N/A',
      };
      report.request_log = requestLog;
      return respond(report);
    }

    // ── REAL ORDER: place_order via pionex-proxy ──────────────────────────
    console.log('[V189] All gates PASS — sending real order. REAL ORDER = ON');
    logReq(`pionex-proxy: place_order ${orderSymbol} ${bestSignal.signal_type} qty=${roundedQty} price=${price}`);

    let createOrderResult: Record<string, unknown> = {};
    let createOrderHttpStatus = 0;
    let orderId: string | null = null;
    let finalOrderStatus: string = 'ORDER_STATUS_UNKNOWN';

    try {
      const placeRes = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/pionex-proxy`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type':  'application/json',
            'x-user-id':     user.id,
          },
          body: JSON.stringify({
            action:            'place_order',
            order_symbol:      orderSymbol,
            order_side:        bestSignal.signal_type,
            order_qty:         roundedQty,
            order_price:       price,
            signal_id:         bestSignal.id,
            order_type:        'MARKET',
            _user_id_override: user.id,
          }),
          signal: AbortSignal.timeout(20000),
        }
      );

      createOrderHttpStatus  = placeRes.status;
      const placeText        = await placeRes.text();
      createOrderResult      = JSON.parse(placeText) as Record<string, unknown>;
      orderId                = createOrderResult.order_id as string | null ?? null;
      finalOrderStatus       = (createOrderResult.status as string) ?? 'UNKNOWN';

      console.log('[V189] place_order response:', JSON.stringify({
        http_status: createOrderHttpStatus,
        order_id:    orderId,
        status:      finalOrderStatus,
        blocked:     createOrderResult.blocked ?? false,
      }));

    } catch (placeErr) {
      const msg = String(placeErr);
      // TIMEOUT on create-order — do NOT retry
      console.error('[V189] place_order TIMEOUT — no retry:', msg);
      createOrderResult  = { error: msg, status: 'TIMEOUT' };
      finalOrderStatus   = 'ORDER_STATUS_UNKNOWN';
      createOrderHttpStatus = 504;

      // Log the ORDER_STATUS_UNKNOWN attempt to live_orders for manual lookup
      await supabase.from('live_orders').insert({
        user_id:         user.id,
        pionex_order_id: `unknown_timeout_${Date.now()}`,
        symbol:          orderSymbol,
        pair:            bestSignal.pair,
        side:            bestSignal.signal_type as 'BUY' | 'SELL',
        status:          'UNKNOWN',
        investment:      roundedInvestment,
        quantity:        roundedQty,
        entry_price:     price,
        signal_id:       bestSignal.id,
        created_at:      new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      }).catch(e => console.error('[V189] failed to persist UNKNOWN order:', String(e)));
    }

    report.create_order = {
      http_status:   createOrderHttpStatus,
      order_id:      orderId,
      status:        finalOrderStatus,
      blocked:       createOrderResult.blocked ?? false,
      reason:        createOrderResult.reason ?? null,
      raw_response:  createOrderResult,
    };

    // ── ORDER STATUS CONFIRMATION ──────────────────────────────────────────
    if (orderId && finalOrderStatus !== 'TIMEOUT') {
      // Single controlled get_order_status call — NO retry
      logReq(`pionex-proxy: get_order_status orderId=${orderId}`);
      try {
        const statusRes = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/pionex-proxy`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type':  'application/json',
              'x-user-id':     user.id,
            },
            body: JSON.stringify({
              action:            'get_order_status',
              order_id:          orderId,
              _user_id_override: user.id,
            }),
            signal: AbortSignal.timeout(12000),
          }
        );
        const statusJson = await statusRes.json() as Record<string, unknown>;
        finalOrderStatus = (statusJson.status as string) ?? 'UNKNOWN';

        report.order_status = {
          order_id:        orderId,
          initial_status:  createOrderResult.status ?? 'NEW',
          confirmed_status: finalOrderStatus,
          raw_status:      statusJson.raw_status ?? null,
          filled_qty:      statusJson.filled_qty ?? null,
          avg_fill_price:  statusJson.avg_fill_price ?? null,
          created_at:      statusJson.created_at ?? null,
          updated_at:      statusJson.updated_at ?? null,
        };
      } catch (statusErr) {
        console.error('[V189] get_order_status failed:', String(statusErr));
        report.order_status = {
          order_id:         orderId,
          initial_status:   createOrderResult.status ?? 'NEW',
          confirmed_status: 'ORDER_STATUS_UNKNOWN',
          error:            String(statusErr),
          note:             'Use get_order_status manually with this order_id to confirm.',
        };
        finalOrderStatus = 'ORDER_STATUS_UNKNOWN';
      }
    } else if (!orderId) {
      report.order_status = {
        order_id:         null,
        initial_status:   finalOrderStatus,
        confirmed_status: 'ORDER_STATUS_UNKNOWN',
        note:             'Pionex did not return an order_id. Check order manually. No retry.',
      };
    }

    // ── Count requests ────────────────────────────────────────────────────
    const totalReq  = requestLog.length;
    const authReq   = requestLog.filter(r =>
      r.includes('place_order') || r.includes('get_order_status') || r.includes('portfolio')
    ).length;
    const publicReq = totalReq - authReq;

    // ── Final verdict ──────────────────────────────────────────────────────
    const orderCreated = !!(orderId && createOrderHttpStatus === 200);
    const testPass = orderCreated && (
      finalOrderStatus === 'NEW'  ||
      finalOrderStatus === 'OPEN' ||
      finalOrderStatus === 'FILLED'
    );

    report.verdict = testPass ? 'LIVE TEST: PASS' : 'LIVE TEST: FAIL';

    report.summary = {
      // Safety flags
      real_order: true,
      dry_run:    false,
      // Signal
      signal:     bestSignal.pair,
      symbol:     orderSymbol,
      side:       bestSignal.signal_type,
      signal_id:  bestSignal.id,
      // Trade values
      investment_usdt:   roundedInvestment,
      quantity:          roundedQty,
      order_value_usdt:  roundedInvestment,
      entry_price:       price,
      estimated_fee:     (roundedInvestment * 0.0005).toFixed(6),
      // Order result
      pionex_order_id:   orderId ?? 'NOT CREATED',
      create_order_http: createOrderHttpStatus,
      initial_status:    createOrderResult.status ?? 'UNKNOWN',
      final_status:      finalOrderStatus,
      // Requests
      requests_total:    totalReq,
      authenticated_req: authReq,
      public_req:        publicReq,
      // Flags
      rate_limited_429:  createOrderHttpStatus === 429 ? 'YES' : 'NO',
      duplicate_blocked: (finalOrderStatus === 'BLOCKED_DUPLICATE') ? 'YES' : 'NO',
      // Balance
      balance_before:    usdtFree > 0 ? usdtFree : 'fetched in place_order',
      balance_after_est: usdtFree > 0 ? (usdtFree - roundedInvestment * 1.0005).toFixed(6) : 'see logs',
      // Force analysis diagnostics (V192)
      force_analysis:    forceAnalysisDiag ?? 'N/A',
      // Explanation
      order_created: orderCreated,
      message: testPass
        ? `Ordre ${orderId} akseptert av Pionex med status ${finalOrderStatus}.`
        : !orderId
          ? 'Ingen order_id returnert av Pionex. Sjekk EF-logger og get_order_status manuelt.'
          : `Ordre IKKE bekreftet. Status: ${finalOrderStatus}.`,
    };

    report.request_log = requestLog;

    console.log('[V192] FINAL VERDICT:', report.verdict);
    return respond(report);

  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    console.error('[V189] Fatal error:', msg);
    report.verdict     = 'LIVE TEST: FAIL';
    report.request_log = requestLog;
    report.summary     = { error: msg, message: 'Uventet feil i live-order-test.' };
    return respond(report, 500);
  }
});
