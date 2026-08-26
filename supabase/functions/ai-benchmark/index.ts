// ─── Fase 3: AI Provider Benchmark Edge Function ──────────────────────────────
// Kjør: POST /functions/v1/ai-benchmark  (med apikey header)
// Sender identisk prompt til Gemini og Groq, ROUNDS ganger hver.
// Returnerer JSON med rådata + statistikk + anbefaling.
// INGEN endringer i tradinglogikk, cache, signaler eller UI.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ROUNDS = 3; // 3 rounds per provider — nok for P95 uten lang ventetid

const GEMINI_URL =
  'https://app-dkpfpbala41t-api-VaOwP8E7dJqa.gateway.appmedo.com' +
  '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Fixed 10-coin market snapshot — identical for every round ────────────────
const MARKET_SNAPSHOT = `[1]BTC/USDT Bitcoin
P:$65230.50 O:$64100.00 H:$66050.00 L:$63850.00 Chg:1.76% Vol:$1248.32M
RSI:56.80 EMA9:$65010.25(ABOVE) EMA21:$64190.10(ABOVE) MACD:0.0118/0.0094/0.0024
Sup:$63765.00 Res:$66166.10 Mom:Bullish

[2]ETH/USDT Ethereum
P:$3218.40 O:$3160.00 H:$3260.00 L:$3140.00 Chg:1.84% Vol:$620.14M
RSI:54.20 EMA9:$3200.10(ABOVE) EMA21:$3155.30(ABOVE) MACD:0.0089/0.0071/0.0018
Sup:$3140.00 Res:$3280.00 Mom:Bullish

[3]SOL/USDT Solana
P:$142.80 O:$148.50 H:$149.20 L:$141.60 Chg:-3.83% Vol:$312.45M
RSI:38.60 EMA9:$145.20(BELOW) EMA21:$147.80(BELOW) MACD:-0.0245/-0.0180/-0.0065
Sup:$139.50 Res:$149.20 Mom:Bearish

[4]BNB/USDT BNB
P:$578.90 O:$570.00 H:$583.00 L:$568.50 Chg:1.56% Vol:$198.76M
RSI:61.40 EMA9:$576.30(ABOVE) EMA21:$568.90(ABOVE) MACD:0.0134/0.0110/0.0024
Sup:$568.50 Res:$590.00 Mom:Bullish

[5]XRP/USDT XRP
P:$0.5124 O:$0.5200 H:$0.5250 L:$0.5050 Chg:-1.46% Vol:$145.23M
RSI:44.80 EMA9:$0.5140(BELOW) EMA21:$0.5180(BELOW) MACD:-0.00012/-0.00008/-0.00004
Sup:$0.5050 Res:$0.5280 Mom:Neutral

[6]DOGE/USDT Dogecoin
P:$0.1342 O:$0.1280 H:$0.1360 L:$0.1275 Chg:4.84% Vol:$89.67M
RSI:67.20 EMA9:$0.1330(ABOVE) EMA21:$0.1295(ABOVE) MACD:0.00045/0.00032/0.00013
Sup:$0.1275 Res:$0.1380 Mom:Bullish

[7]ADA/USDT Cardano
P:$0.4418 O:$0.4500 H:$0.4520 L:$0.4380 Chg:-1.82% Vol:$72.34M
RSI:36.50 EMA9:$0.4440(BELOW) EMA21:$0.4510(BELOW) MACD:-0.00028/-0.00021/-0.00007
Sup:$0.4380 Res:$0.4570 Mom:Bearish

[8]AVAX/USDT Avalanche
P:$36.42 O:$35.80 H:$37.10 L:$35.60 Chg:1.73% Vol:$54.18M
RSI:52.90 EMA9:$36.20(ABOVE) EMA21:$35.95(ABOVE) MACD:0.0072/0.0058/0.0014
Sup:$35.60 Res:$37.80 Mom:Neutral

[9]MATIC/USDT Polygon
P:$0.8934 O:$0.9200 H:$0.9250 L:$0.8850 Chg:-2.89% Vol:$41.22M
RSI:33.40 EMA9:$0.9020(BELOW) EMA21:$0.9180(BELOW) MACD:-0.00098/-0.00072/-0.00026
Sup:$0.8850 Res:$0.9380 Mom:Bearish

[10]LINK/USDT Chainlink
P:$14.82 O:$14.50 H:$15.10 L:$14.40 Chg:2.21% Vol:$38.95M
RSI:58.70 EMA9:$14.75(ABOVE) EMA21:$14.35(ABOVE) MACD:0.0210/0.0168/0.0042
Sup:$14.40 Res:$15.40 Mom:Bullish`;

// Phase-2 optimised prompt — matches production buildBatchPrompt exactly
const BENCH_PROMPT = `Crypto technical analyst. Analyse ALL coins below. Return ONE JSON with ALL signals.

RULES:
- Use ONLY provided data. Never invent values.
- Signal only when confidence>=55 AND RR>=1.5.
- BUY and SELL setups both valid.
- RSI<35 near support→BUY. RSI>68 near resistance→SELL.
- EMA9>EMA21+bullish→BUY. EMA9<EMA21+bearish→SELL.
- Entry: within 1.5% of price. SL: 1.5–3% adverse. TP1: 2.5–5%. TP2: 5–10%.
- 0–8 signals total. Quality>quantity. Skip coin if no quality setup.
- "pair" field MUST match coin label exactly.

COINS(10):
${MARKET_SNAPSHOT}

JSON only (no markdown):
{"signals":[{"symbol":"ETH","pair":"ETH/USDT","coin_name":"Ethereum","current_price":3200.00,"price_change_24h":45.20,"signal_type":"BUY","confidence":72,"risk_level":"Medium","entry_zone_low":3180.00,"entry_zone_high":3210.00,"take_profit_1":3320.00,"take_profit_2":3450.00,"stop_loss":3120.00,"risk_reward":"1.9","holding_time":"6-12 hours","signal_strength":68,"reasoning":{"conclusion":"ETH bouncing off EMA21 with MACD crossover."}}],"market_sentiment":{"score":58,"label":"Greed"}}`;

// ─── Types ────────────────────────────────────────────────────────────────────
interface RoundResult {
  round:          number;
  total_ms:       number;
  ttfb_ms:        number;
  valid_json:     boolean;
  error:          string;
  error_type:     string;
  signal_count:   number;
  signals_valid:  number;
  signal_issues:  string[];
  confidences:    number[];
  sentiment_score: number | null;
}

interface BenchStats {
  rounds:           number;
  successful:       number;
  errors:           number;
  rate_limits:      number;
  timeouts:         number;
  invalid_json:     number;
  avg_total_ms:     number;
  p50_total_ms:     number;
  p95_total_ms:     number;
  min_total_ms:     number;
  max_total_ms:     number;
  avg_ttfb_ms:      number;
  avg_signal_count: number;
  avg_valid_signals:number;
  avg_confidence:   number | null;
  conf_stdev:       number | null;
  tpsl_issues:      number;
  tpsl_issue_sample:string[];
}

// ─── Signal validation ────────────────────────────────────────────────────────
const VALID_PAIRS = new Set([
  'BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT',
  'DOGE/USDT','ADA/USDT','AVAX/USDT','MATIC/USDT','LINK/USDT',
]);
const REQUIRED_FIELDS = [
  'symbol','pair','signal_type','confidence',
  'entry_zone_low','entry_zone_high','take_profit_1','stop_loss',
  'risk_reward','holding_time',
];

function validateSignal(sig: Record<string,unknown>): string[] {
  const issues: string[] = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in sig)) issues.push(`missing:${f}`);
  }
  if (!['BUY','SELL'].includes(sig.signal_type as string))
    issues.push(`bad signal_type:${sig.signal_type}`);
  const conf = Number(sig.confidence);
  if (isNaN(conf) || conf < 55 || conf > 100)
    issues.push(`conf_out_of_range:${conf}`);
  if (!VALID_PAIRS.has(sig.pair as string))
    issues.push(`unknown_pair:${sig.pair}`);
  try {
    const entryMid = (Number(sig.entry_zone_low) + Number(sig.entry_zone_high)) / 2;
    const sl  = Number(sig.stop_loss);
    const tp1 = Number(sig.take_profit_1);
    if (sig.signal_type === 'BUY') {
      if (sl  >= entryMid) issues.push(`BUY_SL_above_entry:sl=${sl}_entry=${entryMid.toFixed(4)}`);
      if (tp1 <= entryMid) issues.push(`BUY_TP1_below_entry:tp1=${tp1}_entry=${entryMid.toFixed(4)}`);
    } else {
      if (sl  <= entryMid) issues.push(`SELL_SL_below_entry:sl=${sl}_entry=${entryMid.toFixed(4)}`);
      if (tp1 >= entryMid) issues.push(`SELL_TP1_above_entry:tp1=${tp1}_entry=${entryMid.toFixed(4)}`);
    }
  } catch { issues.push('tpsl_parse_error'); }
  return issues;
}

// ─── Parse AI output into a round result ─────────────────────────────────────
function parseIntoResult(r: RoundResult, text: string): void {
  const clean = text.replace(/```[a-z]*\s*/g, '').replace(/```\s*$/g, '').trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(clean);
    r.valid_json = true;
  } catch (e) {
    r.valid_json   = false;
    r.error_type   = 'INVALID_JSON';
    r.error        = `parse:${String(e)} | preview:${clean.slice(0, 120)}`;
    return;
  }
  const signals = Array.isArray(parsed.signals) ? (parsed.signals as Record<string,unknown>[]) : [];
  r.signal_count    = signals.length;
  r.sentiment_score = (parsed.market_sentiment as {score?: number})?.score ?? null;
  for (const sig of signals) {
    const issues = validateSignal(sig);
    if (issues.length === 0) r.signals_valid++;
    else r.signal_issues.push(...issues);
    const c = Number(sig.confidence);
    if (!isNaN(c)) r.confidences.push(c);
  }
}

// ─── Gemini SSE call ──────────────────────────────────────────────────────────
async function callGemini(apiKey: string, round: number): Promise<RoundResult> {
  const r: RoundResult = {
    round, total_ms: 0, ttfb_ms: 0, valid_json: false,
    error: '', error_type: '', signal_count: 0, signals_valid: 0,
    signal_issues: [], confidences: [], sentiment_score: null,
  };
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify({ contents: [{ role: 'user', parts: [{ text: BENCH_PROMPT }] }] }),
      signal:  AbortSignal.timeout(90_000),
    });
  } catch (e) {
    r.total_ms  = Date.now() - t0;
    const msg   = String(e);
    r.error_type = msg.includes('Timeout') || msg.includes('AbortError') ? 'TIMEOUT' : 'NETWORK_ERROR';
    r.error      = msg.slice(0, 200);
    return r;
  }
  r.ttfb_ms = Date.now() - t0;

  if (!res.ok) {
    r.total_ms  = Date.now() - t0;
    const txt   = await res.text();
    r.error_type = res.status === 429 ? 'RATE_LIMIT' : (res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : `HTTP_${res.status}`);
    r.error      = `${res.status}: ${txt.slice(0, 200)}`;
    return r;
  }

  // Stream SSE body
  const reader = res.body!.getReader();
  const dec    = new TextDecoder();
  let buf = '', parts: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const data = l.slice(5).trim();
      if (data === '[DONE]' || data === '') continue;
      try {
        const obj  = JSON.parse(data);
        const part = obj?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (part) parts.push(part);
      } catch { /* partial chunk */ }
    }
  }
  r.total_ms = Date.now() - t0;
  parseIntoResult(r, parts.join(''));
  return r;
}

// ─── Groq call ────────────────────────────────────────────────────────────────
async function callGroq(apiKey: string, round: number): Promise<RoundResult> {
  const r: RoundResult = {
    round, total_ms: 0, ttfb_ms: 0, valid_json: false,
    error: '', error_type: '', signal_count: 0, signals_valid: 0,
    signal_issues: [], confidences: [], sentiment_score: null,
  };
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify({
        model:       GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You are a quantitative crypto trading analyst. Return only valid JSON — no markdown fences, no explanations.' },
          { role: 'user',   content: BENCH_PROMPT },
        ],
        temperature: 0.2,
        max_tokens:  4096,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    r.total_ms   = Date.now() - t0;
    const msg    = String(e);
    r.error_type = msg.includes('Timeout') || msg.includes('AbortError') ? 'TIMEOUT' : 'NETWORK_ERROR';
    r.error      = msg.slice(0, 200);
    return r;
  }
  r.ttfb_ms = Date.now() - t0;

  if (!res.ok) {
    r.total_ms   = Date.now() - t0;
    const txt    = await res.text();
    r.error_type = res.status === 429 ? 'RATE_LIMIT' : (res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : `HTTP_${res.status}`);
    r.error      = `${res.status}: ${txt.slice(0, 200)}`;
    return r;
  }
  r.total_ms = Date.now() - t0;

  const body    = await res.json() as { choices?: { message?: { content?: string } }[] };
  const rawText = body?.choices?.[0]?.message?.content ?? '';
  parseIntoResult(r, rawText);
  return r;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function mean(arr: number[]): number { return arr.reduce((a,b) => a+b, 0) / arr.length; }
function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a,b) => a + (b-m)**2, 0) / (arr.length - 1));
}
function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil(sorted.length * p / 100) - 1);
  return sorted[idx];
}

function computeStats(results: RoundResult[]): BenchStats {
  const totalMs   = results.map(r => r.total_ms).sort((a,b) => a-b);
  const ttfbMs    = results.filter(r => r.ttfb_ms > 0).map(r => r.ttfb_ms);
  const ok        = results.filter(r => r.valid_json);
  const sigCounts = ok.map(r => r.signal_count);
  const valCounts = ok.map(r => r.signals_valid);
  const confs     = ok.flatMap(r => r.confidences);
  const issues    = ok.flatMap(r => r.signal_issues);
  return {
    rounds:            results.length,
    successful:        ok.length,
    errors:            results.filter(r => r.error).length,
    rate_limits:       results.filter(r => r.error_type === 'RATE_LIMIT').length,
    timeouts:          results.filter(r => r.error_type === 'TIMEOUT').length,
    invalid_json:      results.filter(r => r.error_type === 'INVALID_JSON').length,
    avg_total_ms:      totalMs.length ? Math.round(mean(totalMs)) : 0,
    p50_total_ms:      totalMs.length ? percentile(totalMs, 50) : 0,
    p95_total_ms:      totalMs.length ? percentile(totalMs, 95) : 0,
    min_total_ms:      totalMs.length ? totalMs[0] : 0,
    max_total_ms:      totalMs.length ? totalMs[totalMs.length-1] : 0,
    avg_ttfb_ms:       ttfbMs.length  ? Math.round(mean(ttfbMs)) : 0,
    avg_signal_count:  sigCounts.length ? Math.round(mean(sigCounts)*10)/10 : 0,
    avg_valid_signals: valCounts.length ? Math.round(mean(valCounts)*10)/10 : 0,
    avg_confidence:    confs.length ? Math.round(mean(confs)*10)/10 : null,
    conf_stdev:        confs.length >= 2 ? Math.round(stdev(confs)*10)/10 : null,
    tpsl_issues:       issues.length,
    tpsl_issue_sample: issues.slice(0, 8),
  };
}

// ─── Recommendation logic ─────────────────────────────────────────────────────
function recommend(g: BenchStats, q: BenchStats): { primary: string; fallback: string; reason: string; scores: Record<string,number> } {
  // Speed score: 0–4 (lower avg_ms = higher score, 5 s buckets)
  const gSpd = Math.max(0, 4 - Math.floor(g.avg_total_ms / 5000));
  const qSpd = Math.max(0, 4 - Math.floor(q.avg_total_ms / 5000));
  // Stability score: successes × 2 − errors − rate_limits × 2
  const gStb = g.successful * 2 - g.errors - g.rate_limits * 2;
  const qStb = q.successful * 2 - q.errors - q.rate_limits * 2;
  // Quality score: avg_valid_signals + bonus for 0 TP/SL issues
  const gQlt = (g.avg_valid_signals) + (g.tpsl_issues === 0 ? 1 : 0);
  const qQlt = (q.avg_valid_signals) + (q.tpsl_issues === 0 ? 1 : 0);

  const gTotal = gSpd + gStb + gQlt;
  const qTotal = qSpd + qStb + qQlt;

  const geminiName = 'Gemini 2.5 Flash';
  const groqName   = `Groq ${GROQ_MODEL}`;
  const speedGapMs = Math.abs(g.avg_total_ms - q.avg_total_ms);

  let primary: string, fallback: string, reason: string;

  if (gTotal > qTotal) {
    primary  = geminiName;
    fallback = groqName;
    reason   = `Gemini skåret ${gTotal} vs Groq ${qTotal}. ` +
      `${g.avg_total_ms < q.avg_total_ms ? `Gemini er ${speedGapMs}ms raskere i snitt. ` : `Groq er ${speedGapMs}ms raskere, men `}` +
      `Gemini leverer ${g.avg_valid_signals} vs ${q.avg_valid_signals} gyldige signaler og ${g.errors} vs ${q.errors} feil.`;
  } else if (qTotal > gTotal) {
    primary  = groqName;
    fallback = geminiName;
    reason   = `Groq skåret ${qTotal} vs Gemini ${gTotal}. ` +
      `${q.avg_total_ms < g.avg_total_ms ? `Groq er ${speedGapMs}ms raskere i snitt. ` : ''}` +
      `Signalkvalitet: Groq ${q.avg_valid_signals} vs Gemini ${g.avg_valid_signals} gyldige. ` +
      `Feil: Groq ${q.errors} vs Gemini ${g.errors}.`;
  } else {
    primary  = geminiName;
    fallback = groqName;
    reason   = `Likt samlet skår (${gTotal}). Gemini beholdes som primær — allerede konfigurert og produksjonstestet.`;
  }

  return {
    primary, fallback, reason,
    scores: { gemini_speed: gSpd, gemini_stability: gStb, gemini_quality: gQlt, gemini_total: gTotal,
              groq_speed: qSpd,   groq_stability: qStb,   groq_quality: qQlt,   groq_total: qTotal },
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  const apiKeyHeader = req.headers.get('apikey');
  if (!authHeader && !apiKeyHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const geminiKey = Deno.env.get('INTEGRATIONS_API_KEY');
  const groqKey   = Deno.env.get('GROQ_API_KEY');

  if (!geminiKey) return new Response(JSON.stringify({ error: 'INTEGRATIONS_API_KEY not set' }), {
    status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
  if (!groqKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY not set' }), {
    status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  console.log(`[ai-benchmark] Starting Fase 3 benchmark — ${ROUNDS} rounds per provider`);
  console.log(`[ai-benchmark] Prompt: ${BENCH_PROMPT.length} chars / ~${Math.round(BENCH_PROMPT.length/4)} tokens`);

  const t0 = Date.now();
  const geminiResults: RoundResult[] = [];
  const groqResults:   RoundResult[] = [];

  // Run Gemini rounds sequentially (avoid flooding the gateway)
  for (let i = 1; i <= ROUNDS; i++) {
    console.log(`[ai-benchmark] Gemini round ${i}/${ROUNDS}…`);
    const r = await callGemini(geminiKey, i);
    geminiResults.push(r);
    console.log(`[ai-benchmark] Gemini r${i}: total=${r.total_ms}ms ttfb=${r.ttfb_ms}ms json=${r.valid_json} signals=${r.signal_count}(valid=${r.signals_valid}) err=${r.error_type||'none'}`);
    if (i < ROUNDS) await new Promise(res => setTimeout(res, 2000));
  }

  // Run Groq rounds sequentially
  for (let i = 1; i <= ROUNDS; i++) {
    console.log(`[ai-benchmark] Groq round ${i}/${ROUNDS}…`);
    const r = await callGroq(groqKey, i);
    groqResults.push(r);
    console.log(`[ai-benchmark] Groq r${i}: total=${r.total_ms}ms ttfb=${r.ttfb_ms}ms json=${r.valid_json} signals=${r.signal_count}(valid=${r.signals_valid}) err=${r.error_type||'none'}`);
    if (i < ROUNDS) await new Promise(res => setTimeout(res, 2000));
  }

  const geminiStats = computeStats(geminiResults);
  const groqStats   = computeStats(groqResults);
  const rec         = recommend(geminiStats, groqStats);
  const totalBenchMs = Date.now() - t0;

  const report = {
    fase:         3,
    benchmark_ms: totalBenchMs,
    rounds_each:  ROUNDS,
    prompt_chars: BENCH_PROMPT.length,
    prompt_tokens_est: Math.round(BENCH_PROMPT.length / 4),
    coins_in_snapshot: 10,
    gemini: {
      model:   'gemini-2.5-flash (gateway)',
      stats:   geminiStats,
      rounds:  geminiResults,
    },
    groq: {
      model:   `groq/${GROQ_MODEL}`,
      stats:   groqStats,
      rounds:  groqResults,
    },
    recommendation: rec,
  };

  console.log(JSON.stringify({
    event: 'FASE3_BENCHMARK_COMPLETE',
    benchmark_ms: totalBenchMs,
    recommendation: rec,
    gemini_avg_ms: geminiStats.avg_total_ms,
    groq_avg_ms:   groqStats.avg_total_ms,
    gemini_success: geminiStats.successful,
    groq_success:   groqStats.successful,
    gemini_valid_signals: geminiStats.avg_valid_signals,
    groq_valid_signals:   groqStats.avg_valid_signals,
  }));

  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
