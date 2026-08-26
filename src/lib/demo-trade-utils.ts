import type { DemoTrade } from '@/types/types';

/**
 * Determine the explicit side of a demo trade.
 * - signal_type === 'SELL' → SHORT
 * - All other values (including null/undefined) → LONG
 *
 * This avoids inferring direction from buy_price or TP/SL values.
 */
export function getTradeSide(trade: DemoTrade): 'LONG' | 'SHORT' {
  return trade.signal_type === 'SELL' ? 'SHORT' : 'LONG';
}

/**
 * Evaluate a demo trade against a live price to see if TP or SL is triggered.
 * Pure function — no side effects, no state mutations.
 *
 * LONG (BUY):
 *   TP: price >= take_profit
 *   SL: price <= stop_loss
 *
 * SHORT (SELL):
 *   TP: price <= take_profit
 *   SL: price >= stop_loss
 */
export function evaluateDemoTradeTPSL(
  trade: DemoTrade,
  price: number,
): {
  triggered: boolean;
  reason: 'take_profit' | 'stop_loss' | null;
  side: 'LONG' | 'SHORT';
} {
  const side = getTradeSide(trade);
  const { take_profit, stop_loss } = trade;
  let reason: 'take_profit' | 'stop_loss' | null = null;

  if (side === 'LONG') {
    if (take_profit != null && price >= take_profit) {
      reason = 'take_profit';
    } else if (stop_loss != null && price <= stop_loss) {
      reason = 'stop_loss';
    }
  } else {
    if (take_profit != null && price <= take_profit) {
      reason = 'take_profit';
    } else if (stop_loss != null && price >= stop_loss) {
      reason = 'stop_loss';
    }
  }

  return { triggered: reason != null, reason, side };
}

/**
 * Format a demo-trade check as a stable, greppable log line.
 */
export function formatDemoTradeCheck(
  trade: DemoTrade,
  price: number,
  result: ReturnType<typeof evaluateDemoTradeTPSL>,
): string {
  const side = result.side;
  const triggered = String(result.triggered);
  return `[DEMO_TRADE_CHECK] symbol=${trade.pair} side=${side} current=${price} stopLoss=${trade.stop_loss ?? 'none'} takeProfit=${trade.take_profit ?? 'none'} triggered=${triggered}${result.reason ? ` reason=${result.reason}` : ''}`;
}
