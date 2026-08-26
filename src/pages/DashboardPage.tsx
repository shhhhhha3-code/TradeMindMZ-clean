import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTrading } from '@/contexts/TradingContext';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, ReferenceLine
} from 'recharts';
import {
  ConfidenceRing, SignalBadge, PnLValue, PnLPct,
  CoinLogo, DemoBadge, CardSkeleton
} from '@/components/ui/TradingComponents';
import {
  TrendingUp, TrendingDown, Wallet, BarChart2, Bot, Activity,
  RefreshCw, ArrowRight, Brain, Layers,
  AlertTriangle, Zap, ClipboardCopy, Server, Cpu, Radio, CheckCircle2,
  AlertCircle, Clock, Terminal, ChevronDown, Globe
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { AISignal, PionexConnection, PionexPosition } from '@/types/types';
import type { DemoTradeHistory, DemoTrade } from '@/types/types';
import { getPionexConnection, type LiveOrder } from '@/db/api';
import { supabase } from '@/db/supabase';
import ManualBuyModal from '@/components/modals/ManualBuyModal';
import TradingDiagnosticsPanel from '@/components/TradingDiagnosticsPanel';
import { formatDistanceToNow } from 'date-fns';
import { computeLiveSignalScores, REC_FRESH_MS, REC_AGING_MS } from '@/lib/signal-scoring';


function StatCard({
  title, value, subtitle, icon: Icon, trend, iconColor, loading
}: {
  title: string; value: React.ReactNode; subtitle?: React.ReactNode;
  icon: React.ElementType; trend?: number; iconColor?: string; loading?: boolean;
}) {
  if (loading) return <CardSkeleton />;
  return (
    <Card className="card-hover relative overflow-hidden border-border" style={{ background: 'hsl(var(--card))' }}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{title}</span>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: `${iconColor ?? 'hsl(var(--primary))'}20` }}>
            <Icon className="w-4 h-4" style={{ color: iconColor ?? 'hsl(var(--primary))' }} />
          </div>
        </div>
        <div className="text-xl font-bold font-['Space_Grotesk'] text-foreground leading-tight mb-1">{value}</div>
        {subtitle && <div className="text-xs">{subtitle}</div>}
        {trend !== undefined && (
          <div className={cn('flex items-center gap-1 text-xs font-medium mt-1', trend >= 0 ? 'text-positive' : 'text-negative')}>
            {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {trend >= 0 ? '+' : ''}{trend.toFixed(2)} USDT ({trend >= 0 ? '+' : ''}{((trend / 500) * 100).toFixed(2)}%)
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Status helpers ───────────────────────────────────────────────────────────

type StatusColor = 'success' | 'warning' | 'destructive' | 'muted';

interface StatusItem {
  label: string;
  status: string;
  color: StatusColor;
  icon?: React.ElementType;
  detail?: string;
  timestamp?: string;
}

function statusColor(status: string | undefined | null): StatusColor {
  if (!status) return 'muted';
  const s = status.toUpperCase();
  if (['LIVE', 'CONNECTED', 'READY', 'ACTIVE', 'ENABLED', 'RUNNING', 'OK', 'TRADING', 'FRESH', 'ONLINE'].includes(s)) return 'success';
  if (['WAITING', 'ANALYZING', 'RATE LIMITED', 'AGING', 'PENDING', 'UPDATING', 'IDLE', 'SCHEDULED'].includes(s)) return 'warning';
  if (['ERROR', 'DISCONNECTED', 'DISABLED', 'STALE', 'FAILED', 'OFFLINE'].includes(s)) return 'destructive';
  return 'muted';
}

function StatusDot({ color, size = 'sm' }: { color: StatusColor; size?: 'sm' | 'md' }) {
  const cls = {
    success: 'bg-success shadow-[0_0_6px_hsl(var(--success))]',
    warning: 'bg-warning shadow-[0_0_6px_hsl(var(--warning))]',
    destructive: 'bg-destructive shadow-[0_0_6px_hsl(var(--destructive))]',
    muted: 'bg-muted-foreground',
  }[color];
  return (
    <span className={cn('rounded-full inline-block', size === 'md' ? 'w-2 h-2' : 'w-1.5 h-1.5', cls)} />
  );
}

function StatusRow({ item, compact = false }: { item: StatusItem; compact?: boolean }) {
  const Icon = item.icon ?? Activity;
  return (
    <div className={cn('flex items-center justify-between gap-2', compact ? 'py-1.5' : 'py-2 border-b border-border last:border-0')}>
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={cn('shrink-0', compact ? 'w-3.5 h-3.5 text-muted-foreground' : 'w-4 h-4 text-muted-foreground')} />
        <span className={cn('text-muted-foreground truncate', compact ? 'text-xs' : 'text-xs')}>{item.label}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <StatusDot color={item.color} />
        <span className={cn('text-xs font-semibold', item.color === 'success' ? 'text-success' : item.color === 'warning' ? 'text-warning' : item.color === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>
          {item.status}
        </span>
      </div>
    </div>
  );
}

function PanelHeader({ title, icon: Icon, action, className }: { title: string; icon: React.ElementType; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-2 mb-3', className)}>
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold font-['Space_Grotesk'] text-foreground uppercase tracking-wide">{title}</h2>
      </div>
      {action}
    </div>
  );
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn('border-border overflow-hidden', className)} style={{ background: 'hsl(var(--card))' }}>
      <CardContent className="p-4">
        {children}
      </CardContent>
    </Card>
  );
}

// ─── Chart helpers ────────────────────────────────────────────────────────────

type TimeFilter = '7D' | '30D' | '90D' | 'ALL';

interface PLPoint {
  timestamp: number;
  date: string;
  cumulativePnL: number;
  accountValue: number;
  tradePnL: number;
}

function buildPLSeries(
  tradeHistory: DemoTradeHistory[],
  openTrades: DemoTrade[],
  totalDeposited: number,
  filter: TimeFilter
): PLPoint[] {
  const now = Date.now();
  const cutoff = filter === '7D' ? now - 7 * 24 * 60 * 60 * 1000
    : filter === '30D' ? now - 30 * 24 * 60 * 60 * 1000
    : filter === '90D' ? now - 90 * 24 * 60 * 60 * 1000
    : 0;

  const closed = tradeHistory
    .filter(t => t.closed_at && new Date(t.closed_at).getTime() >= cutoff)
    .sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime())
    .map(t => ({
      timestamp: new Date(t.closed_at).getTime(),
      date: formatDate(new Date(t.closed_at)),
      tradePnL: t.profit_loss,
    }));

  const points: PLPoint[] = [];
  let cumulative = 0;

  for (const t of closed) {
    cumulative += t.tradePnL;
    points.push({
      timestamp: t.timestamp,
      date: t.date,
      cumulativePnL: cumulative,
      accountValue: totalDeposited + cumulative,
      tradePnL: t.tradePnL,
    });
  }

  // Add current value with open positions
  const openUnrealized = openTrades.reduce((sum, t) => sum + (t.unrealized_pnl ?? 0), 0);
  const realized = tradeHistory
    .filter(t => t.closed_at && new Date(t.closed_at).getTime() >= cutoff)
    .reduce((sum, t) => sum + t.profit_loss, 0);
  points.push({
    timestamp: now,
    date: formatDate(new Date()),
    cumulativePnL: realized + openUnrealized,
    accountValue: totalDeposited + realized + openUnrealized,
    tradePnL: 0,
  });

  return points;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getPeriodCutoff(filter: TimeFilter): number {
  const now = Date.now();
  if (filter === '7D') return now - 7 * 24 * 60 * 60 * 1000;
  if (filter === '30D') return now - 30 * 24 * 60 * 60 * 1000;
  if (filter === '90D') return now - 90 * 24 * 60 * 60 * 1000;
  return 0;
}

interface PeriodStats {
  demoPnl: number;
  demoTrades: number;
  demoWins: number;
  demoWinRate: number;
  livePnl: number;
  liveTrades: number;
  liveWins: number;
  liveWinRate: number;
}

function buildPeriodStats(
  tradeHistory: DemoTradeHistory[],
  liveOrders: LiveOrder[],
  filter: TimeFilter
): PeriodStats {
  const cutoff = getPeriodCutoff(filter);
  const demo = tradeHistory.filter(t => t.closed_at && new Date(t.closed_at).getTime() >= cutoff);
  const live = liveOrders.filter(t => t.closed_at && new Date(t.closed_at).getTime() >= cutoff);

  const demoWins = demo.filter(t => t.profit_loss > 0).length;
  const liveWins = live.filter(t => (t.realized_pnl ?? 0) > 0).length;
  const demoPnl = demo.reduce((sum, t) => sum + (t.profit_loss ?? 0), 0);
  const livePnl = live.reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0);

  return {
    demoPnl,
    demoTrades: demo.length,
    demoWins,
    demoWinRate: demo.length ? (demoWins / demo.length) * 100 : 0,
    livePnl,
    liveTrades: live.length,
    liveWins,
    liveWinRate: live.length ? (liveWins / live.length) * 100 : 0,
  };
}

function MiniBarChart({ data, positiveColor, negativeColor }: { data: { label: string; value: number }[]; positiveColor: string; negativeColor: string }) {
  return (
    <div className="h-24">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 12 }}
            itemStyle={{ color: 'hsl(var(--foreground))' }}
            formatter={(v: number) => v.toFixed(2)}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.value >= 0 ? positiveColor : negativeColor} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function MiniDonut({ data, colors, innerText }: { data: { label: string; value: number }[]; colors: string[]; innerText: string }) {
  return (
    <div className="h-28 relative">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={30} outerRadius={45} paddingAngle={2}>
            {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="text-xs font-bold text-foreground">{innerText}</span>
      </div>
    </div>
  );
}

function PLChart({ data }: { data: PLPoint[] }) {
  if (data.length < 2) return null;
  const startValue = data[0]?.accountValue ?? 0;
  const endValue = data[data.length - 1]?.accountValue ?? 0;
  const positive = endValue >= startValue;
  const color = positive ? 'hsl(var(--success))' : 'hsl(var(--destructive))';

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="plGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0.0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
          <YAxis
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            domain={['auto', 'auto']}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload || !payload.length) return null;
              const p = payload[0].payload as PLPoint;
              return (
                <div className="bg-card border border-border rounded-md p-2.5 text-xs shadow-sm">
                  <div className="text-muted-foreground mb-1">{p.date}</div>
                  <div className="font-semibold text-foreground">Account: {p.accountValue.toFixed(2)} USDT</div>
                  <div className={cn('font-semibold', p.cumulativePnL >= 0 ? 'text-success' : 'text-destructive')}>
                    Cumulative P/L: {p.cumulativePnL >= 0 ? '+' : ''}{p.cumulativePnL.toFixed(2)} USDT
                  </div>
                </div>
              );
            }}
          />
          <ReferenceLine y={startValue} stroke="hsl(var(--border))" strokeDasharray="4 4" />
          <Area type="monotone" dataKey="accountValue" stroke={color} strokeWidth={2} fill="url(#plGradient)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface DashboardEvent {
  type: 'analysis' | 'signal' | 'bcs' | 'trade' | 'scheduler' | 'warning' | 'error' | 'tp' | 'sl';
  timestamp: Date | string;
  message: string;
  detail?: string;
}

function eventColor(type: DashboardEvent['type']): string {
  switch (type) {
    case 'analysis': return 'bg-primary';
    case 'signal': return 'bg-info';
    case 'bcs': return 'bg-warning';
    case 'trade': return 'bg-success';
    case 'tp': return 'bg-success';
    case 'sl': return 'bg-destructive';
    case 'scheduler': return 'bg-muted-foreground';
    case 'warning': return 'bg-warning';
    case 'error': return 'bg-destructive';
    default: return 'bg-muted-foreground';
  }
}

function buildRecentEvents(
  lastAIUpdate: Date | string | null,
  signals: AISignal[],
  autoTraderBestSetup: { signal: AISignal; freshnessLabel: string; currentScore: number } | null,
  autoTraderBestOverallScore: { signal: AISignal; freshnessLabel: string } | null,
  autoTraderLastAction: string | null,
  autoTraderTotalTrades: number,
  tradeHistory: DemoTradeHistory[],
  schedulerCompletedAt: Date | string | null,
  schedulerStatus: { last_run_at?: Date | string | null; last_error?: string | null } | null,
  lastAnalysisError: string | null
): DashboardEvent[] {
  const events: DashboardEvent[] = [];

  if (lastAIUpdate) {
    events.push({
      type: 'analysis',
      timestamp: lastAIUpdate,
      message: 'AI analysis completed',
      detail: `${signals.length} live signals`,
    });
  }

  if (signals.length > 0) {
    const newest = signals.slice().sort((a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime())[0];
    if (newest) {
      events.push({
        type: 'signal',
        timestamp: newest.generated_at,
        message: `Signal generated: ${newest.pair}`,
        detail: `${newest.signal_type} · ${newest.confidence}`,
      });
    }
  }

  if (autoTraderBestSetup) {
    events.push({
      type: 'bcs',
      timestamp: autoTraderBestSetup.signal.generated_at,
      message: `BEST CURRENT SETUP: ${autoTraderBestSetup.signal.pair}`,
      detail: `${autoTraderBestSetup.freshnessLabel} · ${autoTraderBestSetup.currentScore}`,
    });
  } else if (autoTraderBestOverallScore) {
    events.push({
      type: 'bcs',
      timestamp: autoTraderBestOverallScore.signal.generated_at,
      message: `BEST CURRENT SETUP changed: ${autoTraderBestOverallScore.signal.pair}`,
      detail: `${autoTraderBestOverallScore.freshnessLabel} — not tradeable`,
    });
  }

  if (autoTraderLastAction) {
    const lower = autoTraderLastAction.toLowerCase();
    let type: DashboardEvent['type'] = 'trade';
    if (lower.includes('tp') || lower.includes('take_profit')) type = 'tp';
    if (lower.includes('sl') || lower.includes('stop_loss')) type = 'sl';
    events.push({
      type,
      timestamp: new Date(),
      message: `Auto Trader: ${autoTraderLastAction}`,
      detail: `Total trades: ${autoTraderTotalTrades}`,
    });
  }

  const recentClosed = tradeHistory.slice(0, 5);
  for (const t of recentClosed) {
    let type: DashboardEvent['type'] = 'trade';
    if (t.exit_reason === 'take_profit') type = 'tp';
    if (t.exit_reason === 'stop_loss') type = 'sl';
    events.push({
      type,
      timestamp: t.closed_at,
      message: `${t.pair} ${t.exit_reason === 'take_profit' ? 'TP' : t.exit_reason === 'stop_loss' ? 'SL' : 'closed'} triggered`,
      detail: `${t.profit_loss >= 0 ? '+' : ''}${t.profit_loss.toFixed(2)} USDT`,
    });
  }

  if (schedulerCompletedAt) {
    events.push({
      type: 'scheduler',
      timestamp: schedulerCompletedAt,
      message: 'Scheduler completed',
      detail: schedulerStatus?.last_error ? 'with errors' : 'successfully',
    });
  } else if (schedulerStatus?.last_run_at) {
    events.push({
      type: 'scheduler',
      timestamp: schedulerStatus.last_run_at,
      message: 'Scheduler ran',
      detail: schedulerStatus.last_error ? 'with errors' : 'successfully',
    });
  }

  if (lastAnalysisError) {
    events.push({
      type: 'error',
      timestamp: new Date(),
      message: `AI analysis error: ${lastAnalysisError}`,
    });
  }

  if (schedulerStatus?.last_error) {
    events.push({
      type: 'warning',
      timestamp: schedulerStatus.last_run_at || new Date(),
      message: `Scheduler warning: ${schedulerStatus.last_error}`,
    });
  }

  return events
    .filter(e => e.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 25);
}

function fmtTimeAgo(date: Date | string | number | null | undefined): string {
  if (!date) return 'N/A';
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return 'N/A';
  }
}

function formatNumber(v: number | null | undefined, fallback = 'N/A'): string {
  if (v === null || v === undefined || isNaN(v)) return fallback;
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : v < 1000 ? 4 : 2 });
}

function formatPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || isNaN(v)) return 'N/A';
  const d = v < 0.01 ? 6 : v < 1 ? 5 : v < 100 ? 4 : 2;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d })}`;
}

function DashboardLivePositionsPanel({ pionexConnected, compact = false }: { pionexConnected: boolean; compact?: boolean }) {
  const [positions, setPositions] = useState<PionexPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const fetchPositions = useCallback(async () => {
    if (!pionexConnected) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('pionex-proxy', {
        method: 'POST',
        body: { action: 'positions' },
      });
      if (error) {
        const text = await error.context?.text?.().catch(() => '');
        let errMsg = error.message;
        try { const p = JSON.parse(text); errMsg = p.error ?? p.message ?? text; } catch { errMsg = text || error.message; }
        setApiError(errMsg);
        setApiOk(false);
        setPositions([]);
      } else {
        const raw = Array.isArray(data?.positions) ? data.positions : [];
        setPositions(raw);
        setApiOk(true);
        setApiError(null);
        setLastSync(new Date());
      }
    } catch (e) {
      setApiError(e instanceof Error ? e.message : String(e));
      setApiOk(false);
      setPositions([]);
    } finally {
      setLoading(false);
    }
  }, [pionexConnected]);

  useEffect(() => {
    if (pionexConnected) {
      fetchPositions();
      const id = setInterval(fetchPositions, 10000);
      return () => clearInterval(id);
    }
  }, [pionexConnected, fetchPositions]);

  if (!pionexConnected) {
    return (
      <div className="py-6 flex flex-col items-center gap-2 text-center text-muted-foreground">
        <Radio className="w-8 h-8 opacity-30" />
        <p className="text-sm font-medium">Pionex not connected</p>
        <p className="text-xs max-w-[280px]">Connect your Pionex account in Exchange Connections to see live positions.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {lastSync ? `Pionex data: ${formatDistanceToNow(lastSync, { addSuffix: false })} ago` : 'Pionex data: N/A'}
        </span>
        <Button variant="ghost" size="sm" onClick={fetchPositions} disabled={loading} className="gap-1 text-xs h-7 px-2">
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {!loading && apiOk === false && apiError && (
        <div className="flex items-start gap-2 p-2.5 rounded-md border border-destructive/20 bg-destructive/5 text-xs text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>Could not load live positions: {apiError}</span>
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[1, 2].map(i => <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />)}
        </div>
      )}

      {!loading && apiOk === true && positions.length === 0 && (
        <div className="py-6 flex flex-col items-center gap-2 text-center text-muted-foreground">
          <Activity className="w-8 h-8 opacity-30" />
          <p className="text-sm font-medium">No active positions</p>
          <p className="text-xs max-w-[280px]">Your Pionex account has no open USDT-M futures positions.</p>
        </div>
      )}

      {!loading && positions.length > 0 && (
        <div className={cn('grid grid-cols-1 gap-3', compact && 'max-h-[360px] overflow-y-auto pr-1')}>
          {positions.map((pos, i) => (
            <DashboardPositionCard key={`${pos.symbol}-${pos.side}-${i}`} pos={pos} />
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardPositionCard({ pos }: { pos: PionexPosition }) {
  const isProfit = (pos.unrealized_pnl ?? 0) >= 0;
  const pnlColor = isProfit ? 'text-positive' : 'text-negative';
  const sideLabel = pos.side === 'LONG' ? 'BUY' : 'SELL';
  const sideColor = pos.side === 'LONG' ? 'bg-positive/10 text-positive border-positive/40' : 'bg-negative/10 text-negative border-negative/40';
  const entry = pos.avg_price;
  const current = pos.mark_price ?? entry;
  const investment = pos.occupied_margin ?? (pos.position_value ? pos.position_value / (pos.leverage || 1) : 0);
  const value = pos.position_value ?? 0;
  const pnlPct = pos.unrealized_pnl_pct ?? (investment > 0 ? ((pos.unrealized_pnl ?? 0) / investment) * 100 : 0);

  const hasTP = (pos as unknown as Record<string, number | null>).take_profit != null;
  const hasSL = (pos as unknown as Record<string, number | null>).stop_loss != null;
  const tp = (pos as unknown as Record<string, number | null>).take_profit as number | null;
  const sl = (pos as unknown as Record<string, number | null>).stop_loss as number | null;
  let progress = 0;
  if (hasTP && hasSL && entry && current && tp != null && sl != null) {
    progress = Math.min(100, Math.max(0, ((current - sl) / (tp - sl)) * 100));
  } else if (entry && current) {
    progress = Math.min(100, Math.max(0, ((current - entry) / entry) * 100 + 50));
  }

  return (
    <div className="p-4 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-bold text-foreground leading-tight">{pos.symbol}</div>
          <Badge variant="outline" className={cn('text-[10px] font-bold mt-1.5 px-1.5 py-0.5', sideColor)}>
            {sideLabel}
          </Badge>
        </div>
        <div className={cn('text-right', pnlColor)}>
          <div className="text-base font-bold">{isProfit ? '+' : ''}{pos.unrealized_pnl?.toFixed(2) ?? '0.00'} USDT</div>
          <div className="text-xs font-medium">{isProfit ? '+' : ''}{pnlPct.toFixed(2)}%</div>
        </div>
      </div>

      <div className="space-y-2 text-xs mb-3">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Entry</span>
          <span className="font-medium text-foreground">{formatPrice(entry)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Current Price</span>
          <span className="font-medium text-foreground">{formatPrice(current)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Investment</span>
          <span className="font-medium text-foreground">{formatPrice(investment)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Current Value</span>
          <span className="font-medium text-foreground">{value > 0 ? `${value.toFixed(2)} USDT` : formatPrice(value)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">TP</span>
          <span className="font-medium text-success">{tp ? formatPrice(tp) : 'N/A'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">SL</span>
          <span className="font-medium text-destructive">{sl ? formatPrice(sl) : 'N/A'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Status</span>
          <span className="font-medium text-foreground">OPEN</span>
        </div>
      </div>

      {progress > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>Entry</span>
            <span>Current</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
            <div
              className={cn('h-full rounded-full', isProfit ? 'bg-positive' : 'bg-negative')}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}


function DashboardDemoOpenTradesPanel({ openTrades }: { openTrades: DemoTrade[] }) {
  const totalUnrealized = openTrades.reduce((sum, t) => sum + (t.unrealized_pnl ?? 0), 0);

  return (
    <Panel className="flex flex-col">
      <PanelHeader
        title="Demo Open Trades"
        icon={Layers}
        action={
          <div className="flex items-center gap-2">
            <DemoBadge />
            <span className={cn(
              'text-xs font-semibold',
              openTrades.length > 0 ? 'text-primary' : 'text-muted-foreground'
            )}>
              {openTrades.length} open
            </span>
          </div>
        }
      />

      {openTrades.length === 0 ? (
        <div className="min-h-[180px] flex flex-col items-center justify-center text-center text-muted-foreground">
          <Layers className="w-8 h-8 opacity-30 mb-2" />
          <p className="text-sm font-medium">No open demo trades</p>
          <p className="text-xs mt-1 max-w-[280px]">
            Demo positions will appear here immediately after a successful simulated BUY.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {openTrades.map((trade) => {
            const pnl = trade.unrealized_pnl ?? 0;
            const pnlPct = trade.pnl_pct ?? (trade.investment > 0 ? (pnl / trade.investment) * 100 : 0);
            const price = trade.current_price ?? trade.buy_price;
            return (
              <div key={trade.id} className="rounded-lg border border-border/70 p-3 bg-muted/30">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <CoinLogo symbol={trade.symbol} size={32} />
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-foreground truncate">{trade.pair}</div>
                      <div className="text-[10px] text-muted-foreground">
                        Entry {formatPrice(trade.buy_price)} · Now {formatPrice(price)}
                      </div>
                    </div>
                  </div>
                  <div className={cn('text-right shrink-0', pnl >= 0 ? 'text-positive' : 'text-negative')}>
                    <div className="font-bold text-sm">{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USDT</div>
                    <div className="text-[10px]">{pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-3 text-[10px]">
                  <div>
                    <div className="text-muted-foreground">Investment</div>
                    <div className="font-semibold text-foreground">{trade.investment.toFixed(2)} USDT</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Stop Loss</div>
                    <div className="font-semibold text-negative">{trade.stop_loss ? formatPrice(trade.stop_loss) : '—'}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Take Profit</div>
                    <div className="font-semibold text-positive">{trade.take_profit ? formatPrice(trade.take_profit) : '—'}</div>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="flex items-center justify-between pt-2 border-t border-border text-xs">
            <span className="text-muted-foreground">Open demo unrealized P/L</span>
            <span className={cn('font-bold', totalUnrealized >= 0 ? 'text-positive' : 'text-negative')}>
              {totalUnrealized >= 0 ? '+' : ''}{totalUnrealized.toFixed(2)} USDT
            </span>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const {
    demoAccount, openTrades, tradeHistory, signalsCache, liveSignals,
    marketDataStatus, pionexAccountStatus, aiAnalysisStatus, lastAIUpdate, lastAnalysisError,
    scanStats, performance, loadingDemo,
    schedulerStatus, schedulerCompletedAt,
    autoTraderEnabled, autoTraderTradeId, autoTraderTotalTrades, autoTraderLastAction,
    autoTraderBestSetup, autoTraderBestOverallScore,
    signalPerfSummary, signalPerfByConfidence,
    isPionexLive, liveOrders, openLiveOrders
  } = useTrading();
  const [pionexConnection, setPionexConnection] = useState<PionexConnection | null>(null);
  const [plFilter, setPlFilter] = useState<TimeFilter>('30D');
  const [manualBuySignal, setManualBuySignal] = useState<AISignal | null>(null);

  useEffect(() => {
    if (!user) return;
    getPionexConnection(user.id)
      .then(c => setPionexConnection(c))
      .catch(() => setPionexConnection(null));
  }, [user]);

  const pionexConnected = !!pionexConnection?.is_connected;
  const pionexLastSync = pionexConnection?.last_sync ?? null;

  const signals = signalsCache?.signals ?? [];

  const pairsScanned = scanStats?.pairsScanned ?? signalsCache?.pairs_scanned ?? 0;
  const analyzedCount = scanStats?.analyzedByAI ?? signalsCache?.analyzed_count ?? 0;

  // Opportunities = LIVE signals that are tradeable (RECOMMENDED or WATCH tier).
  // Use scoredSignals (computed below) so the number stays consistent with the
  // signal list. Fall back to raw scanStats for first render before scoring runs.
  const diagnostics = signalsCache?.diagnostics ?? null;

  // Sentiment: prefer cache value when AI produced a real run (cache_misses > 0
  // or ai_verified_count > 0). If the last run was 100% cache-hits with no real AI
  // call, the sentiment is stale/default — keep showing whatever the cache has.
  // We never hard-code sentiment; if cache is null, show 50/Neutral as explicit fallback.
  const sentiment = signalsCache?.market_sentiment ?? { score: 50, label: 'Neutral' };
  const aiModel = signalsCache?.model_used ?? 'N/A';
  const aiSource = signalsCache?.ai_source ?? 'N/A';
  const openaiStatus = signalsCache?.gemini_status ?? 'N/A';
  const cacheGeneratedAt = signalsCache?.generated_at ?? null;
  const cacheUpdatedAt = signalsCache?.updated_at ?? null;

  // V2: local pipeline counts
  const localSetupsCount  = signalsCache?.local_setups?.length ?? diagnostics?.qualified_count ?? 0;
  const aiVerifiedCount   = diagnostics?.ai_verified_count ?? 0;
  const recommendedCount  = diagnostics?.recommended_count ?? signals.filter(s => s.server_verdict === 'RECOMMENDED').length;
  const aiRateLimited     = signalsCache?.gemini_status === 'RATE_LIMIT';

  const plData = useMemo(() => buildPLSeries(tradeHistory, openTrades, demoAccount?.total_deposited ?? 500, plFilter), [tradeHistory, openTrades, demoAccount?.total_deposited, plFilter]);
  const periodStats = useMemo(() => buildPeriodStats(tradeHistory, liveOrders, plFilter), [tradeHistory, liveOrders, plFilter]);

  const recentEvents = useMemo(() => buildRecentEvents(
    lastAIUpdate, signals, autoTraderBestSetup, autoTraderBestOverallScore,
    autoTraderLastAction, autoTraderTotalTrades, tradeHistory, schedulerCompletedAt,
    schedulerStatus, lastAnalysisError
  ), [lastAIUpdate, signals, autoTraderBestSetup, autoTraderBestOverallScore, autoTraderLastAction, autoTraderTotalTrades, tradeHistory, schedulerCompletedAt, schedulerStatus, lastAnalysisError]);

  const getAILabel = () => {
    if (aiAnalysisStatus === 'updating') {
      // Guard against permanently stuck "Updating..." — if lastAIUpdate exists and
      // the cache was updated recently, show the time instead of "Updating..."
      // This handles the case where the EF returned cached data (ai_cache_hits=N,
      // cache_misses=0) but the 'updating' state was never cleared due to the
      // response arriving while the component was in a stale closure.
      if (lastAIUpdate) return fmtTimeAgo(lastAIUpdate);
      return 'Updating...';
    }
    if (!lastAIUpdate) return 'Pending';
    return fmtTimeAgo(lastAIUpdate);
  };

  const scoredSignals = useMemo(() => computeLiveSignalScores(signals, [], signalsCache?.reset_at), [signals, signalsCache?.reset_at]);
  const recommendedSignals = scoredSignals.filter(s => s.tier === 'RECOMMENDED');

  // Opportunities = RECOMMENDED + WATCH signals from the scored live pool.
  // This matches what the user sees in the signals list and correctly excludes
  // STALE/NO_TRADE signals. Falls back to scanStats when scoredSignals not yet ready.
  const opportunities = scoredSignals.filter(s => s.tier === 'RECOMMENDED' || s.tier === 'WATCH').length
    || scanStats?.opportunities
    || 0;

  const freshnessSummary = signals.length > 0
    ? (signals.some(s => {
        const age = Date.now() - new Date(s.generated_at).getTime();
        return age <= REC_FRESH_MS;
      }) ? 'FRESH' : signals.some(s => {
        const age = Date.now() - new Date(s.generated_at).getTime();
        return age <= REC_AGING_MS;
      }) ? 'AGING' : 'STALE')
    : 'N/A';
  // when liveSignals are empty or all AGING/STALE — this gives a meaningful number always.
  // Fall back to live cache signals when they are present.
  const avgConfidence = (() => {
    if (liveSignals.length > 0) {
      return Math.round(liveSignals.reduce((s, sig) => s + sig.confidence, 0) / liveSignals.length);
    }
    if (signals.length > 0) {
      return Math.round(signals.reduce((s, sig) => s + sig.confidence, 0) / signals.length);
    }
    // Fallback: historical avg from signal_performance_summary view
    if (signalPerfSummary && signalPerfSummary.evaluated_signals > 0) {
      // avg_return_pct is not confidence — derive from signalPerfByConfidence weighted avg
      if (signalPerfByConfidence && signalPerfByConfidence.length > 0) {
        const totalSignals = signalPerfByConfidence.reduce((s, r) => s + r.total, 0);
        if (totalSignals > 0) {
          // Midpoint of each bucket × count gives weighted avg confidence
          const midpoint = (range: string) => {
            if (range === '80-100') return 90;
            if (range === '70-79') return 74;
            if (range === '60-69') return 64;
            return 55; // below-60
          };
          const weighted = signalPerfByConfidence.reduce(
            (s, r) => s + midpoint(r.confidence_range) * r.total, 0
          );
          return Math.round(weighted / totalSignals);
        }
      }
    }
    return 0;
  })();

  // ─── System Status ───────────────────────────────────────────────────────────
  const systemStatuses: StatusItem[] = useMemo(() => {
    const marketStatus = marketDataStatus === 'live' ? 'LIVE' : marketDataStatus === 'error' ? 'ERROR' : marketDataStatus === 'cached' ? 'CACHED' : 'N/A';
    const accountStatus = pionexAccountStatus === 'connected' ? 'CONNECTED' : pionexAccountStatus === 'error' ? 'ERROR' : 'DISCONNECTED';
    const openaiStatusText = openaiStatus === 'connected' ? 'READY' : openaiStatus ? openaiStatus.replace(/_/g, ' ').toUpperCase() : 'N/A';
    const schedulerStatusText = schedulerStatus ? (schedulerStatus.is_active ? 'ACTIVE' : 'INACTIVE') : 'N/A';
    const aiStatusText = aiAnalysisStatus === 'updating' ? 'ANALYZING' : aiAnalysisStatus === 'error' ? 'ERROR' : aiAnalysisStatus ? aiAnalysisStatus.toUpperCase() : 'N/A';
    const autoTraderStatusText = autoTraderEnabled ? (autoTraderLastAction ? 'ACTIVE' : 'ENABLED') : 'DISABLED';
    return [
      { label: 'Pionex Market', status: marketStatus, color: statusColor(marketStatus), icon: Radio },
      { label: 'Pionex Account', status: accountStatus, color: statusColor(accountStatus), icon: Server },
      { label: 'OpenAI', status: openaiStatusText, color: statusColor(openaiStatusText), icon: Brain },
      { label: 'Scheduler', status: schedulerStatusText, color: statusColor(schedulerStatusText), icon: Clock },
      { label: 'AI Analysis', status: aiStatusText, color: statusColor(aiStatusText), icon: Cpu },
      { label: 'Auto Trader', status: autoTraderStatusText, color: statusColor(autoTraderStatusText), icon: Bot, detail: autoTraderLastAction || undefined },
    ];
  }, [marketDataStatus, pionexAccountStatus, openaiStatus, schedulerStatus, aiAnalysisStatus, autoTraderEnabled, autoTraderLastAction]);

  // ─── Pipeline Diagnostics ──────────────────────────────────────────────────────
  const pipelineSteps = useMemo(() => {
    const freshness = freshnessSummary;
    const recommended = recommendedSignals.length > 0 ? 'READY' : signals.length > 0 ? 'WAITING' : 'N/A';
    const bcs = autoTraderBestSetup ? 'TRADEABLE' : autoTraderBestOverallScore ? 'STALE' : 'N/A';
    const autoTrader = autoTraderEnabled ? (autoTraderLastAction ? 'ACTIVE' : 'ENABLED') : 'DISABLED';
    const tpsl = openTrades.length > 0 ? 'MONITORING' : 'READY';
    const tradeResult = tradeHistory.length > 0 ? `${tradeHistory.length} closed` : 'N/A';
    return [
      { label: 'Pionex Market', status: marketDataStatus === 'live' ? 'LIVE' : 'N/A', color: statusColor(marketDataStatus === 'live' ? 'LIVE' : 'N/A') },
      { label: 'Scheduler', status: schedulerStatus ? (schedulerStatus.is_active ? 'ACTIVE' : 'INACTIVE') : 'N/A', color: statusColor(schedulerStatus ? (schedulerStatus.is_active ? 'ACTIVE' : 'INACTIVE') : 'N/A') },
      { label: 'Market Scan', status: pairsScanned > 0 ? 'READY' : 'N/A', color: statusColor(pairsScanned > 0 ? 'READY' : 'N/A'), detail: pairsScanned > 0 ? `${pairsScanned} pairs` : undefined },
      { label: 'AI Analysis', status: aiAnalysisStatus === 'updating' ? 'ANALYZING' : aiAnalysisStatus === 'error' ? 'ERROR' : analyzedCount > 0 ? 'READY' : 'N/A', color: statusColor(aiAnalysisStatus === 'updating' ? 'ANALYZING' : aiAnalysisStatus === 'error' ? 'ERROR' : analyzedCount > 0 ? 'READY' : 'N/A'), detail: analyzedCount > 0 ? `${analyzedCount} analyzed` : undefined },
      { label: 'Signals', status: signals.length > 0 ? 'READY' : 'N/A', color: statusColor(signals.length > 0 ? 'READY' : 'N/A'), detail: `${signals.length} live` },
      { label: 'Freshness', status: freshness, color: statusColor(freshness), detail: aiAnalysisStatus === 'updating' ? 'ANALYZING' : undefined },
      { label: 'Recommended', status: recommended, color: statusColor(recommended), detail: `${recommendedSignals.length} signals` },
      { label: 'BEST CURRENT SETUP', status: bcs, color: statusColor(bcs), detail: autoTraderBestSetup ? autoTraderBestSetup.signal.pair : autoTraderBestOverallScore ? autoTraderBestOverallScore.freshnessLabel : undefined },
      { label: 'Auto Trader', status: autoTrader, color: statusColor(autoTrader), detail: autoTraderLastAction || undefined },
      { label: 'TP/SL Monitoring', status: tpsl, color: statusColor(tpsl), detail: openTrades.length > 0 ? `${openTrades.length} open` : undefined },
      { label: 'Trade Result', status: tradeResult, color: statusColor(tradeResult !== 'N/A' ? 'READY' : 'N/A') },
    ];
  }, [marketDataStatus, schedulerStatus, pairsScanned, aiAnalysisStatus, analyzedCount, signals.length, freshnessSummary, recommendedSignals.length, autoTraderBestSetup, autoTraderBestOverallScore, autoTraderEnabled, autoTraderLastAction, openTrades.length, tradeHistory.length]);

  // ─── Copy Diagnostics ─────────────────────────────────────────────────────────
  const copyDiagnostics = async () => {
    const report = [
      'TradeMindMZ Diagnostics',
      '=======================',
      '',
      `Timestamp: ${new Date().toISOString()}`,
      '',
      'SYSTEM STATUS',
      '-------------',
      ...systemStatuses.map(s => `${s.label}: ${s.status}`),
      '',
      'PIPELINE',
      '--------',
      ...pipelineSteps.map(s => `${s.label}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`),
      '',
      'SCHEDULER',
      '---------',
      `Last Run: ${schedulerStatus?.last_run_at ? fmtTimeAgo(schedulerStatus.last_run_at) : 'N/A'}`,
      `Next Run: ${schedulerStatus?.next_run_at ? fmtTimeAgo(schedulerStatus.next_run_at) : 'N/A'}`,
      `Last Successful Run: ${schedulerStatus?.last_success_at ? fmtTimeAgo(schedulerStatus.last_success_at) : 'N/A'}`,
      `Last Completed Event: ${schedulerCompletedAt ? fmtTimeAgo(schedulerCompletedAt) : 'N/A'}`,
      `Last Error: ${schedulerStatus?.last_error ?? 'N/A'}`,
      '',
      'AI',
      '--',
      `Provider: ${aiSource}`,
      `Model: ${aiModel}`,
      `OpenAI Status: ${openaiStatus}`,
      `Last Analysis: ${getAILabel()}`,
      `Signals Analyzed: ${analyzedCount}`,
      `Live Signals: ${signals.length}`,
      `Cache Generated: ${cacheGeneratedAt ? fmtTimeAgo(cacheGeneratedAt) : 'N/A'}`,
      `Cache Updated: ${cacheUpdatedAt ? fmtTimeAgo(cacheUpdatedAt) : 'N/A'}`,
      '',
      'AUTO TRADER',
      '-----------',
      `Enabled: ${autoTraderEnabled ? 'YES' : 'NO'}`,
      `Status: ${autoTraderEnabled ? (autoTraderLastAction ? 'ACTIVE' : 'ENABLED') : 'DISABLED'}`,
      `Open Trades: ${openTrades.length}`,
      `Max Open Trades: 1`,
      `Auto-Trader Trade ID: ${autoTraderTradeId ?? 'N/A'}`,
      `Total Trades: ${autoTraderTotalTrades}`,
      `Last Event: ${autoTraderLastAction || 'N/A'}`,
      `Best Current Setup: ${autoTraderBestSetup ? autoTraderBestSetup.signal.pair : 'N/A'}`,
      `Best Overall Score: ${autoTraderBestOverallScore ? autoTraderBestOverallScore.signal.pair : 'N/A'}`,
      '',
      'DEMO TRADING',
      '------------',
      `Balance: ${demoAccount?.balance.toFixed(2) ?? 'N/A'} USDT`,
      `Account Value: ${performance.account_value.toFixed(2)} USDT`,
      `Unrealized P/L: ${performance.unrealized_pnl.toFixed(2)} USDT`,
      `Realized P/L: ${performance.realized_pnl.toFixed(2)} USDT`,
      `Total Return: ${performance.total_return_pct.toFixed(2)}%`,
      `Win Rate: ${performance.win_rate.toFixed(1)}%`,
      '',
      'OPEN POSITIONS',
      '--------------',
      ...openTrades.map(t => `${t.pair} ${t.signal_type} @ ${formatPrice(t.buy_price)} | Qty ${formatNumber(t.quantity)} | P/L ${t.unrealized_pnl?.toFixed(2) ?? 'N/A'} USDT`),
      openTrades.length === 0 ? 'No open demo positions' : '',
      '',
      'PIONEX ACCOUNT',
      '--------------',
      `Connected: ${pionexConnected ? 'YES' : 'NO'}`,
      `Last Sync: ${pionexLastSync ? fmtTimeAgo(pionexLastSync) : 'N/A'}`,
      '',
      'ERRORS / WARNINGS',
      '-----------------',
      lastAnalysisError ? `AI Analysis: ${lastAnalysisError}` : 'None',
      schedulerStatus?.last_error ? `Scheduler: ${schedulerStatus.last_error}` : '',
    ].filter(Boolean).join('\n');

    try {
      await navigator.clipboard.writeText(report);
      toast.success('Diagnostics copied ✓');
    } catch {
      toast.error('Failed to copy diagnostics');
    }
  };

  return (
    <>
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-bold font-['Space_Grotesk'] text-foreground">Dashboard</h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-0.5">AI Trading Control Center</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" className="text-xs gap-1.5 h-8" onClick={copyDiagnostics}>
            <ClipboardCopy className="w-3.5 h-3.5" /> Copy Diagnostics
          </Button>
          <div className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border"
            style={{ borderColor: pionexConnected ? 'hsl(var(--success)/0.3)' : 'hsl(var(--border))', background: pionexConnected ? 'hsl(var(--success)/0.1)' : 'hsl(var(--muted))' }}>
            <StatusDot color={pionexConnected ? 'success' : 'muted'} />
            <span className={cn('font-medium hidden sm:inline', pionexConnected ? 'text-success' : 'text-muted-foreground')}>
              {pionexConnected ? 'Connected' : 'Not Connected'}
            </span>
          </div>
        </div>
      </div>

      {/* AI updating notice — never hides existing data */}
      {aiAnalysisStatus === 'updating' && (
        <div className="flex items-center gap-2 text-xs text-warning p-2.5 rounded-lg border border-warning/20 bg-warning/5">
          <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
          Updating AI analysis in background — previous analysis still displayed.
        </div>
      )}

      {/* ── V2 Pipeline Overview Bar ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[
          {
            label: 'Pairs Scanned',
            value: pairsScanned || '—',
            icon: Globe,
            color: pairsScanned > 0 ? 'text-foreground' : 'text-muted-foreground',
            border: 'border-border',
            link: '/pipeline',
          },
          {
            label: 'Local Setups',
            value: localSetupsCount || '—',
            icon: Cpu,
            color: localSetupsCount > 0 ? 'text-primary' : 'text-muted-foreground',
            border: localSetupsCount > 0 ? 'border-primary/30' : 'border-border',
            link: '/market',
          },
          {
            label: 'AI Review',
            value: analyzedCount || '—',
            icon: Brain,
            color: analyzedCount > 0 ? 'text-primary' : 'text-muted-foreground',
            border: analyzedCount > 0 ? 'border-primary/25' : 'border-border',
            link: '/pipeline',
          },
          {
            // "AI Reviewed" = AI actually responded and created signals this run
            // When rate-limited, this is 0 and we must not show green
            label: aiRateLimited ? 'AI Reviewed ⚠' : 'AI Reviewed',
            value: aiVerifiedCount || '—',
            icon: CheckCircle2,
            color: aiVerifiedCount > 0 && !aiRateLimited ? 'text-success' : 'text-muted-foreground',
            border: aiVerifiedCount > 0 && !aiRateLimited ? 'border-success/30' : 'border-border',
            link: '/ai-signals',
            tooltip: aiRateLimited
              ? 'AI was rate-limited this run. 0 signals were AI-reviewed.'
              : 'Signals reviewed by AI this run.',
          },
          {
            // "AI Recommended" only when AI ran AND server approved
            // When rate-limited, server-qualified setups must NOT show as "Recommended"
            label: aiRateLimited ? 'Server Qualified' : 'AI Recommended',
            value: recommendedCount || '—',
            icon: Zap,
            color: recommendedCount > 0 && !aiRateLimited ? 'text-success' : aiRateLimited ? 'text-warning' : 'text-muted-foreground',
            border: recommendedCount > 0 && !aiRateLimited ? 'border-success/40' : aiRateLimited ? 'border-warning/30' : 'border-border',
            bg: recommendedCount > 0 && !aiRateLimited ? 'bg-success/5' : aiRateLimited ? 'bg-warning/5' : '',
            link: '/ai-signals',
            tooltip: aiRateLimited
              ? 'AI rate-limited — these are server-scored setups only, NOT AI recommendations.'
              : 'Setups AI-reviewed AND server-qualified. Eligible for Auto Trader.',
          },
        ].map(({ label, value, icon: Icon, color, border, bg, link, tooltip }) => (
          <Link key={label} to={link}>
            <div
              title={tooltip}
              className={cn(
                'p-3 rounded-xl border cursor-pointer transition-all hover:border-primary/40',
                border, bg ?? '',
              )}
              style={{ background: bg ? undefined : 'hsl(var(--card))' }}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide leading-tight">{label}</span>
                <Icon className={cn('w-3.5 h-3.5 shrink-0', color)} />
              </div>
              <div className={cn('text-2xl font-bold font-mono leading-none', color)}>{value}</div>
              {aiRateLimited && label === 'AI Review' && (
                <div className="text-[9px] text-warning mt-1">Rate limited</div>
              )}
            </div>
          </Link>
        ))}
      </div>

      {/* Open trades overview — demo and real Pionex positions side-by-side */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <DashboardDemoOpenTradesPanel openTrades={openTrades} />
        <Panel className="flex flex-col">
          <PanelHeader
            title="Pionex Open Trades"
            icon={Radio}
            action={
              <div className="flex items-center gap-2">
                <span className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  pionexConnected ? 'bg-success shadow-[0_0_7px_hsl(var(--success))]' : 'bg-muted-foreground'
                )} />
                <span className={cn('text-xs font-semibold', pionexConnected ? 'text-success' : 'text-muted-foreground')}>
                  {pionexConnected ? `${openLiveOrders.length} tracked` : 'Not connected'}
                </span>
              </div>
            }
          />
          <DashboardLivePositionsPanel pionexConnected={pionexConnected} compact />
        </Panel>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard title="Demo Balance" icon={Wallet}
          value={`${demoAccount?.balance.toFixed(2) ?? '500.00'} USDT`}
          subtitle={<DemoBadge />}
          iconColor="hsl(var(--warning))" loading={loadingDemo} />
        <StatCard title="Open Trades" icon={Layers}
          value={openTrades.length}
          subtitle={openTrades.length > 0
            ? <PnLValue value={performance.unrealized_pnl} suffix=" USDT" />
            : <span className="text-muted-foreground">No active trades</span>}
          iconColor="hsl(var(--primary))" loading={loadingDemo} />
        <StatCard title="AI Confidence" icon={Brain}
          value={`${avgConfidence}/100`}
          subtitle={<span className="text-muted-foreground">{signals.length} signal{signals.length !== 1 ? 's' : ''}</span>}
          iconColor="hsl(var(--primary))" loading={loadingDemo} />
        <StatCard title="Today's P/L" icon={TrendingUp}
          value={<PnLValue value={performance.realized_pnl} suffix=" USDT" />}
          subtitle={<PnLPct value={performance.total_return_pct} />}
          iconColor={performance.realized_pnl >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'}
          loading={loadingDemo} />
      </div>

      {/* Performance Overview with P/L chart */}
      <Panel>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <PanelHeader title="Performance Overview" icon={BarChart2} className="mb-0" />
          <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
            {(['7D', '30D', '90D', 'ALL'] as TimeFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setPlFilter(f)}
                className={cn(
                  'px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors',
                  plFilter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
            <div className="text-xs text-muted-foreground mb-1">Demo P/L · {plFilter}</div>
            <div className={cn('text-lg font-bold font-["Space_Grotesk"]', periodStats.demoPnl >= 0 ? 'text-positive' : 'text-negative')}>
              {periodStats.demoPnl >= 0 ? '+' : ''}{periodStats.demoPnl.toFixed(2)} USDT
            </div>
            <div className="text-[10px] text-muted-foreground">{periodStats.demoTrades} closed · {periodStats.demoWinRate.toFixed(0)}% win rate</div>
          </div>
          <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
            <div className="text-xs text-muted-foreground mb-1">Pionex P/L · {plFilter}</div>
            <div className={cn('text-lg font-bold font-["Space_Grotesk"]', periodStats.livePnl >= 0 ? 'text-positive' : 'text-negative')}>
              {periodStats.livePnl >= 0 ? '+' : ''}{periodStats.livePnl.toFixed(2)} USDT
            </div>
            <div className="text-[10px] text-muted-foreground">{periodStats.liveTrades} closed · {periodStats.liveWinRate.toFixed(0)}% win rate</div>
          </div>
          <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
            <div className="text-xs text-muted-foreground mb-1">Demo Unrealized</div>
            <div className={cn('text-lg font-bold font-["Space_Grotesk"]', performance.unrealized_pnl >= 0 ? 'text-positive' : 'text-negative')}>
              {performance.unrealized_pnl >= 0 ? '+' : ''}{performance.unrealized_pnl.toFixed(2)} USDT
            </div>
            <div className="text-[10px] text-muted-foreground">{openTrades.length} open trades</div>
          </div>
          <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
            <div className="text-xs text-muted-foreground mb-1">Demo Account</div>
            <div className="text-lg font-bold font-['Space_Grotesk'] text-foreground">{performance.account_value.toFixed(2)} USDT</div>
            <div className="text-[10px] text-muted-foreground">All-time · {performance.total_return_pct >= 0 ? '+' : ''}{performance.total_return_pct.toFixed(2)}%</div>
          </div>
        </div>

        <div className="rounded-lg border border-border p-3" style={{ background: 'hsl(var(--muted))' }}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold font-['Space_Grotesk'] text-foreground">DEMO P/L PERFORMANCE</h3>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <div className="text-right">
                <div className="text-muted-foreground">Cumulative P/L</div>
                <div className={cn('font-bold', performance.realized_pnl + performance.unrealized_pnl >= 0 ? 'text-positive' : 'text-negative')}>
                  {performance.realized_pnl + performance.unrealized_pnl >= 0 ? '+' : ''}{(performance.realized_pnl + performance.unrealized_pnl).toFixed(2)} USDT
                </div>
              </div>
              <div className="text-right">
                <div className="text-muted-foreground">Total Return</div>
                <div className={cn('font-bold', performance.total_return_pct >= 0 ? 'text-positive' : 'text-negative')}>
                  {performance.total_return_pct >= 0 ? '+' : ''}{performance.total_return_pct.toFixed(2)}%
                </div>
              </div>
            </div>
          </div>

          {plData.length > 1 ? (
            <PLChart data={plData} />
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-center text-muted-foreground border border-dashed border-border rounded-lg">
              <BarChart2 className="w-10 h-10 mb-2 opacity-50" />
              <p className="text-sm font-medium">Insufficient historical P/L data</p>
              <p className="text-xs max-w-xs">Closed trades will build this chart over time. No data for {plFilter}.</p>
            </div>
          )}
        </div>
      </Panel>

      {/* AI Performance + BEST CURRENT SETUP */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel>
          <PanelHeader title="AI Performance" icon={Brain} action={
            <Link to="/ai-performance" className="shrink-0">
              <Button variant="ghost" size="sm" className="text-xs gap-1 h-7 px-2">
                Details <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          } />
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
                <div className="text-xs text-muted-foreground mb-1">Avg Confidence</div>
                <div className="flex items-center gap-2">
                  <div className="text-2xl font-bold font-['Space_Grotesk'] text-foreground">{avgConfidence}</div>
                  <ConfidenceRing value={avgConfidence} size={48} />
                </div>
              </div>
              <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
                <div className="text-xs text-muted-foreground mb-1">Market Sentiment</div>
                <div className="text-2xl font-bold font-['Space_Grotesk']" style={{ color: sentiment.score >= 60 ? 'hsl(var(--success))' : sentiment.score >= 40 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))' }}>
                  {sentiment.label}
                </div>
                {/* Show score + note when AI returned cached/default 50 */}
                <div className="text-xs text-muted-foreground">
                  Score {sentiment.score}/100
                  {sentiment.score === 50 && diagnostics && (diagnostics.ai_cache_hits ?? 0) > 0 && (diagnostics.ai_cache_misses ?? 0) === 0 && (
                    <span className="ml-1 text-[10px] opacity-70">(cache)</span>
                  )}
                </div>
              </div>
            </div>

            {signalPerfSummary && signalPerfSummary.total_signals > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
                  <div className="text-xs text-muted-foreground mb-2">Win Rate</div>
                  <MiniDonut
                    data={[
                      { label: 'Wins', value: signalPerfSummary.wins },
                      { label: 'Losses', value: signalPerfSummary.losses },
                      { label: 'Expired', value: signalPerfSummary.expired },
                    ]}
                    colors={['hsl(var(--success))', 'hsl(var(--destructive))', 'hsl(var(--warning))']}
                    innerText={`${signalPerfSummary.win_rate_pct.toFixed(0)}%`}
                  />
                  <div className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground mt-1">
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-success" />Wins {signalPerfSummary.wins}</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-destructive" />Losses {signalPerfSummary.losses}</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-warning" />Exp {signalPerfSummary.expired}</span>
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
                  <div className="text-xs text-muted-foreground mb-2">P/L Performance</div>
                  <MiniBarChart
                    data={[
                      { label: 'Avg', value: signalPerfSummary.avg_return_pct ?? 0 },
                      { label: 'Win', value: signalPerfSummary.avg_win_pct ?? 0 },
                      { label: 'Loss', value: signalPerfSummary.avg_loss_pct ?? 0 },
                    ].map(d => ({ ...d, value: d.value / 100 }))}
                    positiveColor="hsl(var(--success))"
                    negativeColor="hsl(var(--destructive))"
                  />
                  <div className="grid grid-cols-2 gap-2 text-[10px] mt-2">
                    <div className="text-center">
                      <div className="text-muted-foreground">Total P/L</div>
                      <div className={cn('font-semibold', (signalPerfSummary.total_pl_usdt ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                        {(signalPerfSummary.total_pl_usdt ?? 0) >= 0 ? '+' : ''}{(signalPerfSummary.total_pl_usdt ?? 0).toFixed(2)} USDT
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="text-muted-foreground">Evaluated</div>
                      <div className="font-semibold text-foreground">{signalPerfSummary.evaluated_signals}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-lg border border-border border-dashed text-center" style={{ background: 'hsl(var(--muted))' }}>
                <Brain className="w-6 h-6 text-muted-foreground mx-auto mb-2 opacity-50" />
                <p className="text-xs text-muted-foreground">No AI performance history yet</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline" className="border-border gap-1">
                <Activity className="w-3 h-3 text-primary" /> {pairsScanned} pairs scanned
              </Badge>
              <Badge variant="outline" className="border-border gap-1">
                <Brain className="w-3 h-3 text-primary" /> {analyzedCount} analyzed
              </Badge>
              <Badge variant="outline" className="border-border gap-1">
                <Zap className="w-3 h-3 text-warning" /> {opportunities} opportunities
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={aiAnalysisStatus === 'updating' ? 'status-dot-warning' : 'status-dot-live'} />
              AI Analysis: {getAILabel()}
              {lastAnalysisError && <span className="text-destructive">• Error: {lastAnalysisError}</span>}
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="BEST CURRENT SETUP" icon={Zap} action={
            <Link to="/ai-signals" className="shrink-0">
              <Button variant="ghost" size="sm" className="text-xs gap-1 h-7 px-2">
                View in AI Signals <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          } />
          <div className="space-y-3">
            {autoTraderBestSetup ? (
              <div className="p-4 rounded-lg border border-primary/30 bg-primary/5">
                <div className="flex items-center justify-between gap-2 mb-4">
                  <div className="flex items-center gap-3">
                    <CoinLogo symbol={autoTraderBestSetup.signal.symbol} size={36} />
                    <div>
                      <div className="font-bold text-base text-foreground leading-tight">{autoTraderBestSetup.signal.pair}</div>
                      <div className="text-xs text-muted-foreground">{autoTraderBestSetup.signal.coin_name}</div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <SignalBadge type={autoTraderBestSetup.signal.signal_type} size="sm" />
                    <Badge variant="outline" className="text-xs border-success/40 bg-success/10 text-success">{autoTraderBestSetup.freshnessLabel}</Badge>
                    <div className="flex items-center gap-1 text-xs text-success">
                      <CheckCircle2 className="w-3.5 h-3.5" /> TRADEABLE
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="text-center p-2 rounded-md bg-background/60 border border-border/50">
                    <div className="text-[10px] text-muted-foreground uppercase">Current Score</div>
                    <div className="text-lg font-bold text-foreground">{autoTraderBestSetup.currentScore}</div>
                  </div>
                  <div className="text-center p-2 rounded-md bg-background/60 border border-border/50">
                    <div className="text-[10px] text-muted-foreground uppercase">Confidence</div>
                    <div className="text-lg font-bold text-foreground">{autoTraderBestSetup.signal.confidence}</div>
                  </div>
                  <div className="text-center p-2 rounded-md bg-background/60 border border-border/50">
                    <div className="text-[10px] text-muted-foreground uppercase">Signal Strength</div>
                    <div className="text-lg font-bold text-primary">{autoTraderBestSetup.signal.signal_strength}</div>
                  </div>
                </div>

                <div className="space-y-2 text-xs mb-4">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Freshness</span>
                    <span className="font-medium text-success">{autoTraderBestSetup.freshnessLabel}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Risk / Reward</span>
                    <span className="font-medium text-foreground">{autoTraderBestSetup.signal.risk_reward ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry</span>
                    <span className="font-medium text-foreground">{formatPrice(autoTraderBestSetup.signal.current_price)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Take Profit</span>
                    <span className="font-medium text-success">{formatPrice(autoTraderBestSetup.signal.take_profit_1)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Stop Loss</span>
                    <span className="font-medium text-destructive">{formatPrice(autoTraderBestSetup.signal.stop_loss)}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border/60">
                  <div className="text-[10px] text-muted-foreground">
                    Generated {fmtTimeAgo(autoTraderBestSetup.signal.generated_at)}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={!pionexConnected || !isPionexLive}
                      onClick={() => { setManualBuySignal(autoTraderBestSetup.signal); }}
                    >
                      BUY LIVE
                    </Button>
                  </div>
                </div>
              </div>
            ) : autoTraderBestOverallScore ? (
              <div className="p-4 rounded-lg border border-border" style={{ background: 'hsl(var(--muted))' }}>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-3">
                    <CoinLogo symbol={autoTraderBestOverallScore.signal.symbol} size={36} />
                    <div>
                      <div className="font-bold text-base text-foreground leading-tight">{autoTraderBestOverallScore.signal.pair}</div>
                      <div className="text-xs text-muted-foreground">{autoTraderBestOverallScore.signal.coin_name}</div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <SignalBadge type={autoTraderBestOverallScore.signal.signal_type} size="sm" />
                    <Badge variant="outline" className="text-xs border-warning/40 bg-warning/10 text-warning">{autoTraderBestOverallScore.freshnessLabel}</Badge>
                    <div className="flex items-center gap-1 text-xs text-warning">
                      <AlertCircle className="w-3.5 h-3.5" /> NOT TRADEABLE
                    </div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Best overall score is {autoTraderBestOverallScore.freshnessLabel.toLowerCase()} — waiting for fresh RECOMMENDED signal.
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Zap className="w-10 h-10 text-muted-foreground mb-2 opacity-50" />
                <p className="text-sm font-medium text-muted-foreground">No qualifying setup</p>
                <p className="text-xs text-muted-foreground mt-1">Waiting for next AI analysis</p>
              </div>
            )}
            {autoTraderBestOverallScore && autoTraderBestOverallScore !== autoTraderBestSetup && (
              <div className="text-xs text-muted-foreground border-t border-border pt-2">
                Best Overall Score: <span className="font-semibold text-foreground">{autoTraderBestOverallScore.signal.pair}</span> — {autoTraderBestOverallScore.freshnessLabel}
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* System Status */}
      <div className="grid grid-cols-1 gap-4">
        <Panel>
          <PanelHeader title="System Status" icon={Server} />
          <div className="space-y-2">
            {systemStatuses.map((s, i) => (
              <div key={i} className="p-2.5 rounded-lg border border-border/50" style={{ background: 'hsl(var(--muted))' }}>
                <StatusRow item={s} />
                {s.detail && <div className="text-[10px] text-muted-foreground pl-6 truncate mt-0.5">{s.detail}</div>}
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-border grid grid-cols-2 gap-3 text-xs">
            <div className="p-2 rounded-md bg-muted">
              <div className="text-muted-foreground text-[10px] uppercase">Last Analysis</div>
              <div className="font-medium text-foreground truncate">{getAILabel()}</div>
            </div>
            <div className="p-2 rounded-md bg-muted">
              <div className="text-muted-foreground text-[10px] uppercase">Last Scheduler Run</div>
              <div className="font-medium text-foreground truncate">{schedulerStatus?.last_run_at ? fmtTimeAgo(schedulerStatus.last_run_at) : 'N/A'}</div>
            </div>
            <div className="p-2 rounded-md bg-muted">
              <div className="text-muted-foreground text-[10px] uppercase">Next Scheduler Run</div>
              <div className="font-medium text-foreground truncate">{schedulerStatus?.next_run_at ? fmtTimeAgo(schedulerStatus.next_run_at) : 'N/A'}</div>
            </div>
            <div className="p-2 rounded-md bg-muted">
              <div className="text-muted-foreground text-[10px] uppercase">Last Successful Run</div>
              <div className="font-medium text-foreground truncate">{schedulerStatus?.last_success_at ? fmtTimeAgo(schedulerStatus.last_success_at) : 'N/A'}</div>
            </div>
          </div>
        </Panel>
      </div>

      {/* Pipeline Diagnostics */}
      <Panel>
        <PanelHeader title="Pipeline Diagnostics" icon={Terminal} />
        <div className="overflow-x-auto pb-3 -mx-4 px-4">
          <div className="flex items-center gap-1.5 min-w-max">
            {pipelineSteps.map((step, idx) => (
              <div key={step.label} className="flex items-center gap-1.5">
                <div className={cn(
                  'flex flex-col items-center gap-1.5 min-w-[92px] max-w-[120px] px-2 py-3 rounded-lg border',
                  step.color === 'success' ? 'border-success/20 bg-success/5'
                  : step.color === 'warning' ? 'border-warning/20 bg-warning/5'
                  : step.color === 'destructive' ? 'border-destructive/20 bg-destructive/5'
                  : 'border-border bg-muted/30'
                )}>
                  <div className="flex items-center gap-1.5">
                    <StatusDot color={step.color} size="md" />
                  </div>
                  <div className="text-[10px] font-semibold text-center text-foreground leading-tight uppercase">{step.label}</div>
                  <div className={cn('text-[10px] font-bold text-center', step.color === 'success' ? 'text-success' : step.color === 'warning' ? 'text-warning' : step.color === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>
                    {step.status}
                  </div>
                  {step.detail && <div className="text-[9px] text-muted-foreground text-center truncate w-full px-1">{step.detail}</div>}
                </div>
                {idx < pipelineSteps.length - 1 && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <div className="w-3 h-px bg-border" />
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground rotate-[-90deg] shrink-0 -ml-2" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {/* Recent Activity / Signal Summary */}
      <Panel>
        <PanelHeader title="Recent Activity" icon={Activity} action={
          <Link to="/ai-signals" className="shrink-0">
            <Button variant="ghost" size="sm" className="text-xs gap-1 h-7 px-2">
              View Signals <ArrowRight className="w-3 h-3" />
            </Button>
          </Link>
        } />
        <div className="space-y-2">
          {loadingDemo ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />)}
            </div>
          ) : recentEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Activity className="w-10 h-10 mb-2 opacity-50" />
              <p className="text-sm font-medium">No recent activity</p>
              <p className="text-xs">Events will appear as the system runs.</p>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto pr-1">
              {recentEvents.map((evt, i) => (
                <div key={i} className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0">
                  <div className={cn('w-2 h-2 rounded-full mt-1.5 shrink-0', eventColor(evt.type))} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-foreground truncate">{evt.message}</div>
                    <div className="text-[10px] text-muted-foreground">{fmtTimeAgo(evt.timestamp)}</div>
                  </div>
                  {evt.detail && <div className="text-[10px] text-muted-foreground shrink-0 max-w-[120px] truncate">{evt.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>

    {manualBuySignal && (
      <ManualBuyModal
        open={!!manualBuySignal}
        onClose={() => setManualBuySignal(null)}
        signal={manualBuySignal}
      />
    )}

    <TradingDiagnosticsPanel />
  </>
  );
}
