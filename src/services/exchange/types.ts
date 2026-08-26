/**
 * TradingExecutionProvider — abstraksjon mellom TradeMindMZ og exchange-execution.
 *
 * FASE 1: LIVE_TRADING_ENABLED = false (frontend konstant, server leser env-var).
 *   - Pionex-implementasjonen er READ-ONLY.
 *   - placeOrder() / cancelOrder() kaster ORDER_BLOCKED i begge implementasjoner.
 *   - Mock-implementasjonen simulerer alle order-utfall uten å kontakte Pionex.
 *
 * FASE 2: Auto Trader kobler seg til via executeViaProvider() i TradingContext.
 *   - MockExchangeProvider brukes som standard execution backend.
 *   - LIVE_TRADING_ENABLED forblir false — ingen ekte Pionex-ordre.
 *   - closeOrder() er ny: brukes av TP/SL-motoren for å bekrefte CLOSED.
 *
 * FASE 3: Ekte Pionex execution aktivert via server-side LIVE_TRADING_ENABLED=true.
 *   - Frontend leser live-status fra EF live_status action.
 *   - PionexExchangeProvider.placeOrder() / closeOrder() kaller EF place_order / close_order.
 *   - Frontend-konstanten LIVE_TRADING_ENABLED forblir false — guards på server-side.
 *   - Pionex market rules og tilgjengelig saldo håndheves server-side.
 */

// ─── Safety flag ──────────────────────────────────────────────────────────────
// Frontend-konstant: alltid false.
// Server-side: Deno.env.get('LIVE_TRADING_ENABLED') === 'true'.
// Ingen frontend-kode skal lese server-side env direkte.
export const LIVE_TRADING_ENABLED = false as const;

// ─── Market ───────────────────────────────────────────────────────────────────
export interface ExchangeMarket {
  symbol:             string;
  base_asset:         string;
  quote_asset:        string;
  quantity_precision: number;
  amount_precision?: number;
  price_precision:    number;
  min_qty:            number;
  min_value:          number;
  status:             string;
}

// ─── Balance ──────────────────────────────────────────────────────────────────
export interface ExchangeBalance {
  usdt_available: number;
  usdt_locked:    number;
  usdt_total:     number;
  balances: Array<{ coin: string; free: number; freeze: number; total: number }>;
}

// ─── Order status ─────────────────────────────────────────────────────────────
export type OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'FAILED'
  | 'UNKNOWN';

export interface ExchangeOrder {
  order_id:       string;
  symbol:         string;
  side:           'BUY' | 'SELL';
  status:         OrderStatus;
  raw_status:     string;
  price:          number;
  qty:            number;
  filled_qty:     number;
  avg_fill_price: number;
  created_at:     string | null;
  updated_at:     string | null;
}

// ─── Place-order input ────────────────────────────────────────────────────────
export interface PlaceOrderParams {
  symbol: string;
  side:   'BUY' | 'SELL';
  qty:    number;
  /** Explicit USDT quote amount for MARKET BUY. */
  amountUsdt?: number;
  price:  number;
  type?:  'LIMIT' | 'MARKET';

  /**
   * USDT-M Futures risk management.
   *
   * These values are signal-derived trigger prices.
   * The provider/proxy is responsible for creating the
   * actual Pionex Futures TP/SL orders after entry.
   */
  takeProfit?: number;
  stopLoss?: number;

  /**
   * Optional signal reference used to link the
   * Futures entry + TP/SL orders locally.
   */
  signal_id?: string;
}

// ─── Close-order input ───────────────────────────────────────────────────────
/**
 * USDT-M Futures TP/SL configuration.
 *
 * SAFE PHASE:
 * These values are transported to the proxy.
 * Real Pionex trigger orders remain disabled.
 */
export interface FuturesTPSLParams {
  symbol: string;
  position_side: 'LONG' | 'SHORT';
  entry_order_id: string;
  take_profit?: number;
  stop_loss?: number;
  signal_id?: string;
}

/**
 * Result from USDT-M Futures TP/SL setup.
 */
export interface FuturesTPSLResult {
  success: boolean;
  blocked?: boolean;
  symbol: string;
  entry_order_id: string;
  take_profit_order_id?: string;
  stop_loss_order_id?: string;
  message?: string;
}

export interface CloseOrderParams {
  order_id: string;
  symbol:   string;
  side:     'BUY' | 'SELL';
  qty:      number;
  price:    number;
  type?:    'LIMIT' | 'MARKET';
}

// ─── Execution result (FASE 2) ────────────────────────────────────────────────
// Returneres av executeViaProvider() etter bekreftet FILLED.
export interface ExecutionResult {
  order_id:        string;
  fill_price:      number;
  filled_qty:      number;
  status:          OrderStatus;
  partially_filled: boolean;
}

// ─── Blocked error ────────────────────────────────────────────────────────────
export class OrderBlockedError extends Error {
  readonly code = 'ORDER_BLOCKED';
  readonly reason: string;
  constructor(reason: string) {
    super(`[ORDER_BLOCKED] reason=${reason}`);
    this.reason = reason;
  }
}

// ─── Provider interface ───────────────────────────────────────────────────────
export interface TradingExecutionProvider {
  /** Hent USDT-balanse og alle coin-saldoer. READ-ONLY. */
  getBalance(): Promise<ExchangeBalance>;

  /** Hent tilgjengelige handelspar med presisjons- og min-ordre-info. READ-ONLY. */
  getMarkets(): Promise<ExchangeMarket[]>;

  /** Hent status på en enkelt ordre via orderId. READ-ONLY. */
  getOrderStatus(orderId: string): Promise<ExchangeOrder>;

  /**
   * FASE 1: ALLTID BLOKKERT — kaster OrderBlockedError(reason='live_trading_disabled').
   * FASE 2 Mock: aktiv når allowOrders=true, simulerer order-utfall.
   * Ingen ekte Pionex-request sendes uansett.
   */
  placeOrder(params: PlaceOrderParams): Promise<ExchangeOrder>;

  /**
   * FASE 2: Lukk en åpen posisjon (SELL for BUY-side, BUY for SELL-side).
   * Returnerer bekreftet ordre. Kaster OrderBlockedError hvis live trading er blokkert.
   * Brukes av TP/SL-motoren — CLOSED registreres kun etter FILLED.
   */
  closeOrder(params: CloseOrderParams): Promise<ExchangeOrder>;

  /**
   * Configure USDT-M Futures TP/SL after a confirmed entry.
   *
   * SAFE PHASE:
   * The proxy currently validates/logs the request.
   * Real Pionex trigger orders are not created yet.
   */
  setFuturesTPSL(params: {
    symbol: string;
    position_side: 'LONG' | 'SHORT';
    entry_order_id: string;
    take_profit?: number;
    stop_loss?: number;
    signal_id?: string;
  }): Promise<FuturesTPSLResult>;

  /**
   * FASE 1/2: ALLTID BLOKKERT.
   * Kaster OrderBlockedError(reason='live_trading_disabled').
   */
  cancelOrder(orderId: string): Promise<void>;
}
