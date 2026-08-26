import { useState, useMemo, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useTrading } from '@/contexts/TradingContext';
import { SignalBadge, RiskBadge, CoinLogo } from '@/components/ui/TradingComponents';
import { toast } from 'sonner';
import { Loader2, AlertTriangle, Zap, RefreshCw } from 'lucide-react';
import type { AISignal } from '@/types/types';
import {
  buildOrder,
  investmentFromPercent,
  type OrderBuildResult,
} from '@/lib/live-order-utils';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  signal: AISignal;
}

const PCT_PRESETS = [25, 50, 75, 100] as const;

interface MarketData {
  basePrecision:   number;
  amountPrecision: number;
  minTradeAmount:  number;
  minOrderValue:   number;
}

export default function ManualBuyModal({ open, onClose, signal }: Props) {
  const {
    isPionexLive,
    pionexAccountStatus,
    dryRunMode,
    executeManualBuy,
    marketPrices,
    getBalance,
    getMarketInfo,
  } = useTrading();

  // ── Live balance + market info ────────────────────────────────────────────
  const [usdtAvailable, setUsdtAvailable] = useState<number | null>(null);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  const fetchInfo = useCallback(async () => {
    setLoadingInfo(true);
    setInfoError(null);
    try {
      const [bal, mkt] = await Promise.all([
        getBalance(),
        getMarketInfo(signal.pair),
      ]);
      setUsdtAvailable(bal.usdt_available);
      if (mkt) {
        setMarketData({
          basePrecision:   mkt.quantity_precision ?? 8,
          amountPrecision: mkt.amount_precision   ?? 2,
          minTradeAmount:  mkt.min_qty            ?? 0,
          minOrderValue:   mkt.min_value          ?? 0,
        });
      } else {
        setMarketData({ basePrecision: 8, amountPrecision: 2, minTradeAmount: 0, minOrderValue: 0 });
      }
    } catch (e) {
      setInfoError('Kunne ikke hente saldo / market-info');
      console.error('[MANUAL_BUY_MODAL] fetchInfo error:', e);
    } finally {
      setLoadingInfo(false);
    }
  }, [getBalance, getMarketInfo, signal.pair]);

  // Fetch on open; reset state when modal closes
  useEffect(() => {
    if (open) {
      fetchInfo();
    } else {
      setUsdtAvailable(null);
      setMarketData(null);
      setInfoError(null);
      setSelectedPct(25);
      setCustomAmount('');
      setIsCustom(false);
    }
  }, [open, fetchInfo]);

  // ── Amount selection ──────────────────────────────────────────────────────
  const [selectedPct, setSelectedPct] = useState<typeof PCT_PRESETS[number]>(25);
  const [customAmount, setCustomAmount] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(false);

  const pionexConnected = pionexAccountStatus === 'connected';
  const currentPrice    = marketPrices[signal.pair]?.price ?? signal.current_price;

  // Investment derived from % of live balance
  const investmentFromPct: number = useMemo(() => {
    if (usdtAvailable == null || usdtAvailable <= 0) return 0;
    return investmentFromPercent(usdtAvailable, selectedPct);
  }, [usdtAvailable, selectedPct]);

  const effectiveAmount: number = isCustom
    ? (parseFloat(customAmount) || 0)
    : investmentFromPct;

  // Order preview using shared buildOrder — same logic as preflight + EF
  // MARKET BUY uses amountUsdt (USDT rounded to amountPrecision), not qty.
  const orderPreview: OrderBuildResult = useMemo(() => {
    if (!marketData || effectiveAmount <= 0 || currentPrice <= 0) {
      return {
        amountUsdt: 0, quantity: 0, investment: 0,
        estimated_fee: 0, estimated_total: 0,
        error_code: undefined, error_message: undefined,
      };
    }
    return buildOrder({
      investment:       effectiveAmount,
      price:            currentPrice,
      basePrecision:    marketData.basePrecision,
      amountPrecision:  marketData.amountPrecision,
      minTradeAmount:   marketData.minTradeAmount,
      minOrderValue:    marketData.minOrderValue,
      side:             'BUY',
      orderType:        'MARKET',
    });
  }, [effectiveAmount, currentPrice, marketData]);

  // ── Validation ────────────────────────────────────────────────────────────
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!pionexConnected) errors.push('Pionex ikke tilkoblet');
    if (!isPionexLive) errors.push('Live trading deaktivert');
    if (loadingInfo) errors.push('Henter saldo…');
    if (infoError) errors.push(infoError);
    if (effectiveAmount <= 0) errors.push('Velg et beløp');
    if (orderPreview.error_message) errors.push(orderPreview.error_message);
    return errors;
  }, [pionexConnected, isPionexLive, loadingInfo, infoError, effectiveAmount, orderPreview]);

  const disabled = validation.length > 0 || loading;
  const disabledReason = validation[0];

  // ── Confirm handler ───────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (disabled) return;
    console.log('[MANUAL_BUY_CONFIRM_CLICKED]', {
      pair: signal.pair,
      price: currentPrice,
      investment: effectiveAmount,
      signal_id: signal.id,
      dryRunMode,
      pionexConnected,
      isPionexLive,
      usdtAvailable,
      orderPreview,
    });
    setLoading(true);
    try {
      console.log('[MANUAL_BUY] calling executeManualBuy…');
      const trace = await executeManualBuy({
        pair:       signal.pair,
        price:      currentPrice,
        investment: effectiveAmount,
        amountUsdt:  orderPreview.amountUsdt,
        signal_id:  signal.id,
      });

      console.log('[MANUAL_BUY] executeManualBuy returned:', {
        error_code:             trace.error_code,
        error_message:          trace.error_message,
        preflight_all_pass:     trace.preflight?.all_pass,
        preflight_error_code:   trace.preflight?.error_code,
        preflight_error_message:trace.preflight?.error_message,
        place_order_called:     trace.place_order_called,
        pionex_request_sent:    trace.pionex_request_sent,
        pionex_http_status:     trace.pionex_http_status,
        pionex_order_id:        trace.pionex_order_id,
        order_status:           trace.order_status,
        live_orders_record_created: trace.live_orders_record_created,
        dry_run:                trace.dry_run,
      });

      if (dryRunMode) {
        toast.info('MANUAL BUY DRY RUN', {
          description: `${signal.pair} — Pionex request NOT SENT`,
        });
        onClose();
        return;
      }

      if (trace.error_code || !trace.preflight?.all_pass) {
        toast.error(`Manual Buy feilet: ${trace.error_message ?? 'Ukjent feil'}`);
        return;
      }

      toast.success(`LIVE BUY sendt: ${signal.pair}`, {
        description: `Ordre ${trace.pionex_order_id ?? 'ukjent'} • ${trace.order_status ?? 'NEW'}`,
      });
      onClose();
    } catch (err: unknown) {
      console.error('[MANUAL_BUY] exception thrown:', err);
      toast.error(err instanceof Error ? err.message : 'Klarte ikke å legge inn live-ordre');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-['Space_Grotesk'] text-base flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-destructive text-destructive-foreground">LIVE BUY</span>
            <span>Ekte handel</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Live warning */}
          <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <strong>Dette sender en ekte BUY-ordre til Pionex med ekte midler.</strong>
              <div className="opacity-80 mt-0.5">
                {dryRunMode ? 'DRY RUN: Ingen ekte ordre vil bli sendt.' : 'Bekreft kun hvis du vil handle live.'}
              </div>
            </div>
          </div>

          {/* Coin info */}
          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted">
            <div className="flex items-center gap-3">
              <CoinLogo symbol={signal.symbol} size={40} />
              <div>
                <div className="font-semibold text-foreground">{signal.pair}</div>
                <div className="text-xs text-muted-foreground">{signal.coin_name}</div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <SignalBadge type={signal.signal_type} />
              <RiskBadge level={signal.risk_level} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg border border-border bg-muted">
              <div className="text-[10px] text-muted-foreground uppercase">Inngang / Nåværende</div>
              <div className="font-semibold text-foreground">${currentPrice.toLocaleString()}</div>
            </div>
            <div className="p-3 rounded-lg border border-border bg-muted">
              <div className="text-[10px] text-muted-foreground uppercase flex items-center gap-1">
                Tilgjengelig USDT
                {loadingInfo && <Loader2 className="w-3 h-3 animate-spin" />}
              </div>
              {usdtAvailable != null ? (
                <div className="font-semibold text-foreground">{usdtAvailable.toFixed(4)} USDT</div>
              ) : loadingInfo ? (
                <div className="h-5 w-24 bg-muted-foreground/20 rounded animate-pulse" />
              ) : (
                <div className="text-xs text-muted-foreground">—</div>
              )}
            </div>
          </div>

          {/* Percent-based amount selector */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-foreground">Investering (% av tilgjengelig)</Label>
              <button
                type="button"
                onClick={fetchInfo}
                disabled={loadingInfo}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                title="Oppdater saldo"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', loadingInfo && 'animate-spin')} />
              </button>
            </div>

            {/* Percent presets */}
            <div className="flex gap-2">
              {PCT_PRESETS.map(pct => (
                <Button
                  key={pct}
                  type="button"
                  size="sm"
                  variant={!isCustom && selectedPct === pct ? 'default' : 'outline'}
                  onClick={() => { setSelectedPct(pct); setIsCustom(false); }}
                  className="flex-1"
                >
                  {pct}%
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant={isCustom ? 'default' : 'outline'}
                onClick={() => {
                  setIsCustom(true);
                  setCustomAmount(investmentFromPct > 0 ? investmentFromPct.toFixed(4) : '');
                }}
                className="flex-1"
              >
                Tilpasset
              </Button>
            </div>

            {/* Derived USDT amount display */}
            {!isCustom && usdtAvailable != null && (
              <div className="text-xs text-muted-foreground px-1">
                {selectedPct}% av {usdtAvailable.toFixed(4)} USDT
                {' = '}
                <span className="text-foreground font-medium">{investmentFromPct.toFixed(4)} USDT</span>
              </div>
            )}

            {isCustom && (
              <Input
                type="number"
                min={0.01}
                step={0.01}
                value={customAmount}
                onChange={e => setCustomAmount(e.target.value)}
                placeholder="Skriv ønsket USDT-beløp"
                className="mt-1"
              />
            )}
          </div>

          {/* Order summary */}
          <div className="p-3 rounded-lg border border-border bg-muted space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Par</span>
              <span className="font-medium text-foreground">{signal.pair}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Side</span>
              <span className="font-medium text-success">BUY</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Inngang / Nåværende</span>
              <span className="font-medium text-foreground">${currentPrice.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ønsket investering</span>
              <span className="font-medium text-foreground">{effectiveAmount.toFixed(4)} USDT</span>
            </div>
            {/* amountUsdt = the USDT value actually sent to Pionex as `amount` field */}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Beløp til Pionex (amount)</span>
              <span className="font-medium text-foreground">
                {orderPreview.amountUsdt > 0
                  ? `${orderPreview.amountUsdt} USDT`
                  : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Estimert gebyr</span>
              <span className="font-medium text-foreground">
                {orderPreview.estimated_fee > 0
                  ? `${orderPreview.estimated_fee.toFixed(4)} USDT`
                  : '—'}
              </span>
            </div>
            <Separator className="my-2" />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Estimert totalkost</span>
              <span className="font-bold text-foreground">
                {orderPreview.estimated_total > 0
                  ? `${orderPreview.estimated_total.toFixed(4)} USDT`
                  : '—'}
              </span>
            </div>
            {marketData && (
              <>
                {marketData.minOrderValue > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Min. ordrebeløp</span>
                    <span className="text-muted-foreground">{marketData.minOrderValue} USDT</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Beløpspresisjon</span>
                  <span className="text-muted-foreground">{marketData.amountPrecision} desimaler</span>
                </div>
              </>
            )}
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Grense</span>
              <span className="text-muted-foreground">Pionex markedsregler</span>
            </div>
          </div>

          {/* Validation error */}
          {disabledReason && !loadingInfo && (
            <div className="text-xs text-destructive flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{disabledReason}</span>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={loading}>
              Avbryt
            </Button>
            <Button
              className={cn(
                'flex-1',
                dryRunMode
                  ? 'bg-warning text-warning-foreground hover:bg-warning/90'
                  : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              )}
              onClick={handleConfirm}
              disabled={disabled}
            >
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {dryRunMode ? (
                <><Zap className="w-4 h-4 mr-2" />Tørrkjør kjøp</>
              ) : (
                <><Zap className="w-4 h-4 mr-2" />Bekreft live-kjøp</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
