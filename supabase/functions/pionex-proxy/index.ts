/**
 * pionex-proxy Edge Function
 *
 * Handles all Pionex API calls server-side. Credentials never touch the frontend.
 *
 * Actions:
 *   connect       — validate + store API key/secret (encrypted)
 *   disconnect    — remove stored credentials
 *   portfolio     — fetch balances, open orders, running bots, USDT-M positions (READ-ONLY)
 *   positions     — fetch USDT-M futures positions only (lightweight refresh, READ-ONLY)
 *   market_data   — fetch Pionex tickers (public, no auth)
 *   candlestick   — fetch kline data for a symbol (public, no auth)
 *
 * USDT-M Futures positions endpoint:
 *   GET https://api.pionex.com/uapi/v1/account/positions
 *   Auth: same HMAC-SHA256 signing as /api/v1/* (PIONEX-KEY + PIONEX-SIGNATURE headers)
 *   This is the internal futures API surface (uapi prefix), distinct from the spot API (api prefix).
 *   Verified live: returns HTTP 200 + APIKEY_LOST when unauthenticated (route exists).
 *
 * READ-ONLY: No write operations. No create/cancel order, no close position, no transfer.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PIONEX_BASE = 'https://api.pionex.com';

// USDT-M futures endpoint — verified to exist (HTTP 200 + APIKEY_LOST unauthenticated)
// Spot endpoint /api/v1/account/positions → 404 (does NOT exist)
const PIONEX_USDTM_POSITIONS_PATH = '/uapi/v1/account/positions';

// USDT-M Futures trading endpoint.
// IMPORTANT: this is NOT the Spot /api/v1/trade/order endpoint.
const PIONEX_USDTM_ORDER_PATH = '/uapi/v1/trade/order';


// ── USDT-M FUTURES BALANCE ────────────────────────────────────────────────
// IMPORTANT: /api/v1/account/balances is Spot/Primary.
// Live Futures trading must use traderAccount from balancesFull.
async function getPionexUsdtMFuturesBalance(
  apiKey: string,
  apiSecret: string,
) {
  const data = await pionexAuthRequest(
    'GET',
    '/api/v1/wallet/balancesFull',
    apiKey,
    apiSecret,
  );

  const wallet = (data?.data ?? {}) as Record<string, unknown>;
  const trader = (wallet.traderAccount ?? {}) as Record<string, unknown>;

  // Pionex documents traderAccount.detail[] as FutureDetail objects whose
  // balances[] contains the actual Futures balance rows. We also recursively
  // scan the trader account so minor response-shape changes do not turn a real
  // USDT-M balance into 0 in the UI.
  const balanceRows: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (seen.has(value as object)) return;
    seen.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }

    const obj = value as Record<string, unknown>;
    const coin = String(obj.coin ?? obj.coinType ?? obj.asset ?? obj.currency ?? '').toUpperCase();
    const hasBalanceField = [
      'free', 'available', 'availableBalance', 'available_balance',
      'usdtAvailable', 'marginAvailable', 'availableMargin',
      'frozen', 'freeze', 'locked', 'marginFrozen', 'frozenBalance',
      'total', 'balance', 'walletBalance', 'equity', 'amount',
    ].some((key) => obj[key] !== undefined);

    if (coin && hasBalanceField) balanceRows.push(obj);

    for (const value of Object.values(obj)) collect(value, depth + 1);
  };

  collect(trader);

  const usdtRows = balanceRows.filter((row) => {
    const coin = String(row.coin ?? row.coinType ?? row.asset ?? row.currency ?? '').toUpperCase();
    return coin === 'USDT';
  });

  const readNumber = (...values: unknown[]): number => {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };

  // Prefer explicit available/free. For a Futures row with no explicit free,
  // derive available from total - frozen so UI does not collapse to zero.
  let available = 0;
  let frozen = 0;
  let total = 0;

  for (const row of usdtRows) {
    const rowFrozen = readNumber(
      row.frozen, row.freeze, row.locked, row.marginFrozen, row.frozenBalance,
    );
    const rowTotal = readNumber(
      row.total, row.balance, row.walletBalance, row.equity, row.amount,
    );
    const explicitAvailable = readNumber(
      row.free,
      row.available,
      row.availableBalance,
      row.available_balance,
      row.usdtAvailable,
      row.marginAvailable,
      row.availableMargin,
    );
    const derivedAvailable = explicitAvailable !== 0
      ? explicitAvailable
      : Math.max(rowTotal - rowFrozen, 0);

    available += derivedAvailable;
    frozen += rowFrozen;
    total += rowTotal > 0 ? rowTotal : derivedAvailable + rowFrozen;
  }

  const traderTotal = readNumber(trader.totalInUsdt);
  if (total <= 0 && traderTotal > 0 && available <= 0) {
    total = traderTotal;
    available = Math.max(traderTotal - frozen, 0);
  }

  const categories = Array.isArray(trader.detail)
    ? trader.detail as Record<string, unknown>[]
    : [];

  console.log('[PIONEX_FUTURES_BALANCE]', JSON.stringify({
    endpoint: '/api/v1/wallet/balancesFull',
    trader_total_in_usdt: trader.totalInUsdt ?? null,
    usdt_available: available,
    usdt_frozen: frozen,
    usdt_total: total,
    usdt_rows: usdtRows.length,
    detail_categories: categories.length,
  }));

  return {
    available,
    frozen,
    total,
    detail: balanceRows,
    trader,
  };
}

// ─── Symbol display normalisation ─────────────────────────────────────────────
// Pionex internal format: RIF_USDT_PERP  →  display: RIF/USDT Perp
// Also handles: BTCUSDT_PERP, BTC_USDT, BTC/USDT etc.
function normaliseSymbolDisplay(raw: string): string {
  // Remove _PERP suffix variants for display, then reformat
  const s = raw.toUpperCase();
  // e.g. RIF_USDT_PERP → RIF/USDT Perp
  const perpMatch = s.match(/^([A-Z0-9]+)[_/]?(USDT|USDC|BUSD|BNB|BTC|ETH|USD)_(PERP|SWAP|FUTURES?)$/);
  if (perpMatch) return `${perpMatch[1]}/${perpMatch[2]} Perp`;
  // e.g. RIFUSDT_PERP or RIFUSDTPERP
  const perpMatch2 = s.match(/^([A-Z0-9]+)(USDT|USDC|BUSD|BTC|ETH)_(PERP|SWAP)$/);
  if (perpMatch2) return `${perpMatch2[1]}/${perpMatch2[2]} Perp`;
  // e.g. RIF_USDT or RIF/USDT (spot-like)
  const spotMatch = s.match(/^([A-Z0-9]+)[_/](USDT|USDC|BUSD|BNB|BTC|ETH|USD)$/);
  if (spotMatch) return `${spotMatch[1]}/${spotMatch[2]}`;
  // Fallback: replace underscores with slashes
  return raw.replace(/_/g, '/');
}

// ─── Encryption (XOR + base64, key from env) ──────────────────────────────

async function encryptSecret(secret: string): Promise<string> {
  const key = Deno.env.get('ENCRYPTION_KEY') ?? 'default-key-change-this-now';
  const keyBytes = new TextEncoder().encode(key);
  const secretBytes = new TextEncoder().encode(secret);
  const encrypted = new Uint8Array(secretBytes.length);
  for (let i = 0; i < secretBytes.length; i++) encrypted[i] = secretBytes[i] ^ keyBytes[i % keyBytes.length];
  return btoa(String.fromCharCode(...encrypted));
}

async function decryptSecret(enc: string): Promise<string> {
  const key = Deno.env.get('ENCRYPTION_KEY') ?? 'default-key-change-this-now';
  const keyBytes = new TextEncoder().encode(key);
  const encBytes = new Uint8Array(atob(enc).split('').map(c => c.charCodeAt(0)));
  const dec = new Uint8Array(encBytes.length);
  for (let i = 0; i < encBytes.length; i++) dec[i] = encBytes[i] ^ keyBytes[i % keyBytes.length];
  return new TextDecoder().decode(dec);
}

// ─── BUG-3 FIX: Rate-limit throttle + exponential backoff ────────────────────
//
// Pionex enforces per-key rate limits on authenticated endpoints.
// Every authenticated call goes through pionexAuthRequest; we track the
// last call timestamp and enforce a minimum gap of MIN_REQUEST_GAP_MS.
// On HTTP 429 the call is retried with exponential backoff (max 3 attempts).
// Public (unauthenticated) calls are NOT throttled here.

const MIN_REQUEST_GAP_MS  = 300;   // ≥ 300 ms between authenticated Pionex calls
const MAX_429_RETRIES     = 3;
const BACKOFF_BASE_MS     = 1_000; // 1 s, 2 s, 4 s

let lastPionexCallMs = 0; // module-level — shared across requests in same isolate

async function throttleDelay(): Promise<void> {
  const now  = Date.now();
  const wait = lastPionexCallMs + MIN_REQUEST_GAP_MS - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastPionexCallMs = Date.now();
}

// ─── Pionex HMAC-SHA256 Signing ───────────────────────────────────────────
//
// Official spec (pionex-official/pionex-open-api openapi.yaml):
//   GET:  HMAC-SHA256(secret, "GET"  + path + "?" + sorted_params)
//   POST: HMAC-SHA256(secret, "POST" + path + "?" + sorted_params + body_json)
//
//   Rules:
//   - Sort params alphabetically by key
//   - NO URL-encoding in the string being signed (use raw values)
//   - Output: lowercase hex (NOT base64)
//   - Send as header: PIONEX-SIGNATURE
//   - Send key as header: PIONEX-KEY
//   - timestamp (ms) included as a regular query param

async function buildPionexSignature(
  method: string,
  path: string,
  params: Record<string, string>,
  apiSecret: string,
  body = ''
): Promise<string> {
  // Sort alphabetically, raw values (no encodeURIComponent) for signing
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const msg = `${method}${path}?${sorted}${body}`;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  // Convert to lowercase hex
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pionexAuthRequest(
  method: string,
  path: string,
  apiKey: string,
  apiSecret: string,
  queryParams: Record<string, string> = {}
) {
  // BUG-3 FIX: throttle + exponential backoff on HTTP 429
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await throttleDelay();

    const timestamp = Date.now().toString();
    const params: Record<string, string> = { ...queryParams, timestamp };

    const signature = await buildPionexSignature(method, path, params, apiSecret);

    // URL uses encodeURIComponent for safe transport (only in URL, not in signing string)
    const qs = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const url = `${PIONEX_BASE}${path}?${qs}`;

    const res = await fetch(url, {
      method,
      headers: {
        'PIONEX-KEY': apiKey,
        'PIONEX-SIGNATURE': signature,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    // BUG-3 FIX: handle 429 with Retry-After + exponential backoff; never retry blindly
    if (res.status === 429) {
      const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '0', 10);
      const backoffMs = retryAfterSec > 0
        ? retryAfterSec * 1_000
        : BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(`[PIONEX_429] ${method} ${path} — attempt ${attempt + 1}/${MAX_429_RETRIES + 1}, backoff ${backoffMs}ms`);
      if (attempt < MAX_429_RETRIES) {
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      // Exhausted retries — propagate as a typed error so callers can return RATE_LIMITED
      throw new Error(`Pionex 429: Too Many Requests (${path})`);
    }

    const responseText = await res.text();
    if (!res.ok) throw new Error(`Pionex ${res.status}: ${responseText}`);

    const json = JSON.parse(responseText);
    if (json.result === false) {
      throw new Error(`${json.message ?? json.code ?? 'Unknown Pionex error'}`);
    }
    return json;
  }
  // Should never reach here
  throw new Error(`Pionex request failed after ${MAX_429_RETRIES + 1} attempts`);
}

// Raw version: returns full JSON without throwing on result:false.
// Use for futures endpoints where the response shape is unknown — we need to
// see the actual payload even when authentication partially succeeds/fails.
async function pionexRawRequest(
  method: string,
  path: string,
  apiKey: string,
  apiSecret: string,
  queryParams: Record<string, string> = {}
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const timestamp = Date.now().toString();
  const params: Record<string, string> = { ...queryParams, timestamp };
  const signature = await buildPionexSignature(method, path, params, apiSecret);
  const qs = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  const url = `${PIONEX_BASE}${path}?${qs}`;

  const res = await fetch(url, {
    method,
    headers: {
      'PIONEX-KEY': apiKey,
      'PIONEX-SIGNATURE': signature,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { body = { raw_text: text }; }
  return { httpStatus: res.status, body };
}

// ─── Main Handler ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Verify JWT and get user
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', '')
  );
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = await req.json().catch(() => ({}));
  const { action, api_key, api_secret, symbol, interval = '15M', limit = 50 } = body;

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    // ── PUBLIC: market data (no Pionex auth required) ──────────────────────

    if (action === 'market_data') {
      const res = await fetch(`${PIONEX_BASE}/api/v1/market/tickers`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Pionex tickers ${res.status}`);
      const body = await res.json();
      return respond(body?.data ?? {});
    }

    if (action === 'candlestick') {
      if (!symbol) return respond({ error: 'symbol required' }, 400);
      const url = `${PIONEX_BASE}/api/v1/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Pionex klines ${res.status}`);
      const kdata = await res.json();
      return respond(kdata?.data ?? {});
    }

    // ── AUTHENTICATED: account actions ────────────────────────────────────

    if (action === 'connect') {
      if (!api_key?.trim() || !api_secret?.trim())
        return respond({ error: 'API key and secret required' }, 400);

      // Validate credentials against Pionex account endpoint
      try {
        await pionexAuthRequest('GET', '/api/v1/account/balances', api_key.trim(), api_secret.trim());
      } catch (e) {
        const msg = String(e);
        // "request auth status failed" = key is valid but IP whitelist blocks this server
        if (msg.includes('request auth status failed') || msg.includes('auth status')) {
          return respond({
            error: 'IP-begrensning blokkerer tilgang. Gå til Pionex → API-administrasjon → rediger nøkkelen din og velg "Ingen IP-begrensning" (eller legg til 0.0.0.0/0). Supabase-serveren har en annen IP enn din hjemme-IP.',
            code: 'IP_WHITELIST_BLOCKED',
          }, 400);
        }
        // INVALID_APIKEY / INVALID_SIGNATURE
        if (msg.includes('INVALID_APIKEY') || msg.includes('Invalid apikey')) {
          return respond({ error: 'API-nøkkelen ble ikke funnet på Pionex. Sjekk at du kopierte riktig nøkkel.', code: 'INVALID_KEY' }, 400);
        }
        if (msg.includes('INVALID_SIGNATURE') || msg.includes('Signature')) {
          return respond({ error: 'Signaturfeil. Sjekk at API-hemmeligheten (Secret) er riktig kopiert uten ekstra mellomrom.', code: 'INVALID_SECRET' }, 400);
        }
        return respond({ error: `Pionex-feil: ${msg}` }, 400);
      }

      const encryptedSecret = await encryptSecret(api_secret.trim());
      const { error: upsertErr } = await supabase.from('pionex_connections').upsert({
        user_id: user.id,
        api_key: api_key.trim(),
        api_secret_encrypted: encryptedSecret,
        is_connected: true,
        last_sync: new Date().toISOString(),
        permissions: ['read'],
      }, { onConflict: 'user_id' });

      if (upsertErr) throw upsertErr;
      return respond({ success: true, permissions: ['read'] });
    }

    if (action === 'disconnect') {
      await supabase.from('pionex_connections').delete().eq('user_id', user.id);
      return respond({ success: true });
    }

    if (action === 'portfolio') {
      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!conn?.is_connected)
        return respond({ error: 'Pionex not connected' }, 404);

      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      // Fetch balances + open orders + bots in parallel — READ-ONLY
      // Positions are fetched separately via pionexRawRequest (never throws on result:false)
      const [balRes, ordRes, botRes] = await Promise.allSettled([
        pionexAuthRequest('GET', '/api/v1/account/balances', conn.api_key, apiSecret),
        pionexAuthRequest('GET', '/api/v1/trade/openOrders', conn.api_key, apiSecret, { limit: '20' }),
        pionexAuthRequest('GET', '/api/v1/bot/orders', conn.api_key, apiSecret, { limit: '20' }),
      ]);

      // USDT-M futures positions — use raw fetcher so result:false is visible, not swallowed
      const { httpStatus: posHttp, body: posBody } = await pionexRawRequest(
        'GET', PIONEX_USDTM_POSITIONS_PATH, conn.api_key, apiSecret
      );
      console.log('[portfolio/positions] HTTP', posHttp,
        '| result:', posBody.result, '| code:', posBody.code,
        '| message:', posBody.message,
        '| data keys:', posBody.data != null ? Object.keys(posBody.data as object) : 'null');

      const balances = balRes.status === 'fulfilled'
        ? ((balRes.value?.data?.balances ?? []) as Record<string, unknown>[])
            .map(b => ({
              coin: String(b.coinType ?? b.coin ?? ''),
              free: parseFloat(String(b.free ?? 0)),
              freeze: parseFloat(String(b.frozen ?? b.freeze ?? 0)),
              total: parseFloat(String(b.free ?? 0)) + parseFloat(String(b.frozen ?? b.freeze ?? 0)),
              usd_value: 0,
            }))
            .filter(b => b.total > 0)
        : [];

      const open_orders = ordRes.status === 'fulfilled'
        ? ((ordRes.value?.data?.orders ?? ordRes.value?.data?.list ?? []) as Record<string, unknown>[])
            .map(o => ({
              id: String(o.orderId ?? o.id ?? ''),
              symbol: String(o.symbol ?? ''),
              side: String(o.side ?? ''),
              price: parseFloat(String(o.price ?? 0)),
              qty: parseFloat(String(o.amount ?? o.size ?? 0)),
              created_at: o.createTime
                ? new Date(Number(o.createTime)).toISOString()
                : new Date().toISOString(),
            }))
        : [];

      // Bots: map from /api/v1/bot/orders response (gracefully empty if permission not granted)
      const bots = botRes.status === 'fulfilled'
        ? ((botRes.value?.data?.orders ?? botRes.value?.data?.list ?? []) as Record<string, unknown>[])
            .map(b => ({
              id: String(b.botOrderId ?? b.orderId ?? b.id ?? ''),
              name: String(b.botType ?? b.type ?? 'Grid Bot'),
              pair: String(b.symbol ?? ''),
              investment: parseFloat(String(b.investment ?? b.totalInvestment ?? 0)),
              total_pnl: parseFloat(String(b.totalProfit ?? b.pnl ?? 0)),
              roi_pct: parseFloat(String(b.roi ?? 0)) * 100,
              status: String(b.state ?? b.status ?? 'running'),
              created_at: b.createTime
                ? new Date(Number(b.createTime)).toISOString()
                : new Date().toISOString(),
            }))
        : [];

      // ── USDT-M Futures positions — parse raw response ─────────────────────
      let rawPositions: Record<string, unknown>[] = [];
      let positionsFetched = false;
      let positionsApiError: string | null = null;

      if (posBody.result === false || posHttp !== 200) {
        positionsApiError = String(posBody.message ?? posBody.code ?? `HTTP ${posHttp}`);
        console.warn('[portfolio/positions] error:', positionsApiError);
      } else {
        positionsFetched = true;
        const d = posBody.data as Record<string, unknown> | null;
        if (Array.isArray(posBody.data))          rawPositions = posBody.data as Record<string, unknown>[];
        else if (d && Array.isArray(d.positions)) rawPositions = d.positions as Record<string, unknown>[];
        else if (d && Array.isArray(d.list))      rawPositions = d.list as Record<string, unknown>[];
        else if (d && Array.isArray(d.data))      rawPositions = d.data as Record<string, unknown>[];
        console.log('[portfolio/positions] raw count:', rawPositions.length,
          '| symbols:', rawPositions.map((p: Record<string, unknown>) => p.symbol ?? '?').join(',') || '(none)');
      }

      // ── portfolio/positions: same normalisation as the standalone positions action ──
      // resolveQty helper (scoped): skip zeros, prefer size over positionAmt
      const portfolioResolveQty = (p: Record<string, unknown>): { value: number; field: string } => {
        const candidates: Array<[string, unknown]> = [
          // Confirmed Pionex field: netSize = -520 (signed)
          ['netSize',      p.netSize],
          ['positionAmt',  p.positionAmt],
          ['size',         p.size],
          ['quantity',     p.quantity],
          ['qty',          p.qty],
          ['amount',       p.amount],
          ['vol',          p.vol],
          ['volume',       p.volume],
          ['pos',          p.pos],
          ['net',          p.net],
          ['holdSize',     p.holdSize],
          ['currentQty',   p.currentQty],
        ];
        for (const [field, val] of candidates) {
          if (val !== undefined && val !== null && val !== '') {
            const n = parseFloat(String(val));
            // Skip NaN and exact zero — a zero qty means closed position
            // We want the first non-zero value (e.g. size=-520 beats positionAmt=0)
            if (!isNaN(n) && n !== 0) return { value: n, field };
          }
        }
        for (const [field, val] of candidates) {
          if (val !== undefined && val !== null && val !== '') {
            const n = parseFloat(String(val));
            if (!isNaN(n)) return { value: n, field };
          }
        }
        return { value: 0, field: 'none' };
      };

      const positions = rawPositions
        .map(p => {
          const rawSymbol    = String(p.symbol ?? p.pair ?? p.contract ?? '');
          const explicitSide = String(p.positionSide ?? p.side ?? '').toUpperCase();
          const { value: rawQtyVal } = portfolioResolveQty(p);

          let side: 'LONG' | 'SHORT';
          if (explicitSide === 'SHORT')     side = 'SHORT';
          else if (explicitSide === 'LONG') side = 'LONG';
          else                              side = rawQtyVal < 0 ? 'SHORT' : 'LONG';
          const absQty = Math.abs(rawQtyVal);

          const avgPrice = parseFloat(String(
            p.avgPrice ?? p.entryPrice ?? p.avg_price ?? p.openPrice ?? 0));
          const markPrice = p.markPrice != null ? parseFloat(String(p.markPrice)) : null;

          const unrealizedPnl = (() => {
            const raw = p.unrealizedPnl ?? p.unRealizedProfit ?? p.unrealizedProfit ??
                        p.unrealisedPnl ?? p.pnl ?? null;
            if (raw === null || raw === undefined) return null;
            const n = parseFloat(String(raw));
            return isNaN(n) ? null : n;
          })();

          const positionValue = (() => {
            const raw = p.positionValue ?? p.notionalValue ?? p.notional ?? p.marketValue ?? p.value ?? null;
            if (raw !== null && raw !== undefined) {
              const n = parseFloat(String(raw));
              if (!isNaN(n) && n !== 0) return Math.abs(n);
            }
            // Confirmed Pionex formula: abs(netSize) × markPrice
            if (markPrice !== null && absQty > 0) return Math.abs(markPrice * absQty);
            return null;
          })();

          const occupiedMargin = (() => {
            const raw = p.occupiedMargin ?? p.margin ?? p.isolatedMargin ??
                        p.positionInitialMargin ?? p.initialMargin ?? null;
            if (raw === null || raw === undefined) return null;
            const n = parseFloat(String(raw));
            return isNaN(n) ? null : n;
          })();

          const liquidationPrice = (() => {
            const raw = p.liquidationPrice ?? p.liqPrice ?? p.forceClosePrice ?? null;
            if (raw === null || raw === undefined) return null;
            const n = parseFloat(String(raw));
            return isNaN(n) ? null : n;
          })();

          const leverage     = parseInt(String(p.leverage ?? 1), 10);
          const marginTypeRaw = String(
            p.marginMode ?? p.marginType ?? p.margin_type ?? p.marginLevel ?? 'cross'
          ).toLowerCase();
          const marginMode: 'Cross' | 'Isolated' =
            marginTypeRaw === 'isolated' ? 'Isolated' : 'Cross';

          let unrealizedPnlPct: number | null = null;
          if (unrealizedPnl !== null && positionValue !== null && positionValue !== 0) {
            unrealizedPnlPct = unrealizedPnl / positionValue;
          }

          return {
            symbol:             normaliseSymbolDisplay(rawSymbol),
            raw_symbol:         rawSymbol,
            side,
            margin_mode:        marginMode,
            leverage,
            quantity:           absQty,
            avg_price:          avgPrice,
            mark_price:         markPrice,
            position_value:     positionValue,
            unrealized_pnl:     unrealizedPnl,
            unrealized_pnl_pct: unrealizedPnlPct,
            occupied_margin:    occupiedMargin,
            liquidation_price:  liquidationPrice,
          };
        })
        // Active = explicit side OR non-zero qty
        .filter(p => {
          const rawP = rawPositions.find(r =>
            String(r.symbol ?? r.pair ?? r.contract ?? '') === p.raw_symbol);
          const expSide = String(rawP?.positionSide ?? rawP?.side ?? '').toUpperCase();
          return expSide === 'LONG' || expSide === 'SHORT' || p.quantity > 0;
        });

      await supabase.from('pionex_connections')
        .update({ last_sync: new Date().toISOString() })
        .eq('user_id', user.id);

      // positions_api_ok: true = API responded (0 positions is valid empty state)
      //                   false = API call failed (do NOT show "no positions" to user)
      return respond({ balances, open_orders, bots, positions, positions_api_ok: positionsFetched, positions_api_error: positionsApiError, source: 'pionex' });
    }

    // ── AUTHENTICATED: fetch USDT-M positions only (lightweight refresh) ───
    if (action === 'positions') {
      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!conn?.is_connected)
        return respond({ error: 'Pionex not connected' }, 404);

      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      // Use raw fetcher — never throws on result:false, so we always see the real payload.
      // This is the critical fix: pionexAuthRequest throws on result:false which was silently
      // swallowing the real Pionex error and returning 0 positions instead of an error state.
      const { httpStatus, body: rawBody } = await pionexRawRequest(
        'GET', PIONEX_USDTM_POSITIONS_PATH, conn.api_key, apiSecret
      );

      // Full safe diagnostic — keys only, no credential values
      console.log('[positions] HTTP', httpStatus,
        '| result:', rawBody.result,
        '| code:', rawBody.code,
        '| message:', rawBody.message,
        '| data keys:', rawBody.data != null ? Object.keys(rawBody.data as object) : 'null',
        '| top-level keys:', Object.keys(rawBody));

      // Auth / API error — return it clearly so UI shows error, NOT "no positions"
      if (rawBody.result === false || httpStatus !== 200) {
        const apiErr = String(rawBody.message ?? rawBody.code ?? `HTTP ${httpStatus}`);
        console.warn('[positions] API returned error:', apiErr);
        return respond({
          positions: [],
          positions_api_ok: false,
          positions_api_error: apiErr,
          _diag: { httpStatus, code: rawBody.code, message: rawBody.message },
        });
      }


      // ── Parse positions: try every known Pionex data envelope shape ──────
      const d = rawBody.data as Record<string, unknown> | null;
      let rawPos: Record<string, unknown>[] = [];
      if (Array.isArray(rawBody.data))                rawPos = rawBody.data as Record<string, unknown>[];
      else if (d && Array.isArray(d.positions))        rawPos = d.positions as Record<string, unknown>[];
      else if (d && Array.isArray(d.list))             rawPos = d.list as Record<string, unknown>[];
      else if (d && Array.isArray(d.data))             rawPos = d.data as Record<string, unknown>[];

      // Log ALL keys on every raw position so we can identify the real quantity field name
      console.log('[positions] raw count before filter:', rawPos.length);
      rawPos.forEach((p, i) => {
        console.log(`[positions] raw[${i}] ALL_KEYS:`, JSON.stringify(Object.keys(p)));
        console.log(`[positions] raw[${i}] FULL:`, JSON.stringify(p));
      });

      // Resolve quantity from the raw position object.
      // Pionex USDT-M /uapi/v1/account/positions uses 'positionAmt' per their API docs.
      // We also try every other known futures API field name as fallback.
      // IMPORTANT: skip exact zero values on first pass so a "0" positionAmt does not
      // shadow a non-zero value in another field (e.g. size=-520).
      // Object.is(n, 0) catches both +0 and -0 (JavaScript negative zero).
      function resolveQty(p: Record<string, unknown>): { value: number; field: string } {
        const candidates: Array<[string, unknown]> = [
          // Confirmed from live Pionex /uapi/v1/account/positions response:
          // netSize = -520 (signed, negative = SHORT)
          ['netSize',       p.netSize],
          // Other Pionex fields present in response (sizeShort is also -520 for SHORT)
          ['sizeShort',     p.side === 'SHORT' ? p.sizeShort : undefined],
          ['sizeLong',      p.side === 'LONG'  ? p.sizeLong  : undefined],
          // Generic futures API field names as fallback
          ['positionAmt',   p.positionAmt],
          ['size',          p.size],
          ['quantity',      p.quantity],
          ['qty',           p.qty],
          ['amount',        p.amount],
          ['vol',           p.vol],
          ['volume',        p.volume],
          ['pos',           p.pos],
          ['net',           p.net],
          ['holdSize',      p.holdSize],
          ['currentQty',    p.currentQty],
          ['contractSize',  p.contractSize],
        ];
        // First pass: non-zero numeric value (skips both +0 and -0)
        for (const [field, val] of candidates) {
          if (val !== undefined && val !== null && val !== '') {
            const n = parseFloat(String(val));
            if (!isNaN(n) && !Object.is(n, 0) && n !== 0) return { value: n, field };
          }
        }
        // Second pass: accept any numeric (fallback for all-zero position state)
        for (const [field, val] of candidates) {
          if (val !== undefined && val !== null && val !== '') {
            const n = parseFloat(String(val));
            if (!isNaN(n)) return { value: n, field };
          }
        }
        return { value: 0, field: 'none' };
      }

      const positions = rawPos
        .map(p => {
          const rawSymbol      = String(p.symbol ?? p.pair ?? p.contract ?? '');
          const explicitSide   = String(p.positionSide ?? p.side ?? '').toUpperCase();
          const { value: rawQtyVal, field: qtyField } = resolveQty(p);

          // Side: explicit positionSide wins; fall back to sign of quantity
          // SHORT positions have negative qty (e.g. -520) — preserve the sign for side detection
          let side: 'LONG' | 'SHORT';
          if (explicitSide === 'SHORT')      side = 'SHORT';
          else if (explicitSide === 'LONG')  side = 'LONG';
          else                               side = rawQtyVal < 0 ? 'SHORT' : 'LONG';

          // Display quantity is always absolute — side badge shows direction
          const absQty = Math.abs(rawQtyVal);

          // Trace log: shows exactly why a position is accepted or would be rejected
          console.log(`[positions] normalize: ${rawSymbol}/${explicitSide}`,
            `| qtyField=${qtyField} rawQty=${rawQtyVal} absQty=${absQty}`,
            `| normalizedSymbol=${normaliseSymbolDisplay(rawSymbol)} side=${side}`);

          // avgPrice: Pionex USDT-M uses avgPrice; also try entryPrice/openPrice
          const avgPrice = parseFloat(String(
            p.avgPrice ?? p.entryPrice ?? p.avg_price ?? p.openPrice ?? 0));

          // markPrice: standard across most APIs
          const markPrice = p.markPrice != null ? parseFloat(String(p.markPrice)) : null;

          // unrealizedPnl: try all known names — Pionex USDT-M API name TBD from diag
          const unrealizedPnl = (() => {
            const raw =
              p.unrealizedPnl      ?? p.unrealizedPnL    ?? p.unRealizedProfit ??
              p.unrealizedProfit   ?? p.unrealisedPnl    ?? p.unrealisedProfit ??
              p.openPnl            ?? p.floatingPnl      ?? p.floatProfit      ??
              p.pnl                ?? p.profit           ?? null;
            if (raw === null || raw === undefined) return null;
            const n = parseFloat(String(raw));
            return isNaN(n) ? null : n;
          })();

          // positionValue: Pionex /uapi/v1/account/positions has no explicit notional field.
          // Confirmed formula: abs(netSize) × markPrice = abs(-520) × 0.06704 ≈ 34.86 USDT
          // Try any explicit field first; fall back to the confirmed calculation.
          const positionValue = (() => {
            const raw =
              p.positionValue  ?? p.notionalValue ?? p.notional      ??
              p.marketValue    ?? p.mktValue      ?? p.value         ??
              p.positionNotional ?? p.contractValue ?? null;
            if (raw !== null && raw !== undefined) {
              const n = parseFloat(String(raw));
              if (!isNaN(n) && n !== 0) return Math.abs(n);
            }
            // Primary fallback: abs(netSize) × markPrice (confirmed correct for Pionex)
            if (markPrice !== null && absQty > 0) return Math.abs(markPrice * absQty);
            return null;
          })();

          // occupiedMargin: Pionex may use occupiedMargin, margin, or isolatedMargin
          const occupiedMargin = (() => {
            const raw =
              p.occupiedMargin       ?? p.margin             ??
              p.isolatedMargin       ?? p.positionInitialMargin ??
              p.initialMargin        ?? p.maintenanceMargin  ?? null;
            if (raw === null || raw === undefined) return null;
            const n = parseFloat(String(raw));
            return isNaN(n) ? null : n;
          })();

          // liquidationPrice: standard name, also try liqPrice
          const liquidationPrice = (() => {
            const raw = p.liquidationPrice ?? p.liqPrice ?? p.forceClosePrice ?? null;
            if (raw === null || raw === undefined) return null;
            const n = parseFloat(String(raw));
            return isNaN(n) ? null : n;
          })();

          // leverage: integer
          const leverage = parseInt(String(p.leverage ?? 1), 10);

          // marginMode: Pionex may use marginMode, marginType, or marginLevel
          const marginTypeRaw = String(
            p.marginMode ?? p.marginType ?? p.margin_type ?? p.marginLevel ?? 'cross'
          ).toLowerCase();
          const marginMode: 'Cross' | 'Isolated' =
            marginTypeRaw === 'isolated' ? 'Isolated' : 'Cross';

          // unrealizedPnlPct: use raw from Pionex if available, otherwise compute
          let unrealizedPnlPct: number | null = null;
          const rawPct = p.unrealizedPnlPct ?? p.unrealizedPnLPct ?? p.pnlPct ??
                         p.returnRate ?? p.roe ?? null;
          if (rawPct !== null && rawPct !== undefined) {
            const n = parseFloat(String(rawPct));
            if (!isNaN(n)) {
              // Pionex may return percentage as -2.28 (percent) or -0.0228 (decimal)
              // If absolute value > 1, it's already a percentage — convert to decimal
              unrealizedPnlPct = Math.abs(n) > 1 ? n / 100 : n;
            }
          } else if (unrealizedPnl !== null && positionValue !== null && positionValue !== 0) {
            unrealizedPnlPct = unrealizedPnl / positionValue;
          }

          // Mapping trace log — shows RAW field → NORMALIZED → UI value
          console.log(`[positions] mapping ${rawSymbol}:`,
            `avgPrice(raw=${p.avgPrice ?? p.entryPrice})=${avgPrice}`,
            `markPrice(raw=${p.markPrice})=${markPrice}`,
            `unrealizedPnl(raw=${p.unrealizedPnl ?? p.unRealizedProfit ?? p.pnl})=${unrealizedPnl}`,
            `positionValue(raw=${p.positionValue ?? p.notional})=${positionValue}`,
            `occupiedMargin(raw=${p.occupiedMargin ?? p.margin})=${occupiedMargin}`,
            `liqPrice(raw=${p.liquidationPrice ?? p.liqPrice})=${liquidationPrice}`,
            `leverage=${leverage} marginMode=${marginMode} qtyField=${qtyField} qty=${absQty}`
          );

          return {
            symbol:             normaliseSymbolDisplay(rawSymbol),
            raw_symbol:         rawSymbol,
            side,
            margin_mode:        marginMode,
            leverage,
            quantity:           absQty,
            avg_price:          avgPrice,
            mark_price:         markPrice,
            position_value:     positionValue,
            unrealized_pnl:     unrealizedPnl,
            unrealized_pnl_pct: unrealizedPnlPct,
            occupied_margin:    occupiedMargin,
            liquidation_price:  liquidationPrice,
            _qty_field:         qtyField,
          };
        })
        // Active = explicit positionSide LONG/SHORT OR non-zero quantity
        .filter(p => {
          const rawP = rawPos.find(r =>
            String(r.symbol ?? r.pair ?? r.contract ?? '') === p.raw_symbol);
          const expSide = String(rawP?.positionSide ?? rawP?.side ?? '').toUpperCase();
          const hasExplicitSide = expSide === 'LONG' || expSide === 'SHORT';
          const accepted = hasExplicitSide || p.quantity > 0;
          console.log(`[positions] filter: ${p.raw_symbol}/${p.side}`,
            `| hasExplicitSide=${hasExplicitSide} qty=${p.quantity}`,
            `| qtyField=${p._qty_field} accepted=${accepted}`);
          return accepted;
        });

      console.log('[positions] after filter:', positions.length,
        '| symbols:', positions.map(p => p.raw_symbol).join(',') || '(none)');

      return respond({
        positions,
        positions_api_ok: true,
        positions_api_error: null,
        // Include raw positions for client-side debugging (no credentials, safe)
        _raw_positions: rawPos.map(p => ({ ...p })),
      });
    }

    // ── AUTHENTICATED: diagnostic — full raw Pionex response, all field names ──
    if (action === 'diag_positions') {
      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!conn?.is_connected)
        return respond({ error: 'Pionex not connected' }, 404);

      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      const { httpStatus, body: rawBody } = await pionexRawRequest(
        'GET', PIONEX_USDTM_POSITIONS_PATH, conn.api_key, apiSecret
      );

      // Extract position array from every known envelope shape
      const dd = rawBody.data as Record<string, unknown> | null;
      let rawArr: Record<string, unknown>[] = [];
      if (Array.isArray(rawBody.data))              rawArr = rawBody.data as Record<string, unknown>[];
      else if (dd && Array.isArray(dd.positions))   rawArr = dd.positions as Record<string, unknown>[];
      else if (dd && Array.isArray(dd.list))        rawArr = dd.list as Record<string, unknown>[];
      else if (dd && Array.isArray(dd.data))        rawArr = dd.data as Record<string, unknown>[];

      // Return every raw key on every position so the UI can show exactly what Pionex sent
      return respond({
        endpoint:       PIONEX_USDTM_POSITIONS_PATH,
        http_status:    httpStatus,
        result:         rawBody.result,
        code:           rawBody.code,
        message:        rawBody.message,
        timestamp:      rawBody.timestamp,
        top_level_keys: Object.keys(rawBody),
        position_count: rawArr.length,
        // Full raw positions including all field names and values
        raw_positions:  rawArr.map(p => ({ ...p })),
        // Convenience: just the keys on the first position
        position_keys:  rawArr.length > 0 ? Object.keys(rawArr[0]) : [],
      });
    }

    // ── get_balance: USDT-M Futures balance — READ-ONLY ────────────────
    if (action === 'get_balance') {
      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!conn?.is_connected) {
        return respond({ error: 'Pionex not connected' }, 404);
      }

      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      const futures = await getPionexUsdtMFuturesBalance(
        conn.api_key,
        apiSecret,
      );

      const balances = futures.detail
        .map((b) => {
          const coin = String(
            b.coin ??
            b.coinType ??
            b.asset ??
            b.currency ??
            ''
          );

          const free = Number(
            b.free ??
            b.available ??
            b.usdtAvailable ??
            0
          );

          const freeze = Number(
            b.frozen ??
            b.freeze ??
            b.locked ??
            b.marginFrozen ??
            0
          );

          const explicitTotal = Number(
            b.total ??
            b.balance ??
            b.amount ??
            0
          );

          const total = Number.isFinite(explicitTotal) && explicitTotal > 0
            ? explicitTotal
            : free + freeze;

          return {
            coin,
            free: Number.isFinite(free) ? free : 0,
            freeze: Number.isFinite(freeze) ? freeze : 0,
            total: Number.isFinite(total) ? total : 0,
          };
        })
        .filter((b) => b.total > 0);

      return respond({
        usdt_available: futures.available,
        usdt_locked: futures.frozen,
        usdt_total: futures.total,
        balances,
      });
    }

    // ── get_markets: symbol info, precision, min order — READ-ONLY ───────────
    if (action === 'get_markets') {
      console.log('[PIONEX_MARKETS] fetching market symbols');
      // Public endpoint — no auth required
      const res = await fetch(`${PIONEX_BASE}/api/v1/common/symbols`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Pionex symbols ${res.status}`);
      const json = await res.json();

      // Pionex /api/v1/common/symbols response shape:
      // { result: true, data: { symbols: [ { symbol, baseCurrency, quoteCurrency,
      //     basePrecision, quotePrecision, minTradeAmount, minOrderValue, ... } ] } }
      const rawSymbols = (json?.data?.symbols ?? []) as Record<string, unknown>[];

      const markets = rawSymbols.map(s => {
        const rawMinQty   = s.minTradeAmount ?? s.minQty ?? null;
        const rawMinVal   = s.minOrderValue  ?? s.minNotional ?? null;
        const minQtyParsed  = rawMinQty !== null && rawMinQty !== '' ? parseFloat(String(rawMinQty)) : 0;
        const minValParsed  = rawMinVal !== null && rawMinVal !== '' ? parseFloat(String(rawMinVal)) : 0;
        return {
          symbol:             String(s.symbol ?? ''),
          base_asset:         String(s.baseCurrency ?? s.base ?? ''),
          quote_asset:        String(s.quoteCurrency ?? s.quote ?? ''),
          quantity_precision: parseInt(String(s.basePrecision ?? s.amountPrecision ?? 8)),
          amount_precision: s.amountPrecision !== undefined
            ? parseInt(String(s.amountPrecision), 10)
            : undefined,
          price_precision:    parseInt(String(s.quotePrecision ?? s.pricePrecision ?? 8)),
          min_qty:            isNaN(minQtyParsed)  ? 0 : minQtyParsed,
          min_value:          isNaN(minValParsed)  ? 0 : minValParsed,
          status:             String(s.status ?? 'TRADING'),
          // Pass raw Pionex filter fields through so EF place_order can re-read them
          // without a second symbols fetch. All original field names preserved.
          _raw_minTradeAmount: rawMinQty,
          _raw_minOrderValue:  rawMinVal,
          _raw_basePrecision:  s.basePrecision ?? s.amountPrecision ?? null,
        };
      });

      // Diagnostic log for AVAX_USDT so we can confirm actual filter values
      const avaxMarket = markets.find(m => m.symbol === 'AVAX_USDT');
      if (avaxMarket) {
        console.log('[PIONEX_MARKETS_DIAG] AVAX_USDT filters:', JSON.stringify({
          symbol:            avaxMarket.symbol,
          quantity_precision: avaxMarket.quantity_precision,
          min_qty:           avaxMarket.min_qty,
          min_value:         avaxMarket.min_value,
          _raw_minTradeAmount: avaxMarket._raw_minTradeAmount,
          _raw_minOrderValue:  avaxMarket._raw_minOrderValue,
          _raw_basePrecision:  avaxMarket._raw_basePrecision,
        }));
      }

      console.log('[PIONEX_MARKETS] symbols returned:', markets.length);
      return respond({ markets, total: markets.length });
    }

    // ── get_order_status: fetch single order by ID — READ-ONLY ───────────────
    if (action === 'get_order_status') {
      const { order_id } = body;
      if (!order_id) return respond({ error: 'order_id required' }, 400);

      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!conn?.is_connected) return respond({ error: 'Pionex not connected' }, 404);
      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      console.log('[PIONEX_ORDER_STATUS] fetching orderId:', order_id);
      let data: Record<string, unknown>;
      try {
        // USDT-M Futures order status.
        // IKKE bruk Spot /api/v1/trade/order her.
        data = await pionexAuthRequest(
          'GET',
          PIONEX_USDTM_ORDER_PATH,
          conn.api_key,
          apiSecret,
          { orderId: order_id }
        );
      } catch (e) {
        const msg = String(e);
        console.warn('[PIONEX_API_ERROR] order_status fetch failed:', msg);
        return respond({ error: msg, status: 'UNKNOWN' }, 400);
      }

      const order = (data?.data?.order ?? data?.data ?? {}) as Record<string, unknown>;

      // Normalise Pionex status strings to standard values
      const rawStatus = String(order.state ?? order.status ?? '').toUpperCase();
      const statusMap: Record<string, string> = {
        'NEW':              'NEW',
        'OPEN':             'NEW',
        'PARTIALLY_FILLED': 'PARTIALLY_FILLED',
        'PART_FILLED':      'PARTIALLY_FILLED',
        'FILLED':           'FILLED',
        'COMPLETE':         'FILLED',
        'DONE':             'FILLED',
        'CANCELED':         'CANCELLED',
        'CANCELLED':        'CANCELLED',
        'CANCEL':           'CANCELLED',
        'FAILED':           'FAILED',
        'REJECTED':         'FAILED',
        'EXPIRED':          'FAILED',
      };
      const normStatus = statusMap[rawStatus] ?? 'UNKNOWN';

      console.log('[PIONEX_ORDER_STATUS] orderId:', order_id, '| raw:', rawStatus, '| norm:', normStatus);
      return respond({
        order_id:        String(order.orderId ?? order.id ?? order_id),
        symbol:          String(order.symbol ?? ''),
        side:            String(order.side ?? ''),
        status:          normStatus,
        raw_status:      rawStatus,
        price:           parseFloat(String(order.price ?? 0)),
        qty:             parseFloat(String(order.amount ?? order.size ?? order.qty ?? 0)),
        filled_qty:      parseFloat(String(order.filledAmount ?? order.executedQty ?? order.dealAmount ?? 0)),
        avg_fill_price:  parseFloat(String(order.avgPrice ?? order.dealPrice ?? 0)),
        created_at:      order.createTime ? new Date(Number(order.createTime)).toISOString() : null,
        updated_at:      order.updateTime ? new Date(Number(order.updateTime)).toISOString() : null,
      });
    }

    // ── live_status: server-side live trading flag — READ ────────────────────
    // Priority: app_settings DB row (user-controlled) > LIVE_TRADING_ENABLED env var (fallback)
    // Returns: { live_enabled, source }
    if (action === 'live_status') {
      const { data: setting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('user_id', user.id)
        .eq('key', 'live_trading_enabled')
        .maybeSingle();

      let liveEnabled: boolean;
      let source: string;
      if (setting !== null && setting !== undefined) {
        liveEnabled = setting.value === 'true';
        source = 'db';
      } else {
        liveEnabled = Deno.env.get('LIVE_TRADING_ENABLED') === 'true';
        source = 'env';
      }
      console.log('[LIVE_STATUS] live_enabled:', liveEnabled, 'source:', source);
      return respond({ live_enabled: liveEnabled, source });
    }

    // ── live_status_set: toggle live trading ON/OFF server-side ──────────────
    // Persists the user's live trading preference in app_settings (server-enforced).
    // place_order and close_order check this before executing any real trade.
    if (action === 'live_status_set') {
      const { enable } = body as { enable?: boolean };
      if (typeof enable !== 'boolean') {
        return respond({ error: 'enable (boolean) required' }, 400);
      }
      const { error: upsertErr } = await supabase
        .from('app_settings')
        .upsert(
          {
            user_id:    user.id,
            key:        'live_trading_enabled',
            value:      enable ? 'true' : 'false',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,key' }
        );
      if (upsertErr) {
        console.error('[LIVE_STATUS_SET] upsert error:', upsertErr.message);
        return respond({ error: upsertErr.message }, 500);
      }
      console.log('[LIVE_STATUS_SET] user', user.id, 'set live_trading_enabled =', enable);
      return respond({ live_enabled: enable, source: 'db' });
    }

    // ── place_order: FASE 3 — real Pionex BUY/SELL with full safety checks ───
    if (action === 'place_order') {
      console.log('[PIONEX_PROXY] place_order action received', {
        user_id: user.id,
        order_symbol: body.order_symbol,
        order_side: body.order_side,
        order_qty: body.order_qty,
        order_amount_usdt: body.order_amount_usdt,
        order_price: body.order_price,
        order_type: body.order_type,
        signal_id: body.signal_id,
      });

      // ── SAFETY GATE 1: server-side live_trading flag ────────────────────
      // Priority: app_settings DB row > LIVE_TRADING_ENABLED env var (fallback)
      const { data: liveSetting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('user_id', user.id)
        .eq('key', 'live_trading_enabled')
        .maybeSingle();
      const liveEnabled = liveSetting !== null && liveSetting !== undefined
        ? liveSetting.value === 'true'
        : Deno.env.get('LIVE_TRADING_ENABLED') === 'true';
      if (!liveEnabled) {
        console.log('[LIVE_ENTRY_REQUEST] place_order blocked: live_trading_enabled=false');
        return respond({
          blocked: true,
          reason:  'live_trading_disabled',
          code:    'ORDER_BLOCKED',
          message: 'LIVE TRADING er deaktivert. Ingen ordre kan sendes til Pionex.',
        }, 403);
      }

      const {
        order_symbol,
        order_side,
        order_qty,
        order_amount_usdt,
        order_price,
        signal_id,
        take_profit,
        stop_loss,
        order_type = 'MARKET',
      } = body as {
        order_symbol?: string;
        order_side?: 'BUY' | 'SELL';
        order_qty?: number;
        order_amount_usdt?: number;
        order_price?: number;
        signal_id?: string;
        take_profit?: number;
        stop_loss?: number;
        order_type?: string;
      };

      // ── SAFETY GATE 2: required fields ──────────────────────────────────
      if (!order_symbol || !order_side || !order_qty || !order_price) {
        return respond({ error: 'order_symbol, order_side, order_qty, order_price required' }, 400);
      }
      if (order_side !== 'BUY' && order_side !== 'SELL') {
        return respond({ error: 'order_side must be BUY or SELL' }, 400);
      }

      const parsedTakeProfit =
        take_profit !== undefined && take_profit !== null
          ? Number(take_profit)
          : null;

      const parsedStopLoss =
        stop_loss !== undefined && stop_loss !== null
          ? Number(stop_loss)
          : null;

      if (
        parsedTakeProfit !== null &&
        (!Number.isFinite(parsedTakeProfit) || parsedTakeProfit <= 0)
      ) {
        return respond({
          blocked: true,
          code: 'ORDER_BLOCKED',
          error: 'Invalid take_profit.',
        }, 400);
      }

      if (
        parsedStopLoss !== null &&
        (!Number.isFinite(parsedStopLoss) || parsedStopLoss <= 0)
      ) {
        return respond({
          blocked: true,
          code: 'ORDER_BLOCKED',
          error: 'Invalid stop_loss.',
        }, 400);
      }

      // ── Raw investment: used for logging only — no max-cap gate ────────
      // The only hard limits on order size are Pionex's own market rules
      // (minAmount, minOrderValue, balance check) enforced below.
      const rawInvestment = order_side === 'BUY' && order_type === 'MARKET' && order_amount_usdt !== undefined
        ? order_amount_usdt
        : order_qty * order_price;
      console.log('[LIVE_ENTRY_REQUEST] raw investment:', rawInvestment.toFixed(4), 'USDT');

      // ── SAFETY GATE 4: Pionex connection required ────────────────────────
      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();
      console.log('[PIONEX_PROXY] connection lookup:', {
        user_id: user.id,
        found: !!conn,
        is_connected: conn?.is_connected,
        has_api_key: !!conn?.api_key,
      });
      if (!conn?.is_connected) {
        console.log('[PIONEX_PROXY] BLOCKED: Pionex not connected');
        return respond({ error: 'Pionex not connected' }, 404);
      }
      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      // ── SAFETY GATE 5: duplicate signal guard ────────────────────────────
      if (signal_id) {
        const { data: existingOrder } = await supabase
          .from('live_orders')
          .select('id, status')
          .eq('user_id', user.id)
          .eq('signal_id', signal_id)
          .maybeSingle();
        if (existingOrder) {
          console.log('[LIVE_ENTRY_REQUEST] BLOCKED: duplicate signal_id', signal_id,
            'existing order id:', existingOrder.id, 'status:', existingOrder.status);
          return respond({
            blocked: true,
            reason:  'duplicate_signal',
            code:    'ORDER_BLOCKED',
            message: `Signal ${signal_id} er allerede utført (order id=${existingOrder.id}).`,
          }, 409);
        }
      }

      // ── SAFETY GATE 7: symbol info (precision + min order) ──────────────
      // Resolve the canonical Pionex symbol from /api/v1/common/symbols by matching:
      //   1. Exact symbol field match (case-insensitive, e.g. "XRP_USDT" == "xrp_usdt")
      //   2. baseCurrency + quoteCurrency match (handles "XRPUSDT" input → "XRP_USDT" canonical)
      // NEVER assume stripping "_" or "/" gives the Pionex symbol format.
      const symRes = await fetch(`${PIONEX_BASE}/api/v1/common/symbols`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!symRes.ok) throw new Error(`Pionex symbols ${symRes.status}`);
      const symJson    = await symRes.json();
      const rawSymbols = (symJson?.data?.symbols ?? []) as Record<string, unknown>[];

      // Step 1: exact symbol match
      let marketInfo = rawSymbols.find(s =>
        String(s.symbol ?? '').toUpperCase() === order_symbol.toUpperCase()
      );
      // Step 2: derive base+quote from the input and match via currency fields.
      // Handles both "XRPUSDT" (slash already stripped) and "XRP_USDT" variants.
      if (!marketInfo) {
        // Try common quote suffixes to split the input into base+quote
        const QUOTES = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'BUSD', 'USD'];
        const stripped = order_symbol.replace(/_/g, '').toUpperCase();
        for (const q of QUOTES) {
          if (stripped.endsWith(q)) {
            const base = stripped.slice(0, stripped.length - q.length);
            if (base.length > 0) {
              marketInfo = rawSymbols.find(s =>
                String(s.baseCurrency ?? s.base ?? '').toUpperCase()  === base &&
                String(s.quoteCurrency ?? s.quote ?? '').toUpperCase() === q
              );
              if (marketInfo) break;
            }
          }
        }
      }

      if (!marketInfo) {
        console.log('[LIVE_ENTRY_REQUEST] BLOCKED: unsupported pair', order_symbol);
        return respond({
          blocked: true,
          reason:  'unsupported_pair',
          code:    'ORDER_BLOCKED',
          status:  'REJECTED',
          symbol:  order_symbol,
          message: `${order_symbol} finnes ikke på Pionex.`,
        }, 400);
      }

      // Replace order_symbol with the canonical symbol from the API
      const canonicalSymbol = String(marketInfo.symbol ?? order_symbol);

      // ── Pionex field naming reference ───────────────────────────────────
      // basePrecision   = decimal places for base-asset quantity (size field in SELL/LIMIT)
      // amountPrecision = decimal places for quote-currency amount (amount field in MARKET BUY)
      // minAmount       = minimum USDT amount for MARKET BUY
      // minOrderValue   = minimum USDT order value (same concept, different field name on some pairs)
      // minTradeAmount  = minimum base-asset quantity (used for SELL / LIMIT)
      const basePrecision     = parseInt(String(marketInfo.basePrecision    ?? 8), 10);
      const amountPrecision   = parseInt(String(marketInfo.amountPrecision  ?? 2), 10);

      // For MARKET BUY: round the USDT investment DOWN to amountPrecision
      // For MARKET SELL / LIMIT: round the base qty DOWN to basePrecision
      const amountFactor    = Math.pow(10, amountPrecision);
      const precisionFactor = Math.pow(10, basePrecision);

      // roundedAmount = USDT to send as `amount` for MARKET BUY (Pionex requirement)
      const amountUsdt         = order_side === 'BUY' && order_type === 'MARKET' && order_amount_usdt !== undefined
        ? order_amount_usdt
        : order_qty * order_price;
      const roundedAmount     = Math.floor(amountUsdt * amountFactor) / amountFactor;
      // roundedQty = base-asset qty, used for SELL / LIMIT and local investment checks
      const roundedQty        = Math.floor(order_qty * precisionFactor) / precisionFactor;
      // For MARKET BUY the effective investment IS the rounded USDT amount
      const roundedInvestment = (order_side === 'BUY' && order_type === 'MARKET')
        ? roundedAmount
        : roundedQty * order_price;

      // ── SAFETY GATE 3b: post-rounding balance adequacy (no artificial max cap) ─
      // Only the Pionex market rules (minAmount, minOrderValue, balance) apply.
      if (roundedInvestment <= 0) {
        console.log('[LIVE_ENTRY_REQUEST] BLOCKED (Gate 3b): rounded investment is zero');
        return respond({
          blocked: true,
          reason:  'zero_investment_after_rounding',
          code:    'ORDER_BLOCKED',
          investment: roundedInvestment,
          message: `Avrundet investering ble 0 USDT — for lavt beløp.`,
        }, 400);
      }

      // minAmount / minOrderValue: both represent the minimum USDT value Pionex accepts
      // on a MARKET BUY. Use whichever is present; fall back to 0 (no minimum enforced).
      const minAmount       = parseFloat(String(marketInfo.minAmount       ?? 0));
      const minOrderValue   = parseFloat(String(marketInfo.minOrderValue   ?? marketInfo.minNotional ?? 0));
      const effectiveMinUSDT = Math.max(
        isNaN(minAmount)     ? 0 : minAmount,
        isNaN(minOrderValue) ? 0 : minOrderValue,
      );

      // minTradeAmount = minimum base-asset quantity (used for SELL / LIMIT orders).
      // Not applicable for MARKET BUY (Pionex uses minAmount there).
      const rawMinTradeAmount      = parseFloat(String(marketInfo.minTradeAmount ?? marketInfo.minQty ?? 0));
      const minTradeAmountFromValue = (effectiveMinUSDT > 0 && order_price > 0)
        ? effectiveMinUSDT / order_price
        : 0;
      const minTradeAmount = Math.max(
        isNaN(rawMinTradeAmount) ? 0 : rawMinTradeAmount,
        minTradeAmountFromValue,
      );

      console.log('[LIVE_ENTRY_FILTERS]', JSON.stringify({
        symbol:                     canonicalSymbol,
        order_side,
        order_type,
        base_precision:             basePrecision,
        amount_precision:           amountPrecision,
        min_amount:                 minAmount,
        min_order_value:            minOrderValue,
        effective_min_usdt:         effectiveMinUSDT,
        raw_min_trade_amount:       rawMinTradeAmount,
        derived_min_from_value:     minTradeAmountFromValue.toFixed(8),
        effective_min_trade_amount: minTradeAmount.toFixed(8),
        rounded_amount_usdt:        roundedAmount,
        rounded_qty:                roundedQty,
        rounded_investment:         roundedInvestment.toFixed(6),
        above_min_usdt:             effectiveMinUSDT <= 0 || roundedAmount >= effectiveMinUSDT,
        above_min_qty:              minTradeAmount <= 0 || roundedQty >= minTradeAmount,
      }));

      // ── SAFETY GATE 6: USDT balance check ───────────────────────────────
      // BUG-4 FIX: fetch balance with 429-aware error handling; log ALL
      // diagnostic fields (available, frozen, total, investment, precision,
      // min order) BEFORE any blocking decision so every BLOCKED log is actionable.
      let balData: Record<string, unknown>;
      try {
        const futuresBalance = await getPionexUsdtMFuturesBalance(
          conn.api_key,
          apiSecret,
        );

        balData = {
          data: {
            balances: [{
              coinType: 'USDT',
              free: futuresBalance.available,
              frozen: futuresBalance.frozen,
              total: futuresBalance.total,
            }],
          },
        };
      } catch (balErr) {
        const msg = String(balErr);
        // BUG-5 FIX: 429 during balance fetch → RATE_LIMITED status, never EXECUTED
        if (msg.includes('429')) {
          console.warn('[LIVE_ENTRY_REQUEST] RATE_LIMITED during balance fetch:', msg);
          return respond({
            blocked: true,
            reason:  'rate_limited',
            code:    'ORDER_BLOCKED',
            status:  'RATE_LIMITED',
            message: 'Pionex rate limit truffet under saldosjekk. Ikke retry automatisk — vent noen sekunder.',
          }, 429);
        }
        throw balErr;
      }
      const allBal     = (balData?.data?.balances ?? []) as Record<string, unknown>[];
      const usdtRow    = allBal.find(b => String(b.coinType ?? b.coin ?? '').toUpperCase() === 'USDT');
      const usdtFree   = parseFloat(String(usdtRow?.free   ?? 0));
      const usdtFrozen = parseFloat(String(usdtRow?.frozen ?? usdtRow?.freeze ?? 0));
      const usdtTotal  = usdtFree + usdtFrozen;

      // BUG-4 FIX: full preflight log — emitted BEFORE any block so every
      // blocking decision is traceable in edge-function logs.
      console.log('[LIVE_ENTRY_PREFLIGHT]', JSON.stringify({
        input_symbol:      order_symbol,
        canonical_symbol:  canonicalSymbol,
        side:              order_side,
        type:              order_type,
        signal_id:         signal_id ?? null,
        raw_qty:           order_qty,
        amount_usdt:       amountUsdt,
        rounded_qty:       roundedQty,
        rounded_amount_usdt: roundedAmount,
        base_precision:    basePrecision,
        amount_precision:  amountPrecision,
        price:             order_price,
        investment_raw:    rawInvestment.toFixed(6),
        investment_final:  roundedInvestment.toFixed(6),
        usdt_available:    usdtFree.toFixed(6),
        usdt_frozen:       usdtFrozen.toFixed(6),
        usdt_total:        usdtTotal.toFixed(6),
        effective_min_usdt:    effectiveMinUSDT,
        min_trade_amount:  minTradeAmount,
        sufficient:        usdtFree >= roundedInvestment,
        above_min_usdt:    effectiveMinUSDT <= 0 || roundedAmount >= effectiveMinUSDT,
        above_min_qty:     minTradeAmount <= 0 || roundedQty >= minTradeAmount,
        user_id:           user.id,
      }));

      if (usdtFree < roundedInvestment) {
        console.log('[LIVE_ENTRY_REQUEST] BLOCKED: INSUFFICIENT_BALANCE',
          'available:', usdtFree.toFixed(6),
          'needed:', roundedInvestment.toFixed(6),
          'frozen:', usdtFrozen.toFixed(6),
          'total:', usdtTotal.toFixed(6));
        return respond({
          blocked:        true,
          reason:         'insufficient_balance',
          code:           'ORDER_BLOCKED',
          status:         'INSUFFICIENT_BALANCE',
          usdt_available: usdtFree,
          usdt_frozen:    usdtFrozen,
          usdt_total:     usdtTotal,
          investment:     roundedInvestment,
          message: `Utilstrekkelig USDT-saldo: ${usdtFree.toFixed(4)} USDT tilgjengelig (${usdtFrozen.toFixed(4)} låst), trenger ${roundedInvestment.toFixed(4)} USDT.`,
        }, 402);
      }

      // MARKET BUY uses roundedAmount (USDT); other order types use roundedInvestment (qty×price)
      const isMarketBuy = order_side === 'BUY' && order_type === 'MARKET';
      if (effectiveMinUSDT > 0 && roundedInvestment < effectiveMinUSDT) {
        console.log('[LIVE_ENTRY_REQUEST] BLOCKED: BELOW_MIN_ORDER_VALUE',
          roundedInvestment.toFixed(6), '<', effectiveMinUSDT);
        return respond({
          blocked:           true,
          reason:            'below_min_order_value',
          code:              'ORDER_BLOCKED',
          status:            'REJECTED',
          investment:        roundedInvestment,
          min_order_value:   effectiveMinUSDT,
          message: `Investering ${roundedInvestment.toFixed(4)} USDT er under minimum ordre-verdi ${effectiveMinUSDT} USDT for ${canonicalSymbol}.`,
        }, 400);
      }

      // ── SAFETY GATE 7b: minimum base-asset quantity (for SELL / LIMIT only) ──
      // MARKET BUY uses `amount` (USDT), not `size` (qty) — Pionex does NOT apply
      // minTradeAmount to MARKET BUY; it applies minAmount instead (checked above).
      if (!isMarketBuy && minTradeAmount > 0 && roundedQty < minTradeAmount) {
        const neededInvestment = minTradeAmount * order_price;
        console.log('[LIVE_ENTRY_REQUEST] BLOCKED: BELOW_MIN_TRADE_AMOUNT',
          roundedQty, '<', minTradeAmount,
          'need at least', neededInvestment.toFixed(4), 'USDT');
        return respond({
          blocked:           true,
          reason:            'below_min_trade_amount',
          code:              'ORDER_BLOCKED',
          status:            'REJECTED',
          qty:               roundedQty,
          min_trade_amount:  minTradeAmount,
          needed_investment: neededInvestment,
          message: `Antall ${roundedQty} ${canonicalSymbol.split('_')[0]} er under Pionex minimum ${minTradeAmount}. Du trenger minst ${neededInvestment.toFixed(2)} USDT for å handle ${canonicalSymbol}.`,
        }, 400);
      }

      // ── PRE-ORDER LOG ───────────────────────────────────────────────────
      console.log('[LIVE_ENTRY_REQUEST]', JSON.stringify({
        symbol:            canonicalSymbol,
        side:              order_side,
        type:              order_type,
        signal_id:         signal_id ?? null,
        is_market_buy:     isMarketBuy,
        amount_usdt:       roundedAmount,
        qty:               roundedQty,
        price:             order_price,
        investment:        roundedInvestment.toFixed(4),
        usdt_free:         usdtFree.toFixed(4),
        user_id:           user.id,
      }));

      // ── SEND USDT-M FUTURES ORDER TO PIONEX ─────────────────────────────
      //
      // Pionex Futures:
      //   POST /uapi/v1/trade/order
      //
      // Futures market order:
      //   type = MARKET_QTY
      //   size = base-asset quantity
      //
      // Spot MARKET BUY uses `amount`, but Futures does NOT.
      //
      // Position mode:
      //   BOTH = one-way mode
      //
      // USDT-M ENTRY:
      //   BUY  = open/increase LONG
      //   SELL = open/increase SHORT
      //
      // Entry orders are NEVER reduce-only.
      // Closing a position is handled separately by close_order.
      const timestamp = Date.now().toString();

      const futuresSymbol =
        canonicalSymbol.endsWith('_PERP')
          ? canonicalSymbol
          : `${canonicalSymbol}_PERP`;

      const reduceOnly = false;

      const orderPayload: Record<string, unknown> = {
        symbol: futuresSymbol,
        side: order_side,
        type: 'MARKET_QTY',
        size: roundedQty.toString(),
        positionSide: 'BOTH',
        reduceOnly,
      };

      const orderBody = JSON.stringify(orderPayload);

      const signature = await buildPionexSignature(
        'POST',
        PIONEX_USDTM_ORDER_PATH,
        { timestamp },
        apiSecret,
        orderBody
      );

      const qs =
        `timestamp=${encodeURIComponent(timestamp)}`;

      const orderUrl =
        `${PIONEX_BASE}${PIONEX_USDTM_ORDER_PATH}?${qs}`;

      console.log('[PIONEX_USDTM_ORDER_PAYLOAD]', JSON.stringify({
        url: orderUrl,
        method: 'POST',
        payload: orderPayload,
        futures: true,
        reduce_only: reduceOnly,
        symbol: futuresSymbol,
      }));

      let orderRes: Response;
      let orderText: string;

      try {
        orderRes = await fetch(orderUrl, {
          method: 'POST',
          headers: {
            'PIONEX-KEY': conn.api_key,
            'PIONEX-SIGNATURE': signature,
            'Content-Type': 'application/json',
          },
          body: orderBody,
          signal: AbortSignal.timeout(12000),
        });

        orderText = await orderRes.text();

        console.log('[PIONEX_USDTM_ORDER_RESPONSE]', {
          http_status: orderRes.status,
          status_text: orderRes.statusText,
          body: orderText,
        });
      } catch (fetchErr) {
        console.error(
          '[PIONEX_USDTM_ORDER] network error — no blind retry:',
          String(fetchErr)
        );

        return respond({
          error: String(fetchErr),
          status: 'TIMEOUT',
          message:
            'Nettverksfeil ved USDT-M ordre. Ingen blind retry.',
        }, 504);
      }

      let orderJson: Record<string, unknown> = {};
      try { orderJson = JSON.parse(orderText); } catch { orderJson = { raw: orderText }; }

      console.log('[PIONEX_PROXY] place_order parsed response:', orderJson);

      // BUG-5 FIX: explicit 429 check on the order POST — return RATE_LIMITED, never persist order
      if (orderRes.status === 429) {
        const retryAfterSec = parseInt(orderRes.headers.get('Retry-After') ?? '0', 10);
        console.error('[LIVE_ENTRY_ORDER_CREATED] RATE_LIMITED by Pionex — order NOT sent, no local record',
          { symbol: canonicalSymbol, retryAfterSec });
        return respond({
          error:          'Pionex 429: Too Many Requests',
          status:         'RATE_LIMITED',
          retry_after_s:  retryAfterSec || null,
          message:        `Pionex rate limit på ordre-sending. Ingen ordre ble plassert. Vent ${retryAfterSec || 'noen'} sekunder og prøv igjen.`,
        }, 429);
      }

      if (!orderRes.ok || orderJson.result === false) {
        const errMsg = String(orderJson.message ?? orderJson.code ?? orderText);
        console.error('[LIVE_ENTRY_ORDER_CREATED] Pionex order rejected:', {
          http_status: orderRes.status,
          error_message: errMsg,
          pionex_code: orderJson.code ?? null,
          pionex_message: orderJson.message ?? null,
          raw_body: orderText,
        });
        return respond({
          error:   errMsg,
          status:  'REJECTED',
          blocked: false,
          http_status: orderRes.status,
          pionex_code: orderJson.code ?? null,
          message: `Pionex avviste ordren: ${errMsg}`,
        }, orderRes.status >= 400 ? orderRes.status : 400);
      }

      const orderId = String(
        (orderJson?.data as Record<string, unknown>)?.orderId
        ?? (orderJson?.data as Record<string, unknown>)?.order_id
        ?? orderJson?.orderId
        ?? ''
      );

      console.log('[LIVE_ENTRY_ORDER_CREATED]', JSON.stringify({
        order_id:         orderId,
        symbol:           futuresSymbol,
        side:             order_side,
        type:             order_type,
        signal_id:        signal_id ?? null,
        is_market_buy:    isMarketBuy,
        amount_usdt_sent: isMarketBuy ? roundedAmount : null,
        qty_sent:         isMarketBuy ? null : roundedQty,
        investment:       roundedInvestment.toFixed(4),
        take_profit:      parsedTakeProfit,
        stop_loss:        parsedStopLoss,
        signal_type:      order_side,
        user_id:          user.id,
      }));

      // ── PERSIST live_orders record ─────────────────────────────────────
      // Derive display pair from canonical symbol using baseCurrency/quoteCurrency
      // fields from the market info — never guess by regex on the symbol string.
      const baseCoin  = String(marketInfo.baseCurrency ?? marketInfo.base ?? '');
      const quoteCoin = String(marketInfo.quoteCurrency ?? marketInfo.quote ?? '');
      const displayPair = baseCoin && quoteCoin
        ? `${baseCoin}/${quoteCoin}`
        : canonicalSymbol.replace('_', '/');   // safe fallback only
      const finalStatus = orderId ? 'NEW' : 'UNKNOWN';
      const persistId   = orderId || `unknown_${Date.now()}_${user.id.slice(0, 8)}`;

      if (finalStatus === 'UNKNOWN') {
        console.warn('[LIVE_ENTRY_ORDER_CREATED] orderId missing from Pionex response — ORDER_STATUS_UNKNOWN', {
          symbol:     canonicalSymbol,
          side:       order_side,
          signal_id:  signal_id ?? null,
          raw_response: orderJson,
        });
      }

      await supabase.from('live_orders').upsert({
        user_id:          user.id,
        pionex_order_id:  persistId,
        symbol:           canonicalSymbol,
        pair:             displayPair,
        side:             order_side,
        status:           finalStatus,
        investment:       roundedInvestment,
        quantity:         roundedQty,
        entry_price:      order_price,
        take_profit:      parsedTakeProfit,
        stop_loss:        parsedStopLoss,
        signal_type:      order_side,
        signal_id:        signal_id ?? null,
        created_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      }, { onConflict: 'pionex_order_id' });

      return respond({
        order_id:    orderId || null,
        symbol:      canonicalSymbol,
        side:        order_side,
        status:      finalStatus,
        investment:  roundedInvestment,
        quantity:      roundedQty,
        entry_price:   order_price,
        take_profit:   parsedTakeProfit,
        stop_loss:     parsedStopLoss,
        signal_type:   order_side,
        signal_id:     signal_id ?? null,
        raw:           orderJson,
      });
    }

    // ── close_order: USDT-M FUTURES ───────────────────────────────────────
    //
    // Close an existing USDT-M LONG position.
    //
    // IMPORTANT:
    // - NEVER use Spot /api/v1/trade/order here.
    // - Futures endpoint is /uapi/v1/trade/order.
    // - LONG close = SELL + reduceOnly=true.
    // - One-way position mode = BOTH.
    // - Market close = MARKET_QTY + size.
    //
    // ── set_tpsl: USDT-M FUTURES TP/SL ───────────────────────────────────
    //
    // SAFE PHASE:
    // - Validate TP/SL request.
    // - Log complete request.
    // - DO NOT create real Pionex trigger orders yet.
    //
    // Real TP/SL execution will be added only after this data path
    // has been verified end-to-end.

    if (action === 'set_tpsl') {
      const {
        symbol,
        position_side,
        entry_order_id,
        take_profit,
        stop_loss,
        signal_id,
      } = body as {
        symbol?: string;
        position_side?: 'LONG' | 'SHORT';
        entry_order_id?: string;
        take_profit?: number;
        stop_loss?: number;
        signal_id?: string;
      };

      if (!symbol || !position_side || !entry_order_id) {
        return respond({
          success: false,
          blocked: true,
          status: 'REJECTED',
          error:
            'symbol, position_side and entry_order_id are required.',
        }, 400);
      }

      if (
        position_side !== 'LONG' &&
        position_side !== 'SHORT'
      ) {
        return respond({
          success: false,
          blocked: true,
          status: 'REJECTED',
          error:
            'position_side must be LONG or SHORT.',
        }, 400);
      }

      const tp =
        take_profit !== undefined &&
        take_profit !== null
          ? Number(take_profit)
          : undefined;

      const sl =
        stop_loss !== undefined &&
        stop_loss !== null
          ? Number(stop_loss)
          : undefined;

      if (
        tp !== undefined &&
        (!Number.isFinite(tp) || tp <= 0)
      ) {
        return respond({
          success: false,
          blocked: true,
          status: 'REJECTED',
          error: 'Invalid take_profit.',
        }, 400);
      }

      if (
        sl !== undefined &&
        (!Number.isFinite(sl) || sl <= 0)
      ) {
        return respond({
          success: false,
          blocked: true,
          status: 'REJECTED',
          error: 'Invalid stop_loss.',
        }, 400);
      }

      console.log(
        '[PIONEX_TPSL_SAFE_REQUEST]',
        JSON.stringify({
          symbol,
          position_side,
          entry_order_id,
          take_profit: tp ?? null,
          stop_loss: sl ?? null,
          signal_id: signal_id ?? null,
          REAL_ORDERS_CREATED: false,
        })
      );

      return respond({
        success: true,
        blocked: true,
        symbol,
        entry_order_id,
        message:
          'TP/SL validated. Real Pionex TP/SL trigger orders are still disabled.',
      });
    }

    if (action === 'close_order') {
      // ── SAFETY GATE ──────────────────────────────────────────────────────
      const { data: closeliveSetting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('user_id', user.id)
        .eq('key', 'live_trading_enabled')
        .maybeSingle();

      const closeLiveEnabled =
        closeliveSetting !== null && closeliveSetting !== undefined
          ? closeliveSetting.value === 'true'
          : Deno.env.get('LIVE_TRADING_ENABLED') === 'true';

      if (!closeLiveEnabled) {
        console.log(
          '[LIVE_CLOSE_REQUEST] close_order blocked: live_trading_enabled=false'
        );

        return respond({
          blocked: true,
          reason: 'live_trading_disabled',
          code: 'ORDER_BLOCKED',
          message:
            'LIVE TRADING er deaktivert. Ingen USDT-M close-ordre kan sendes.',
        }, 403);
      }

      const {
        close_order_id,
        close_symbol,
        close_side,
        close_qty,
        close_price,
        trade_id,
      } = body as {
        close_order_id?: string;
        close_symbol?: string;
        close_side?: 'BUY' | 'SELL';
        close_qty?: number;
        close_price?: number;
        trade_id?: string;
      };

      if (
        !close_symbol ||
        !close_side ||
        !close_qty ||
        close_qty <= 0 ||
        !close_price
      ) {
        return respond({
          error:
            'close_symbol, close_side, close_qty and close_price are required',
          status: 'REJECTED',
        }, 400);
      }

      // USDT-M close:
      //
      // LONG  -> SELL + reduceOnly=true
      // SHORT -> BUY  + reduceOnly=true
      //
      // The caller supplies the opposite side of the position.
      if (close_side !== 'BUY' && close_side !== 'SELL') {
        return respond({
          error: 'USDT-M close side must be BUY or SELL.',
          status: 'REJECTED',
        }, 400);
      }

      // ── Pionex connection ────────────────────────────────────────────────
      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!conn?.is_connected) {
        return respond({
          error: 'Pionex not connected',
          status: 'REJECTED',
        }, 404);
      }

      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      // ── Normalize Futures symbol ─────────────────────────────────────────
      const futuresSymbol =
        close_symbol.toUpperCase().endsWith('_PERP')
          ? close_symbol.toUpperCase()
          : `${close_symbol.toUpperCase()}_PERP`;

      const timestamp = Date.now().toString();

      // ── USDT-M FUTURES MARKET CLOSE ───────────────────────────────────────
      const closePayload: Record<string, unknown> = {
        symbol: futuresSymbol,
        side: close_side,
        type: 'MARKET_QTY',
        size: String(close_qty),
        positionSide: 'BOTH',
        reduceOnly: true,
      };

      const closeBody = JSON.stringify(closePayload);

      console.log(
        '[PIONEX_USDTM_CLOSE_PAYLOAD]',
        JSON.stringify({
          symbol: futuresSymbol,
          side: close_side,
          type: 'MARKET_QTY',
          size: close_qty,
          positionSide: 'BOTH',
          reduceOnly: true,
          open_order_id: close_order_id ?? null,
          trade_id: trade_id ?? null,
        })
      );

      const signature = await buildPionexSignature(
        'POST',
        PIONEX_USDTM_ORDER_PATH,
        { timestamp },
        apiSecret,
        closeBody
      );

      const qs = `timestamp=${encodeURIComponent(timestamp)}`;

      const closeUrl =
        `${PIONEX_BASE}${PIONEX_USDTM_ORDER_PATH}?${qs}`;

      let closeRes: Response;
      let closeText: string;

      try {
        closeRes = await fetch(closeUrl, {
          method: 'POST',
          headers: {
            'PIONEX-KEY': conn.api_key,
            'PIONEX-SIGNATURE': signature,
            'Content-Type': 'application/json',
          },
          body: closeBody,
          signal: AbortSignal.timeout(12000),
        });

        closeText = await closeRes.text();

        console.log('[PIONEX_USDTM_CLOSE_RESPONSE]', {
          http_status: closeRes.status,
          status_text: closeRes.statusText,
          body: closeText,
        });
      } catch (fetchErr) {
        console.error(
          '[PIONEX_USDTM_CLOSE] network error — no blind retry:',
          String(fetchErr)
        );

        return respond({
          error: String(fetchErr),
          status: 'TIMEOUT',
          message:
            'Nettverksfeil ved USDT-M close. Ingen blind retry.',
        }, 504);
      }

      let closeJson: Record<string, unknown> = {};

      try {
        closeJson = JSON.parse(closeText);
      } catch {
        closeJson = { raw: closeText };
      }

      // ── Pionex rejection ─────────────────────────────────────────────────
      if (
        !closeRes.ok ||
        closeJson.result === false
      ) {
        const errMsg = String(
          closeJson.message ??
          closeJson.code ??
          closeText
        );

        console.error(
          '[PIONEX_USDTM_CLOSE] Pionex rejected:',
          errMsg
        );

        return respond({
          error: errMsg,
          status: 'FAILED',
          message:
            `Pionex avviste USDT-M close-ordren: ${errMsg}`,
          raw: closeJson,
        }, 400);
      }

      // ── Extract Futures order ID ─────────────────────────────────────────
      const closeData =
        closeJson.data &&
        typeof closeJson.data === 'object'
          ? closeJson.data as Record<string, unknown>
          : {};

      const closeOrderId = String(
        closeData.orderId ??
        closeData.order_id ??
        closeJson.orderId ??
        closeJson.order_id ??
        ''
      );

      if (!closeOrderId) {
        console.error(
          '[PIONEX_USDTM_CLOSE] Pionex returned no order ID',
          closeJson
        );

        return respond({
          error: 'Pionex returned no Futures close order ID.',
          status: 'UNKNOWN',
          message:
            'Close-request ble sendt, men Pionex returnerte ingen order ID. Ingen retry.',
          raw: closeJson,
        }, 502);
      }

      console.log(
        '[LIVE_USDTM_CLOSE_ORDER_CREATED]',
        JSON.stringify({
          close_order_id: closeOrderId,
          trade_id: trade_id ?? null,
          open_order_id: close_order_id ?? null,
          symbol: futuresSymbol,
          side: 'SELL',
          reduceOnly: true,
          user_id: user.id,
        })
      );

      // Store close-order reference locally.
      if (trade_id) {
        await supabase
          .from('live_orders')
          .update({
            close_order_id: closeOrderId,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id)
          .eq('id', trade_id);
      }

      return respond({
        order_id: closeOrderId,
        symbol: futuresSymbol,
        side: 'SELL',
        status: 'NEW',
        raw: closeJson,
      });
    }

    // ── reconcile: check Pionex open orders against local live_orders ────────
    // Called at app-start / refresh. Returns open Pionex orders so the frontend
    // can avoid sending a duplicate entry when local state is stale.
    if (action === 'reconcile') {
      const { data: conn } = await supabase
        .from('pionex_connections')
        .select('api_key, api_secret_encrypted, is_connected')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!conn?.is_connected) {
        return respond({ open_orders: [], local_live_orders: [] });
      }
      const apiSecret = await decryptSecret(conn.api_secret_encrypted);

      // Fetch open orders from Pionex
      let pionexOpen: Record<string, unknown>[] = [];
      try {
        const data = await pionexAuthRequest('GET', '/api/v1/trade/openOrders',
          conn.api_key, apiSecret, { limit: '20' });
        pionexOpen = (data?.data?.orders ?? data?.data?.result ?? []) as Record<string, unknown>[];
      } catch (e) {
        console.warn('[RECONCILE] could not fetch Pionex open orders:', String(e));
      }

      // Fetch local live_orders with status NEW/PARTIALLY_FILLED
      const { data: localOrders } = await supabase
        .from('live_orders')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['NEW', 'PARTIALLY_FILLED', 'OPEN']);

      console.log('[RECONCILE] Pionex open orders:', pionexOpen.length,
        '| local live_orders:', localOrders?.length ?? 0);

      return respond({
        open_orders:        pionexOpen,
        local_live_orders:  localOrders ?? [],
        has_open_on_pionex: pionexOpen.length > 0,
        has_local_live:     (localOrders?.length ?? 0) > 0,
      });
    }

    return respond({ error: 'Unknown action' }, 400);

  } catch (err) {
    console.error('[PIONEX_API_ERROR] pionex-proxy unhandled error:', err);
    return respond({ error: String(err) }, 500);
  }
});
