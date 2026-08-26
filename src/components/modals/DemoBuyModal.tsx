import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useTrading } from '@/contexts/TradingContext';
import { SignalBadge, RiskBadge, CoinLogo } from '@/components/ui/TradingComponents';
import { toast } from 'sonner';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { AISignal } from '@/types/types';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  signal: AISignal;
}

const PRESET_AMOUNTS = [25, 50, 100, 250];

export default function DemoBuyModal({ open, onClose, signal }: Props) {
  const { demoAccount, executeDemoBuy, marketPrices } = useTrading();
  const [amount, setAmount] = useState<number>(50);
  const [customAmount, setCustomAmount] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(false);

  const currentPrice = marketPrices[signal.pair]?.price ?? signal.current_price;
  const effectiveAmount = isCustom ? (parseFloat(customAmount) || 0) : amount;
  const quantity = effectiveAmount > 0 ? effectiveAmount / currentPrice : 0;
  const availableBalance = demoAccount?.balance ?? 0;
  const exceedsBalance = effectiveAmount > availableBalance;
  const rr = `1 : ${signal.risk_reward}`;

  const handleConfirm = async () => {
    if (exceedsBalance) { toast.error('Insufficient demo balance'); return; }
    if (effectiveAmount < 1) { toast.error('Minimum trade amount is 1 USDT'); return; }
    setLoading(true);
    try {
      await executeDemoBuy({
        symbol: signal.symbol,
        pair: signal.pair,
        coin_name: signal.coin_name,
        buy_price: currentPrice,
        investment: effectiveAmount,
        stop_loss: signal.stop_loss,
        take_profit: signal.take_profit_1,
        signal_id: signal.id,
        signal_type: signal.signal_type === 'SELL' ? 'SELL' : 'BUY',
        ai_confidence: signal.confidence,
      });
      toast.success(`Demo trade opened: ${effectiveAmount} USDT on ${signal.pair}`, {
        description: 'SIMULATED — No real money involved'
      });
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to open trade');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-['Space_Grotesk'] text-base flex items-center gap-2">
            <span className="demo-badge">DEMO BUY</span>
            <span>Simulated Trade</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
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

          {/* Price info grid */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {[
              ['Current Price', `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: currentPrice < 1 ? 6 : 2 })}`],
              ['Entry Zone', `$${signal.entry_zone_low.toLocaleString()} – $${signal.entry_zone_high.toLocaleString()}`],
              ['Stop Loss', `$${signal.stop_loss.toLocaleString()}`],
              ['Take Profit', `$${signal.take_profit_1.toLocaleString()}`],
              ['Risk / Reward', rr],
              ['AI Confidence', `${signal.confidence}/100`],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col p-2 rounded bg-muted border border-border">
                <span className="text-xs text-muted-foreground">{k}</span>
                <span className="text-xs font-semibold text-foreground mt-0.5">{v}</span>
              </div>
            ))}
          </div>

          <Separator className="bg-border" />

          {/* Amount selection */}
          <div>
            <Label className="text-sm font-medium mb-2 block">Trade Amount</Label>
            <div className="grid grid-cols-4 gap-2 mb-2">
              {PRESET_AMOUNTS.map(a => (
                <Button key={a} variant="outline" size="sm"
                  className={cn('text-xs h-9', !isCustom && amount === a && 'border-primary text-primary bg-primary/10')}
                  onClick={() => { setAmount(a); setIsCustom(false); }}>
                  {a} USDT
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm"
                className={cn('text-xs h-9 shrink-0', isCustom && 'border-primary text-primary bg-primary/10')}
                onClick={() => setIsCustom(true)}>
                Custom
              </Button>
              {isCustom && (
                <Input value={customAmount} onChange={e => setCustomAmount(e.target.value)}
                  placeholder="Enter USDT amount" type="number" min="1"
                  className="h-9 bg-input border-border px-3 text-sm" />
              )}
            </div>
          </div>

          {/* Trade summary */}
          <div className="p-3 rounded-lg border border-border bg-muted space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Investment</span>
              <span className="font-semibold text-foreground">{effectiveAmount.toFixed(2)} USDT</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Position Size</span>
              <span className="font-semibold text-foreground">≈ {quantity.toFixed(6)} {signal.symbol}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Available Balance</span>
              <span className={cn('font-semibold', exceedsBalance ? 'text-destructive' : 'text-positive')}>
                {availableBalance.toFixed(2)} USDT
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Balance After Trade</span>
              <span className="font-semibold text-foreground">
                {Math.max(0, availableBalance - effectiveAmount).toFixed(2)} USDT
              </span>
            </div>
          </div>

          {exceedsBalance && (
            <div className="flex items-center gap-2 text-xs text-destructive p-2.5 rounded-lg bg-destructive/10 border border-destructive/20">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Amount exceeds available demo balance
            </div>
          )}

          {/* Disclaimer */}
          <div className="flex items-start gap-2 text-xs text-muted-foreground p-2.5 rounded-lg bg-warning/5 border border-warning/20">
            <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
            <span>This is a SIMULATED trade using virtual funds only. No real money is involved. This is not financial advice.</span>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose} className="flex-1" disabled={loading}>Cancel</Button>
            <Button onClick={handleConfirm} disabled={loading || exceedsBalance || effectiveAmount < 1}
              className="flex-1" style={{ background: 'var(--gradient-primary)' }}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Confirm Demo Buy
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
