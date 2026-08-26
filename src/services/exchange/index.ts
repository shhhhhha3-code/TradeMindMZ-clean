/**
 * Exchange service — eksport-inngangspunkt.
 *
 * Bruk:
 *   import { getPionexProvider, getMockProvider, LIVE_TRADING_ENABLED } from '@/services/exchange';
 *
 * FASE 1/2: LIVE_TRADING_ENABLED = false (frontend-konstant).
 *   - getPionexProvider() returnerer READ-ONLY instans.
 *   - getMockProvider() returnerer testinstans (placeOrder blokkert med mindre allowOrders=true).
 *   - Ingen av disse er koblet til Auto Trader i FASE 1.
 *
 * FASE 3: Server-side LIVE_TRADING_ENABLED=true aktiverer ekte Pionex execution.
 *   - TradingContext spør EF live_status for å avgjøre om live modus er aktiv.
 *   - getPionexProvider() brukes da som execution backend i stedet for Mock.
 */

export { LIVE_TRADING_ENABLED, OrderBlockedError } from './types';
export type {
  TradingExecutionProvider,
  ExchangeBalance,
  ExchangeMarket,
  ExchangeOrder,
  PlaceOrderParams,
  CloseOrderParams,
  ExecutionResult,
  OrderStatus,
} from './types';

export { PionexExchangeProvider } from './PionexExchangeProvider';
export { MockExchangeProvider } from './MockExchangeProvider';
export type { MockOrderOutcome } from './MockExchangeProvider';

import { PionexExchangeProvider } from './PionexExchangeProvider';
import { MockExchangeProvider } from './MockExchangeProvider';
import type { MockProviderOptions } from './MockExchangeProvider';
export type { MockProviderOptions } from './MockExchangeProvider';

/** Returnerer singleton Pionex READ-ONLY provider. */
let _pionexInstance: PionexExchangeProvider | null = null;
export function getPionexProvider(): PionexExchangeProvider {
  if (!_pionexInstance) _pionexInstance = new PionexExchangeProvider();
  return _pionexInstance;
}

/** Returnerer ny Mock-instans med valgfrie innstillinger. */
export function getMockProvider(options?: MockProviderOptions): MockExchangeProvider {
  return new MockExchangeProvider(options);
}
