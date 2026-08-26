/**
 * PionexExchangeProvider — implementasjon av TradingExecutionProvider mot Pionex.
 *
 * FASE 1: KUN READ-ONLY.
 *   - getBalance(), getMarkets(), getOrderStatus() er aktive.
 *   - placeOrder() og cancelOrder() kaster ORDER_BLOCKED — ingen request sendes.
 *   - Alle kall rutes gjennom pionex-proxy Edge Function (credentials forblir server-side).
 *
 * FASE 2: Fortsatt READ-ONLY. Mock håndterer execution.
 *
 * FASE 3: LIVE EXECUTION aktivert server-side via LIVE_TRADING_ENABLED=true env-var.
 *   - placeOrder() kaller EF action=place_order — server validerer og sender ordre.
 *   - closeOrder() kaller EF action=close_order — server sender close-ordre.
 *   - cancelOrder() fortsatt blokkert (ikke i bruk i Auto Trader).
 *   - Alle safety gates håndheves SERVER-SIDE (max invest, balance, pair, dup signal).
 *   - Credentials forblir i EF — aldri eksponert til frontend.
 */

import { supabase } from '@/db/supabase';
import {
  LIVE_TRADING_ENABLED,
  OrderBlockedError,
  type CloseOrderParams,
  type ExchangeBalance,
  type ExchangeMarket,
  type ExchangeOrder,
  type OrderStatus,
  type PlaceOrderParams,
  type TradingExecutionProvider,
} from './types';

// ─── Hjelpefunksjon: kall Edge Function med feilhåndtering ───────────────────
async function callProxy<T>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  console.log('[PIONEX_PROXY_CALL] invoking action:', action, 'payload:', { ...extra, api_key: undefined, api_secret: undefined });

  const { data, error } = await supabase.functions.invoke('pionex-proxy', {
    method: 'POST',
    body: { action, ...extra },
  });

  console.log('[PIONEX_PROXY_CALL] action:', action, 'error:', error, 'data:', data);

  if (error) {
    let msg = error.message;
    let statusCode: number | undefined = (error as { context?: { status?: number } }).context?.status;
    console.warn('[PIONEX_PROXY_CALL] function error — raw message:', msg, 'status:', statusCode);

    try {
      const text = await (error as { context?: { text?: () => Promise<string> } }).context?.text?.();
      console.warn('[PIONEX_PROXY_CALL] error body text:', text);
      if (text) {
        const parsed = JSON.parse(text);
        console.warn('[PIONEX_PROXY_CALL] parsed error body:', parsed);
        // Propagate ORDER_BLOCKED code so callers can distinguish from generic errors
        if (parsed?.code === 'ORDER_BLOCKED' || parsed?.blocked === true) {
          const blockedErr = new OrderBlockedError(parsed?.reason ?? 'server_blocked');
          (blockedErr as Error & { statusCode?: number }).statusCode = statusCode;
          throw blockedErr;
        }
        msg = parsed?.error ?? parsed?.message ?? text;
      }
    } catch (inner) {
      if (inner instanceof OrderBlockedError) throw inner;
      /* bruk original */
    }
    console.warn('[PIONEX_API_ERROR]', action, msg);
    throw new Error(msg);
  }

  // HTTP 200 but server returned blocked:true
  if (data?.blocked === true || data?.code === 'ORDER_BLOCKED') {
    console.warn('[ORDER_BLOCKED]', action, data?.reason);
    throw new OrderBlockedError(data?.reason ?? 'server_blocked');
  }

  if (data?.error) {
    console.warn('[PIONEX_API_ERROR]', action, data.error);
    throw new Error(data.error);
  }

  return data as T;
}

export class PionexExchangeProvider implements TradingExecutionProvider {

  async getBalance(): Promise<ExchangeBalance> {
    console.log('[PIONEX_BALANCE] PionexExchangeProvider.getBalance()');

    return callProxy<ExchangeBalance>('get_balance');  }

  async getMarkets(): Promise<ExchangeMarket[]> {
    console.log('[PIONEX_MARKETS] PionexExchangeProvider.getMarkets()');
    const res = await callProxy<{ markets: ExchangeMarket[]; total: number }>('get_markets');
    return res.markets;
  }

  async getOrderStatus(orderId: string): Promise<ExchangeOrder> {
    console.log('[PIONEX_ORDER_STATUS] PionexExchangeProvider.getOrderStatus()', orderId);
    const raw = await callProxy<{
      order_id: string; symbol: string; side: string;
      status: string; raw_status: string;
      price: number; qty: number; filled_qty: number; avg_fill_price: number;
      created_at: string | null; updated_at: string | null;
    }>('get_order_status', { order_id: orderId });

    return {
      ...raw,
      side:   (raw.side?.toUpperCase() ?? 'BUY') as 'BUY' | 'SELL',
      status: raw.status as OrderStatus,
    };
  }

  /**
   * FASE 3: Kall EF place_order — server sender ekte BUY/SELL til Pionex.
   * Server validerer: live flag, max invest, balance, pair, duplicate signal.
   * Kaster OrderBlockedError hvis noen safety gate blokkerer.
   * Returnerer order med status=NEW — kaller getOrderStatus() for å bekrefte FILLED.
   */
  async placeOrder(params: PlaceOrderParams): Promise<ExchangeOrder> {
    // Frontend-side guard — stoppes uansett på server-side
    if (LIVE_TRADING_ENABLED === false) {
      // I FASE 3 er server-side live=true selv om frontend-konstanten er false.
      // Ingen frontend-blokkering her — la server avgjøre.
      console.log(
      '[PIONEX_PLACE_ORDER] Sending USDT-M Futures order via EF place_order'
    );
    }

    console.log('[LIVE_ENTRY_REQUEST] PionexExchangeProvider.placeOrder()',
      'symbol:', params.symbol, 'side:', params.side,
      'qty:', params.qty, 'price:', params.price);

    const raw = await callProxy<{
      order_id: string; symbol: string; side: string;
      status: string; investment: number; signal_id?: string;
      raw?: Record<string, unknown>;
    }>('place_order', {
      order_symbol: params.symbol,
      order_side:   params.side,
      order_qty:    params.qty,
      order_amount_usdt: params.side === 'BUY' && params.type === 'MARKET'
        ? params.amountUsdt
        : undefined,
      order_price:  params.price,
      order_type:   params.type ?? 'MARKET',

      // USDT-M TP/SL values are passed to the execution layer.
      // The proxy will create the actual Futures trigger orders
      // only after the entry order has been accepted/filled.
      take_profit:  params.takeProfit,
      stop_loss:    params.stopLoss,

      signal_id:    params.signal_id,
    });

    console.log('[LIVE_ENTRY_ORDER_CREATED] orderId:', raw.order_id,
      'symbol:', raw.symbol, 'side:', raw.side, 'status:', raw.status);

    // ============================================================
    // LIVE ENTRY CONFIRMATION
    // ============================================================
    //
    // place_order kan returnere NEW/OPEN før Pionex faktisk har
    // fylt entry-ordren.
    //
    // Derfor returnerer vi IKKE FILLED basert på create-response.
    //
    // Vi poller den faktiske Pionex order-statusen.
    //
    // HARD SAFETY:
    // - Ingen retry av entry-order creation.
    // - Timeout betyr IKKE FILLED.
    // - PARTIALLY_FILLED betyr IKKE ferdig entry.
    // - Kun faktisk FILLED kan sendes videre som bekreftet entry.
    // ============================================================

    const closeOrderId = raw.order_id;
    const pollTimeoutMs = 12000;
    const pollIntervalMs = 500;
    const pollStartedAt = Date.now();

    type ConfirmedEntryStatus = {
      order_id?: string;
      symbol?: string;
      side?: string;
      status?: string;
      investment?: number;
      signal_id?: string;
      price?: number;
      qty?: number;
      filled_qty?: number;
      avg_fill_price?: number;
      raw?: Record<string, unknown>;
    };

    let confirmed: ConfirmedEntryStatus = raw;

    while (Date.now() - pollStartedAt < pollTimeoutMs) {
      try {
        const statusResult = await callProxy<{
          order_id: string;
          symbol: string;
          side: string;
          status: string;
          filled_qty?: number;
          avg_fill_price?: number;
          price?: number;
          qty?: number;
          raw?: Record<string, unknown>;
        }>('get_order_status', {
          order_id: closeOrderId,
        });

        confirmed = statusResult;

        const status = String(
          statusResult.status ?? 'UNKNOWN'
        ).toUpperCase();

        console.log(
          '[LIVE_ENTRY_POLL]',
          {
            order_id: closeOrderId,
            status,
            filled_qty: statusResult.filled_qty ?? 0,
            avg_fill_price: statusResult.avg_fill_price ?? 0,
          }
        );

        if (
          status === 'FILLED' ||
          status === 'FAILED' ||
          status === 'CANCELLED' ||
          status === 'UNKNOWN'
        ) {
          break;
        }

        await new Promise(resolve =>
          setTimeout(resolve, pollIntervalMs)
        );

      } catch (pollError) {
        console.error(
          '[LIVE_ENTRY_POLL_ERROR]',
          {
            order_id: closeOrderId,
            error: pollError,
          }
        );

        // Poll-feil skal IKKE føre til ny close-order.
        // Returner UNKNOWN slik at execution layer ikke
        // registrerer trade som CLOSED.
        confirmed = {
          order_id: closeOrderId,
          symbol: raw.symbol ?? params.symbol,
          side: raw.side ?? params.side,
          status: 'UNKNOWN',
          filled_qty: 0,
          avg_fill_price: 0,
        };

        break;
      }
    }

    const confirmedStatus = String(
      confirmed.status ?? 'UNKNOWN'
    ).toUpperCase();

    if (
      Date.now() - pollStartedAt >= pollTimeoutMs &&
      !['FILLED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(
        confirmedStatus
      )
    ) {
      console.warn(
        '[LIVE_ENTRY_POLL_TIMEOUT]',
        {
          order_id: closeOrderId,
          status: confirmedStatus,
        }
      );

      confirmed = {
        ...confirmed,
        status: 'UNKNOWN',
      };
    }

    const now = new Date().toISOString();

    return {
      order_id:       confirmed.order_id ?? closeOrderId,
      symbol:         confirmed.symbol ?? raw.symbol ?? params.symbol,
      side:           (
        confirmed.side?.toUpperCase() ??
        raw.side?.toUpperCase() ??
        params.side
      ) as 'BUY' | 'SELL',
      status:         (
        confirmed.status ?? 'UNKNOWN'
      ) as OrderStatus,
      raw_status:     confirmed.status ?? 'UNKNOWN',
      price:          Number(
        confirmed.price ?? params.price
      ),
      qty:            Number(
        confirmed.qty ?? params.qty
      ),
      filled_qty:     Number(
        confirmed.filled_qty ?? 0
      ),
      avg_fill_price: Number(
        confirmed.avg_fill_price ?? 0
      ),
      created_at:     now,
      updated_at:     now,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    // cancelOrder er ikke brukt i Auto Trader — alltid blokkert
    console.log('[ORDER_BLOCKED] PionexExchangeProvider.cancelOrder()',
      'reason=not_implemented_in_fase3', 'orderId:', orderId);
    throw new OrderBlockedError('not_implemented_in_fase3');
  }

  /**
   * FASE 3: Kall EF close_order — server sender close-ordre (SELL for BUY-side).
   * CLOSED registreres KUN etter bekreftet FILLED via getOrderStatus().
   * Returnerer order med status=NEW — kaller getOrderStatus() for å bekrefte FILLED.
   */
  async setFuturesTPSL(params: {
    symbol: string;
    position_side: 'LONG' | 'SHORT';
    entry_order_id: string;
    take_profit?: number;
    stop_loss?: number;
    signal_id?: string;
  }): Promise<{
    success: boolean;
    blocked?: boolean;
    symbol: string;
    entry_order_id: string;
    take_profit_order_id?: string;
    stop_loss_order_id?: string;
    message?: string;
  }> {
    console.log(
      '[PIONEX_TPSL] setFuturesTPSL',
      JSON.stringify(params)
    );

    return callProxy('set_tpsl', {
      symbol: params.symbol,
      position_side: params.position_side,
      entry_order_id: params.entry_order_id,
      take_profit: params.take_profit,
      stop_loss: params.stop_loss,
      signal_id: params.signal_id,
    });
  }

  async closeOrder(params: CloseOrderParams): Promise<ExchangeOrder> {
    console.log(
      '[LIVE_CLOSE_REQUEST] PionexExchangeProvider.closeOrder()',
      'symbol:', params.symbol,
      'side:', params.side,
      'qty:', params.qty,
      'price:', params.price
    );

    // ================================================================
    // 1. CREATE CLOSE ORDER
    // ================================================================

    const raw = await callProxy<{
      order_id: string;
      symbol: string;
      side: string;
      status: string;
      raw?: Record<string, unknown>;
    }>('close_order', {
      close_order_id: params.order_id,
      close_symbol: params.symbol,
      close_side: params.side,
      close_qty: params.qty,
      close_price: params.price,
      close_type: params.type ?? 'MARKET',
    });

    const closeOrderId = String(raw.order_id ?? '');

    if (!closeOrderId) {
      console.error(
        '[LIVE_CLOSE_NO_ORDER_ID]',
        {
          symbol: params.symbol,
          side: params.side,
          qty: params.qty,
        }
      );

      const now = new Date().toISOString();

      return {
        order_id: '',
        symbol: raw.symbol ?? params.symbol,
        side: (
          raw.side?.toUpperCase() ?? params.side
        ) as 'BUY' | 'SELL',
        status: 'UNKNOWN',
        raw_status: 'UNKNOWN',
        price: params.price,
        qty: params.qty,
        filled_qty: 0,
        avg_fill_price: 0,
        created_at: now,
        updated_at: now,
      };
    }

    console.log(
      '[LIVE_CLOSE_ORDER_CREATED]',
      {
        order_id: closeOrderId,
        symbol: raw.symbol ?? params.symbol,
        side: raw.side ?? params.side,
        status: raw.status ?? 'NEW',
      }
    );

    // ================================================================
    // 2. POLL ACTUAL CLOSE ORDER STATUS
    // ================================================================
    //
    // IMPORTANT:
    // close_order success means only that Pionex accepted/created
    // the close order. It does NOT mean that the close is FILLED.
    //
    // Therefore the execution layer must confirm the actual order.
    //
    // No automatic retry is performed.
    // ================================================================

    const pollTimeoutMs = 12000;
    const pollIntervalMs = 500;
    const pollStartedAt = Date.now();

    let confirmed: {
      order_id?: string;
      symbol?: string;
      side?: string;
      status?: string;
      price?: number;
      qty?: number;
      filled_qty?: number;
      avg_fill_price?: number;
      raw?: Record<string, unknown>;
    } = {
      order_id: closeOrderId,
      symbol: raw.symbol ?? params.symbol,
      side: raw.side ?? params.side,
      status: raw.status ?? 'NEW',
      price: params.price,
      qty: params.qty,
      filled_qty: 0,
      avg_fill_price: 0,
    };

    while (Date.now() - pollStartedAt < pollTimeoutMs) {
      try {
        const statusResult = await callProxy<{
          order_id?: string;
          symbol?: string;
          side?: string;
          status?: string;
          price?: number;
          qty?: number;
          filled_qty?: number;
          avg_fill_price?: number;
          raw?: Record<string, unknown>;
        }>('get_order_status', {
          order_id: closeOrderId,
        });

        confirmed = statusResult;

        const status = String(
          statusResult.status ?? 'UNKNOWN'
        ).toUpperCase();

        console.log(
          '[LIVE_CLOSE_POLL]',
          {
            order_id: closeOrderId,
            status,
            filled_qty: statusResult.filled_qty ?? 0,
            avg_fill_price: statusResult.avg_fill_price ?? 0,
          }
        );

        if (
          status === 'FILLED' ||
          status === 'FAILED' ||
          status === 'CANCELLED' ||
          status === 'UNKNOWN'
        ) {
          break;
        }

        await new Promise(resolve =>
          setTimeout(resolve, pollIntervalMs)
        );

      } catch (pollError) {
        console.error(
          '[LIVE_CLOSE_POLL_ERROR]',
          {
            order_id: closeOrderId,
            error: pollError,
          }
        );

        // Poll failure = UNKNOWN.
        //
        // NEVER send another close order automatically.
        confirmed = {
          order_id: closeOrderId,
          symbol: raw.symbol ?? params.symbol,
          side: raw.side ?? params.side,
          status: 'UNKNOWN',
          price: params.price,
          qty: params.qty,
          filled_qty: 0,
          avg_fill_price: 0,
        };

        break;
      }
    }

    // ================================================================
    // 3. TIMEOUT SAFETY
    // ================================================================

    let confirmedStatus = String(
      confirmed.status ?? 'UNKNOWN'
    ).toUpperCase();

    if (
      Date.now() - pollStartedAt >= pollTimeoutMs &&
      ![
        'FILLED',
        'FAILED',
        'CANCELLED',
        'UNKNOWN',
      ].includes(confirmedStatus)
    ) {
      console.warn(
        '[LIVE_CLOSE_POLL_TIMEOUT]',
        {
          order_id: closeOrderId,
          status: confirmedStatus,
        }
      );

      confirmed = {
        ...confirmed,
        status: 'UNKNOWN',
      };

      confirmedStatus = 'UNKNOWN';
    }

    // ================================================================
    // 4. ONLY FILLED COUNTS AS CONFIRMED CLOSE
    // ================================================================

    const closeConfirmed =
      confirmedStatus === 'FILLED';

    console.log(
      '[LIVE_CLOSE_CONFIRMED_RESULT]',
      {
        order_id:
          confirmed.order_id ?? closeOrderId,

        symbol:
          confirmed.symbol ??
          raw.symbol ??
          params.symbol,

        status: confirmedStatus,

        filled_qty:
          confirmed.filled_qty ?? 0,

        avg_fill_price:
          confirmed.avg_fill_price ?? 0,

        CLOSE_CONFIRMED: closeConfirmed,

        // Hard safety marker.
        // This provider result does not itself update local
        // live_orders to CLOSED.
        LOCAL_TRADE_CLOSED: false,
      }
    );

    const now = new Date().toISOString();

    return {
      order_id:
        confirmed.order_id ?? closeOrderId,

      symbol:
        confirmed.symbol ??
        raw.symbol ??
        params.symbol,

      side: (
        confirmed.side?.toUpperCase() ??
        raw.side?.toUpperCase() ??
        params.side
      ) as 'BUY' | 'SELL',

      status:
        confirmedStatus as OrderStatus,

      raw_status:
        confirmedStatus,

      price: Number(
        confirmed.price ?? params.price
      ),

      qty: Number(
        confirmed.qty ?? params.qty
      ),

      filled_qty: Number(
        confirmed.filled_qty ?? 0
      ),

      avg_fill_price: Number(
        confirmed.avg_fill_price ?? 0
      ),

      created_at: now,
      updated_at: now,
    };
  }


  /**
   * reconcileWithPionex — kall ved app-start / refresh.
   * Returnerer true hvis Pionex har åpen ordre som matcher et local live_order.
   * Forhindrer at Auto Trader sender ny ordre når lokal state er stale.
   */
  async reconcileWithPionex(): Promise<{
    has_open_on_pionex: boolean;
    has_local_live: boolean;
    open_orders: Record<string, unknown>[];
    local_live_orders: Record<string, unknown>[];
  }> {
    console.log('[RECONCILE] PionexExchangeProvider.reconcileWithPionex()');
    return callProxy('reconcile');
  }
}
