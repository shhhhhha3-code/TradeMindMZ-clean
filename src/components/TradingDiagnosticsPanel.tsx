import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useTrading } from '@/contexts/TradingContext';
import { toast } from 'sonner';
import { Terminal, Zap, RefreshCw } from 'lucide-react';

export default function TradingDiagnosticsPanel() {
  const {
    dryRunMode,
    setDryRunMode,
    manualBuyTrace,
    autoTradeTrace,
    refreshLiveOrders,
  } = useTrading();

  const renderTrace = (trace: typeof manualBuyTrace) => {
    if (!trace) {
      return <p className="text-xs text-muted-foreground">No trace yet. Run a Manual Buy or Auto Trade.</p>;
    }

    return (
      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <Badge variant={trace.error_code ? 'destructive' : 'default'}>
            {trace.error_code ? 'FAIL' : 'PASS'}
          </Badge>
          <span className="font-semibold text-foreground uppercase">{trace.mode}</span>
          <span className="text-muted-foreground">{new Date(trace.timestamp).toLocaleString()}</span>
          {trace.dry_run && <Badge variant="outline">DRY RUN</Badge>}
        </div>
        {trace.pair && (
          <div className="text-foreground">Pair: <span className="font-medium">{trace.pair}</span></div>
        )}
        {trace.signal_id && (
          <div className="text-foreground">Signal ID: <span className="font-mono">{trace.signal_id}</span></div>
        )}
        <div className="text-foreground">
          Triggered: <span className="font-medium">{trace.triggered ? 'Yes' : 'No'}</span>
        </div>
        <div className="text-foreground">
          place_order called: <span className="font-medium">{trace.place_order_called ? 'Yes' : 'No'}</span>
        </div>
        <div className="text-foreground">
          Pionex request sent: <span className="font-medium">{trace.pionex_request_sent ? 'Yes' : 'No'}</span>
        </div>
        <div className="text-foreground">
          Pionex HTTP status: <span className="font-mono">{String(trace.pionex_http_status ?? 'N/A')}</span>
        </div>
        <div className="text-foreground">
          Pionex order ID: <span className="font-mono">{trace.pionex_order_id ?? 'N/A'}</span>
        </div>
        <div className="text-foreground">
          live_orders record: <span className="font-medium">{trace.live_orders_record_created ? 'Yes' : 'No'}</span>
        </div>
        <div className="text-foreground">
          Order status: <span className="font-mono">{trace.order_status ?? 'N/A'}</span>
        </div>
        {trace.preflight && (
          <div className="mt-2 p-2 rounded border border-border bg-muted">
            <div className="font-semibold text-foreground mb-1">
              Preflight gates: {trace.preflight.all_pass ? 'ALL PASS' : 'FAILED'}
            </div>
            <div className="space-y-1">
              {trace.preflight.gates.map(g => (
                <div key={g.name} className="flex items-center justify-between gap-2">
                  <span className={g.pass ? 'text-success' : 'text-destructive'}>
                    {g.pass ? '✓' : '✗'} {g.name}
                  </span>
                  <span className="text-muted-foreground text-right truncate">{g.detail}</span>
                </div>
              ))}
            </div>
            {trace.preflight.error_message && (
              <div className="mt-2 text-destructive font-medium">{trace.preflight.error_message}</div>
            )}
            <Separator className="my-2" />
            <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
              <div>Investment: {trace.preflight.investment_final.toFixed(4)} USDT</div>
              <div>Qty: {trace.preflight.quantity_final.toFixed(8)}</div>
              <div>Symbol: {trace.preflight.symbol}</div>
              <div>Precision: {trace.preflight.base_precision}</div>
              <div>Min order: {trace.preflight.min_order_value} USDT</div>
              <div>Est. fee: {trace.preflight.estimated_fee.toFixed(4)} USDT</div>
              <div>Est. total: {trace.preflight.estimated_total.toFixed(4)} USDT</div>
            </div>
          </div>
        )}
        {trace.error_message && (
          <div className="text-destructive font-medium">{trace.error_code}: {trace.error_message}</div>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Terminal className="w-4 h-4" />
          Trading Diagnostics
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted">
          <div className="flex items-center gap-3">
            <Zap className="w-4 h-4 text-warning" />
            <div>
              <div className="text-sm font-medium text-foreground">Dry-run mode</div>
              <div className="text-xs text-muted-foreground">Run gates without sending real orders to Pionex</div>
            </div>
          </div>
          <Switch
            id="dry-run-mode"
            checked={dryRunMode}
            onCheckedChange={setDryRunMode}
          />
        </div>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" className="gap-1" onClick={() => { refreshLiveOrders(); toast.info('Live orders refreshed'); }}>
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh live orders
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-3 rounded-lg border border-border bg-muted">
            <div className="font-semibold text-sm text-foreground mb-2">Manual Buy Trace</div>
            {renderTrace(manualBuyTrace)}
          </div>
          <div className="p-3 rounded-lg border border-border bg-muted">
            <div className="font-semibold text-sm text-foreground mb-2">Auto Trade Trace</div>
            {renderTrace(autoTradeTrace)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
