import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useTrading } from '@/contexts/TradingContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { StatusPill } from '@/components/ui/TradingComponents';
import { toast } from 'sonner';
import { supabase } from '@/db/supabase';
import {
  getPionexConnection, removePionexConnection,
} from '@/db/api';
import type { PionexConnection, PionexPortfolio } from '@/types/types';
import { Link2, Unlink, RefreshCw, Shield, Eye, EyeOff, AlertTriangle, Loader2, Info, Coins, Wifi, WifiOff, Lock, Zap, Power } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import LivePositionsSection from '@/components/exchange/LivePositionsSection';

export default function ExchangeConnectionsPage() {
  const { user } = useAuth();
  const { isPionexLive, refreshLiveStatus, toggleLiveTrading } = useTrading();
  const [connection, setConnection] = useState<PionexConnection | null>(null);
  const [portfolio, setPortfolio] = useState<PionexPortfolio | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  // Start as false — show UI immediately, load connection in background
  const [loadingConn, setLoadingConn] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [liveTogglePending, setLiveTogglePending] = useState(false);
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [liveConfirmIntent, setLiveConfirmIntent] = useState<boolean>(false);

  useEffect(() => {
    if (!user) return;
    setLoadingConn(true);
    getPionexConnection(user.id)
      .then(c => {
        setConnection(c);
        if (c?.is_connected) loadPortfolio();
      })
      .catch(() => { /* never block the page on DB error */ })
      .finally(() => setLoadingConn(false));
  }, [user]);

  const loadPortfolio = async () => {
    setFetching(true);
    setPortfolioError(null);
    try {
      const { data, error } = await supabase.functions.invoke('pionex-proxy', { method: 'POST', body: { action: 'portfolio' } });
      if (error) throw new Error(await error.context?.text() ?? error.message);
      setPortfolio(data);
    } catch (err: unknown) {
      setPortfolioError(err instanceof Error ? err.message : 'Failed to load Pionex data');
    } finally {
      setFetching(false);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || !apiSecret.trim()) {
      toast.error('Vennligst skriv inn både API-nøkkel og hemmelighet');
      return;
    }
    if (!user) return;
    setLoading(true);
    try {
      // Edge Function validates credentials, signs with correct Pionex HMAC format,
      // and upserts to DB atomically — no separate DB call needed here.
      const { data, error } = await supabase.functions.invoke('pionex-proxy', {
        method: 'POST',
        body: { action: 'connect', api_key: apiKey.trim(), api_secret: apiSecret.trim() },
      });

      if (error) {
        // Try to extract the actual server error message
        let msg = error.message;
        try {
          const text = await error.context?.text?.();
          if (text) {
            const parsed = JSON.parse(text);
            msg = parsed?.error ?? parsed?.message ?? text;
          }
        } catch { /* use original message */ }
        throw new Error(msg);
      }

      // data.error means Pionex rejected the credentials (returned result:false)
      if (data?.error) throw new Error(data.error);

      // Refresh connection state from DB (EF has already upserted it)
      const updated = await getPionexConnection(user.id);
      setConnection(updated);
      setApiKey('');
      setApiSecret('');
      toast.success('Pionex tilkoblet (skrivebeskyttet)');
      loadPortfolio();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Tilkobling mislyktes';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!user) return;
    setLoading(true);
    try {
      await supabase.functions.invoke('pionex-proxy', { method: 'POST', body: { action: 'disconnect' } });
      await removePionexConnection(user.id);
      setConnection(null);
      setPortfolio(null);
      toast.success('Pionex frakoblet');
    } catch {
      toast.error('Frakobling mislyktes');
    } finally {
      setLoading(false);
    }
  };

  if (loadingConn) {
    // Inline skeleton — UI renders instantly, connection status loads below
    return (
      <div className="p-4 md:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold font-['Space_Grotesk'] text-foreground">Exchange Connections</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Connect your Pionex account for read-only portfolio monitoring</p>
        </div>
        <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-muted text-xs text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
          Loading connection status...
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl md:text-2xl font-bold font-['Space_Grotesk'] text-foreground">Exchange Connections</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Connect your Pionex account for read-only portfolio monitoring</p>
      </div>

      {/* Pionex API setup guide */}
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <Info className="w-4 h-4 shrink-0" />
            Viktig: Slik oppretter du API-nøkkel på Pionex
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-foreground space-y-2">
          <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
            <li>Logg inn på <span className="font-medium text-foreground">pionex.com</span> → klikk på profilikon → <span className="font-medium text-foreground">API Management</span></li>
            <li>Klikk <span className="font-medium text-foreground">Create API</span> og gi den et navn (f.eks. «TradeMindMZ»)</li>
            <li className="text-destructive font-medium">
              Under «IP Restriction» — velg <span className="underline">No Restriction</span> (ikke lås til hjemme-IP).
              Appen kjører på en sky-server med en annen IP enn din.
            </li>
            <li>Aktiver <span className="font-medium text-foreground">Enable reading</span> og <span className="font-medium text-foreground">Bot reading</span>. Deaktiver Trade og Withdraw.</li>
            <li>Kopier <span className="font-medium text-foreground">API Key</span> og <span className="font-medium text-foreground">Secret Key</span> direkte — uten ekstra mellomrom.</li>
          </ol>
          <div className="flex items-center gap-1.5 pt-1 text-amber-600 dark:text-amber-400 font-medium">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Feilen «request auth status failed» betyr at IP-begrensning blokkerer tilgang.
          </div>
        </CardContent>
      </Card>

      {/* Security notice */}
      <div className="flex items-start gap-3 p-3 rounded-lg border border-primary/20 bg-primary/5">
        <Shield className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <div className="text-xs text-foreground">
          <span className="font-semibold">Skrivebeskyttet tilgang: </span>
          TradeMindMZ leser kun porteføljedata. Ingen ordre, bots eller overføringer gjøres noen gang. API-hemmeligheten din krypteres og lagres på serveren — aldri returnert til nettleseren.
        </div>
      </div>

      {/* Connection status */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Link2 className="w-4 h-4 text-primary" />
              Pionex
            </CardTitle>
            <StatusPill connected={!!connection?.is_connected} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {connection?.is_connected ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                <div className="p-2 rounded bg-muted border border-border">
                  <div className="text-muted-foreground mb-0.5">Last Sync</div>
                  <div className="font-medium text-foreground">
                    {connection.last_sync ? format(new Date(connection.last_sync), 'MMM d, HH:mm') : 'Never'}
                  </div>
                </div>
                <div className="p-2 rounded bg-muted border border-border">
                  <div className="text-muted-foreground mb-0.5">API Key</div>
                  <div className="font-medium text-foreground font-mono">{connection.api_key.slice(0, 8)}...{connection.api_key.slice(-4)}</div>
                </div>
                <div className="p-2 rounded bg-muted border border-border">
                  <div className="text-muted-foreground mb-0.5">Permissions</div>
                  <div className="font-medium text-success">Read Only</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={loadPortfolio} disabled={fetching} className="gap-2 text-xs">
                  <RefreshCw className={cn('w-3.5 h-3.5', fetching && 'animate-spin')} />
                  Sync Portfolio
                </Button>
                <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={loading}
                  className="gap-2 text-xs text-destructive hover:text-destructive border-destructive/30">
                  <Unlink className="w-3.5 h-3.5" />
                  Disconnect
                </Button>
              </div>
            </>
          ) : (
            <form onSubmit={handleConnect} className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/5 border border-warning/20 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                <span className="text-muted-foreground">Create a <strong className="text-foreground">Read-Only</strong> API key on Pionex (no trading or withdrawal permissions required). Never share a key with withdrawal or trading permissions.</span>
              </div>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="api-key" className="text-xs font-medium mb-1.5 block">API Key</Label>
                  <Input id="api-key" value={apiKey} onChange={e => setApiKey(e.target.value)}
                    placeholder="Enter your Pionex API Key" className="bg-input border-border h-10 px-3 text-sm font-mono" />
                </div>
                <div>
                  <Label htmlFor="api-secret" className="text-xs font-medium mb-1.5 block">API Secret</Label>
                  <div className="relative">
                    <Input id="api-secret" type={showSecret ? 'text' : 'password'} value={apiSecret}
                      onChange={e => setApiSecret(e.target.value)}
                      placeholder="Enter your Pionex API Secret"
                      className="bg-input border-border h-10 px-3 pr-10 text-sm font-mono" />
                    <button type="button" onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                    <Shield className="w-3 h-3" />
                    Secret is encrypted and stored securely — never returned to the browser
                  </p>
                </div>
              </div>
              <Button type="submit" disabled={loading} className="w-full gap-2" style={{ background: 'var(--gradient-primary)' }}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                Connect Pionex (Read-Only)
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Portfolio display */}
      {connection?.is_connected && (
        <>
          {portfolioError && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-destructive/20 bg-destructive/5 text-xs text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>Pionex data temporarily unavailable: {portfolioError}. Other app features continue working normally.</span>
            </div>
          )}

          {fetching ? (
            <div className="space-y-3">
              {/* Section skeletons — show independently while each loads */}
              <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                Loading portfolio data...
              </div>
            </div>
          ) : portfolio ? (
            <div className="space-y-4">
              {/* Balances */}
              <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Coins className="w-4 h-4 text-primary" /> Portfolio Balances
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[400px]">
                      <thead>
                        <tr className="border-b border-border">
                          {['Coin', 'Free', 'Frozen', 'Total', 'USD Value'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-xs text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {portfolio.balances.filter(b => b.total > 0).map(b => (
                          <tr key={b.coin} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-2.5 text-xs font-semibold text-foreground whitespace-nowrap">{b.coin}</td>
                            <td className="px-4 py-2.5 text-xs text-foreground whitespace-nowrap">{b.free.toFixed(6)}</td>
                            <td className="px-4 py-2.5 text-xs text-foreground whitespace-nowrap">{b.freeze.toFixed(6)}</td>
                            <td className="px-4 py-2.5 text-xs font-medium text-foreground whitespace-nowrap">{b.total.toFixed(6)}</td>
                            <td className="px-4 py-2.5 text-xs text-foreground whitespace-nowrap">${b.usd_value.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Running Bots */}
              {portfolio.bots.length > 0 && (
                <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold">Running Grid Bots</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[500px]">
                        <thead>
                          <tr className="border-b border-border">
                            {['Bot Name', 'Pair', 'Investment', 'Total P/L', 'ROI', 'Status'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left text-xs text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {portfolio.bots.map(bot => (
                            <tr key={bot.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-2.5 text-xs font-medium text-foreground whitespace-nowrap">{bot.name}</td>
                              <td className="px-4 py-2.5 text-xs text-foreground whitespace-nowrap">{bot.pair}</td>
                              <td className="px-4 py-2.5 text-xs text-foreground whitespace-nowrap">{bot.investment.toFixed(2)} USDT</td>
                              <td className={cn('px-4 py-2.5 text-xs font-semibold whitespace-nowrap', bot.total_pnl >= 0 ? 'text-positive' : 'text-negative')}>
                                {bot.total_pnl >= 0 ? '+' : ''}{bot.total_pnl.toFixed(2)} USDT
                              </td>
                              <td className={cn('px-4 py-2.5 text-xs font-semibold whitespace-nowrap', bot.roi_pct >= 0 ? 'text-positive' : 'text-negative')}>
                                {bot.roi_pct >= 0 ? '+' : ''}{bot.roi_pct.toFixed(2)}%
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap">
                                <Badge variant="outline" className="text-xs border-success/30 text-success">{bot.status}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Live Positions — READ-ONLY USDT-M futures positions */}
              <LivePositionsSection
                initialPositions={portfolio.positions}
                initialApiOk={portfolio.positions_api_ok}
              />
            </div>
          ) : null}
        </>
      )}

      {/* Pionex diagnostics status badge */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-border bg-muted text-xs">
          {connection?.is_connected
            ? <Wifi className="w-3.5 h-3.5 text-success shrink-0" />
            : <WifiOff className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
          <div>
            <div className="text-[10px] text-muted-foreground">Pionex Connection</div>
            <div className={cn('font-semibold', connection?.is_connected ? 'text-success' : 'text-muted-foreground')}>
              {connection?.is_connected ? 'CONNECTED' : 'DISCONNECTED'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-border bg-muted text-xs">
          {portfolioError
            ? <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0" />
            : <Shield className="w-3.5 h-3.5 text-success shrink-0" />}
          <div>
            <div className="text-[10px] text-muted-foreground">API</div>
            <div className={cn('font-semibold', portfolioError ? 'text-destructive' : 'text-success')}>
              {portfolioError ? 'ERROR' : 'OK'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-border bg-muted text-xs">
          {portfolio
            ? <Coins className="w-3.5 h-3.5 text-success shrink-0" />
            : <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
          <div>
            <div className="text-[10px] text-muted-foreground">Account</div>
            <div className={cn('font-semibold', portfolio ? 'text-success' : 'text-muted-foreground')}>
              {portfolio ? 'AVAILABLE' : 'ERROR'}
            </div>
          </div>
        </div>
        <div className={cn(
          'flex items-center gap-2 p-2.5 rounded-lg border text-xs',
          isPionexLive
            ? 'border-success/40 bg-success/5'
            : 'border-destructive/30 bg-destructive/5'
        )}>
          {isPionexLive
            ? <Zap className="w-3.5 h-3.5 text-success shrink-0" />
            : <Lock className="w-3.5 h-3.5 text-destructive shrink-0" />}
          <div>
            <div className="text-[10px] text-muted-foreground">Live Trading</div>
            <div className={cn('font-bold', isPionexLive ? 'text-success' : 'text-destructive')}>
              {isPionexLive ? '🟢 ON' : '🔴 OFF'}
            </div>
          </div>
        </div>
      </div>

      {/* ── LIVE TRADING status card ───────────────────────────────────────── */}
      <Card className={cn(
        'border-2',
        isPionexLive ? 'border-success/50 bg-success/5' : 'border-destructive/30 bg-destructive/5'
      )}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              {isPionexLive
                ? <Zap className="w-4 h-4 text-success" />
                : <Lock className="w-4 h-4 text-destructive" />}
              LIVE TRADING
              <Badge className={cn(
                'text-xs font-bold px-2 py-0.5 border',
                isPionexLive
                  ? 'border-success/50 text-success bg-success/10'
                  : 'border-destructive/40 text-destructive bg-destructive/10'
              )}>
                {isPionexLive ? '🟢 ON' : '🔴 OFF'}
              </Badge>
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => refreshLiveStatus()}
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Sjekk status
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {isPionexLive ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 rounded-lg border border-success/30 bg-success/5">
                <span className="w-2.5 h-2.5 rounded-full bg-success animate-pulse shrink-0" />
                <p className="text-xs font-semibold text-success">
                  REAL MONEY · LIVE TRADING AKTIVERT
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Live trading er aktivert server-side. Auto Trader kan sende ekte ordre til Pionex. Alle safety-gates gjelder (maks 1 åpen trade, Gate 1–5).
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={liveTogglePending}
                className="w-full h-9 text-xs font-semibold border-destructive/50 text-destructive hover:bg-destructive/10"
                onClick={() => { setLiveConfirmIntent(false); setLiveConfirmOpen(true); }}
              >
                {liveTogglePending
                  ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Slår av…</>
                  : <><Power className="w-3.5 h-3.5 mr-1.5" />Slå av LIVE TRADING</>}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 rounded-lg border border-border bg-muted/40">
                <Shield className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <p className="text-xs text-muted-foreground font-medium">
                  Demo trading only · No real orders
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Live trading er deaktivert server-side. Auto Trader kjører kun i demo-modus. Ingen ekte Pionex-ordre kan sendes.
              </p>
              <Button
                size="sm"
                disabled={liveTogglePending}
                className="w-full h-9 text-xs font-semibold bg-success hover:bg-success/90 text-success-foreground"
                onClick={() => { setLiveConfirmIntent(true); setLiveConfirmOpen(true); }}
              >
                {liveTogglePending
                  ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Slår på…</>
                  : <><Zap className="w-3.5 h-3.5 mr-1.5" />Slå på LIVE TRADING</>}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── LIVE TRADING bekreftelsesdialog ───────────────────────────────── */}
      <AlertDialog open={liveConfirmOpen} onOpenChange={setLiveConfirmOpen}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {liveConfirmIntent
                ? <><Zap className="w-4 h-4 text-warning" />⚠️ AKTIVER LIVE TRADING</>
                : <><Power className="w-4 h-4 text-destructive" />Slå av LIVE TRADING?</>}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm space-y-1">
              {liveConfirmIntent ? (
                <>
                  <span className="block">Dette tillater Auto Trader å sende ekte ordre til Pionex med ekte penger.</span>
                  <span className="block font-semibold text-warning">Kun Pionex sine egne markedsregler begrenser ordrebeløpet.</span>
                  <span className="block">Er du sikker?</span>
                </>
              ) : (
                <>
                  <span className="block">Auto Trader kan ikke åpne nye ekte handler.</span>
                  <span className="block text-muted-foreground">Allerede åpne live-trades påvirkes ikke — de overvåkes og lukkes normalt via TP/SL.</span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                liveConfirmIntent
                  ? 'bg-success hover:bg-success/90 text-success-foreground'
                  : 'bg-destructive hover:bg-destructive/90 text-destructive-foreground'
              )}
              onClick={async () => {
                setLiveConfirmOpen(false);
                setLiveTogglePending(true);
                try {
                  const newState = await toggleLiveTrading(liveConfirmIntent);
                  toast.success(newState
                    ? '🟢 LIVE TRADING aktivert — ekte Pionex-ordre er nå tillatt.'
                    : '🔴 LIVE TRADING deaktivert — kun demo-modus.');
                } catch (e) {
                  toast.error(`Kunne ikke endre live-status: ${String(e)}`);
                } finally {
                  setLiveTogglePending(false);
                }
              }}
            >
              {liveConfirmIntent ? 'Ja, aktiver LIVE TRADING' : 'Slå av'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex items-start gap-2 p-3 rounded-lg border border-border bg-muted text-xs text-muted-foreground">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          {isPionexLive
            ? `Live trading er PÅ. Auto Trader kan sende ekte Pionex-ordre (maks 1 åpen trade). Demo trading fungerer som normalt parallelt.`
            : 'Live trading er AV. TradeMindMZ er i demo-modus. Ingen ekte ordre, bots eller overføringer kan gjøres. Status kontrolleres kun server-side.'}
        </span>
      </div>
    </div>
  );
}
