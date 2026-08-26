/**
 * market-data Edge Function — v3
 *
 * Fetches live prices for ALL USDT pairs from Pionex tickers in one call.
 * Returns Record<"SYMBOL/USDT", MarketData> for every pair found.
 *
 * FIX (v3): Previously only returned 8 hardcoded pairs. Demo trades opened
 * on AI-signal pairs (e.g. DYM/USDT, OSMO/USDT) had no price → P/L stayed 0.
 * Now every USDT pair Pionex publishes is included in the response.
 *
 * Sparklines are still fetched — but only for the 8 dashboard pairs to keep
 * the response fast. All other pairs return sparkline: [].
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PIONEX_BASE = 'https://api.pionex.com';

// Pairs that get sparkline data (dashboard display). All other USDT pairs
// still appear in the response with sparkline: [] for P/L calculation.
const SPARKLINE_PAIRS: { pair: string; pionex_symbol: string }[] = [
  { pair: 'BTC/USDT',  pionex_symbol: 'BTC_USDT'  },
  { pair: 'ETH/USDT',  pionex_symbol: 'ETH_USDT'  },
  { pair: 'SOL/USDT',  pionex_symbol: 'SOL_USDT'  },
  { pair: 'BNB/USDT',  pionex_symbol: 'BNB_USDT'  },
  { pair: 'XRP/USDT',  pionex_symbol: 'XRP_USDT'  },
  { pair: 'ADA/USDT',  pionex_symbol: 'ADA_USDT'  },
  { pair: 'DOGE/USDT', pionex_symbol: 'DOGE_USDT' },
  { pair: 'DOT/USDT',  pionex_symbol: 'DOT_USDT'  },
];

interface PionexTicker {
  symbol: string; open: string; close: string;
  high: string; low: string; volume: string; amount: string;
}

async function fetchSparkline(pionexSymbol: string): Promise<number[]> {
  try {
    const url = `${PIONEX_BASE}/api/v1/market/klines?symbol=${pionexSymbol}&interval=60M&limit=24`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.data?.klines ?? [])
      .map((k: { close: string }) => parseFloat(k.close))
      .filter((n: number) => !isNaN(n) && n > 0);
  } catch { return []; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Fetch tickers + sparklines for dashboard pairs in parallel
    const [tickerRes, ...sparklineResults] = await Promise.allSettled([
      fetch(`${PIONEX_BASE}/api/v1/market/tickers`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8_000),
      }),
      ...SPARKLINE_PAIRS.map(m => fetchSparkline(m.pionex_symbol)),
    ]);

    if (tickerRes.status === 'rejected' || !(tickerRes.value as Response).ok) {
      const status = tickerRes.status === 'rejected' ? 'fetch failed' : `HTTP ${(tickerRes.value as Response).status}`;
      return new Response(
        JSON.stringify({ error: `Pionex tickers: ${status}`, source: 'pionex' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await (tickerRes.value as Response).json();
    const tickers: PionexTicker[] = body?.data?.tickers ?? [];
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Empty tickers from Pionex', source: 'pionex' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build sparkline map for the dashboard pairs
    const sparklineMap: Record<string, number[]> = {};
    for (let i = 0; i < SPARKLINE_PAIRS.length; i++) {
      const result = sparklineResults[i];
      sparklineMap[SPARKLINE_PAIRS[i].pair] = result?.status === 'fulfilled'
        ? (result.value as number[])
        : [];
    }

    const fetchedAt = new Date().toISOString();
    const priceMap: Record<string, unknown> = {};

    // Include ALL USDT pairs from Pionex — not just the 8 dashboard pairs.
    // This ensures demo trades on AI-signal pairs (DYM, OSMO, ACE, etc.)
    // always have a live price for P/L calculation.
    for (const t of tickers) {
      if (!t.symbol.endsWith('_USDT')) continue;
      const price = parseFloat(t.close);
      if (isNaN(price) || price <= 0) continue;

      // Convert "BTC_USDT" → "BTC/USDT"
      const pair   = t.symbol.replace('_', '/');
      const symbol = t.symbol.replace('_USDT', '');
      const open   = parseFloat(t.open);
      const high   = parseFloat(t.high);
      const low    = parseFloat(t.low);
      const volume = parseFloat(t.amount);
      const change24h = price - open;
      const changePct = open > 0 ? ((price - open) / open) * 100 : 0;

      priceMap[pair] = {
        symbol, pair, coin_name: symbol,
        pionex_symbol: t.symbol,
        price, change_24h: change24h, change_pct_24h: changePct,
        volume_24h: volume, high_24h: high, low_24h: low,
        sparkline: sparklineMap[pair] ?? [],
        source: 'pionex', fetched_at: fetchedAt,
      };
    }

    if (Object.keys(priceMap).length === 0) {
      return new Response(
        JSON.stringify({ error: 'No USDT pairs found in Pionex tickers', source: 'pionex' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify(priceMap), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('market-data error:', err);
    return new Response(
      JSON.stringify({ error: String(err), source: 'pionex' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

