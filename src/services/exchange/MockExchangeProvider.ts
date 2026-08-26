/**
 * MockExchangeProvider — simulerer exchange execution uten å kontakte Pionex.
 *
 * Brukes til testing av execution-flow i FASE 2 uten ekte penger.
 *
 * Støtter simulerte utfall:
 *   FILLED, PARTIALLY_FILLED, FAILED, CANCELLED, TIMEOUT
 *
 * LIVE_TRADING_ENABLED=false → placeOrder/cancelOrder er blokkert selv i mock.
 * Sett mockAllowOrders=true i constructor for å teste order-flow isolert.
 */

import {
  LIVE_TRADING_ENABLED,
  OrderBlockedError,
  type CloseOrderParams,
  type ExchangeBalance,
  type ExchangeMarket,
  type ExchangeOrder,
  type PlaceOrderParams,
  type TradingExecutionProvider,
} from './types';

export type MockOrderOutcome =
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMEOUT';

export interface MockProviderOptions {
  /** Overstyrer LIVE_TRADING_ENABLED for isolert order-flow-testing. Default: false. */
  allowOrders?: boolean;
  /** Simulert order-utfall. Default: 'FILLED'. */
  defaultOutcome?: MockOrderOutcome;
  /** Simulert forsinkelse i ms. Default: 0. */
  latencyMs?: number;
  /** Simulert USDT-balanse. Default: 1000. */
  usdtBalance?: number;
}

export class MockExchangeProvider implements TradingExecutionProvider {
  private readonly allowOrders: boolean;
  private defaultOutcome: MockOrderOutcome;
  private readonly latencyMs: number;
  private usdtBalance: number;

  private orderCounter = 0;
  private readonly orderStore = new Map<string, ExchangeOrder>();

  constructor(options: MockProviderOptions = {}) {
    this.allowOrders   = options.allowOrders   ?? false;
    this.defaultOutcome = options.defaultOutcome ?? 'FILLED';
    this.latencyMs     = options.latencyMs     ?? 0;
    this.usdtBalance   = options.usdtBalance   ?? 1000;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise(r => setTimeout(r, this.latencyMs));
  }

  async getBalance(): Promise<ExchangeBalance> {
    await this.delay();
    console.log('[PIONEX_BALANCE] MockExchangeProvider.getBalance() usdt:', this.usdtBalance);
    return {
      usdt_available: this.usdtBalance,
      usdt_locked:    0,
      usdt_total:     this.usdtBalance,
      balances: [
        { coin: 'USDT', free: this.usdtBalance, freeze: 0, total: this.usdtBalance },
      ],
    };
  }

  async getMarkets(): Promise<ExchangeMarket[]> {
    await this.delay();
    console.log('[PIONEX_MARKETS] MockExchangeProvider.getMarkets()');
    // Returner representative testpar
    return [
      { symbol: 'BTC_USDT', base_asset: 'BTC', quote_asset: 'USDT', quantity_precision: 6, price_precision: 2, min_qty: 0.00001, min_value: 1, status: 'TRADING' },
      { symbol: 'ETH_USDT', base_asset: 'ETH', quote_asset: 'USDT', quantity_precision: 5, price_precision: 2, min_qty: 0.0001,  min_value: 1, status: 'TRADING' },
      { symbol: 'DODO_USDT', base_asset: 'DODO', quote_asset: 'USDT', quantity_precision: 2, price_precision: 5, min_qty: 1,      min_value: 1, status: 'TRADING' },
    ];
  }

  async getOrderStatus(orderId: string): Promise<ExchangeOrder> {
    await this.delay();
    console.log('[PIONEX_ORDER_STATUS] MockExchangeProvider.getOrderStatus()', orderId);
    const existing = this.orderStore.get(orderId);
    if (existing) return existing;
    return {
      order_id: orderId, symbol: 'UNKNOWN_USDT', side: 'BUY',
      status: 'UNKNOWN', raw_status: 'UNKNOWN',
      price: 0, qty: 0, filled_qty: 0, avg_fill_price: 0,
      created_at: null, updated_at: null,
    };
  }

  async placeOrder(params: PlaceOrderParams): Promise<ExchangeOrder> {
    await this.delay();

    // Primær safety-sjekk: LIVE_TRADING_ENABLED
    if (!LIVE_TRADING_ENABLED && !this.allowOrders) {
      console.log('[ORDER_BLOCKED] MockExchangeProvider.placeOrder() reason=live_trading_disabled');
      throw new OrderBlockedError('live_trading_disabled');
    }

    this.orderCounter += 1;
    const orderId = `MOCK-${Date.now()}-${this.orderCounter}`;
    const now = new Date().toISOString();

    const statusMap: Record<MockOrderOutcome, ExchangeOrder['status']> = {
      FILLED:           'FILLED',
      PARTIALLY_FILLED: 'PARTIALLY_FILLED',
      FAILED:           'FAILED',
      CANCELLED:        'CANCELLED',
      TIMEOUT:          'UNKNOWN',
    };

    if (this.defaultOutcome === 'TIMEOUT') {
      throw new Error('[MOCK] Simulert timeout — ingen ordre opprettet');
    }

    const filledQty = this.defaultOutcome === 'PARTIALLY_FILLED'
      ? params.qty * 0.5
      : this.defaultOutcome === 'FILLED'
      ? params.qty
      : 0;

    const order: ExchangeOrder = {
      order_id:       orderId,
      symbol:         params.symbol,
      side:           params.side,
      status:         statusMap[this.defaultOutcome],
      raw_status:     this.defaultOutcome,
      price:          params.price,
      qty:            params.qty,
      filled_qty:     filledQty,
      avg_fill_price: this.defaultOutcome === 'FILLED' || this.defaultOutcome === 'PARTIALLY_FILLED'
                        ? params.price : 0,
      created_at: now,
      updated_at: now,
    };

    this.orderStore.set(orderId, order);

    console.log('[MOCK_EXECUTION] placeOrder', params.side, params.symbol,
      '| outcome:', this.defaultOutcome, '| orderId:', orderId);
    return order;
  }

  /**
   * Mock implementation of USDT-M Futures TP/SL.
   *
   * Demo/mock mode must never contact Pionex.
   * Return a successful simulated configuration so the
   * execution flow can be tested without live orders.
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
    symbol: string;
    entry_order_id: string;
    take_profit_order_id?: string;
    stop_loss_order_id?: string;
    message?: string;
  }> {
    console.log(
      '[MOCK_TPSL] setFuturesTPSL',
      JSON.stringify(params)
    );

    return {
      success: true,
      symbol: params.symbol,
      entry_order_id: params.entry_order_id,
      take_profit_order_id: params.take_profit !== undefined
        ? `MOCK-TP-${params.entry_order_id}`
        : undefined,
      stop_loss_order_id: params.stop_loss !== undefined
        ? `MOCK-SL-${params.entry_order_id}`
        : undefined,
      message: 'Mock TP/SL configured — no real exchange order created.',
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.delay();
    if (!LIVE_TRADING_ENABLED && !this.allowOrders) {
      console.log('[ORDER_BLOCKED] MockExchangeProvider.cancelOrder() reason=live_trading_disabled');
      throw new OrderBlockedError('live_trading_disabled');
    }
    const existing = this.orderStore.get(orderId);
    if (existing) {
      existing.status = 'CANCELLED';
      existing.raw_status = 'CANCELLED';
      existing.updated_at = new Date().toISOString();
    }
    console.log('[MOCK_EXECUTION] cancelOrder orderId:', orderId);
  }

  /**
   * FASE 2: Lukk en posisjon (brukes av TP/SL-motoren).
   * Simulerer SELL-side FILLED (eller FAILED basert på defaultOutcome).
   * CLOSED registreres kun etter bekreftet FILLED.
   */
  async closeOrder(params: CloseOrderParams): Promise<ExchangeOrder> {
    await this.delay();

    if (!LIVE_TRADING_ENABLED && !this.allowOrders) {
      console.log('[ORDER_BLOCKED] MockExchangeProvider.closeOrder() reason=live_trading_disabled');
      throw new OrderBlockedError('live_trading_disabled');
    }

    this.orderCounter += 1;
    const orderId = `MOCK-CLOSE-${Date.now()}-${this.orderCounter}`;
    const now = new Date().toISOString();

    if (this.defaultOutcome === 'TIMEOUT') {
      throw new Error('[MOCK] Simulert timeout ved close — ingen ordre opprettet');
    }

    // Nekte close hvis defaultOutcome er FAILED eller CANCELLED
    const closeFilled = this.defaultOutcome !== 'FAILED' && this.defaultOutcome !== 'CANCELLED';
    const filledQty = closeFilled
      ? (this.defaultOutcome === 'PARTIALLY_FILLED' ? params.qty * 0.5 : params.qty)
      : 0;

    const order: ExchangeOrder = {
      order_id:       orderId,
      symbol:         params.symbol,
      side:           params.side,
      status:         closeFilled ? (this.defaultOutcome === 'PARTIALLY_FILLED' ? 'PARTIALLY_FILLED' : 'FILLED') : this.defaultOutcome as ExchangeOrder['status'],
      raw_status:     this.defaultOutcome,
      price:          params.price,
      qty:            params.qty,
      filled_qty:     filledQty,
      avg_fill_price: closeFilled ? params.price : 0,
      created_at:     now,
      updated_at:     now,
    };

    this.orderStore.set(orderId, order);
    console.log('[MOCK_EXECUTION] closeOrder', params.side, params.symbol,
      '| outcome:', this.defaultOutcome, '| orderId:', orderId);
    return order;
  }

  /** Test-hjelper: sett simulert utfall for neste kall */
  setOutcome(outcome: MockOrderOutcome): void {
    this.defaultOutcome = outcome;
  }

  /** Test-hjelper: sett simulert balanse */
  setBalance(usdt: number): void {
    this.usdtBalance = usdt;
  }
}
