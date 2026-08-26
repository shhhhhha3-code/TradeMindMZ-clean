/**
 * Shared live-order validation helpers for Manual Buy and Auto Trade.
 *
 * These functions are PURE: they do not send orders to Pionex.
 * The actual place_order call always goes through the PionexExchangeProvider
 * / pionex-proxy Edge Function, which is shared by both Manual Buy and Auto Trade.
 */

export type LiveOrderErrorCode =
  | 'PIONEX_NOT_CONNECTED'
  | 'LIVE_TRADING_DISABLED'
  | 'INVALID_SYMBOL'
  | 'BELOW_MIN_ORDER'
  | 'BELOW_MIN_QTY'
  | 'INSUFFICIENT_BALANCE'
  | 'BALANCE_CHECK_FAILED'
  | 'DUPLICATE'
  | 'OPEN_TRADE_EXISTS'
  | 'RATE_LIMITED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface PreflightGate {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface LiveOrderPreflight {
  all_pass: boolean;
  gates: PreflightGate[];
  error_code?: LiveOrderErrorCode;
  error_message?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  pair: string;
  price: number;
  investment_raw: number;
  investment_final: number;
  /** Final USDT quote amount for MARKET BUY. */
  amount_usdt_final: number;
  quantity_raw: number;
  quantity_final: number;
  base_precision: number;
  min_order_value: number;
  /** Minimum base-asset quantity (Pionex minTradeAmount). 0 = no minimum. */
  min_trade_amount: number;
  estimated_fee: number;
  estimated_total: number;
  pionex_request: 'NOT_SENT' | 'PENDING';
}

export interface ExchangeMarketInfo {
  symbol:              string;
  base_asset?:         string;
  quote_asset?:        string;
  quantity_precision?: number;
  /** Decimal places for USDT `amount` field in MARKET BUY (Pionex amountPrecision). Default 2. */
  amount_precision?:   number;
  price_precision?:    number;
  min_qty?:            number;   // minimum base-asset qty (Pionex minTradeAmount)
  min_value?:          number;   // minimum USDT order value (Pionex minOrderValue / minAmount)
  status?:             string;
}

export interface ExchangeBalanceInfo {
  usdt_available: number;
  usdt_total: number;
}

/**
 * Resolve the canonical Pionex symbol from a UI pair string like "XRP/USDT".
 *
 * Strategy (in order):
 *   1. Exact match of the `symbol` field from /api/v1/common/symbols (case-insensitive).
 *   2. Match by base_asset + quote_asset from the pair (e.g. "XRP" + "USDT").
 *
 * Returns the exact symbol string from the Pionex API, or null if not found.
 * NEVER guesses by stripping "/" — always use the API as source of truth.
 */
export function resolvePionexSymbol(
  pair: string,
  markets: ExchangeMarketInfo[]
): string | null {
  const pairUpper = pair.toUpperCase();

  // Step 1: exact symbol match (e.g. some pairs might already be "XRP_USDT")
  const exactMatch = markets.find(m => m.symbol.toUpperCase() === pairUpper);
  if (exactMatch) return exactMatch.symbol;

  // Step 2: parse "BASE/QUOTE" → match base_asset + quote_asset
  const slashIdx = pair.indexOf('/');
  if (slashIdx !== -1) {
    const base  = pair.slice(0, slashIdx).toUpperCase();
    const quote = pair.slice(slashIdx + 1).toUpperCase();
    const assetMatch = markets.find(
      m =>
        (m.base_asset ?? '').toUpperCase()  === base &&
        (m.quote_asset ?? '').toUpperCase() === quote
    );
    if (assetMatch) return assetMatch.symbol;
  }

  return null;
}

/**
 * Legacy helper — only used for non-Pionex display or Demo mode.
 * DO NOT use for any live order symbol derivation.
 * @deprecated Use resolvePionexSymbol() against the markets list instead.
 */
export function formatPionexSymbol(pair: string): string {
  return pair.replace('/', '');
}

export function roundQuantity(qty: number, basePrecision: number): number {
  const factor = Math.pow(10, basePrecision);
  return Math.floor(qty * factor) / factor;
}

/**
 * Floor qty down to the nearest multiple of stepSize.
 * If stepSize <= 0 or undefined, falls back to basePrecision rounding.
 *
 * Example: qty=3.456789, stepSize=0.01 → 3.45
 */
export function floorToStep(qty: number, stepSize: number | undefined, basePrecision: number): number {
  if (!stepSize || stepSize <= 0) return roundQuantity(qty, basePrecision);
  // Work in integer space to avoid floating-point drift
  const scale = Math.round(1 / stepSize);
  return Math.floor(qty * scale) / scale;
}

export function estimateFee(investment: number): number {
  // Pionex spot market order fee ≈ 0.05%
  return investment * 0.0005;
}

/**
 * Derive investment USDT from a percentage of available balance.
 * Returns 0 if balance is 0. No artificial cap — Pionex rules are the only limit.
 */
export function investmentFromPercent(
  balanceUsdt: number,
  pct: number,         // 0–100
): number {
  const raw = balanceUsdt * (pct / 100);
  // Floor to 4 decimal places to avoid dust
  return Math.floor(raw * 10000) / 10000;
}

export interface OrderBuildResult {
  /** Final rounded USDT amount to send as `amount` for MARKET BUY. */
  amountUsdt:       number;
  /** Final rounded quantity to send as `size` for SELL / LIMIT orders. */
  quantity:         number;
  /** Final investment value in USDT (= amountUsdt for MARKET BUY, qty×price otherwise). */
  investment:       number;
  /** Estimated taker fee (0.05% of investment). */
  estimated_fee:    number;
  /** investment + estimated_fee. */
  estimated_total:  number;
  /** Validation error code if order would be rejected; undefined = valid. */
  error_code?:      LiveOrderErrorCode;
  /** Human-readable Norwegian error message. */
  error_message?:   string;
}

/**
 * Build and validate a prospective order from an investment-USDT amount.
 *
 * Pionex field semantics (must match EF exactly):
 *   MARKET BUY  → `amount` = USDT, rounded to amountPrecision (quote precision)
 *   MARKET SELL → `size`   = base qty, rounded to basePrecision
 *   LIMIT       → `size`   = base qty, rounded to basePrecision + `price`
 *
 * This is the SINGLE source of truth shared by ManualBuyModal preview and
 * preflightLiveOrder (auto-trade validation) — must match EF logic exactly.
 */
export function buildOrder(params: {
  investment:       number;   // desired USDT to spend
  price:            number;   // current market price
  basePrecision:    number;   // quantity_precision from ExchangeMarket
  amountPrecision?: number;   // quote-currency precision for MARKET BUY (default 2)
  stepSize?:        number;   // optional qty step (not used by Pionex spot)
  minTradeAmount?:  number;   // min base-asset qty (for SELL/LIMIT)
  minOrderValue?:   number;   // min USDT amount
  side?:            'BUY' | 'SELL';
  orderType?:       'MARKET' | 'LIMIT';
}): OrderBuildResult {
  const {
    investment, price, basePrecision,
    amountPrecision = 2,
    stepSize, minTradeAmount = 0, minOrderValue = 0,
    side = 'BUY', orderType = 'MARKET',
  } = params;

  const isMarketBuy = side === 'BUY' && orderType === 'MARKET';

  if (price <= 0 || investment <= 0) {
    return {
      amountUsdt: 0, quantity: 0, investment: 0,
      estimated_fee: 0, estimated_total: 0,
      error_code: 'BELOW_MIN_ORDER', error_message: 'Ugyldig pris eller investering.',
    };
  }

  // MARKET BUY: round the USDT investment to amountPrecision (floor)
  const amountFactor   = Math.pow(10, amountPrecision);
  const amountUsdt     = Math.floor(investment * amountFactor) / amountFactor;

  // SELL / LIMIT: round the base qty to basePrecision (floor)
  const qtyRaw         = investment / price;
  const quantity       = floorToStep(qtyRaw, stepSize, basePrecision);

  // Effective investment for fee/total calculations
  const invFinal       = isMarketBuy ? amountUsdt : quantity * price;
  const fee            = estimateFee(invFinal);
  const total          = invFinal + fee;

  if (isMarketBuy && amountUsdt <= 0) {
    return {
      amountUsdt, quantity, investment: invFinal, estimated_fee: fee, estimated_total: total,
      error_code: 'BELOW_MIN_ORDER',
      error_message: `Investering for lav — beregnet USDT-beløp ble 0 etter avrunding.`,
    };
  }

  if (!isMarketBuy && quantity <= 0) {
    return {
      amountUsdt, quantity, investment: invFinal, estimated_fee: fee, estimated_total: total,
      error_code: 'BELOW_MIN_QTY',
      error_message: `Investering for lav — beregnet antall ble 0 etter avrunding.`,
    };
  }

  // minOrderValue applies to MARKET BUY (Pionex minAmount)
  if (minOrderValue > 0 && invFinal < minOrderValue) {
    return {
      amountUsdt, quantity, investment: invFinal, estimated_fee: fee, estimated_total: total,
      error_code: 'BELOW_MIN_ORDER',
      error_message: `Ordrebeløp ${invFinal.toFixed(4)} USDT er under Pionex-minimum ${minOrderValue} USDT.`,
    };
  }

  // minTradeAmount applies to SELL / LIMIT only
  if (!isMarketBuy && minTradeAmount > 0 && quantity < minTradeAmount) {
    const needed = Math.ceil(minTradeAmount * price * 1.01 * 100) / 100;
    return {
      amountUsdt, quantity, investment: invFinal, estimated_fee: fee, estimated_total: total,
      error_code: 'BELOW_MIN_QTY',
      error_message: `Antall ${quantity} er under Pionex-minimum ${minTradeAmount}. Trenger minst ~${needed.toFixed(2)} USDT.`,
    };
  }

  return { amountUsdt, quantity, investment: invFinal, estimated_fee: fee, estimated_total: total };
}

/**
 * Run all client-side safety gates for a live order.
 * Does NOT call place_order. Real Pionex validation is still enforced by pionex-proxy.
 *
 * Symbol resolution:
 *   getMarketInfo receives the UI pair string ("XRP/USDT") and must return the
 *   ExchangeMarketInfo with the canonical Pionex `symbol` field populated.
 *   The returned `preflight.symbol` is always the Pionex-canonical symbol and
 *   must be used verbatim as `order_symbol` when calling place_order.
 */
export async function preflightLiveOrder(params: {
  pair: string;
  side: 'BUY' | 'SELL';
  price: number;
  investment: number;
  signal_id?: string;
  is_pionex_live: boolean;
  is_pionex_connected: boolean;
  getBalance: () => Promise<ExchangeBalanceInfo>;
  /** Receives the UI pair string (e.g. "XRP/USDT"). Must resolve the canonical Pionex symbol. */
  getMarketInfo: (pair: string) => Promise<ExchangeMarketInfo | null>;
  checkDuplicate: (signal_id: string) => Promise<boolean>;
  existing_open_orders?: number;
}): Promise<LiveOrderPreflight> {
  // symbol will be set to the canonical Pionex symbol once market info is fetched.
  // Until then it is a placeholder used only for logging.
  let resolvedSymbol = params.pair.replace('/', ''); // fallback display only
  const gates: PreflightGate[] = [];

  // Gate 1: Pionex connected
  gates.push({
    name: 'Pionex connected',
    pass: params.is_pionex_connected,
    detail: params.is_pionex_connected ? 'connected' : 'not connected',
  });

  // Gate 2: Live trading enabled
  gates.push({
    name: 'Live trading enabled',
    pass: params.is_pionex_live,
    detail: params.is_pionex_live ? 'enabled' : 'disabled',
  });

  // Gate 4: Symbol validation — getMarketInfo resolves the canonical Pionex symbol.
  // Pass the UI pair ("XRP/USDT") so the implementation can match base_asset+quote_asset.
  let marketInfo: ExchangeMarketInfo | null = null;
  let basePrecision   = 8;
  let amountPrecision = 2;
  let minOrderValue   = 0;
  let minTradeAmount  = 0;

  try {
    marketInfo = await params.getMarketInfo(params.pair);
    if (marketInfo) {
      resolvedSymbol  = marketInfo.symbol;
      basePrecision   = marketInfo.quantity_precision   ?? 8;
      amountPrecision = marketInfo.amount_precision     ?? 2;
      minOrderValue   = marketInfo.min_value            ?? 0;
      minTradeAmount  = marketInfo.min_qty              ?? 0;
    }
    gates.push({
      name: 'Valid symbol',
      pass: !!marketInfo,
      detail: marketInfo ? `${params.pair} → ${resolvedSymbol}` : `${params.pair} not found on Pionex`,
    });
  } catch (e) {
    gates.push({ name: 'Valid symbol', pass: false, detail: String(e) });
  }

  // Use buildOrder as single source of truth — matches EF payload exactly.
  // MARKET BUY: amountUsdt (USDT rounded to amountPrecision) is what gets sent.
  const order = buildOrder({
    investment:       params.investment,
    price:            params.price,
    basePrecision,
    amountPrecision,
    minTradeAmount,
    minOrderValue,
    side:             params.side,
    orderType:        'MARKET',
  });

  const quantityRaw     = params.investment / params.price;
  const quantityFinal   = order.quantity;
  const investmentFinal = order.investment;

  gates.push({
    name: 'Amount / Quantity',
    pass: order.amountUsdt > 0 || quantityFinal > 0,
    detail: params.side === 'BUY'
      ? `amount=${order.amountUsdt} USDT (amountPrecision ${amountPrecision})`
      : `qty=${quantityFinal} (basePrecision ${basePrecision})`,
  });

  // Min order value (USDT) — for MARKET BUY uses amountUsdt
  const aboveMin = order.error_code !== 'BELOW_MIN_ORDER';
  gates.push({
    name: 'Min order value',
    pass: aboveMin,
    detail: minOrderValue > 0
      ? `${investmentFinal.toFixed(4)} >= ${minOrderValue} USDT`
      : 'no minimum',
  });

  // Min trade amount (base-asset qty)
  const aboveMinQty = order.error_code !== 'BELOW_MIN_QTY';
  if (minTradeAmount > 0) {
    const neededUsdt = minTradeAmount * params.price;
    gates.push({
      name: 'Min trade amount',
      pass: aboveMinQty,
      detail: aboveMinQty
        ? `${quantityFinal} >= ${minTradeAmount} (min qty)`
        : `${quantityFinal} < ${minTradeAmount} min qty — du trenger minst ${neededUsdt.toFixed(2)} USDT`,
    });
  }

  // Balance check
  let balanceFree = 0;
  let balanceOk = false;
  try {
    const bal = await params.getBalance();
    balanceFree = bal.usdt_available;
    balanceOk = balanceFree >= investmentFinal;
    gates.push({
      name: 'Sufficient balance',
      pass: balanceOk,
      detail: `${balanceFree.toFixed(4)} USDT available / ${investmentFinal.toFixed(4)} needed`,
    });
  } catch (e) {
    gates.push({
      name: 'Sufficient balance',
      pass: false,
      detail: `Balance check failed: ${String(e)}`,
    });
  }

  // Duplicate signal guard
  let duplicate = false;
  if (params.signal_id) {
    try {
      duplicate = await params.checkDuplicate(params.signal_id);
      gates.push({
        name: 'Duplicate signal',
        pass: !duplicate,
        detail: duplicate ? 'signal already has live order' : 'no existing order',
      });
    } catch (e) {
      gates.push({ name: 'Duplicate signal', pass: false, detail: String(e) });
    }
  }

  // Open order limit (one live order at a time)
  gates.push({
    name: 'Open trade limit',
    pass: (params.existing_open_orders ?? 0) === 0,
    detail: `${params.existing_open_orders ?? 0} open`,
  });

  const allPass = gates.every(g => g.pass);

  let errorCode: LiveOrderErrorCode | undefined;
  let errorMessage: string | undefined;

  if (!allPass) {
    const failed = gates.find(g => !g.pass);
    if (!params.is_pionex_connected) {
      errorCode = 'PIONEX_NOT_CONNECTED';
      errorMessage = 'Pionex is not connected';
    } else if (!params.is_pionex_live) {
      errorCode = 'LIVE_TRADING_DISABLED';
      errorMessage = 'Live trading is disabled';
    } else if (!marketInfo) {
      errorCode = 'INVALID_SYMBOL';
      errorMessage = `${params.pair} not found on Pionex (tried symbol lookup by base_asset+quote_asset)`;
    } else if (order.error_code) {
      // Use the error from buildOrder directly — it is the canonical, user-facing reason
      errorCode    = order.error_code;
      errorMessage = order.error_message;
    } else if (!balanceOk) {
      errorCode = 'INSUFFICIENT_BALANCE';
      errorMessage = `Insufficient balance: ${balanceFree.toFixed(4)} USDT free, need ${investmentFinal.toFixed(4)} USDT`;
    } else if (duplicate) {
      errorCode = 'DUPLICATE';
      errorMessage = 'A live order already exists for this signal';
    } else if ((params.existing_open_orders ?? 0) > 0) {
      errorCode = 'OPEN_TRADE_EXISTS';
      errorMessage = 'An open live order already exists';
    } else {
      errorCode = 'REJECTED';
      errorMessage = failed ? `Gate failed: ${failed.name} — ${failed.detail}` : 'Unknown preflight failure';
    }
  }

  return {
    all_pass: allPass,
    gates,
    error_code: errorCode,
    error_message: errorMessage,
    symbol: resolvedSymbol,   // canonical Pionex symbol — use verbatim as order_symbol
    side: params.side,
    pair: params.pair,
    price: params.price,
    investment_raw: params.investment,
    investment_final: investmentFinal,
    amount_usdt_final: order.amountUsdt,
    quantity_raw: quantityRaw,
    quantity_final: quantityFinal,
    base_precision: basePrecision,
    min_order_value: minOrderValue,
    min_trade_amount: minTradeAmount,
    estimated_fee:   order.estimated_fee,
    estimated_total: order.estimated_total,
    pionex_request: 'NOT_SENT',
  };
}

export function formatError(code: LiveOrderErrorCode, detail?: string): string {
  const messages: Record<LiveOrderErrorCode, string> = {
    PIONEX_NOT_CONNECTED: 'Pionex is not connected',
    LIVE_TRADING_DISABLED: 'Live trading is disabled',
    INVALID_SYMBOL: 'Invalid symbol',
    BELOW_MIN_ORDER: 'Order value below minimum',
    BELOW_MIN_QTY: 'Antall under Pionex minimum (amount filter)',
    INSUFFICIENT_BALANCE: 'Insufficient balance',
    BALANCE_CHECK_FAILED: 'Balance check failed',
    DUPLICATE: 'Duplicate signal — order already exists',
    OPEN_TRADE_EXISTS: 'Open trade already exists',
    RATE_LIMITED: 'Pionex rate limited',
    REJECTED: 'Order rejected by Pionex',
    TIMEOUT: 'Request timed out',
    UNKNOWN: 'Unknown error',
  };
  return `${messages[code] ?? 'Unknown error'}${detail ? `: ${detail}` : ''}`;
}
