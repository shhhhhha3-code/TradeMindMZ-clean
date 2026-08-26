import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTrading } from '@/contexts/TradingContext';
import {
  SignalBadge,
  RiskBadge,
  CoinLogo,
} from '@/components/ui/TradingComponents';
import { toast } from 'sonner';
import {
  Loader2,
  AlertTriangle,
  XCircle,
  CheckCircle2,
} from 'lucide-react';
import type { AISignal } from '@/types/types';

interface Props {
  open: boolean;
  onClose: () => void;
  signal: AISignal;
}

export default function ManualSellModal({
  open,
  onClose,
  signal,
}: Props) {
  const {
    isPionexLive,
    pionexAccountStatus,
    dryRunMode,
    executeManualSell,
    liveOrders,
    marketPrices,
  } = useTrading();

  const [loading, setLoading] = useState(false);

  const pionexConnected = pionexAccountStatus === 'connected';

  const currentPrice =
    marketPrices[signal.pair]?.price ??
    signal.current_price;

  // Finn eksisterende åpen live-position på samme pair.
  const normalizedPair = signal.pair.toUpperCase();

  const openOrder = liveOrders.find(order =>
    ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(
      String(order.status).toUpperCase()
    ) &&
    String(order.pair ?? '').toUpperCase() === normalizedPair
  );

  const quantity = Number(openOrder?.filled_qty ?? 0);

  const validationError =
    !pionexConnected
      ? 'Pionex er ikke tilkoblet.'
      : !isPionexLive
      ? 'Live trading er deaktivert.'
      : !openOrder
      ? `Ingen åpen LIVE trade funnet for ${signal.pair}.`
      : quantity <= 0
      ? 'Åpen trade har ingen gyldig quantity.'
      : null;

  const disabled = Boolean(validationError) || loading;

  useEffect(() => {
    if (!open) {
      setLoading(false);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (disabled || !openOrder) return;

    console.log('[MANUAL_SELL_CONFIRM_CLICKED]', {
      pair: signal.pair,
      symbol: openOrder.symbol,
      price: currentPrice,
      quantity,
      pionex_order_id: openOrder.pionex_order_id,
      signal_id: signal.id,
      dryRunMode,
    });

    setLoading(true);

    try {
      const trace = await executeManualSell({
        pair: signal.pair,
        price: currentPrice,
        signal_id: signal.id,
      });

      console.log('[MANUAL_SELL] executeManualSell returned:', {
        error_code: trace.error_code,
        error_message: trace.error_message,
        pionex_order_id: trace.pionex_order_id,
        order_status: trace.order_status,
        pionex_request_sent: trace.pionex_request_sent,
        pionex_http_status: trace.pionex_http_status,
        dry_run: trace.dry_run,
      });

      if (dryRunMode) {
        toast.info('MANUAL SELL DRY RUN', {
          description: `${signal.pair} — ingen ekte SELL ble sendt.`,
        });
        onClose();
        return;
      }

      if (trace.error_code) {
        toast.error(
          `Manual Sell feilet: ${trace.error_message ?? 'Ukjent feil'}`
        );
        return;
      }

      toast.success(`LIVE SELL sendt: ${signal.pair}`, {
        description:
          `Ordre ${trace.pionex_order_id ?? 'ukjent'} • ${trace.order_status ?? 'NEW'}`,
      });

      onClose();
    } catch (err: unknown) {
      console.error('[MANUAL_SELL_MODAL] exception:', err);

      toast.error(
        err instanceof Error
          ? err.message
          : 'Klarte ikke å sende SELL'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-['Space_Grotesk'] text-base flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-destructive text-destructive-foreground">
              LIVE SELL
            </span>
            <span>Selg eksisterende trade</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">

          {/* Warning */}
          <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <strong>
                Dette sender en ekte SELL-ordre til Pionex.
              </strong>

              <div className="opacity-80 mt-0.5">
                {dryRunMode
                  ? 'DRY RUN: Ingen ekte ordre vil bli sendt.'
                  : 'SELL lukker den eksisterende spot-posisjonen.'}
              </div>
            </div>
          </div>

          {/* Signal / coin */}
          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted">
            <div className="flex items-center gap-3">
              <CoinLogo
                symbol={signal.symbol}
                size={40}
              />

              <div>
                <div className="font-semibold text-foreground">
                  {signal.pair}
                </div>

                <div className="text-xs text-muted-foreground">
                  {signal.coin_name}
                </div>
              </div>
            </div>

            <div className="flex flex-col items-end gap-1">
              <SignalBadge type={signal.signal_type} />
              <RiskBadge level={signal.risk_level} />
            </div>
          </div>

          {/* Position information */}
          <div className="grid grid-cols-2 gap-3">

            <div className="p-3 rounded-lg border border-border bg-muted">
              <div className="text-[10px] text-muted-foreground uppercase">
                Nåværende pris
              </div>

              <div className="font-semibold text-foreground">
                ${currentPrice.toLocaleString()}
              </div>
            </div>

            <div className="p-3 rounded-lg border border-border bg-muted">
              <div className="text-[10px] text-muted-foreground uppercase">
                Quantity
              </div>

              <div className="font-semibold text-foreground">
                {quantity > 0
                  ? quantity.toLocaleString(undefined, {
                      maximumFractionDigits: 8,
                    })
                  : '—'}
              </div>
            </div>

          </div>

          {/* Existing order */}
          {openOrder ? (
            <div className="p-3 rounded-lg border border-border bg-muted space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <CheckCircle2 className="w-4 h-4 text-positive" />
                Åpen LIVE trade funnet
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">
                    Status
                  </span>

                  <div className="font-medium">
                    {openOrder.status}
                  </div>
                </div>

                <div>
                  <span className="text-muted-foreground">
                    Pionex Order ID
                  </span>

                  <div className="font-medium truncate">
                    {openOrder.pionex_order_id}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-xs flex items-start gap-2">
              <XCircle className="w-4 h-4 shrink-0" />

              <div>
                <strong>Ingen åpen trade</strong>
                <div className="opacity-80 mt-0.5">
                  Det finnes ingen lokal LIVE-posisjon på {signal.pair}.
                </div>
              </div>
            </div>
          )}

          {/* Validation */}
          {validationError && (
            <div className="p-3 rounded-lg border border-border bg-muted text-xs text-muted-foreground">
              {validationError}
            </div>
          )}

          {/* Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-1">

            <Button
              type="button"
              variant="outline"
              className="h-10"
              onClick={onClose}
              disabled={loading}
            >
              Avbryt
            </Button>

            <Button
              type="button"
              variant="destructive"
              className="h-10 font-semibold"
              onClick={handleConfirm}
              disabled={disabled}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Selger…
                </>
              ) : (
                'SELL LIVE'
              )}
            </Button>

          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}
