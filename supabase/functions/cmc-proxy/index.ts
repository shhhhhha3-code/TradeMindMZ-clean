/**
 * cmc-proxy Edge Function
 *
 * Proxies CoinMarketCap API calls server-side so CMC_API_KEY is never
 * exposed to the browser. Accepts a POST body with { action } and returns
 * structured market data.
 *
 * Actions:
 *   global_metrics  — global market cap, volume, BTC/ETH dominance, active cryptos
 *   top_movers      — top gainers + losers (last 24h, among top-500 by market cap)
 *   listings        — top N coins by market cap with price, volume, % changes
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CMC_BASE = 'https://pro-api.coinmarketcap.com/v1';

// ─── CoinMarketCap helper ──────────────────────────────────────────────────

async function cmcFetch(path: string, params: Record<string, string>, apiKey: string) {
  const url = new URL(`${CMC_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { 'X-CMC_PRO_API_KEY': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`CMC ${path} HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Data builders ─────────────────────────────────────────────────────────

async function getGlobalMetrics(apiKey: string) {
  const body = await cmcFetch('/global-metrics/quotes/latest', {}, apiKey);
  const d = body?.data;
  if (!d) throw new Error('CMC global-metrics: no data');
  const q = d.quote?.USD ?? {};
  return {
    total_market_cap_usd:    q.total_market_cap       ?? 0,
    total_volume_24h_usd:    q.total_volume_24h        ?? 0,
    btc_dominance:           d.btc_dominance           ?? 0,
    eth_dominance:           d.eth_dominance           ?? 0,
    active_cryptos:          d.active_cryptocurrencies ?? 0,
    active_exchanges:        d.active_exchanges        ?? 0,
    market_cap_change_24h:   q.total_market_cap_yesterday_percentage_change ?? 0,
    defi_market_cap:         q.defi_market_cap         ?? 0,
    defi_volume_24h:         q.defi_volume_24h         ?? 0,
    last_updated: d.last_updated ?? new Date().toISOString(),
  };
}

async function getTopMovers(apiKey: string) {
  // Fetch top 200 by market cap then extract top 5 gainers + 5 losers
  const body = await cmcFetch('/cryptocurrency/listings/latest', {
    limit: '200',
    sort: 'market_cap',
    convert: 'USD',
  }, apiKey);
  const coins: {
    symbol: string;
    name: string;
    quote: { USD: { price: number; percent_change_24h: number; volume_24h: number; market_cap: number } };
  }[] = body?.data ?? [];

  const mapped = coins.map(c => ({
    symbol: c.symbol,
    name: c.name,
    price: c.quote.USD.price,
    change_24h: c.quote.USD.percent_change_24h,
    volume_24h: c.quote.USD.volume_24h,
    market_cap: c.quote.USD.market_cap,
  }));

  const sorted = [...mapped].sort((a, b) => b.change_24h - a.change_24h);
  return {
    gainers: sorted.slice(0, 5),
    losers: sorted.slice(-5).reverse(),
  };
}

async function getListings(apiKey: string, limit = 50) {
  const body = await cmcFetch('/cryptocurrency/listings/latest', {
    limit: String(limit),
    sort: 'market_cap',
    convert: 'USD',
  }, apiKey);
  const coins: {
    id: number;
    symbol: string;
    name: string;
    cmc_rank: number;
    quote: { USD: { price: number; percent_change_1h: number; percent_change_24h: number; percent_change_7d: number; volume_24h: number; market_cap: number } };
  }[] = body?.data ?? [];

  return coins.map(c => ({
    id: c.id,
    rank: c.cmc_rank,
    symbol: c.symbol,
    name: c.name,
    price: c.quote.USD.price,
    change_1h:  c.quote.USD.percent_change_1h,
    change_24h: c.quote.USD.percent_change_24h,
    change_7d:  c.quote.USD.percent_change_7d,
    volume_24h: c.quote.USD.volume_24h,
    market_cap: c.quote.USD.market_cap,
  }));
}

// ─── Main Handler ──────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const cmcKey = Deno.env.get('CMC_API_KEY');
  if (!cmcKey) {
    return new Response(JSON.stringify({ error: 'CMC_API_KEY not configured' }), {
      status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body?.action ?? 'global_metrics';

    let result: unknown;
    switch (action) {
      case 'global_metrics':
        result = await getGlobalMetrics(cmcKey);
        break;
      case 'top_movers':
        result = await getTopMovers(cmcKey);
        break;
      case 'listings':
        result = await getListings(cmcKey, Number(body?.limit ?? 50));
        break;
      // Combined: fetch all three in parallel for the dashboard panel
      case 'market_overview': {
        const [metrics, movers, listings] = await Promise.allSettled([
          getGlobalMetrics(cmcKey),
          getTopMovers(cmcKey),
          getListings(cmcKey, 20),
        ]);
        result = {
          global_metrics: metrics.status === 'fulfilled' ? metrics.value : null,
          top_movers:     movers.status  === 'fulfilled' ? movers.value  : null,
          listings:       listings.status === 'fulfilled' ? listings.value : null,
          fetched_at: new Date().toISOString(),
        };
        break;
      }
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[cmc-proxy] error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
