import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { CoinLogo } from '@/components/ui/TradingComponents';
import { useState } from 'react';
import { useTrading } from '@/contexts/TradingContext';
import { toast } from 'sonner';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { DemoTrade } from '@/types/types';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  trade: DemoTrade;
}

export default function DemoSellModal({ open, onClose, trade }: Props) {
  const { executeDemoSell, marketPrices } = useTrading();
  const [loading, setLoading] = useState(false);

  const sellPrice = trade.current_price ?? marketPrices[trade.pair]?.price ?? trade.buy_price;
  const finalValue = sellPrice * trade.quantity;
  const pnl = finalValue - trade.investment;
  const pnlPct = (pnl / trade.investment) * 100;
  const isProfit = pnl >= 0;

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await executeDemoSell(trade.id, 'manual');
      toast.success(`Trade closed: ${isProfit ? '+' : ''}${pnl.toFixed(2)} USDT`, {
        description: 'SIMULATED — No real money involved'
      });
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to close trade');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-['Space_Grotesk'] text-base flex items-center gap-2">
            <span className="demo-badge">CLOSE DEMO TRADE</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Coin info */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted border border-border">
            <CoinLogo symbol={trade.symbol} size={36} />
            <div>
              <div className="font-semibold text-foreground">{trade.pair}</div>
              <div className="text-xs text-muted-foreground">{trade.coin_name}</div>
            </div>
          </div>

          {/* Trade details */}
          <div className="space-y-2">
            {[
              ['Entry Price', `$${trade.buy_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: trade.buy_price < 1 ? 6 : 2 })}`],
              ['Current Price', `$${sellPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: sellPrice < 1 ? 6 : 2 })}`],
              ['Quantity', trade.quantity.toFixed(6)],
              ['Investment', `${trade.investment.toFixed(2)} USDT`],
              ['Current Value', `${finalValue.toFixed(2)} USDT`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between items-center py-1.5 border-b border-border last:border-0">
                <span className="text-xs text-muted-foreground">{k}</span>
                <span className="text-xs font-medium text-foreground">{v}</span>
              </div>
            ))}
          </div>

          <Separator className="bg-border" />

          {/* P/L summary */}
          <div className={cn('p-4 rounded-lg border text-center', isProfit ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5')}>
            <div className="text-sm text-muted-foreground mb-1">Profit / Loss</div>
            <div className={cn('text-2xl font-bold font-["Space_Grotesk"]', isProfit ? 'text-positive' : 'text-negative')}>
              {isProfit ? '+' : ''}{pnl.toFixed(2)} USDT
            </div>
            <div className={cn('text-sm font-medium mt-1', isProfit ? 'text-positive' : 'text-negative')}>
              {isProfit ? '+' : ''}{pnlPct.toFixed(2)}%
            </div>
          </div>

          <div className="flex items-start gap-2 text-xs text-muted-foreground p-2.5 rounded-lg bg-warning/5 border border-warning/20">
            <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
            This is a SIMULATED trade. No real money is involved.
          </div>

          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose} className="flex-1" disabled={loading}>Cancel</Button>
            <Button onClick={handleConfirm} disabled={loading}
              className="flex-1"
              style={{ background: isProfit ? 'hsl(var(--success))' : 'hsl(var(--destructive))' }}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Confirm Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
