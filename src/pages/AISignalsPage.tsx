import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTrading } from '@/contexts/TradingContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ConfidenceRing, SignalBadge, RiskBadge, CoinLogo, DemoBadge,
  PnLValue, PnLPct, CardSkeleton, StatRow
} from '@/components/ui/TradingComponents';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { RateLimitBanner } from '@/components/ui/SignalStatusLabel';
import DemoBuyModal from '@/components/modals/DemoBuyModal';
import ManualBuyModal from '@/components/modals/ManualBuyModal';
import ManualSellModal from '@/components/modals/ManualSellModal';
import DemoSellModal from '@/components/modals/DemoSellModal';
import {
  Brain, RefreshCw, Activity, Clock, TrendingUp, TrendingDown,
  RotateCcw, PlusCircle, AlertTriangle, BarChart2, Zap, Globe,
  ArrowUpRight, ArrowDownRight, Bug, CheckCircle2, XCircle,
  History, Trophy, Target, Percent, Timer, Filter, ChevronDown, X,
  Star, Info, ShieldAlert
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AISignal, DemoTrade, DemoTradeHistory, SignalHistory } from '@/types/types';
import {
  computeLiveSignalScores, holdingTimeToMsFE,
  GATE_TYPE_SAMPLE, GATE_WIN_RATE, GATE_AVG_PL, GATE_CONFIDENCE, GATE_STRENGTH, GATE_RR,
  MIN_PAIR_RELIABLE, RECENT_DAYS, REC_FRESH_MS, REC_AGING_MS,
  AUTO_TRADER_INVESTMENT_PCT,
} from '@/lib/signal-scoring';
import type { ScoredSignal, TradeTier } from '@/lib/signal-scoring';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction
} from '@/components/ui/alert-dialog';
import { formatDistanceToNow, format } from 'date-fns';
import { getSignalHistoryPage, getEvaluatedSignalsPage } from '@/db/api';
import type { LiveOrder } from '@/db/api';
import { Pagination } from '@/components/ui/SignalPagination';

const PAGE_SIZE = 20; // items per page for all paginated lists

// ── Signal Filters ─────────────────────────────────────────────────────────────

type SignalTypeFilter = 'all' | 'BUY' | 'SELL' | 'HOLD';
type ConfidenceFilter = 'all' | '60' | '70' | '80';
type RiskFilter = 'all' | 'Low' | 'Medium' | 'High';
type AISourceFilter = 'all' | 'openai' | 'gemini' | 'groq';
type SortOption = 'newest' | 'conf_desc' | 'conf_asc';

interface SignalFilterState {
  signalType: SignalTypeFilter;
  confidence: ConfidenceFilter;
  risk: RiskFilter;
  aiSource: AISourceFilter;
  sort: SortOption;
}

const DEFAULT_FILTERS: SignalFilterState = {
  signalType: 'all', confidence: 'all', risk: 'all', aiSource: 'all', sort: 'newest',
};

const LS_KEY = 'tm_signal_filters_v1';

function loadFilters(): SignalFilterState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_FILTERS;
}

function saveFilters(f: SignalFilterState) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(f)); } catch { /* ignore */ }
}

function applyFilters(signals: AISignal[], f: SignalFilterState): AISignal[] {
  let result = [...signals];

  if (f.signalType !== 'all') {
    result = result.filter(s => s.signal_type === f.signalType);
  }
  if (f.confidence !== 'all') {
    const min = parseInt(f.confidence, 10);
    result = result.filter(s => (s.confidence ?? 0) >= min);
  }
  if (f.risk !== 'all') {
    result = result.filter(s =>
      (s.risk_level ?? '').toLowerCase() === f.risk.toLowerCase()
    );
  }
  if (f.aiSource !== 'all') {
    result = result.filter(s => s.ai_source === f.aiSource);
  }

  if (f.sort === 'newest') {
    result.sort((a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime());
  } else if (f.sort === 'conf_desc') {
    result.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  } else {
    result.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
  }

  return result;
}

function hasActiveFilters(f: SignalFilterState): boolean {
  return (
    f.signalType !== 'all' || f.confidence !== 'all' ||
    f.risk !== 'all' || f.aiSource !== 'all' || f.sort !== 'newest'
  );
}

// ── FilterPanel (rendered inside popover) ────────────────────────────────────
function FilterPanel({
  filters, onChange, onClear,
}: {
  filters: SignalFilterState;
  onChange: (f: SignalFilterState) => void;
  onClear: () => void;
}) {
  const set = <K extends keyof SignalFilterState>(key: K, val: SignalFilterState[K]) =>
    onChange({ ...filters, [key]: val });

  const Chip = ({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-muted text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3 p-1">
      {/* Signal type */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Signal</p>
        <div className="flex flex-wrap gap-1.5">
          {(['all', 'BUY', 'SELL', 'HOLD'] as SignalTypeFilter[]).map(v => (
            <Chip key={v} label={v === 'all' ? 'All' : v} active={filters.signalType === v} onClick={() => set('signalType', v)} />
          ))}
        </div>
      </div>
      {/* Confidence */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Confidence</p>
        <div className="flex flex-wrap gap-1.5">
          {([['all','All'],['80','80+'],['70','70+'],['60','60+']] as [ConfidenceFilter,string][]).map(([v,l]) => (
            <Chip key={v} label={l} active={filters.confidence === v} onClick={() => set('confidence', v)} />
          ))}
        </div>
      </div>
      {/* Risk */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Risk</p>
        <div className="flex flex-wrap gap-1.5">
          {([['all','All'],['Low','Low'],['Medium','Med'],['High','High']] as [RiskFilter,string][]).map(([v,l]) => (
            <Chip key={v} label={l} active={filters.risk === v} onClick={() => set('risk', v)} />
          ))}
        </div>
      </div>
      {/* AI Source */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">AI Source</p>
        <div className="flex flex-wrap gap-1.5">
          {([['all','All'],['openai','OpenAI'],['groq','Groq']] as [AISourceFilter,string][]).map(([v,l]) => (
            <Chip key={v} label={l} active={filters.aiSource === v} onClick={() => set('aiSource', v)} />
          ))}
        </div>
      </div>
      {/* Sort */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Sort</p>
        <div className="flex flex-wrap gap-1.5">
          {([['newest','Newest'],['conf_desc','Conf ↓'],['conf_asc','Conf ↑']] as [SortOption,string][]).map(([v,l]) => (
            <Chip key={v} label={l} active={filters.sort === v} onClick={() => set('sort', v)} />
          ))}
        </div>
      </div>
      {/* Clear */}
      {hasActiveFilters(filters) && (
        <button
          onClick={onClear}
          className="w-full mt-1 text-[11px] text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 py-1"
        >
          <X className="w-3 h-3" /> Clear all filters
        </button>
      )}
    </div>
  );
}

// ── SignalFilters: Filter button + popover ────────────────────────────────────
function SignalFilters({
  filters, onChange, onClear, totalCount, filteredCount,
}: {
  filters: SignalFilterState;
  onChange: (f: SignalFilterState) => void;
  onClear: () => void;
  totalCount: number;
  filteredCount: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = hasActiveFilters(filters);
  const activeCount = [
    filters.signalType !== 'all',
    filters.confidence !== 'all',
    filters.risk !== 'all',
    filters.aiSource !== 'all',
    filters.sort !== 'newest',
  ].filter(Boolean).length;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      {/* Counter */}
      <p className="text-xs text-muted-foreground">
        {active
          ? <><span className="text-foreground font-medium">{filteredCount}</span> of <span className="text-foreground font-medium">{totalCount}</span> live signals</>
          : <><span className="text-foreground font-medium">{totalCount}</span> live signal{totalCount !== 1 ? 's' : ''}</>
        }
      </p>

      {/* Filter button + popover */}
      <div className="relative" ref={ref}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(v => !v)}
          className={cn(
            'h-7 px-2.5 text-xs gap-1.5',
            active && 'border-primary text-primary'
          )}
        >
          <Filter className="w-3 h-3" />
          Filter
          {activeCount > 0 && (
            <span className="bg-primary text-primary-foreground rounded-full w-4 h-4 text-[10px] flex items-center justify-center font-bold">
              {activeCount}
            </span>
          )}
          <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
        </Button>

        <div className={cn(
          'absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-3 w-64',
          open ? 'block' : 'hidden',
        )}>
          <FilterPanel
            filters={filters}
            onChange={f => { onChange(f); saveFilters(f); }}
            onClear={() => { onClear(); setOpen(false); }}
          />
        </div>
      </div>
    </div>
  );
}


/** Format a duration in ms as a human string: "11h 42m", "2d 3h", "45m", "< 1m" */
function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'Expiring';
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 1) return '< 1m';
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(ms / 3_600_000);
  const remMin = Math.ceil((ms % 3_600_000) / 60_000);
  if (hours < 24) return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  const days  = Math.floor(ms / 86_400_000);
  const remH  = Math.floor((ms % 86_400_000) / 3_600_000);
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

/**
 * SignalAgeBadge — countdown driven by expires_at stored on the signal.
 * Falls back to computing expires_at from generated_at + holdingTimeToMsFE(holding_time).
 * Updates every 60 s for short signals, every 5 min for multi-hour signals.
 */
function SignalAgeBadge({ signal }: { signal: AISignal }) {
  // Resolve the expiry deadline: prefer DB-stored expires_at, fall back to computed value
  const expiresAtMs = useMemo(() => {
    if (signal.expires_at) {
      const t = new Date(signal.expires_at).getTime();
      if (!isNaN(t)) return t;
    }
    const genMs = new Date(signal.generated_at).getTime();
    const ttlMs = holdingTimeToMsFE(signal.holding_time);
    return genMs + ttlMs;
  }, [signal.expires_at, signal.generated_at, signal.holding_time]);

  const [remainMs, setRemainMs] = useState(() => Math.max(0, expiresAtMs - Date.now()));

  useEffect(() => {
    const refresh = () => setRemainMs(Math.max(0, expiresAtMs - Date.now()));
    // Tick every 60 s for < 2 h remaining; otherwise every 5 min
    const intervalMs = remainMs < 2 * 3_600_000 ? 60_000 : 5 * 60_000;
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [expiresAtMs, remainMs]);

  const totalMs = expiresAtMs - new Date(signal.generated_at).getTime();
  const pct = totalMs > 0 ? Math.min(100, ((totalMs - remainMs) / totalMs) * 100) : 100;
  const isUrgent = remainMs < 30 * 60_000; // < 30 min

  return (
    <div className={cn(
      'flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border',
      isUrgent
        ? 'text-warning border-warning/40 bg-warning/10'
        : 'text-muted-foreground border-border bg-muted/40'
    )}>
      <Timer className="w-3 h-3 shrink-0" />
      {fmtRemaining(remainMs)}
      <span className="text-[9px] opacity-60">{Math.round(pct)}%</span>
    </div>
  );
}

// ─── AI Signal Card ──────────────────────────────────────────────────────────
function SignalCard({
  signal,
  onDemoBuy,
  onLiveBuy,
  onLiveSell,
}: {
  signal: AISignal;
  onDemoBuy: (s: AISignal) => void;
  onLiveBuy: (s: AISignal) => void;
  onLiveSell: (s: AISignal) => void;
}) {
  const { isPionexLive, pionexAccountStatus } = useTrading();
  const pionexConnected = pionexAccountStatus === 'connected';
  const liveDisabled = !isPionexLive || !pionexConnected;
  const liveDisabledReason = !isPionexLive
    ? 'Live trading disabled'
    : !pionexConnected
    ? 'Pionex not connected'
    : null;
  const [expanded, setExpanded] = useState(false);
  const generatedLabel = formatDistanceToNow(new Date(signal.generated_at), { addSuffix: true });

  return (
    <Card className="card-hover border-border" style={{ background: 'hsl(var(--card))' }}>
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start gap-3">
          <CoinLogo symbol={signal.symbol} size={42} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">{signal.pair}</span>
              <SignalBadge type={signal.signal_type} />
              <RiskBadge level={signal.risk_level} />
              {signal.ai_source === 'groq' && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-warning/40 bg-warning/10 text-warning">
                  AI: Groq
                </span>
              )}
              {(signal.ai_source === 'openai' || signal.ai_source === 'gemini') && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-primary/30 bg-primary/5 text-primary">
                  AI: OpenAI
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{signal.coin_name}</div>
            <div className="text-lg font-bold font-['Space_Grotesk'] mt-1">
              ${signal.current_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: signal.current_price < 1 ? 6 : 2 })}
            </div>
          </div>
          <ConfidenceRing value={signal.confidence} size={70} />
        </div>

        {/* Age + generated time */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <SignalAgeBadge signal={signal} />
          <span className="text-[10px] text-muted-foreground">Generated {generatedLabel}</span>
        </div>

        {/* Signal details */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
          {[
            ['Entry Zone', `${signal.entry_zone_low.toLocaleString()} – ${signal.entry_zone_high.toLocaleString()}`],
            ['Take Profit', `${signal.take_profit_1.toLocaleString()} / ${signal.take_profit_2.toLocaleString()}`],
            ['Stop Loss', signal.stop_loss.toLocaleString()],
            ['Risk / Reward', `1 : ${signal.risk_reward}`],
            ['Hold Time', signal.holding_time],
            ['Signal Strength', `${signal.signal_strength}/100`],
          ].map(([k, v]) => (
            <div key={k} className="p-2 rounded bg-muted border border-border">
              <div className="text-muted-foreground mb-0.5">{k}</div>
              <div className="font-medium text-foreground">{v}</div>
            </div>
          ))}
        </div>

        {/* AI Reasoning */}
        <div className="p-3 rounded-lg border border-border bg-muted">
          <button onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between gap-2 text-left">
            <div className="flex items-center gap-1.5">
              <Brain className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="text-xs font-semibold text-foreground">AI Reasoning</span>
            </div>
            <span className="text-xs text-primary">{expanded ? 'Less' : 'More'}</span>
          </button>
          {expanded ? (
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              {[
                ['Trend', signal.reasoning.trend],
                ['Momentum', signal.reasoning.momentum],
                ['RSI', signal.reasoning.rsi?.toString()],
                ['MACD', signal.reasoning.macd],
                ['Volume', signal.reasoning.volume],
                ['Support', signal.reasoning.support],
              ].map(([k, v]) => (
                <div key={k}>
                  <span className="text-muted-foreground">{k}: </span>
                  <span className="font-medium text-foreground">{v}</span>
                </div>
              ))}
              <div className="col-span-2 mt-2 pt-2 border-t border-border">
                <span className="text-muted-foreground">AI Conclusion: </span>
                <span className="font-medium text-foreground">{signal.reasoning.conclusion}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{signal.reasoning.conclusion}</p>
          )}
        </div>

        {/* Actions */}
        {signal.signal_type === 'BUY' && (
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" className="h-9 text-sm font-semibold"
              style={{ background: 'var(--gradient-primary)' }}
              onClick={() => onDemoBuy(signal)}>
              Demo Buy
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-sm font-semibold border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onLiveBuy(signal)}
              disabled={liveDisabled}
              title={liveDisabledReason ?? 'Send real BUY to Pionex'}
            >
              BUY LIVE
            </Button>
          </div>
        )}
        {signal.signal_type === 'SELL' && (
          <div className="grid grid-cols-1 gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-sm font-semibold border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onLiveSell(signal)}
              disabled={liveDisabled}
              title={liveDisabledReason ?? 'Sell existing live position on Pionex'}
            >
              SELL LIVE
            </Button>
          </div>
        )}

        {signal.signal_type === 'WAIT' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground p-2 rounded bg-muted border border-border">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            AI recommends waiting for better entry conditions
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Open Trade Card ──────────────────────────────────────────────────────────
function OpenTradeCard({ trade, onClose }: { trade: DemoTrade; onClose: () => void }) {
  const pnl = trade.unrealized_pnl ?? 0;
  const pnlPct = trade.pnl_pct ?? 0;
  const isProfit = pnl >= 0;
  const aiStatus = trade.ai_status ?? 'Holding';
  const duration = formatDistanceToNow(new Date(trade.opened_at), { addSuffix: false });

  const aiStatusColor = {
    'Holding': 'text-muted-foreground',
    'Bullish': 'text-positive',
    'Bearish': 'text-negative',
    'Take Profit Approaching': 'text-success',
    'Stop Loss Approaching': 'text-destructive',
    'Trend Changed': 'text-warning',
    'Risk Increased': 'text-warning',
    'Potential Exit': 'text-warning',
  }[aiStatus] ?? 'text-muted-foreground';

  return (
    <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <CoinLogo symbol={trade.symbol} size={38} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">{trade.pair}</span>
              <Badge variant="outline" className="text-xs text-primary border-primary/30">OPEN</Badge>
            </div>
            <div className="text-xs text-muted-foreground">{trade.coin_name}</div>
          </div>
          <div className="text-right shrink-0">
            <div className={cn('text-lg font-bold font-["Space_Grotesk"]', isProfit ? 'text-positive' : 'text-negative')}>
              {isProfit ? '+' : ''}{pnl.toFixed(2)} USDT
            </div>
            <div className={cn('text-xs font-medium', isProfit ? 'text-positive' : 'text-negative')}>
              {isProfit ? '+' : ''}{pnlPct.toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          {[
            ['Buy Price', `$${trade.buy_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: trade.buy_price < 1 ? 6 : 2 })}`],
            ['Current Price', `$${(trade.current_price ?? trade.buy_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: (trade.current_price ?? trade.buy_price) < 1 ? 6 : 2 })}`],
            ['Quantity', trade.quantity.toFixed(6)],
            ['Investment', `${trade.investment.toFixed(2)} USDT`],
            ['Current Value', `${(trade.current_value ?? trade.investment).toFixed(2)} USDT`],
            ['Duration', duration],
          ].map(([k, v]) => (
            <div key={k} className="p-2 rounded bg-muted border border-border">
              <div className="text-muted-foreground mb-0.5">{k}</div>
              <div className="font-medium text-foreground">{v}</div>
            </div>
          ))}
        </div>

        {(trade.stop_loss || trade.take_profit) && (
          <div className="flex gap-2 text-xs">
            {trade.stop_loss && (
              <div className="flex-1 p-2 rounded border border-destructive/30 bg-destructive/5">
                <span className="text-destructive/70">SL: </span>
                <span className="text-destructive font-medium">${trade.stop_loss.toLocaleString()}</span>
              </div>
            )}
            {trade.take_profit && (
              <div className="flex-1 p-2 rounded border border-success/30 bg-success/5">
                <span className="text-success/70">TP: </span>
                <span className="text-success font-medium">${trade.take_profit.toLocaleString()}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20">
          <Brain className="w-3.5 h-3.5 text-primary shrink-0" />
          <div className="flex-1 min-w-0 text-xs">
            <span className="text-muted-foreground">AI Status: </span>
            <span className={cn('font-semibold', aiStatusColor)}>{aiStatus}</span>
          </div>
          {trade.ai_confidence && (
            <span className="text-xs text-muted-foreground shrink-0">Conf: {trade.ai_confidence}%</span>
          )}
        </div>

        <Button variant="outline" size="sm" className="w-full h-9 text-destructive hover:text-destructive border-destructive/30 hover:border-destructive/50"
          onClick={onClose}>
          Close Trade
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Trade History Row ─────────────────────────────────────────────────────────
function HistoryRow({ trade }: { trade: DemoTradeHistory }) {
  const isProfit = trade.profit_loss >= 0;
  const exitLabels = { manual: 'Manual Close', take_profit: 'Take Profit', stop_loss: 'Stop Loss' };
  return (
    <div className="grid grid-cols-[auto_1fr_auto_auto_auto] md:grid-cols-[auto_1fr_1fr_1fr_auto_auto] items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
      <CoinLogo symbol={trade.symbol} size={28} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{trade.pair}</div>
        <div className="text-xs text-muted-foreground truncate">{format(new Date(trade.closed_at), 'MMM d, HH:mm')}</div>
      </div>
      <div className="hidden md:block text-xs">
        <div className="text-muted-foreground">Buy</div>
        <div className="font-medium">${trade.buy_price.toFixed(2)}</div>
      </div>
      <div className="hidden md:block text-xs">
        <div className="text-muted-foreground">Sell</div>
        <div className="font-medium">${trade.sell_price.toFixed(2)}</div>
      </div>
      <div className="text-right">
        <div className={cn('text-sm font-bold', isProfit ? 'text-positive' : 'text-negative')}>
          {isProfit ? '+' : ''}{trade.profit_loss.toFixed(2)} USDT
        </div>
        <div className={cn('text-xs', isProfit ? 'text-positive' : 'text-negative')}>
          {isProfit ? '+' : ''}{trade.profit_loss_pct.toFixed(2)}%
        </div>
      </div>
      <Badge variant="outline" className={cn('text-xs shrink-0',
        trade.exit_reason === 'take_profit' ? 'border-success/30 text-success' :
        trade.exit_reason === 'stop_loss' ? 'border-destructive/30 text-destructive' :
        'border-border text-muted-foreground')}>
        {exitLabels[trade.exit_reason]}
      </Badge>
    </div>
  );
}

// ─── Live Order Card (ekte Pionex-trade, kun visning) ─────────────────────────
function LiveOrderCard({ order, currentPrice }: { order: LiveOrder; currentPrice?: number }) {
  const fillPrice  = Number(order.fill_price)  || 0;
  const filledQty  = Number(order.filled_qty)  || 0;
  const investment = Number(order.investment)  || 0;
  const isOpen     = ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(order.status);
  const isClosed   = ['FILLED', 'CLOSED', 'CANCELED', 'CANCELLED'].includes(order.status);

  // Beregn P/L for åpne trades basert på gjeldende markedspris
  const livePrice  = currentPrice ?? fillPrice;
  const unrealized = order.side === 'BUY'
    ? (livePrice - fillPrice) * filledQty
    : (fillPrice - livePrice) * filledQty;
  const unrealizedPct = fillPrice > 0 ? (unrealized / investment) * 100 : 0;
  const isProfit   = unrealized >= 0;

  const duration = order.created_at
    ? formatDistanceToNow(new Date(order.created_at), { addSuffix: false })
    : '—';

  const statusColor = {
    NEW:              'border-primary/40 text-primary bg-primary/10',
    PARTIALLY_FILLED: 'border-warning/40 text-warning bg-warning/10',
    OPEN:             'border-primary/40 text-primary bg-primary/10',
    FILLED:           'border-success/40 text-success bg-success/10',
    CLOSED:           'border-muted-foreground/40 text-muted-foreground bg-muted',
    CANCELED:         'border-destructive/40 text-destructive bg-destructive/10',
    CANCELLED:        'border-destructive/40 text-destructive bg-destructive/10',
  }[order.status] ?? 'border-border text-muted-foreground';

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-3">
          <CoinLogo symbol={order.symbol} size={38} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">{order.pair}</span>
              <Badge className={cn('text-xs font-bold px-2 py-0.5', order.side === 'BUY' ? 'bg-success/15 text-success border border-success/30' : 'bg-destructive/15 text-destructive border border-destructive/30')}>
                {order.side}
              </Badge>
              <Badge className={cn('text-xs px-2 py-0.5 border', statusColor)}>
                {order.status}
              </Badge>
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[10px] font-bold text-destructive bg-destructive/10 border border-destructive/30 rounded px-1.5 py-0.5">
                🔴 LIVE / REAL MONEY
              </span>
            </div>
          </div>
          {isOpen && (
            <div className="text-right shrink-0">
              <div className={cn('text-lg font-bold font-["Space_Grotesk"]', isProfit ? 'text-positive' : 'text-negative')}>
                {isProfit ? '+' : ''}{unrealized.toFixed(4)} USDT
              </div>
              <div className={cn('text-xs font-medium', isProfit ? 'text-positive' : 'text-negative')}>
                {isProfit ? '+' : ''}{unrealizedPct.toFixed(2)}%
              </div>
            </div>
          )}
          {isClosed && order.realized_pnl !== null && (
            <div className="text-right shrink-0">
              <div className={cn('text-lg font-bold font-["Space_Grotesk"]', (order.realized_pnl ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                {(order.realized_pnl ?? 0) >= 0 ? '+' : ''}{(order.realized_pnl ?? 0).toFixed(4)} USDT
              </div>
              <div className="text-xs text-muted-foreground">Realized P/L</div>
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          {[
            ['Fill Price',  fillPrice  > 0 ? `$${fillPrice.toLocaleString('en-US',  { minimumFractionDigits: 2, maximumFractionDigits: fillPrice  < 1 ? 6 : 4 })}` : '—'],
            isOpen
              ? ['Current Price', livePrice > 0 ? `$${livePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: livePrice < 1 ? 6 : 4 })}` : '—']
              : ['Exit Price', order.closed_at ? '—' : '—'],
            ['Quantity',    filledQty  > 0 ? filledQty.toFixed(6) : '—'],
            ['Investment',  `${investment.toFixed(4)} USDT`],
            ['Duration',    duration],
            ['Order ID',    order.pionex_order_id ? `…${order.pionex_order_id.slice(-8)}` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="p-2 rounded bg-muted border border-border">
              <div className="text-muted-foreground mb-0.5 truncate">{k}</div>
              <div className="font-medium text-foreground truncate">{v}</div>
            </div>
          ))}
        </div>

        {/* Pionex Order ID full */}
        {order.pionex_order_id && (
          <div className="text-[10px] text-muted-foreground break-all px-1">
            Pionex Order ID: <span className="font-mono text-foreground">{order.pionex_order_id}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Live History Row ──────────────────────────────────────────────────────────
function LiveHistoryRow({ order }: { order: LiveOrder }) {
  const fillPrice    = Number(order.fill_price)   || 0;
  const investment   = Number(order.investment)   || 0;
  const realizedPnl  = Number(order.realized_pnl) || 0;
  const pnlPct       = investment > 0 ? (realizedPnl / investment) * 100 : 0;
  const isProfit     = realizedPnl >= 0;
  const exitLabels: Record<string, string> = {
    take_profit: 'Take Profit',
    stop_loss:   'Stop Loss',
    manual:      'Manual',
    tp:          'Take Profit',
    sl:          'Stop Loss',
  };
  const exitLabel = order.exit_reason ? (exitLabels[order.exit_reason] ?? order.exit_reason) : '—';

  return (
    <div className="grid grid-cols-[auto_1fr_auto_auto] md:grid-cols-[auto_1fr_1fr_1fr_1fr_auto] items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
      <CoinLogo symbol={order.symbol} size={28} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium text-foreground">{order.pair}</span>
          <Badge className={cn('text-[10px] px-1.5 py-0', order.side === 'BUY' ? 'bg-success/15 text-success border border-success/30' : 'bg-destructive/15 text-destructive border border-destructive/30')}>
            {order.side}
          </Badge>
          <span className="text-[10px] font-bold text-destructive">🔴 LIVE</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {order.created_at ? format(new Date(order.created_at), 'MMM d, HH:mm') : '—'}
          {order.closed_at ? ` → ${format(new Date(order.closed_at), 'MMM d, HH:mm')}` : ''}
        </div>
      </div>
      <div className="hidden md:block text-xs">
        <div className="text-muted-foreground">Entry</div>
        <div className="font-medium">${fillPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: fillPrice < 1 ? 6 : 4 })}</div>
      </div>
      <div className="hidden md:block text-xs">
        <div className="text-muted-foreground">Investert</div>
        <div className="font-medium">{investment.toFixed(4)} USDT</div>
      </div>
      <div className="text-right">
        <div className={cn('text-sm font-bold', isProfit ? 'text-positive' : 'text-negative')}>
          {isProfit ? '+' : ''}{realizedPnl.toFixed(4)} USDT
        </div>
        <div className={cn('text-xs', isProfit ? 'text-positive' : 'text-negative')}>
          {isProfit ? '+' : ''}{pnlPct.toFixed(2)}%
        </div>
      </div>
      <Badge variant="outline" className={cn('text-xs shrink-0 hidden md:flex',
        order.exit_reason === 'take_profit' || order.exit_reason === 'tp' ? 'border-success/30 text-success' :
        order.exit_reason === 'stop_loss'   || order.exit_reason === 'sl'  ? 'border-destructive/30 text-destructive' :
        'border-border text-muted-foreground')}>
        {exitLabel}
      </Badge>
    </div>
  );
}

// ─── Signal History Row ────────────────────────────────────────────────────────
function SignalHistoryRow({ item }: { item: SignalHistory }) {
  const resultConfig = {
    WIN:     { label: 'WIN',     cls: 'border-success/40 text-success bg-success/10' },
    LOSS:    { label: 'LOSS',    cls: 'border-destructive/40 text-destructive bg-destructive/10' },
    EXPIRED: { label: 'EXPIRED', cls: 'border-border text-muted-foreground bg-muted/40' },
  };
  const rc = item.result ? resultConfig[item.result] : resultConfig.EXPIRED;
  const plIsPos = (item.pl_pct ?? 0) >= 0;

  return (
    <div className="grid grid-cols-[auto_1fr_auto_auto] md:grid-cols-[auto_1fr_auto_auto_auto_auto_auto] items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
      <CoinLogo symbol={item.symbol} size={26} />
      {/* Pair + time */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium text-foreground">{item.pair}</span>
          <SignalBadge type={item.signal_type} />
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {format(new Date(item.generated_at), 'MMM d, HH:mm')} → {format(new Date(item.expires_at), 'HH:mm')}
        </div>
      </div>
      {/* Confidence (hidden on small) */}
      <div className="hidden md:block text-xs text-center">
        <div className="text-muted-foreground">Conf.</div>
        <div className="font-semibold text-foreground">{item.confidence}%</div>
      </div>
      {/* Entry / Exit prices (hidden on small) */}
      <div className="hidden md:block text-xs">
        <div className="text-muted-foreground">Entry</div>
        <div className="font-medium">${Number(item.entry_price).toLocaleString('en-US', { maximumFractionDigits: item.entry_price < 1 ? 6 : 2 })}</div>
      </div>
      <div className="hidden md:block text-xs">
        <div className="text-muted-foreground">Exit</div>
        <div className="font-medium">{item.exit_price != null ? `$${Number(item.exit_price).toLocaleString('en-US', { maximumFractionDigits: item.exit_price < 1 ? 6 : 2 })}` : '—'}</div>
      </div>
      {/* P/L % */}
      <div className="text-right text-xs hidden md:block">
        <div className="text-muted-foreground">P/L</div>
        <div className={cn('font-bold', item.pl_pct != null ? (plIsPos ? 'text-positive' : 'text-negative') : 'text-muted-foreground')}>
          {item.pl_pct != null ? `${plIsPos ? '+' : ''}${Number(item.pl_pct).toFixed(2)}%` : '—'}
        </div>
      </div>
      {/* Result badge */}
      <Badge variant="outline" className={cn('text-[10px] shrink-0 font-semibold', rc.cls)}>
        {rc.label}
      </Badge>
    </div>
  );
}

// ─── Trade Recommendation Engine ──────────────────────────────────────────────

interface TradeRec {
  signalType: 'BUY' | 'SELL';
  recommended: boolean;
  reason: string;
  minConfidence: number | null;
  minStrength: number | null;
  minRR: number | null;
  preferredAI: string | null;
  winRate: number | null;
  avgPL: number | null;
  sampleSize: number;
}

interface RecommendationResult {
  buy: TradeRec;
  sell: TradeRec;
  insufficientData: boolean;
  overallWinRate: number | null;
}

function computeTradeRecommendation(
  patternStats: import('@/types/types').SignalPatternStat[],
  byAI: import('@/types/types').SignalPerformanceByAI[],
  evaluated: number,
): RecommendationResult {
  const MIN_SAMPLE = 5;      // need at least 5 WIN/LOSS signals per type to recommend
  const WIN_THRESHOLD = 55;  // must exceed 55% win rate to recommend
  const MIN_AVG_PL = 0;      // avg P/L must be non-negative to recommend

  const insufficientData = evaluated < MIN_SAMPLE;

  const makeStat = (type: 'BUY' | 'SELL'): TradeRec => {
    const stat = patternStats.find(p => p.signal_type === type);
    const wlTotal = (stat?.wins ?? 0) + (stat?.losses ?? 0);

    if (!stat || wlTotal < MIN_SAMPLE) {
      return {
        signalType: type,
        recommended: false,
        reason: wlTotal === 0
          ? 'No evaluated signals yet for this type.'
          : `Only ${wlTotal} WIN/LOSS signal${wlTotal !== 1 ? 's' : ''} evaluated — need ${MIN_SAMPLE} to assess.`,
        minConfidence: null, minStrength: null, minRR: null,
        preferredAI: null, winRate: null, avgPL: null,
        sampleSize: wlTotal,
      };
    }

    const winRate = Number(stat.win_rate_pct);
    const avgPL   = stat.avg_return_pct != null ? Number(stat.avg_return_pct) : null;

    // Determine best AI provider for this type
    const openai = byAI.find(a => a.ai_source === 'openai') ?? byAI.find(a => a.ai_source === 'gemini');
    const groq   = byAI.find(a => a.ai_source === 'groq');
    let preferredAI: string | null = null;
    if (openai && groq) {
      const gRate = openai.wins / Math.max(openai.wins + openai.losses, 1);
      const qRate = groq.wins   / Math.max(groq.wins   + groq.losses,   1);
      if (Math.abs(gRate - qRate) >= 0.1) {
        preferredAI = gRate > qRate ? 'OpenAI' : 'Groq';
      }
    } else if (openai && (openai.wins + openai.losses) >= 3) {
      preferredAI = 'OpenAI';
    } else if (groq && (groq.wins + groq.losses) >= 3) {
      preferredAI = 'Groq';
    }

    // Derive recommended minimum confidence from winning signals
    // Use avg_winning_confidence rounded up to nearest 5
    const rawConf = stat.avg_winning_confidence;
    const minConf = rawConf != null ? Math.ceil(Number(rawConf) / 5) * 5 : 65;

    const recommended = winRate >= WIN_THRESHOLD && (avgPL == null || avgPL >= MIN_AVG_PL);

    // Build human reason
    let reason: string;
    if (recommended) {
      reason = `${winRate.toFixed(1)}% win rate on ${wlTotal} signals`;
      if (avgPL != null && avgPL > 0) reason += `, avg +${avgPL.toFixed(2)}% P/L`;
      if (preferredAI) reason += `. ${preferredAI} performs better for ${type} signals`;
      reason += '.';
    } else {
      if (winRate < WIN_THRESHOLD && (avgPL == null || avgPL < 0)) {
        reason = `${winRate.toFixed(1)}% win rate and negative avg P/L (${avgPL?.toFixed(2)}%) — not profitable enough to recommend.`;
      } else if (winRate < WIN_THRESHOLD) {
        reason = `${winRate.toFixed(1)}% win rate on ${wlTotal} signals is below the 55% threshold.`;
      } else {
        reason = `Win rate is adequate but avg P/L is ${avgPL?.toFixed(2)}% — risk/reward not favorable.`;
      }
    }

    return {
      signalType: type,
      recommended,
      reason,
      minConfidence: minConf,
      minStrength: recommended ? 65 : null,
      minRR: recommended ? 1.6 : null,
      preferredAI,
      winRate,
      avgPL,
      sampleSize: wlTotal,
    };
  };

  const buy  = makeStat('BUY');
  const sell = makeStat('SELL');

  const totalWL  = patternStats.reduce((s, p) => s + p.wins + p.losses, 0);
  const totalWin = patternStats.reduce((s, p) => s + p.wins, 0);
  const overallWinRate = totalWL > 0 ? Math.round((totalWin / totalWL) * 1000) / 10 : null;

  return { buy, sell, insufficientData, overallWinRate };
}

// ─── Trade Recommendation Card ─────────────────────────────────────────────────
function TradeRecommendationCard({ rec }: { rec: TradeRec }) {
  const isInsuff = rec.sampleSize < 5;

  return (
    <div className={cn(
      'rounded-xl border p-4 flex flex-col gap-3',
      isInsuff
        ? 'border-border bg-muted/30'
        : rec.recommended
          ? 'border-positive/30 bg-positive/5'
          : 'border-negative/20 bg-negative/5',
    )}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <SignalBadge type={rec.signalType} />
          <span className="text-xs text-muted-foreground font-medium">signals</span>
        </div>
        <div className={cn(
          'text-xs font-bold px-2.5 py-1 rounded-full border',
          isInsuff
            ? 'text-muted-foreground border-border bg-muted/50'
            : rec.recommended
              ? 'text-positive border-positive/40 bg-positive/10'
              : 'text-negative border-negative/30 bg-negative/10',
        )}>
          {isInsuff ? 'Not enough data' : rec.recommended ? '✓ RECOMMENDED' : '✗ NOT RECOMMENDED'}
        </div>
      </div>

      {/* Reason */}
      <p className="text-xs text-muted-foreground leading-relaxed">{rec.reason}</p>

      {/* Stats grid — only when there's data */}
      {rec.sampleSize > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Win rate</span>
            <span className={cn('font-semibold tabular-nums',
              rec.winRate == null ? 'text-muted-foreground'
                : rec.winRate >= 55 ? 'text-positive' : 'text-negative'
            )}>
              {rec.winRate != null ? `${rec.winRate.toFixed(1)}%` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Avg P/L</span>
            <span className={cn('font-semibold tabular-nums',
              rec.avgPL == null ? 'text-muted-foreground'
                : rec.avgPL >= 0 ? 'text-positive' : 'text-negative'
            )}>
              {rec.avgPL != null ? `${rec.avgPL >= 0 ? '+' : ''}${rec.avgPL.toFixed(2)}%` : '—'}
            </span>
          </div>
          {rec.recommended && rec.minConfidence != null && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Min confidence</span>
              <span className="font-semibold text-foreground tabular-nums">{rec.minConfidence}%</span>
            </div>
          )}
          {rec.recommended && rec.minStrength != null && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Min strength</span>
              <span className="font-semibold text-foreground tabular-nums">{rec.minStrength}</span>
            </div>
          )}
          {rec.recommended && rec.minRR != null && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Min risk/reward</span>
              <span className="font-semibold text-foreground tabular-nums">{rec.minRR}×</span>
            </div>
          )}
          {rec.preferredAI && (
            <div className="flex items-center justify-between col-span-2">
              <span className="text-muted-foreground">Best AI provider</span>
              <span className="font-semibold text-foreground capitalize">{rec.preferredAI}</span>
            </div>
          )}
          <div className="flex items-center justify-between col-span-2">
            <span className="text-muted-foreground">Sample size (W/L)</span>
            <span className="font-semibold text-foreground tabular-nums">{rec.sampleSize} signals</span>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Recommended to Trade: UI Components ─────────────────────────────────────

const TIER_CONFIG: Record<TradeTier, {
  emoji: string; label: string;
  badgeClass: string; borderClass: string; bgClass: string;
}> = {
  RECOMMENDED: {
    emoji: '🟢', label: 'RECOMMENDED',
    badgeClass: 'text-positive border-positive/40 bg-positive/10',
    borderClass: 'border-positive/30',
    bgClass: 'bg-positive/5',
  },
  WATCH: {
    emoji: '🟡', label: 'WATCH',
    badgeClass: 'text-warning border-warning/40 bg-warning/10',
    borderClass: 'border-warning/30',
    bgClass: 'bg-warning/5',
  },
  NO_TRADE: {
    emoji: '🔴', label: 'NO TRADE',
    badgeClass: 'text-negative border-negative/30 bg-negative/10',
    borderClass: 'border-border',
    bgClass: 'bg-muted/20',
  },
};

function ScoreBar({ score, current }: { score: number; current: number }) {
  const color = current >= 55 ? 'bg-positive' : current >= 35 ? 'bg-warning' : 'bg-negative';
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${current}%` }} />
        </div>
        <span className="text-[10px] font-bold tabular-nums text-foreground w-12 text-right">{current}/100</span>
      </div>
      {current !== score && (
        <p className="text-[9px] text-muted-foreground text-right">
          Historical: {score}/100
        </p>
      )}
    </div>
  );
}

// Helper: format signal age in a compact human string
function fmtSignalAge(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  const m = Math.floor(ageMs / 60_000);
  const s = Math.floor((ageMs % 60_000) / 1_000);
  return s > 0 ? `${m}m ${s}s ago` : `${m}m ago`;
}

function RecommendedSignalCard({ item, rank, best }: { item: ScoredSignal; rank: number; best?: boolean }) {
  const cfg = TIER_CONFIG[item.tier];
  const s   = item.signal;
  const fmt = (n: number) => n < 1
    ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Live signal age: recomputed every second via parent tick
  const [liveAgeMs, setLiveAgeMs] = useState(() => Date.now() - new Date(s.generated_at).getTime());
  useEffect(() => {
    const t = setInterval(() => setLiveAgeMs(Date.now() - new Date(s.generated_at).getTime()), 1_000);
    return () => clearInterval(t);
  }, [s.generated_at]);

  const liveFreshness: 'FRESH' | 'AGING' | 'STALE' =
    liveAgeMs <= REC_FRESH_MS ? 'FRESH' :
    liveAgeMs <= REC_AGING_MS ? 'AGING' : 'STALE';

  const freshnessStyle =
    liveFreshness === 'FRESH' ? 'text-positive border-positive/40 bg-positive/10' :
    liveFreshness === 'AGING' ? 'text-warning border-warning/40 bg-warning/10' :
    'text-negative border-negative/40 bg-negative/10';

  const freshnessEmoji =
    liveFreshness === 'FRESH' ? '🟢' :
    liveFreshness === 'AGING' ? '🟡' : '🔴';

  // Show raw pair P/L for display, but flag it as low-sample if needed
  const displayPL  = item.typeAvgPL;           // always show type-level (reliable)
  const pairDispPL = item.pairAvgPL;           // show pair P/L only as supplementary
  const pairTiny   = item.pairSampleSize > 0 && item.pairSampleSize < MIN_PAIR_RELIABLE;

  return (
    <div className={cn('rounded-xl border p-4 flex flex-col gap-3',
      best ? 'border-primary/40 bg-primary/5' : cfg.borderClass,
      best ? '' : cfg.bgClass
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className={cn('w-6 h-6 rounded-full border flex items-center justify-center shrink-0',
            best ? 'bg-primary/20 border-primary/30' : 'bg-primary/10 border-primary/20'
          )}>
            <span className="text-[10px] font-bold text-primary">#{rank}</span>
          </div>
          <CoinLogo symbol={s.symbol} size={32} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-sm text-foreground">{s.pair}</span>
              <SignalBadge type={s.signal_type} />
            </div>
            <div className="text-[10px] text-muted-foreground">{s.coin_name}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={cn('text-[10px] font-bold px-2 py-1 rounded-full border', cfg.badgeClass)}>
            {cfg.emoji} {cfg.label}
          </span>
          {/* Freshness badge — live countdown */}
          <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', freshnessStyle)}>
            {freshnessEmoji} {liveFreshness} · {fmtSignalAge(liveAgeMs)}
          </span>
          {best && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary">
              BEST SETUP
            </span>
          )}
          {s.ai_source && (
            <span className={cn('text-[9px] font-semibold px-1.5 py-0.5 rounded-full border',
              (s.ai_source === 'openai' || s.ai_source === 'gemini')
                ? 'text-primary border-primary/30 bg-primary/5'
                : 'text-warning border-warning/40 bg-warning/10'
            )}>
              {(s.ai_source === 'openai' || s.ai_source === 'gemini') ? 'OpenAI' : 'Groq'}
            </span>
          )}
        </div>
      </div>

      {/* Current Score bar (freshness-adjusted) */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] text-muted-foreground font-medium">Current Score</p>
          {liveFreshness !== 'FRESH' && (
            <p className="text-[9px] text-warning">
              {liveFreshness === 'AGING' ? '×0.70 freshness penalty' : '×0.30 stale penalty'}
            </p>
          )}
        </div>
        <ScoreBar score={item.score} current={item.currentScore} />
      </div>

      {/* Why recommended — data-driven summary */}
      {item.tier === 'RECOMMENDED' && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 space-y-1.5">
          <p className="text-[10px] font-semibold text-primary flex items-center gap-1">
            <Target className="w-3 h-3" />
            {best ? 'STRONG HISTORICAL EDGE' : 'QUALIFIED BY HISTORICAL EDGE'}
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Similar signals</span>
              <span className="font-semibold tabular-nums text-foreground">{item.comparableSampleSize}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Win rate</span>
              <span className={cn('font-semibold tabular-nums',
                (item.comparableWinRate ?? 0) >= GATE_WIN_RATE ? 'text-positive' : 'text-foreground'
              )}>
                {item.comparableWinRate != null ? `${item.comparableWinRate.toFixed(0)}%` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Avg P/L</span>
              <span className={cn('font-semibold tabular-nums',
                (item.comparableAvgPL ?? 0) > 0 ? 'text-positive' : 'text-foreground'
              )}>
                {item.comparableAvgPL != null ? `${item.comparableAvgPL >= 0 ? '+' : ''}${item.comparableAvgPL.toFixed(2)}%` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Recent (7d) P/L</span>
              <span className={cn('font-semibold tabular-nums',
                (item.recentAvgPL ?? 0) > 0 ? 'text-positive' : 'text-foreground'
              )}>
                {item.recentAvgPL != null ? `${item.recentAvgPL >= 0 ? '+' : ''}${item.recentAvgPL.toFixed(2)}%` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Expired rate</span>
              <span className="font-semibold tabular-nums text-foreground">
                {item.comparableExpiredRate != null ? `${item.comparableExpiredRate.toFixed(0)}%` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Confidence</span>
              <span className="font-semibold tabular-nums text-foreground">{s.confidence}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Stats grid — type-level (authoritative) + key signal quality metrics */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Type win rate</span>
          <span className={cn('font-semibold tabular-nums',
            item.typeWinRate == null ? 'text-muted-foreground'
              : item.typeWinRate >= GATE_WIN_RATE ? 'text-positive' : 'text-negative'
          )}>
            {item.typeWinRate != null ? `${item.typeWinRate.toFixed(0)}%` : '—'}
            <span className="text-[9px] text-muted-foreground ml-1">({item.typeSampleSize})</span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Type avg P/L</span>
          <span className={cn('font-semibold tabular-nums',
            displayPL == null ? 'text-muted-foreground'
              : displayPL > GATE_AVG_PL ? 'text-positive' : 'text-negative'
          )}>
            {displayPL != null ? `${displayPL >= 0 ? '+' : ''}${displayPL.toFixed(1)}%` : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Confidence</span>
          <span className={cn('font-semibold tabular-nums',
            s.confidence >= GATE_CONFIDENCE ? 'text-foreground' : 'text-negative'
          )}>{s.confidence}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Signal strength</span>
          <span className={cn('font-semibold tabular-nums',
            (s.signal_strength ?? 0) >= GATE_STRENGTH ? 'text-foreground' : 'text-negative'
          )}>{s.signal_strength}/100</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Risk/Reward</span>
          <span className={cn('font-semibold tabular-nums',
            parseFloat(s.risk_reward ?? '0') >= GATE_RR ? 'text-foreground' : 'text-negative'
          )}>1:{s.risk_reward}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Recent WR (7d)</span>
          <span className={cn('font-semibold tabular-nums',
            item.recentWinRate == null ? 'text-muted-foreground'
              : item.recentWinRate >= GATE_WIN_RATE ? 'text-positive' : 'text-negative'
          )}>
            {item.recentWinRate != null ? `${item.recentWinRate.toFixed(0)}%` : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Hold time</span>
          <span className="font-semibold tabular-nums text-foreground">{s.holding_time}</span>
        </div>
      </div>

      {/* Pair-level P/L (supplementary — with explicit sample warning) */}
      {pairDispPL !== null && item.pairSampleSize > 0 && (
        <div className={cn('rounded-lg border px-3 py-2 text-[10px]',
          pairTiny ? 'border-warning/30 bg-warning/5' : 'border-border bg-muted/30'
        )}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">
              {s.pair} avg P/L ({item.pairSampleSize} trade{item.pairSampleSize !== 1 ? 's' : ''})
            </span>
            <span className={cn('font-semibold tabular-nums',
              pairDispPL >= 0 ? 'text-positive' : 'text-negative'
            )}>
              {pairDispPL >= 0 ? '+' : ''}{pairDispPL.toFixed(1)}%
            </span>
          </div>
          {pairTiny && (
            <p className="text-warning/80 mt-1">
              ⚠ Insufficient sample — not used for scoring
            </p>
          )}
        </div>
      )}

      {/* Failed gates (WATCH / NO_TRADE only) */}
      {item.failedGates.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground">Unmet criteria</p>
          {item.failedGates.map(g => (
            <div key={g.label} className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">{g.label}</span>
              <span className="text-negative font-medium">{g.value} (need {g.required})</span>
            </div>
          ))}
        </div>
      )}

      {/* Price levels */}
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div className="rounded bg-muted/60 border border-border p-2">
          <div className="text-muted-foreground mb-0.5">Entry</div>
          <div className="font-medium text-foreground">${fmt(s.entry_zone_low)}</div>
        </div>
        <div className="rounded bg-positive/10 border border-positive/20 p-2">
          <div className="text-muted-foreground mb-0.5">Take Profit</div>
          <div className="font-medium text-positive">${fmt(s.take_profit_1)}</div>
        </div>
        <div className="rounded bg-negative/10 border border-negative/20 p-2">
          <div className="text-muted-foreground mb-0.5">Stop Loss</div>
          <div className="font-medium text-negative">${fmt(s.stop_loss)}</div>
        </div>
      </div>

      {/* Reason */}
      <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-border pt-2">
        {item.reason}
      </p>
    </div>
  );
}

function WatchlistRow({ item }: { item: ScoredSignal }) {
  const s = item.signal;
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
      <CoinLogo symbol={s.symbol} size={28} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-semibold text-foreground">{s.pair}</span>
          <SignalBadge type={s.signal_type} />
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border text-warning border-warning/40 bg-warning/10">
            🟡 WATCH
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{item.reason}</p>
        {item.failedGates.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {item.failedGates.map(g => (
              <span key={g.label} className="text-[9px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                {g.label}: {g.value}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="text-[10px] font-bold tabular-nums text-muted-foreground shrink-0">{item.score}/100</span>
    </div>
  );
}

// ─── Signal History Tab (server-side paginated) ───────────────────────────────
function SignalHistoryTab() {
  const { refreshSignalHistory } = useTrading();

  const [page, setPage]               = useState(1);
  const [rows, setRows]               = useState<SignalHistory[]>([]);
  const [totalCount, setTotalCount]   = useState(0);
  const [loading, setLoading]         = useState(true);
  const [typeFilter, setTypeFilter]   = useState<'all' | 'BUY' | 'SELL'>('all');
  const [resultFilter, setResultFilter] = useState<'all' | 'WIN' | 'LOSS' | 'EXPIRED'>('all');

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const fetchPage = useCallback(async (p: number, type: string, result: string) => {
    setLoading(true);
    try {
      // Client-side filter from full page: use a larger fetch when filters active
      // so filtering before pagination works correctly.
      // For "all" filters: pure server-side LIMIT/OFFSET.
      // For filtered: fetch all matching rows server-side via a filtered query.
      const { rows: fetched, totalCount: total } = await (async () => {
        if (type === 'all' && result === 'all') {
          return getSignalHistoryPage(p, PAGE_SIZE);
        }
        // Filtered: fetch all, filter, paginate in-memory
        const { rows: all } = await getSignalHistoryPage(1, 1000);
        const filtered = all.filter(r => {
          if (type !== 'all' && r.signal_type !== type) return false;
          if (result !== 'all' && r.result !== result) return false;
          return true;
        });
        const from = (p - 1) * PAGE_SIZE;
        return { rows: filtered.slice(from, from + PAGE_SIZE), totalCount: filtered.length };
      })();
      setRows(fetched);
      setTotalCount(total);
    } catch { /* swallow */ }
    setLoading(false);
  }, []);

  // Fetch on mount and whenever page/filters change
  useEffect(() => { fetchPage(page, typeFilter, resultFilter); }, [fetchPage, page, typeFilter, resultFilter]);

  // Reset to page 1 when filters change
  const handleTypeFilter = (v: 'all' | 'BUY' | 'SELL') => { setTypeFilter(v); setPage(1); };
  const handleResultFilter = (v: 'all' | 'WIN' | 'LOSS' | 'EXPIRED') => { setResultFilter(v); setPage(1); };

  const handleRefresh = async () => {
    await refreshSignalHistory();
    fetchPage(page, typeFilter, resultFilter);
  };

  return (
    <Card className="border-border overflow-hidden" style={{ background: 'hsl(var(--card))' }}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <History className="w-4 h-4 text-primary" />
            AI Signal History
            {totalCount > 0 && (
              <span className="text-[11px] font-normal text-muted-foreground">({totalCount} total)</span>
            )}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
            <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
        {/* Filters */}
        <div className="flex flex-wrap gap-1.5 pt-2">
          {(['all', 'BUY', 'SELL'] as const).map(v => (
            <button
              key={v}
              onClick={() => handleTypeFilter(v)}
              className={cn(
                'px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors',
                typeFilter === v
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/40 text-muted-foreground border-border hover:border-primary/40',
              )}
            >{v === 'all' ? 'All types' : v}</button>
          ))}
          <span className="w-px bg-border self-stretch mx-0.5" />
          {(['all', 'WIN', 'LOSS', 'EXPIRED'] as const).map(v => (
            <button
              key={v}
              onClick={() => handleResultFilter(v)}
              className={cn(
                'px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors',
                resultFilter === v
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/40 text-muted-foreground border-border hover:border-primary/40',
              )}
            >{v === 'all' ? 'All results' : v}</button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6 space-y-2">
            {[1, 2, 3, 4].map(i => <CardSkeleton key={i} className="h-14" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <History className="w-10 h-10 text-muted-foreground mx-auto opacity-40" />
            <p className="text-sm font-medium text-muted-foreground">
              {totalCount === 0 ? 'No signal history yet' : 'No signals match these filters'}
            </p>
            {totalCount === 0 && (
              <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                Signals are evaluated when their AI-recommended Hold Time elapses using real Pionex prices. Check back soon.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <div className="min-w-[480px]">
                <div className="grid grid-cols-[auto_1fr_auto_auto] md:grid-cols-[auto_1fr_auto_auto_auto_auto_auto] items-center gap-3 px-4 py-2 border-b border-border bg-muted/40 text-[10px] text-muted-foreground font-medium">
                  <div />
                  <div>Pair / Time</div>
                  <div className="hidden md:block text-center">Conf.</div>
                  <div className="hidden md:block">Entry</div>
                  <div className="hidden md:block">Exit</div>
                  <div className="hidden md:block text-right">P/L</div>
                  <div>Result</div>
                </div>
                {rows.map(item => <SignalHistoryRow key={item.id} item={item} />)}
              </div>
            </div>
            {/* Pagination */}
            {totalPages > 1 && (
              <div className="py-3 px-4 border-t border-border flex flex-col items-center gap-1">
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
                <p className="text-[10px] text-muted-foreground">
                  Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount} signals
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RecommendedToTradePanel() {
  const {
    liveSignals,
    signalHistory,
    loadingSignalHistory,
    refreshSignalHistory,
    signalsCache,
  } = useTrading();

  const [refreshing, setRefreshing]       = useState(false);
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [filterType, setFilterType]       = useState<'ALL' | 'BUY' | 'SELL' | 'STRONG'>('ALL');
  const [page, setPage]                   = useState(1);

  const PAGE_SIZE = 5;

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshSignalHistory();
    setRefreshing(false);
  }, [refreshSignalHistory]);

  const tradableLive = useMemo(
    () => liveSignals.filter(s => s.signal_type === 'BUY' || s.signal_type === 'SELL'),
    [liveSignals]
  );

  const totalEvaluated = useMemo(() => {
    return signalHistory.filter(h => h.result === 'WIN' || h.result === 'LOSS' || h.result === 'EXPIRED').length;
  }, [signalHistory]);

  const scoredSignals = useMemo(
    () => computeLiveSignalScores(tradableLive, signalHistory, signalsCache?.reset_at),
    [tradableLive, signalHistory, signalsCache?.reset_at]
  );

  const allRecommended = scoredSignals.filter(x => x.tier === 'RECOMMENDED');
  const watchlist      = scoredSignals.filter(x => x.tier === 'WATCH');

  // ── Filter: applied AFTER scoring + sorting, BEFORE pagination ────────
  const STRONG_THRESHOLD = 70;
  const recommended = useMemo(() => {
    let list = allRecommended;
    if (filterType === 'BUY')    list = list.filter(x => x.signal.signal_type === 'BUY');
    if (filterType === 'SELL')   list = list.filter(x => x.signal.signal_type === 'SELL');
    if (filterType === 'STRONG') list = list.filter(x => x.score >= STRONG_THRESHOLD);
    return list;
  }, [allRecommended, filterType]);

  // Reset to page 1 when filter changes
  const handleFilter = (f: typeof filterType) => {
    setFilterType(f);
    setPage(1);
  };

  // ── Pagination ─────────────────────────────────────────────────────────
  const totalPages  = Math.max(1, Math.ceil(recommended.length / PAGE_SIZE));
  const pagedItems  = recommended.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const bestItem    = page === 1 ? pagedItems[0] : null;
  const otherItems  = page === 1 ? pagedItems.slice(1) : pagedItems;

  // ── Loading ────────────────────────────────────────────────────────────
  if (loadingSignalHistory) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <CardSkeleton key={i} className="h-72" />)}
      </div>
    );
  }

  // ── No live tradable signals ───────────────────────────────────────────
  if (tradableLive.length === 0) {
    return (
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-8 text-center space-y-3">
          <Star className="w-10 h-10 text-muted-foreground mx-auto opacity-40" />
          <p className="text-sm font-medium text-foreground">No live signals to evaluate</p>
          <p className="text-xs text-muted-foreground max-w-xs mx-auto">
            Press "Analyze Market" to generate fresh signals. Recommendations appear here within seconds.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                <Star className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Recommended to Trade</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {totalEvaluated >= GATE_TYPE_SAMPLE
                    ? `${allRecommended.length} qualified · ${watchlist.length} watching · ${totalEvaluated} signals evaluated`
                    : `${totalEvaluated} / ${GATE_TYPE_SAMPLE} evaluated signals needed`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {allRecommended.length > 0 && (
                <span className="text-[10px] font-semibold px-2 py-1 rounded-full border text-positive border-positive/40 bg-positive/10">
                  🟢 {allRecommended.length}
                </span>
              )}
              {watchlist.length > 0 && (
                <span className="text-[10px] font-semibold px-2 py-1 rounded-full border text-warning border-warning/40 bg-warning/10">
                  🟡 {watchlist.length}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="h-7 px-2.5 text-xs">
                <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
              </Button>
            </div>
          </div>

          {/* Disclaimer */}
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              <span className="font-semibold text-foreground">Decision support only.</span>{' '}
              Does not execute trades. Based solely on this app's historical signal performance. Carry significant risk. Always do your own research.
            </p>
          </div>

          {/* Qualification criteria summary */}
          <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2">
            {[
              { label: 'Min evaluated', value: `≥${GATE_TYPE_SAMPLE} signals` },
              { label: 'Min win rate', value: `≥${GATE_WIN_RATE}%` },
              { label: 'Avg P/L', value: `>${GATE_AVG_PL}%` },
              { label: 'Min confidence', value: `≥${GATE_CONFIDENCE}%` },
              { label: 'Min strength', value: `≥${GATE_STRENGTH}` },
              { label: 'Min R/R', value: `≥1:${GATE_RR}` },
            ].map(c => (
              <div key={c.label} className="flex items-center justify-between text-[10px] px-2 py-1.5 rounded bg-muted/40 border border-border">
                <span className="text-muted-foreground">{c.label}</span>
                <span className="font-semibold text-foreground">{c.value}</span>
              </div>
            ))}
          </div>

          {/* ── Filter bar ──────────────────────────────────────────────── */}
          {allRecommended.length > 0 && (
            <div className="mt-3 flex items-center gap-1.5 flex-wrap">
              {(['ALL', 'BUY', 'SELL', 'STRONG'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => handleFilter(f)}
                  className={cn(
                    'px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors',
                    filterType === f
                      ? f === 'BUY'    ? 'bg-positive/20 border-positive/50 text-positive'
                      : f === 'SELL'   ? 'bg-negative/20 border-negative/50 text-negative'
                      : f === 'STRONG' ? 'bg-primary/20 border-primary/50 text-primary'
                      : 'bg-primary/10 border-primary/30 text-primary'
                      : 'bg-muted/40 border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {f === 'STRONG' ? `Strong (≥${STRONG_THRESHOLD})` : f}
                </button>
              ))}
              {filterType !== 'ALL' && (
                <span className="text-[10px] text-muted-foreground ml-1">
                  {recommended.length} signal{recommended.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── NO QUALIFIED TRADES ─────────────────────────────────────────── */}
      {recommended.length === 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-8 text-center space-y-3">
            <XCircle className="w-10 h-10 text-negative mx-auto opacity-60" />
            <p className="text-base font-bold text-foreground">
              {allRecommended.length > 0 ? 'NO SIGNALS MATCH THIS FILTER' : 'NO QUALIFIED TRADES RIGHT NOW'}
            </p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              {allRecommended.length > 0
                ? `${allRecommended.length} qualified signal${allRecommended.length !== 1 ? 's' : ''} exist — try a different filter.`
                : totalEvaluated < GATE_TYPE_SAMPLE
                  ? ` More historical data is needed (${totalEvaluated}/${GATE_TYPE_SAMPLE} evaluated).`
                  : ' None of the live signals pass all six qualification gates simultaneously.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── RECOMMENDED section ─────────────────────────────────────────── */}
      {recommended.length > 0 && (
        <div className="space-y-4">
          {/* BEST CURRENT SETUP — only on page 1 */}
          {bestItem && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <Trophy className="w-4 h-4 text-primary" />
                <h4 className="text-sm font-semibold text-foreground">BEST CURRENT SETUP</h4>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <ErrorBoundary key={bestItem.signal.id} inline label={bestItem.signal.pair}>
                  <RecommendedSignalCard item={bestItem} rank={1} best />
                </ErrorBoundary>
              </div>
            </div>
          )}

          {/* Other qualified signals on this page */}
          {otherItems.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <CheckCircle2 className="w-4 h-4 text-positive" />
                <h4 className="text-sm font-semibold text-foreground">
                  {page === 1 ? 'Other qualified signals' : `Page ${page} signals`}
                </h4>
                <span className="text-xs text-muted-foreground">
                  ({page === 1 ? recommended.length - 1 : otherItems.length})
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {otherItems.map((item, i) => (
                  <ErrorBoundary key={item.signal.id} inline label={item.signal.pair}>
                    <RecommendedSignalCard item={item} rank={(page - 1) * PAGE_SIZE + (page === 1 ? i + 2 : i + 1)} />
                  </ErrorBoundary>
                ))}
              </div>
            </div>
          )}

          {/* ── Pagination ─────────────────────────────────────────────── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-3 px-1">
              <span className="text-[11px] text-muted-foreground">
                Side {page} av {totalPages} · {recommended.length} signaler
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="h-7 px-2.5 text-xs"
                >
                  ← Forrige
                </Button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <Button
                    key={p}
                    variant={p === page ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPage(p)}
                    className="h-7 w-7 p-0 text-xs"
                  >
                    {p}
                  </Button>
                ))}
                <Button
                  variant="outline" size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="h-7 px-2.5 text-xs"
                >
                  Neste →
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── WATCHLIST (collapsible) ──────────────────────────────────────── */}
      {watchlist.length > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <button
            onClick={() => setWatchlistOpen(v => !v)}
            className="w-full flex items-center justify-between gap-2 p-4 text-left"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" />
              <span className="text-sm font-semibold text-foreground">Watchlist</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border text-warning border-warning/40 bg-warning/10">
                🟡 {watchlist.length} signal{watchlist.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Close to qualifying</span>
              <ChevronDown className={cn('w-4 h-4 transition-transform', watchlistOpen && 'rotate-180')} />
            </div>
          </button>
          {watchlistOpen && (
            <CardContent className="pt-0 px-4 pb-4">
              <p className="text-[10px] text-muted-foreground mb-3">
                These signals are close to qualifying but do not yet meet all requirements. Do not treat as trading recommendations.
              </p>
              <div>
                {watchlist.map(item => (
                  <WatchlistRow key={item.signal.id} item={item} />
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Methodology footnote */}
      <p className="text-[10px] text-muted-foreground text-right px-1">
        All 6 gates must pass for RECOMMENDED. Pair P/L with &lt;{MIN_PAIR_RELIABLE} samples is shrinkage-adjusted to prevent small-sample distortion.
        Recency-weighted (last {RECENT_DAYS}d blended 40%).
      </p>
    </div>
  );
}

// ─── AI Auto Trader (Demo Mode Only) ─────────────────────────────────────────
//
// NOTE: enabled/tradeId/lastAction are owned by TradingContext, NOT this panel.
// This makes the Auto Trader global and persistent across tab switches,
// component unmount/remount, and page refresh.
//
// Rules:
//  • Max 1 open demo-trade at a time — enforced in TradingContext.
//  • Signal must be ≤5 min old (FRESH) to be tradeable. AGING/STALE are blocked.
//  • Uses BEST CURRENT SETUP (scored[0] RECOMMENDED) — same source as the UI panel.
//  • Auto Trader evaluates ENTRY exactly once after each new Scheduler analysis.
//  • Scheduler completion is detected via TradingContext.schedulerCompletedAt.
//  • No separate 30-second entry-polling loop. TP/SL monitoring remains in
//    TradingContext and is completely independent of the entry trigger.
//  • STALE/AGING/ingen signal keeps Auto Trader ENABLED; it simply waits for the
//    next Scheduler-run.
//  • Only the "Stop Auto Trader" button disables it. Unmounting this panel
//    does NOT change enabled state.
//  • Event log records: ENTRY_ATTEMPT, ENTRY_BLOCKED, ENTRY_OPENED,
//    AUTO_TRADER_STOPPED, SCHEDULER_TRIGGER, INFO.

const AUTO_LOG_MAX               = 8;          // max event-log entries shown

type AutoLogEvent = {
  ts: string;
  type: 'ENTRY_ATTEMPT' | 'ENTRY_BLOCKED' | 'ENTRY_OPENED' | 'AUTO_TRADER_STOPPED' | 'SCHEDULER_TRIGGER' | 'INFO';
  msg: string;
};

interface AutoTraderState {
  status: 'IDLE' | 'SCANNING' | 'TRADING' | 'WAITING_CLOSE';
  tradeId: string | null;
  signal: ScoredSignal | null;
  score: number | null;
  openedAt: string | null;
  lastAction: string;
  eventLog: AutoLogEvent[];
}

function AIAutoTraderPanel() {
  const {
    openTrades,
        marketPrices,
    liveSignals, signalHistory, signalsCache,
    autoTraderEnabled, autoTraderTradeId, autoTraderTotalTrades, autoTraderLastAction,
    startAutoTrader, stopAutoTrader,
    isPionexLive, firstLiveTradeDone,
  } = useTrading();

  // UI-only state: stays local to this panel. enabled/tradeId/lastAction are
  // owned by TradingContext so the trader survives tab switches and remounts.
  const [state, setState] = useState<AutoTraderState>({
    status: 'IDLE', tradeId: null, signal: null, score: null,
    openedAt: null, lastAction: 'Auto Trader deaktivert.',
    eventLog: [],
  });

  // Sync local UI state with global Auto Trader state
  useEffect(() => {
    const currentOpen = openTrades;
    const trackedOpen = autoTraderTradeId
      ? currentOpen.find(t => t.id === autoTraderTradeId)
      : null;

    if (trackedOpen) {
      setState(prev => ({ ...prev, status: 'TRADING', tradeId: autoTraderTradeId }));
    } else if (currentOpen.length > 0) {
      setState(prev => ({ ...prev, status: 'WAITING_CLOSE', tradeId: null }));
    } else {
      setState(prev => ({ ...prev, status: 'IDLE', tradeId: null }));
    }
  }, [openTrades, autoTraderTradeId]);

  // Mirror global lastAction into local event log so the panel shows the
  // same message history when the user switches back to the Auto Trader tab.
  useEffect(() => {
    if (!autoTraderLastAction) return;
    setState(prev => {
      if (prev.lastAction === autoTraderLastAction) return prev;
      return {
        ...prev,
        lastAction: autoTraderLastAction,
        eventLog: [{ ts: new Date().toLocaleTimeString('nb-NO'), type: 'INFO' as const, msg: autoTraderLastAction }, ...prev.eventLog].slice(0, AUTO_LOG_MAX),
      };
    });
  }, [autoTraderLastAction]);

  const addLog = (type: AutoLogEvent['type'], msg: string) => {
    const entry: AutoLogEvent = { ts: new Date().toLocaleTimeString('nb-NO'), type, msg };
    setState(prev => ({
      ...prev,
      eventLog: [entry, ...prev.eventLog].slice(0, AUTO_LOG_MAX),
    }));
  };


  const currentTrade = state.tradeId ? openTrades.find(t => t.id === state.tradeId) : null;

  // BEST CURRENT SETUP / BEST OVERALL SCORE must be recomputed from the same
  // scoring engine as Recommended so the UI shows current freshness, not the
  // stale snapshot stored in context at the time of the last entry.
  const currentScored = useMemo(() => {
    const tradable = liveSignals.filter(s => s.signal_type === 'BUY' || s.signal_type === 'SELL');
    return computeLiveSignalScores(tradable, signalHistory, signalsCache?.reset_at);
  }, [liveSignals, signalHistory, signalsCache?.reset_at]);

  const currentRecommended = useMemo(
    () => currentScored.filter(x => x.tier === 'RECOMMENDED'),
    [currentScored]
  );

  const currentBestSetup = currentRecommended.find(x => x.freshnessLabel === 'FRESH') ?? null;
  const currentBestOverall = currentRecommended[0] ?? null;
  const currentSelected = currentBestSetup;

  // The context snapshot is only authoritative for the actual trade that was opened

  const bestSetup = currentBestSetup;
  const bestSetupSig = bestSetup?.signal ?? null;
  const bestOverall = currentBestOverall;
  const bestOverallSig = bestOverall?.signal ?? null;
  const selected = currentSelected;
  const selectedSig = selected?.signal ?? null;

  const ageOf = (s: ScoredSignal | null): number => s?.signalAgeMs ?? 0;

  const ageBadgeStyle = (label: 'FRESH' | 'AGING' | 'STALE') =>
    label === 'FRESH' ? 'text-positive border-positive/40 bg-positive/10' :
    label === 'AGING' ? 'text-warning border-warning/40 bg-warning/10' :
    'text-negative border-negative/40 bg-negative/10';

  const selectedPrice = selectedSig ? (marketPrices[selectedSig.pair]?.price ?? selectedSig.current_price) : null;
  const bestSetupPrice = bestSetupSig ? (marketPrices[bestSetupSig.pair]?.price ?? bestSetupSig.current_price) : null;
  const bestOverallPrice = bestOverallSig ? (marketPrices[bestOverallSig.pair]?.price ?? bestOverallSig.current_price) : null;

  // ── Tre tydelige Auto Trader-tilstander for UI ──────────────────────────────
  // OFF      : autoTraderEnabled = false
  // ON·VENTER: autoTraderEnabled = true, ingen åpen trade (IDLE / SCANNING)
  // ON·HANDLER: autoTraderEnabled = true, trade er åpen (TRADING / WAITING_CLOSE)
  type ATUIState = 'OFF' | 'WAITING' | 'TRADING';
  const atUIState: ATUIState = !autoTraderEnabled
    ? 'OFF'
    : (state.status === 'TRADING' || state.status === 'WAITING_CLOSE')
      ? 'TRADING'
      : 'WAITING';

  return (
    <div className="space-y-4">

      {/* ── LIVE TRADING-banner: alltid synlig, farge avhenger av isPionexLive ── */}
      <div className={cn(
        'rounded-xl border-2 px-4 py-3 flex items-center justify-between gap-3 flex-wrap',
        isPionexLive
          ? 'border-negative/60 bg-negative/10'
          : 'border-border bg-muted/40'
      )}>
        <div className="flex items-center gap-3">
          <span className={cn(
            'w-3 h-3 rounded-full shrink-0',
            isPionexLive ? 'bg-negative animate-pulse' : 'bg-muted-foreground'
          )} />
          <div>
            {isPionexLive ? (
              <>
                <p className="text-sm font-bold text-negative leading-tight">🔴 LIVE TRADING ON</p>
              <p className="text-xs font-semibold text-negative/80 leading-tight">REAL MONEY · LIVE TRADING ON</p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-muted-foreground leading-tight">🔴 LIVE TRADING OFF</p>
                <p className="text-xs text-muted-foreground leading-tight">DEMO TRADING ONLY · Ingen ekte Pionex-ordre</p>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {firstLiveTradeDone && isPionexLive && (
            <Badge variant="outline" className="text-[10px] border-warning/50 text-warning bg-warning/10 font-semibold">
              FASE 3 FULLFØRT — RAPPORTER
            </Badge>
          )}
          {/* NØDSTOP — kun synlig når Auto Trader kjører og live trading er ON */}
          {autoTraderEnabled && isPionexLive && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                stopAutoTrader();
                addLog('AUTO_TRADER_STOPPED', '🔴 NØDSTOP aktivert — Auto Trader stoppet.');
              }}
              className="h-8 px-3 text-xs border-negative/60 text-negative hover:bg-negative/20 font-bold"
            >
              ⛔ NØDSTOP
            </Button>
          )}
        </div>
      </div>

      {/* ── AUTO TRADER header card ───────────────────────────────────────── */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4 space-y-4">

          {/* Status-rad */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <div className={cn(
                'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0',
                atUIState === 'OFF'
                  ? 'bg-muted border-border'
                  : atUIState === 'TRADING'
                    ? 'bg-positive/10 border-positive/30'
                    : 'bg-primary/10 border-primary/20'
              )}>
                <Zap className={cn(
                  'w-5 h-5',
                  atUIState === 'OFF' ? 'text-muted-foreground' :
                  atUIState === 'TRADING' ? 'text-positive' : 'text-primary'
                )} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground">🤖 AUTO TRADER</p>

                {/* Primær status-linje */}
                {atUIState === 'OFF' && (
                  <p className="text-xs font-semibold text-muted-foreground mt-0.5">🔴 OFF</p>
                )}
                {atUIState === 'WAITING' && (
                  <p className="text-xs font-semibold text-primary mt-0.5">🟢 ON · VENTER</p>
                )}
                {atUIState === 'TRADING' && (
                  <p className="text-xs font-semibold text-positive mt-0.5">🟢 ON · HANDLER</p>
                )}

                {/* Sekundær kontekst-linje */}
                {atUIState === 'OFF' && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Auto Trader er deaktivert</p>
                )}
                {atUIState === 'WAITING' && (
                  isPionexLive ? (
                    <p className="text-[10px] text-negative font-semibold mt-0.5">🔴 LIVE MODE · ekte Pionex-ordre kan sendes</p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground mt-0.5">DEMO MODE · ingen ekte ordre</p>
                  )
                )}
                {atUIState === 'TRADING' && (
                  isPionexLive ? (
                    <p className="text-[10px] text-negative font-semibold mt-0.5">🔴 LIVE MODE · REAL MONEY</p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground mt-0.5">DEMO MODE</p>
                  )
                )}
              </div>
            </div>

            {/* Start / Stopp-knapp */}
            <div className="flex items-center gap-2 shrink-0">
              {atUIState !== 'OFF' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    stopAutoTrader();
                    addLog('AUTO_TRADER_STOPPED', 'Auto Trader stoppet manuelt.');
                  }}
                  className="h-8 px-3 text-xs border-negative/40 text-negative hover:bg-negative/10"
                >
                  ⏹ Stopp Auto Trader
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  disabled={firstLiveTradeDone && isPionexLive}
                  onClick={() => {
                    startAutoTrader();
                    addLog('INFO', 'Auto Trader startet.');
                  }}
                  className="h-8 px-3 text-xs"
                >
                  ▶ Start Auto Trader
                </Button>
              )}
            </div>
          </div>

          {/* Venter-melding: kun synlig når ON·VENTER */}
          {atUIState === 'WAITING' && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
              <Activity className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
              <p className="text-[10px] text-primary leading-relaxed font-medium">
                Venter på FRESH + RECOMMENDED signal. AI scanner Pionex hvert 7. minutt.
              </p>
            </div>
          )}

          {/* firstLiveTradeDone-varsel */}
          {firstLiveTradeDone && isPionexLive && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <ShieldAlert className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
              <p className="text-[10px] text-warning leading-relaxed font-medium">
                FASE 3: Første ekte live trade er fullført. Auto Trader er stoppet for nye live-entries. Rapporter resultat til administrator før normal live trading aktiveres.
              </p>
            </div>
          )}

          {/* Rules summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {[
              { label: 'Maks åpne trades', value: '1' },
              { label: 'Maks signal-alder', value: '5 min' },
              { label: 'Investering/trade', value: `${(AUTO_TRADER_INVESTMENT_PCT * 100).toFixed(0)}% av saldo` },
              { label: 'Kilde', value: 'Best Current Setup' },
            ].map(c => (
              <div key={c.label} className="flex flex-col gap-0.5 text-[10px] px-2 py-1.5 rounded bg-muted/40 border border-border">
                <span className="text-muted-foreground">{c.label}</span>
                <span className="font-semibold text-foreground">{c.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Status + last action ─────────────────────────────────────────── */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Activity className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="font-semibold text-foreground">Siste hendelse:</span>
            <span className="truncate">{state.lastAction}</span>
          </div>

          {/* Session stats */}
          <div className="flex items-center gap-3 flex-wrap">
            {[
              { label: 'Trades', value: autoTraderTotalTrades },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-1.5 text-[11px]">
                <span className="text-muted-foreground">{s.label}:</span>
                <span className="font-semibold text-foreground">{s.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── BEST CURRENT SETUP card ──────────────────────────────────────── */}
      {bestSetup ? (
        <Card className="border-border border-positive/30" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-positive/10 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-bold text-positive">BCS</span>
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground">BEST CURRENT SETUP</p>
                  <p className="text-[10px] text-muted-foreground">Høyest rangerte FRESH Recommended</p>
                </div>
              </div>
              <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', ageBadgeStyle(bestSetup.freshnessLabel))}>
                {bestSetup.freshnessLabel} – {fmtSignalAge(ageOf(bestSetup))}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <CoinLogo symbol={bestSetupSig?.symbol ?? ''} size={28} />
              <div>
                <span className="text-sm font-bold text-foreground">{bestSetupSig?.pair}</span>
                <span className={cn(
                  'ml-2 text-[11px] font-bold px-1.5 py-0.5 rounded',
                  bestSetupSig?.signal_type === 'BUY' ? 'text-positive bg-positive/10' : 'text-negative bg-negative/10'
                )}>
                  {bestSetupSig?.signal_type}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {[
                ['Score', `${bestSetup.currentScore}/100`],
                ['Entry', bestSetupSig ? `$${bestSetupSig.entry_zone_low.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['Current Price', bestSetupPrice ? `$${bestSetupPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['TP', bestSetupSig?.take_profit_1 ? `$${bestSetupSig.take_profit_1.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['SL', bestSetupSig?.stop_loss ? `$${bestSetupSig.stop_loss.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['Status', 'TRADEABLE'],
              ].map(([k, v]) => (
                <div key={k} className="p-2 rounded bg-muted border border-border">
                  <div className="text-muted-foreground mb-0.5">{k}</div>
                  <div className={cn('font-semibold text-foreground', k === 'Status' ? 'text-positive' : '')}>{v}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border border-dashed" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-bold text-muted-foreground">BCS</span>
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground">NO FRESH SETUP</p>
                  <p className="text-[10px] text-muted-foreground">Ingen FRESH Recommended-signaler akkurat nå</p>
                </div>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border text-muted-foreground border-border bg-muted/40">
                WAITING
              </span>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-[10px] text-foreground">
                Auto Trader venter på neste Scheduler-analyse. BEST OVERALL SCORE vises nedenfor hvis et signal finnes.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── BEST OVERALL SCORE card ──────────────────────────────────────── */}
      {bestOverall && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-bold text-muted-foreground">BOS</span>
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground">BEST OVERALL SCORE</p>
                  <p className="text-[10px] text-muted-foreground">Høyeste score uavhengig av freshness</p>
                </div>
              </div>
              <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', ageBadgeStyle(bestOverall.freshnessLabel))}>
                {bestOverall.freshnessLabel} – {fmtSignalAge(ageOf(bestOverall))}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <CoinLogo symbol={bestOverallSig?.symbol ?? ''} size={28} />
              <div>
                <span className="text-sm font-bold text-foreground">{bestOverallSig?.pair}</span>
                <span className={cn(
                  'ml-2 text-[11px] font-bold px-1.5 py-0.5 rounded',
                  bestOverallSig?.signal_type === 'BUY' ? 'text-positive bg-positive/10' : 'text-negative bg-negative/10'
                )}>
                  {bestOverallSig?.signal_type}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {[
                ['Score', `${bestOverall.currentScore}/100`],
                ['Entry', bestOverallSig ? `$${bestOverallSig.entry_zone_low.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['Current Price', bestOverallPrice ? `$${bestOverallPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['TP', bestOverallSig?.take_profit_1 ? `$${bestOverallSig.take_profit_1.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['SL', bestOverallSig?.stop_loss ? `$${bestOverallSig.stop_loss.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['Status', bestOverall.freshnessLabel === 'FRESH' ? 'TRADEABLE' : 'NOT TRADEABLE'],
              ].map(([k, v]) => (
                <div key={k} className="p-2 rounded bg-muted border border-border">
                  <div className="text-muted-foreground mb-0.5">{k}</div>
                  <div className={cn('font-semibold text-foreground', k === 'Status' && bestOverall.freshnessLabel === 'FRESH' ? 'text-positive' : k === 'Status' ? 'text-negative' : '')}>{v}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Selected (tradeable) signal ──────────────────────────────────── */}
      {selected && selected.freshnessLabel === 'FRESH' && (
        <Card className="border-border border-positive/30" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <CoinLogo symbol={selectedSig?.symbol ?? ''} size={28} />
                <div>
                  <span className="text-sm font-bold text-foreground">{selectedSig?.pair}</span>
                  <span className={cn(
                    'ml-2 text-[11px] font-bold px-1.5 py-0.5 rounded',
                    selectedSig?.signal_type === 'BUY' ? 'text-positive bg-positive/10' : 'text-negative bg-negative/10'
                  )}>
                    {selectedSig?.signal_type}
                  </span>
                </div>
              </div>
              <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', ageBadgeStyle(selected.freshnessLabel))}>
                {selected.freshnessLabel} – {fmtSignalAge(ageOf(selected))}
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {[
                ['Entry', `$${selectedSig?.entry_zone_low.toLocaleString('en-US', { maximumFractionDigits: 6 })}`],
                ['Take Profit', selectedSig?.take_profit_1 ? `$${selectedSig.take_profit_1.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['Stop Loss', selectedSig?.stop_loss ? `$${selectedSig.stop_loss.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['Confidence', `${selectedSig?.confidence}%`],
                ['Rec. Score', `${selected.currentScore}/100`],
                ['Current Price', selectedPrice ? `$${selectedPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
              ].map(([k, v]) => (
                <div key={k} className="p-2 rounded bg-muted border border-border">
                  <div className="text-muted-foreground mb-0.5">{k}</div>
                  <div className="font-semibold text-foreground">{v}</div>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-positive/30 bg-positive/5 px-3 py-2">
              <Info className="w-3.5 h-3.5 text-positive shrink-0 mt-0.5" />
              <p className="text-[10px] text-foreground">
                Dette er det signalet Auto Trader faktisk handler hvis den velger å åpne en trade — samme referanse som BEST CURRENT SETUP.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Current open trade ───────────────────────────────────────────── */}
      {currentTrade && (
        <Card className="border-border border-positive/30" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-semibold text-foreground flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-positive animate-pulse" />
              Auto Trade aktiv — {currentTrade.pair}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {[
                ['Kjøpspris',     `$${currentTrade.buy_price.toLocaleString('en-US', { maximumFractionDigits: 6 })}`],
                ['Nå-pris',       `$${(currentTrade.current_price ?? currentTrade.buy_price).toLocaleString('en-US', { maximumFractionDigits: 6 })}`],
                ['Investert',     `${currentTrade.investment.toFixed(2)} USDT`],
                ['Verdi nå',      `${(currentTrade.current_value ?? currentTrade.investment).toFixed(2)} USDT`],
                ['Stop Loss',     currentTrade.stop_loss ? `$${currentTrade.stop_loss.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
                ['Take Profit',   currentTrade.take_profit ? `$${currentTrade.take_profit.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—'],
              ].map(([k, v]) => (
                <div key={k} className="p-2 rounded bg-muted border border-border">
                  <div className="text-muted-foreground mb-0.5">{k}</div>
                  <div className="font-semibold text-foreground">{v}</div>
                </div>
              ))}
            </div>
            <div className={cn(
              'flex items-center justify-between p-3 rounded-lg border',
              (currentTrade.unrealized_pnl ?? 0) >= 0
                ? 'border-positive/30 bg-positive/5'
                : 'border-negative/30 bg-negative/5'
            )}>
              <span className="text-xs text-muted-foreground">Unrealized P/L</span>
              <div className="text-right">
                <div className={cn(
                  'text-sm font-bold',
                  (currentTrade.unrealized_pnl ?? 0) >= 0 ? 'text-positive' : 'text-negative'
                )}>
                  {(currentTrade.unrealized_pnl ?? 0) >= 0 ? '+' : ''}{(currentTrade.unrealized_pnl ?? 0).toFixed(4)} USDT
                </div>
                <div className={cn(
                  'text-xs font-medium',
                  (currentTrade.pnl_pct ?? 0) >= 0 ? 'text-positive' : 'text-negative'
                )}>
                  {(currentTrade.pnl_pct ?? 0) >= 0 ? '+' : ''}{(currentTrade.pnl_pct ?? 0).toFixed(2)}%
                </div>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              TP/SL lukker automatisk via eksisterende system. Kan også lukkes manuelt under Open-fanen.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Event log ────────────────────────────────────────────────────── */}
      {state.eventLog.length > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Hendelseslogg
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 space-y-1">
            {state.eventLog.map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-[10px]">
                <span className="text-muted-foreground shrink-0 tabular-nums">{e.ts}</span>
                <span className={cn('font-semibold shrink-0',
                  e.type === 'ENTRY_OPENED'         ? 'text-positive' :
                  e.type === 'ENTRY_BLOCKED'        ? 'text-warning'  :
                  e.type === 'AUTO_TRADER_STOPPED'  ? 'text-negative' :
                  e.type === 'ENTRY_ATTEMPT'        ? 'text-primary'  : 'text-muted-foreground'
                )}>{e.type}</span>
                <span className="text-muted-foreground">{e.msg}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── Idle / no signal state ───────────────────────────────────────── */}
      {autoTraderEnabled && !currentTrade && !selectedSig && state.status === 'IDLE' && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-8 text-center space-y-3">
            <Target className="w-10 h-10 text-muted-foreground mx-auto opacity-40" />
            <p className="text-sm font-medium text-foreground">Venter på ferskt signal</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Auto Trader søker etter kvalifiserte RECOMMENDED-signaler som er ≤5 minutter gamle.
              Kjør «Analyze Market» for å generere nye signaler.
            </p>
          </CardContent>
        </Card>
      )}

      {!autoTraderEnabled && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-8 text-center space-y-3">
            <Zap className="w-10 h-10 text-muted-foreground mx-auto opacity-30" />
            <p className="text-sm font-medium text-foreground">Auto Trader er deaktivert</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Trykk «Start Auto Trader» for å aktivere automatisk demo-trading basert på Recommended-signaler.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Signal Performance Panel ─────────────────────────────────────────────────
function SignalPerformancePanel() {
  const {
    signalPerfSummary, signalPatternStats,
    signalPerfByAI, signalPerfByConfidence,
    signalHistory,
    loadingSignalHistory, refreshSignalHistory,
  } = useTrading();

  const [refreshing, setRefreshing] = useState(false);

  // Server-side paginated evaluated signals table
  const [evalPage, setEvalPage]           = useState(1);
  const [evalRows, setEvalRows]           = useState<SignalHistory[]>([]);
  const [evalTotal, setEvalTotal]         = useState(0);
  const [evalLoading, setEvalLoading]     = useState(false);
  const evalTotalPages = Math.max(1, Math.ceil(evalTotal / PAGE_SIZE));

  const fetchEvalPage = useCallback(async (p: number) => {
    setEvalLoading(true);
    try {
      const { rows, totalCount } = await getEvaluatedSignalsPage(p, PAGE_SIZE);
      setEvalRows(rows);
      setEvalTotal(totalCount);
    } catch { /* swallow */ }
    setEvalLoading(false);
  }, []);

  useEffect(() => { fetchEvalPage(evalPage); }, [fetchEvalPage, evalPage]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshSignalHistory();
    // Re-fetch evaluated page after history refresh
    await fetchEvalPage(evalPage);
    setRefreshing(false);
  }, [refreshSignalHistory, fetchEvalPage, evalPage]);

  // Must be above all early returns (Rules of Hooks)
  const recommendation = useMemo(() =>
    computeTradeRecommendation(signalPatternStats, signalPerfByAI, signalPerfSummary?.evaluated_signals ?? 0),
    [signalPatternStats, signalPerfByAI, signalPerfSummary]
  );

  // Best/worst callout: derive from full in-memory set (above early returns — Rules of Hooks)
  const evaluatedSignalsAll = useMemo(() =>
    signalHistory.filter(h => h.result !== null && h.exit_price !== null),
    [signalHistory]
  );

  if (loadingSignalHistory) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[1,2,3,4,5,6].map(i => <CardSkeleton key={i} className="h-24" />)}
      </div>
    );
  }

  const s = signalPerfSummary;
  const total           = s?.total_signals          ?? 0;
  const live            = s?.live_signals            ?? 0;
  const evaluated       = s?.evaluated_signals       ?? 0;
  const wins            = s?.wins                    ?? 0;
  const losses          = s?.losses                  ?? 0;
  const expired         = s?.expired                 ?? 0;
  const expiredGood     = s?.expired_good_direction  ?? 0;
  const expiredNeutral  = s?.expired_neutral         ?? 0;
  const expiredBad      = s?.expired_bad_direction   ?? 0;
  const aggressiveTP    = s?.signals_with_aggressive_tp ?? 0;
  const winRate         = s?.win_rate_pct            ?? 0;
  const avgReturn       = s?.avg_return_pct          ?? null;
  const totalPL         = s?.total_pl_usdt           ?? null;
  const bestPct         = s?.best_trade_pct          ?? null;
  const worstPct        = s?.worst_trade_pct         ?? null;
  const expiredAvgPL    = s?.expired_avg_pl_pct      ?? null;
  const wlTotal         = wins + losses;
  // Win Rate threshold guard: only meaningful when ≥5 WIN/LOSS signals exist
  const INSUFF          = wlTotal < 5;
  // Expired rate: expired / total evaluated
  const expiredRate     = evaluated > 0 ? (expired / evaluated) * 100 : null;
  // EXPIRED sub-classified count (rows with expired_class set)
  const expiredClassified = expiredGood + expiredNeutral + expiredBad;

  // ── Empty state: no signals at all ──────────────────────────────────────
  if (total === 0) {
    return (
      <div>
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-8 text-center space-y-3">
            <Trophy className="w-10 h-10 text-muted-foreground mx-auto opacity-40" />
            <p className="text-sm font-medium text-foreground">No performance data yet</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Press "Analyze Market" to generate signals. They are evaluated when their AI-recommended Hold Time elapses using live Pionex prices.
            </p>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="mt-2">
              <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} /> Refresh
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Pending state: signals exist but none evaluated yet ─────────────────
  if (evaluated === 0 && live > 0) {
    return (
      <div className="space-y-4">
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-8 text-center space-y-3">
            <Timer className="w-10 h-10 text-primary mx-auto opacity-60" />
            <p className="text-sm font-medium text-foreground">
              {live} signal{live !== 1 ? 's' : ''} pending evaluation
            </p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Signals are evaluated when their AI-recommended Hold Time elapses using live Pionex exit prices.
              Click Refresh to check — expired signals are evaluated automatically.
            </p>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="mt-2">
              <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Evaluating…' : 'Check Now'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Summary stat cards ───────────────────────────────────────────────────
  const statCards = [
    {
      icon: <Activity className="w-4 h-4 text-primary" />,
      label: 'Totalt evaluert', value: String(evaluated),
      sub: live > 0 ? `${live} live` : undefined,
    },
    {
      icon: <CheckCircle2 className="w-4 h-4 text-positive" />,
      label: 'Vinn', value: String(wins),
      highlight: 'text-positive',
    },
    {
      icon: <XCircle className="w-4 h-4 text-negative" />,
      label: 'Tap', value: String(losses),
      highlight: 'text-negative',
    },
    {
      icon: <Timer className="w-4 h-4 text-muted-foreground" />,
      label: 'Utløpt', value: String(expired),
      highlight: 'text-muted-foreground',
      sub: expiredRate != null ? `${expiredRate.toFixed(0)}% rate` : undefined,
    },
    {
      icon: <Percent className="w-4 h-4 text-primary" />,
      label: 'Vinnrate',
      value: INSUFF ? '—' : `${winRate.toFixed(1)}%`,
      highlight: INSUFF ? 'text-muted-foreground' : winRate >= 55 ? 'text-positive' : winRate < 40 ? 'text-negative' : 'text-foreground',
      sub: INSUFF ? `Trenger ${Math.max(0, 5 - wlTotal)} VINN/TAP` : 'VINN / (VINN+TAP)',
    },
    {
      icon: <TrendingUp className="w-4 h-4 text-primary" />,
      label: 'Gj.snitt P/L',
      value: avgReturn != null ? `${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%` : '—',
      highlight: avgReturn != null ? (avgReturn >= 0 ? 'text-positive' : 'text-negative') : 'text-muted-foreground',
      sub: 'inkl. utløpt',
    },
    {
      icon: <Trophy className="w-4 h-4 text-warning" />,
      label: 'Total P/L',
      value: totalPL != null ? `${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(4)} USDT` : '—',
      highlight: totalPL != null ? (totalPL >= 0 ? 'text-positive' : 'text-negative') : 'text-muted-foreground',
      sub: 'inkl. utløpt',
    },
    {
      icon: <Clock className="w-4 h-4 text-muted-foreground" />,
      label: 'Utløpt gj.snitt P/L',
      value: expiredAvgPL != null ? `${expiredAvgPL >= 0 ? '+' : ''}${expiredAvgPL.toFixed(2)}%` : expired > 0 ? '—' : 'Ingen data',
      highlight: expiredAvgPL != null ? (expiredAvgPL >= 0 ? 'text-positive' : 'text-negative') : 'text-muted-foreground',
      sub: expired > 0 ? `${expired} signal${expired !== 1 ? 'er' : ''}` : undefined,
    },
  ];

  // Best/worst use evaluatedSignalsAll defined above early returns
  const bestSignal  = evaluatedSignalsAll.find(h => h.pl_pct === bestPct);
  const worstSignal = evaluatedSignalsAll.find(h => h.result === 'LOSS' && h.pl_pct === worstPct);

  // ── EXPIRED sub-class badge helper ───────────────────────────────────────
  function ExpiredClassBadge({ cls }: { cls: string | null }) {
    if (!cls) return <span className="text-muted-foreground">UTLØPT</span>;
    if (cls === 'GOOD_DIRECTION')
      return <span className="text-warning font-semibold">UTLØPT ↑</span>;
    if (cls === 'BAD_DIRECTION')
      return <span className="text-orange-400 font-semibold">UTLØPT ↓</span>;
    return <span className="text-muted-foreground">UTLØPT ~</span>;
  }

  return (
    <div className="space-y-4">
      {/* ── Recommended to Trade ──────────────────────────────────────── */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            Recommended to Trade
            <span className="ml-auto text-[10px] font-normal text-muted-foreground">
              Based on {evaluated} evaluated signal{evaluated !== 1 ? 's' : ''}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-4 px-4">
          {recommendation.insufficientData ? (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-semibold text-foreground mb-0.5">Not enough data</p>
                <p className="text-muted-foreground">
                  Need at least 5 fully evaluated (WIN or LOSS) signals to generate a
                  recommendation. Currently {wlTotal} WIN/LOSS evaluated — keep running
                  "Analyze Market" to build the dataset.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TradeRecommendationCard rec={recommendation.buy} />
              <TradeRecommendationCard rec={recommendation.sell} />
            </div>
          )}
          {!recommendation.insufficientData && recommendation.overallWinRate != null && (
            <p className="text-[10px] text-muted-foreground mt-3 text-right">
              Overall win rate across all types: {recommendation.overallWinRate}%
              &nbsp;·&nbsp; Thresholds: ≥55% win rate &amp; positive avg P/L required
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Summary stats ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statCards.map(sc => (
          <Card key={sc.label} className="border-border" style={{ background: 'hsl(var(--card))' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                {sc.icon}
                <span className="text-xs text-muted-foreground">{sc.label}</span>
              </div>
              <div className={cn('text-lg font-bold font-["Space_Grotesk"] leading-tight', sc.highlight ?? 'text-foreground')}>
                {sc.value}
              </div>
              {sc.sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sc.sub}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── EXPIRED 5-kategori fordeling ──────────────────────────────── */}
      {expired > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Timer className="w-4 h-4 text-muted-foreground" />
              Utløpsanalyse — 5 kategorier
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                {expired} utløpte signal{expired !== 1 ? 'er' : ''}
                {expiredClassified > 0 && expiredClassified < expired && ` · ${expired - expiredClassified} ukategorisert (eldre data)`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 pb-4 px-4 space-y-3">
            {/* 5-category bar */}
            {(() => {
              const total5 = wins + losses + expiredGood + expiredNeutral + expiredBad;
              if (total5 === 0) return null;
              const pct = (n: number) => ((n / total5) * 100).toFixed(1);
              const bars = [
                { label: 'VINN',           count: wins,          color: 'bg-positive',      pctVal: Number(pct(wins)) },
                { label: 'TAP',            count: losses,        color: 'bg-negative',       pctVal: Number(pct(losses)) },
                { label: 'UTLØPT ↑',       count: expiredGood,   color: 'bg-warning',        pctVal: Number(pct(expiredGood)) },
                { label: 'UTLØPT ~',       count: expiredNeutral,color: 'bg-muted-foreground',pctVal: Number(pct(expiredNeutral)) },
                { label: 'UTLØPT ↓',       count: expiredBad,    color: 'bg-orange-400',     pctVal: Number(pct(expiredBad)) },
              ];
              return (
                <>
                  {/* stacked progress bar */}
                  <div className="flex h-3 w-full rounded-full overflow-hidden gap-px">
                    {bars.map(b => b.count > 0 && (
                      <div
                        key={b.label}
                        className={cn(b.color, 'transition-all')}
                        style={{ width: `${b.pctVal}%` }}
                        title={`${b.label}: ${b.count} (${b.pctVal}%)`}
                      />
                    ))}
                  </div>
                  {/* legend */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                    {bars.map(b => (
                      <div key={b.label} className="flex items-center gap-1.5">
                        <div className={cn('w-2.5 h-2.5 rounded-sm shrink-0', b.color)} />
                        <span className="text-muted-foreground">{b.label}</span>
                        <span className="font-semibold text-foreground ml-auto">{b.count}</span>
                        <span className="text-muted-foreground">({b.pctVal}%)</span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}

            {/* EXPIRED sub-class explanation */}
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground space-y-0.5">
              <p><span className="text-warning font-semibold">UTLØPT ↑ (God retning)</span> — bevegde seg ≥50% mot TP, men nådde det ikke innen hold-tid</p>
              <p><span className="text-muted-foreground font-semibold">UTLØPT ~ (Nøytral)</span> — lite prisbevegelse, signalet utløp uten klar retning</p>
              <p><span className="text-orange-400 font-semibold">UTLØPT ↓ (Feil retning)</span> — bevegde seg mot SL (men ble ikke stoppet)</p>
            </div>

            {/* TP_FEASIBILITY insight */}
            {aggressiveTP > 0 && evaluated > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[10px] space-y-0.5">
                <p className="font-semibold text-warning">TP_FEASIBILITY innsikt</p>
                <p className="text-muted-foreground">
                  {aggressiveTP} av {evaluated} evaluerte signal ({((aggressiveTP / evaluated) * 100).toFixed(0)}%) hadde TP1 &gt; 2.5% — over historisk median MFE.
                  {' '}AI-motoren er nå kalibrert til å foretrekke TP1 ≤ 2.5% basert på dette.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Best / Worst signal callout ───────────────────────────────── */}
      {!INSUFF && (bestSignal || worstSignal) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bestSignal && (
            <Card className="border-positive/20 bg-positive/5">
              <CardContent className="p-3 flex items-center gap-3">
                <ArrowUpRight className="w-5 h-5 text-positive shrink-0" />
                <div className="min-w-0">
                  <div className="text-[10px] text-muted-foreground">Best Signal</div>
                  <div className="text-sm font-semibold text-foreground truncate">
                    {bestSignal.pair} <SignalBadge type={bestSignal.signal_type} />
                  </div>
                  <div className="text-xs text-positive font-bold">
                    +{Number(bestSignal.pl_pct).toFixed(2)}% &nbsp;·&nbsp; conf {bestSignal.confidence}%
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {worstSignal && (
            <Card className="border-negative/20 bg-negative/5">
              <CardContent className="p-3 flex items-center gap-3">
                <ArrowDownRight className="w-5 h-5 text-negative shrink-0" />
                <div className="min-w-0">
                  <div className="text-[10px] text-muted-foreground">Worst Signal</div>
                  <div className="text-sm font-semibold text-foreground truncate">
                    {worstSignal.pair} <SignalBadge type={worstSignal.signal_type} />
                  </div>
                  <div className="text-xs text-negative font-bold">
                    {Number(worstSignal.pl_pct).toFixed(2)}% &nbsp;·&nbsp; conf {worstSignal.confidence}%
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Per-signal evaluated table (server-side paginated) ──────── */}
      {evalTotal > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <History className="w-4 h-4 text-primary" />
              Evaluated Signals ({evaluated} of {total})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {evalLoading ? (
              <div className="p-4 space-y-2">
                {[1,2,3].map(i => <CardSkeleton key={i} className="h-10" />)}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        {['Pair','Type','Result','Confidence','Str','Entry','Exit','Hold','P/L %'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {evalRows.map(h => {
                        const holdMs = h.evaluated_at
                          ? new Date(h.evaluated_at).getTime() - new Date(h.generated_at).getTime()
                          : null;
                        const holdMin = holdMs ? Math.round(holdMs / 60000) : null;
                        const pl = Number(h.pl_pct ?? 0);
                        return (
                          <tr key={h.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                            <td className="px-3 py-2 font-semibold text-foreground whitespace-nowrap">
                              <CoinLogo symbol={h.symbol} size={14} />
                              <span className="ml-1.5">{h.pair}</span>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <SignalBadge type={h.signal_type} />
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {h.result === 'WIN' && (
                                <span className="font-semibold text-positive">VINN</span>
                              )}
                              {h.result === 'LOSS' && (
                                <span className="font-semibold text-negative">TAP</span>
                              )}
                              {h.result === 'EXPIRED' && (
                                <ExpiredClassBadge cls={h.expired_class ?? null} />
                              )}
                            </td>
                            <td className="px-3 py-2 text-foreground">{h.confidence}%</td>
                            <td className="px-3 py-2 text-muted-foreground">{h.signal_strength ?? '—'}</td>
                            <td className="px-3 py-2 text-foreground whitespace-nowrap">{Number(h.entry_price).toPrecision(5)}</td>
                            <td className="px-3 py-2 text-foreground whitespace-nowrap">{h.exit_price != null ? Number(h.exit_price).toPrecision(5) : '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                              {holdMin != null ? (holdMin < 60 ? `${holdMin}m` : `${Math.round(holdMin/60)}h`) : '—'}
                            </td>
                            <td className={cn('px-3 py-2 font-semibold whitespace-nowrap', pl >= 0 ? 'text-positive' : 'text-negative')}>
                              {pl >= 0 ? '+' : ''}{pl.toFixed(2)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Pagination */}
                {evalTotalPages > 1 && (
                  <div className="py-3 px-4 border-t border-border flex flex-col items-center gap-1">
                    <Pagination page={evalPage} totalPages={evalTotalPages} onChange={setEvalPage} />
                    <p className="text-[10px] text-muted-foreground">
                      Showing {((evalPage - 1) * PAGE_SIZE) + 1}–{Math.min(evalPage * PAGE_SIZE, evalTotal)} of {evalTotal} evaluated signals
                    </p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── BUY vs SELL breakdown ──────────────────────────────────────── */}
      {signalPatternStats.length > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-primary" />
              BUY vs SELL Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {['Type','Signals','Wins','Losses','Win Rate','Avg Return','Total P/L','Avg Win RSI','Avg Conf(W)'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {signalPatternStats.map(p => {
                    const hasEnough = p.total >= 5;
                    return (
                      <tr key={p.signal_type} className="border-b border-border last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-semibold"><SignalBadge type={p.signal_type as 'BUY'|'SELL'|'HOLD'|'WAIT'} /></td>
                        <td className="px-3 py-2 text-foreground">{p.total}</td>
                        <td className="px-3 py-2 text-positive">{p.wins}</td>
                        <td className="px-3 py-2 text-negative">{p.losses}</td>
                        <td className={cn('px-3 py-2 font-semibold', !hasEnough ? 'text-muted-foreground' : p.win_rate_pct >= 55 ? 'text-positive' : p.win_rate_pct < 40 ? 'text-negative' : 'text-foreground')}>
                          {hasEnough ? `${p.win_rate_pct}%` : '—'}
                        </td>
                        <td className={cn('px-3 py-2 font-semibold', (p.avg_return_pct ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                          {p.avg_return_pct != null ? `${p.avg_return_pct >= 0 ? '+' : ''}${p.avg_return_pct}%` : '—'}
                        </td>
                        <td className={cn('px-3 py-2', (p.total_pl_usdt ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                          {p.total_pl_usdt != null ? `${p.total_pl_usdt >= 0 ? '+' : ''}${Number(p.total_pl_usdt).toFixed(4)}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{p.avg_rsi_win ?? '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.avg_winning_confidence ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── OpenAI vs Groq breakdown ────────────────────────────────────── */}
      {signalPerfByAI.length > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Brain className="w-4 h-4 text-primary" />
              OpenAI vs Groq Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[400px] text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {['AI Provider','Signals','Wins','Losses','Win Rate','Avg Return','Total P/L'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {signalPerfByAI.map(a => {
                    const hasEnough = a.total >= 3;
                    return (
                      <tr key={a.ai_source} className="border-b border-border last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-semibold capitalize text-foreground">{a.ai_source}</td>
                        <td className="px-3 py-2 text-foreground">{a.total}</td>
                        <td className="px-3 py-2 text-positive">{a.wins}</td>
                        <td className="px-3 py-2 text-negative">{a.losses}</td>
                        <td className={cn('px-3 py-2 font-semibold', !hasEnough ? 'text-muted-foreground' : a.win_rate_pct >= 55 ? 'text-positive' : a.win_rate_pct < 40 ? 'text-negative' : 'text-foreground')}>
                          {hasEnough ? `${a.win_rate_pct}%` : 'Insufficient data'}
                        </td>
                        <td className={cn('px-3 py-2', (a.avg_return_pct ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                          {a.avg_return_pct != null ? `${a.avg_return_pct >= 0 ? '+' : ''}${a.avg_return_pct}%` : '—'}
                        </td>
                        <td className={cn('px-3 py-2', (a.total_pl_usdt ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                          {a.total_pl_usdt != null ? `${a.total_pl_usdt >= 0 ? '+' : ''}${Number(a.total_pl_usdt).toFixed(4)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Performance by confidence range ───────────────────────────── */}
      {signalPerfByConfidence.length > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Percent className="w-4 h-4 text-primary" />
              Performance by Confidence Range
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {['Confidence','Signals','Wins','Losses','Win Rate','Avg Return'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {signalPerfByConfidence.map(c => {
                    const hasEnough = c.total >= 3;
                    return (
                      <tr key={c.confidence_range} className="border-b border-border last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-semibold text-foreground">{c.confidence_range}</td>
                        <td className="px-3 py-2 text-foreground">{c.total}</td>
                        <td className="px-3 py-2 text-positive">{c.wins}</td>
                        <td className="px-3 py-2 text-negative">{c.losses}</td>
                        <td className={cn('px-3 py-2 font-semibold', !hasEnough ? 'text-muted-foreground' : c.win_rate_pct >= 55 ? 'text-positive' : c.win_rate_pct < 40 ? 'text-negative' : 'text-foreground')}>
                          {hasEnough ? `${c.win_rate_pct}%` : 'Insufficient data'}
                        </td>
                        <td className={cn('px-3 py-2', (c.avg_return_pct ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                          {c.avg_return_pct != null ? `${c.avg_return_pct >= 0 ? '+' : ''}${c.avg_return_pct}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── AI Learning status ─────────────────────────────────────────── */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-start gap-3">
          <Brain className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="font-semibold text-foreground mb-1">AI Performance Feedback Active</p>
            <p className="text-muted-foreground">
              {evaluated >= 10
                ? `${evaluated} evaluated signals feed back into OpenAI/Groq prompts to calibrate confidence, BUY/SELL setups, RSI thresholds, and entry levels. Pattern weighting changes require ≥20 signals per type.`
                : `Collecting data… ${evaluated}/10 evaluated signals needed before AI calibration activates. Only WIN/LOSS/EXPIRED signals count (not LIVE).`}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} />
          {refreshing ? 'Evaluating…' : 'Refresh stats'}
        </Button>
      </div>
    </div>
  );
}

// ─── Performance Panel (demo trading) ─────────────────────────────────────────
function PerformancePanel() {
  const { performance, resetDemo, refillDemo } = useTrading();
  const [resetOpen, setResetOpen] = useState(false);
  const [refillOpen, setRefillOpen] = useState(false);

  return (
    <div className="space-y-4">
      <DemoBadge />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Account overview */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Account Overview</CardTitle></CardHeader>
          <CardContent className="space-y-0.5">
            <StatRow label="Account Value" value={`${performance.account_value.toFixed(2)} USDT`} />
            <StatRow label="Available Balance" value={`${performance.available_balance.toFixed(2)} USDT`} />
            <StatRow label="Invested" value={`${performance.invested_amount.toFixed(2)} USDT`} />
            <StatRow label="Unrealized P/L" value={<PnLValue value={performance.unrealized_pnl} />} />
            <StatRow label="Realized P/L" value={<PnLValue value={performance.realized_pnl} />} />
            <StatRow label="Total Return" value={<PnLPct value={performance.total_return_pct} />} />
          </CardContent>
        </Card>
        {/* Trade stats */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Trade Stats</CardTitle></CardHeader>
          <CardContent className="space-y-0.5">
            <StatRow label="Total Trades" value={String(performance.total_trades)} />
            <StatRow label="Winning Trades" value={<span className="text-positive font-medium">{performance.winning_trades}</span>} />
            <StatRow label="Losing Trades" value={<span className="text-negative font-medium">{performance.losing_trades}</span>} />
            <StatRow label="Win Rate" value={`${performance.win_rate.toFixed(1)}%`} />
            <StatRow label="Avg Win" value={`+${performance.avg_win.toFixed(2)} USDT`} />
            <StatRow label="Avg Loss" value={`-${performance.avg_loss.toFixed(2)} USDT`} />
          </CardContent>
        </Card>
      </div>

      {/* Reset / Refill */}
      <div className="flex gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={() => setRefillOpen(true)}>
          <PlusCircle className="w-4 h-4 mr-2" /> Add $100
        </Button>
        <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:border-destructive/50 hover:text-destructive"
          onClick={() => setResetOpen(true)}>
          <RotateCcw className="w-4 h-4 mr-2" /> Reset Account
        </Button>
      </div>

      <AlertDialog open={refillOpen} onOpenChange={setRefillOpen}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Add $100 to Demo Account</AlertDialogTitle>
            <AlertDialogDescription>This will add $100 USDT to your demo balance.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { await refillDemo(100); toast.success('Added $100 to demo account'); }}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Demo Account</AlertDialogTitle>
            <AlertDialogDescription>This will close all trades and reset your balance to $500. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => { await resetDemo(); toast.success('Demo account reset'); }}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Scan Stats Banner ─────────────────────────────────────────────────────────
// ─── Diagnostic Panel ─────────────────────────────────────────────────────────
// ─── Expired Signal Analysis ─────────────────────────────────────────────────
interface ExpiredAnalysis {
  count: number;
  avgHoldMin: number | null;
  medianHoldMin: number | null;
  avgPL: number | null;
  avgTpDistPct: number | null;   // TP distance from entry
  avgSlDistPct: number | null;   // SL distance from entry
  avgDistToTpAtExpiry: number | null;   // how far exit_price was from TP1
  avgDistToSlAtExpiry: number | null;   // how far exit_price was from SL
  pctPositive: number | null;
  pctNegative: number | null;
  buyCount: number;
  sellCount: number;
  avgConfidence: number | null;
  avgStrength: number | null;
  mostCommonHoldMin: number | null;
  closeToTpCount: number;   // within 30% of TP distance
  closeToSlCount: number;   // within 30% of SL distance
  avgPlBuy: number | null;
  avgPlSell: number | null;
  avgHoldBuy: number | null;
  avgHoldSell: number | null;
  tpHitRate: number | null;   // WIN / (WIN+LOSS+EXPIRED)
  slHitRate: number | null;   // LOSS / (WIN+LOSS+EXPIRED)
  expiryRate: number | null;  // EXPIRED / (WIN+LOSS+EXPIRED)
  conclusion: string;
  analysedAt: Date;
}

function computeExpiredAnalysis(history: import('@/types/types').SignalHistory[]): ExpiredAnalysis | null {
  const all    = history.filter(h => h.result === 'WIN' || h.result === 'LOSS' || h.result === 'EXPIRED');
  const expired = history.filter(h => h.result === 'EXPIRED');

  const total = all.length;
  const expiredCount = expired.length;

  if (expiredCount < 3) return null;  // not enough data

  // Hold time in minutes
  const holdMins: number[] = [];
  expired.forEach(h => {
    const start = new Date(h.generated_at).getTime();
    const end   = new Date(h.evaluated_at ?? h.created_at).getTime();
    const mins  = (end - start) / 60000;
    if (mins > 0) holdMins.push(mins);
  });
  const avgHoldMin = holdMins.length ? holdMins.reduce((a, b) => a + b, 0) / holdMins.length : null;
  const sortedHold = [...holdMins].sort((a, b) => a - b);
  const medianHoldMin = sortedHold.length
    ? sortedHold.length % 2 === 0
      ? (sortedHold[sortedHold.length / 2 - 1] + sortedHold[sortedHold.length / 2]) / 2
      : sortedHold[Math.floor(sortedHold.length / 2)]
    : null;

  // Most common hold duration (rounded to nearest 5 min)
  const holdBuckets: Record<number, number> = {};
  holdMins.forEach(m => {
    const bucket = Math.round(m / 5) * 5;
    holdBuckets[bucket] = (holdBuckets[bucket] ?? 0) + 1;
  });
  const mostCommonHoldMin = Object.keys(holdBuckets).length
    ? Number(Object.entries(holdBuckets).sort((a, b) => b[1] - a[1])[0][0])
    : null;

  // Avg P/L
  const plVals = expired.filter(h => h.pl_pct != null).map(h => Number(h.pl_pct));
  const avgPL  = plVals.length ? plVals.reduce((a, b) => a + b, 0) / plVals.length : null;
  const pctPositive = plVals.length ? (plVals.filter(v => v >= 0).length / plVals.length) * 100 : null;
  const pctNegative = plVals.length ? (plVals.filter(v => v < 0).length / plVals.length) * 100 : null;

  // TP / SL distances from entry (how ambitious were targets)
  const tpDists: number[] = [];
  const slDists: number[] = [];
  const distToTpAtExpiry: number[] = [];
  const distToSlAtExpiry: number[] = [];
  let closeToTpCount = 0;
  let closeToSlCount = 0;

  expired.forEach(h => {
    const entry = Number(h.entry_price);
    const tp    = Number(h.take_profit_1);
    const sl    = Number(h.stop_loss);
    const exit  = Number(h.exit_price);
    if (!entry || !tp || !sl || !exit) return;

    const isBuy = h.signal_type === 'BUY';
    // TP distance % from entry
    const tpDist = isBuy ? ((tp - entry) / entry) * 100 : ((entry - tp) / entry) * 100;
    const slDist = isBuy ? ((entry - sl) / entry) * 100 : ((sl - entry) / entry) * 100;
    if (tpDist > 0) tpDists.push(tpDist);
    if (slDist > 0) slDists.push(slDist);

    // Distance from exit_price to TP at expiry
    const distToTp = isBuy ? ((tp - exit) / entry) * 100 : ((exit - tp) / entry) * 100;
    const distToSl = isBuy ? ((exit - sl) / entry) * 100 : ((sl - exit) / entry) * 100;
    if (isFinite(distToTp)) distToTpAtExpiry.push(distToTp);
    if (isFinite(distToSl)) distToSlAtExpiry.push(distToSl);

    // "Close to TP" = exit was within 30% of TP distance from TP
    if (tpDist > 0 && distToTp < tpDist * 0.3) closeToTpCount++;
    if (slDist > 0 && distToSl < slDist * 0.3) closeToSlCount++;
  });

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const avgTpDistPct        = avg(tpDists);
  const avgSlDistPct        = avg(slDists);
  const avgDistToTpAtExpiry = avg(distToTpAtExpiry);
  const avgDistToSlAtExpiry = avg(distToSlAtExpiry);

  // BUY / SELL breakdown
  const buyExpired  = expired.filter(h => h.signal_type === 'BUY');
  const sellExpired = expired.filter(h => h.signal_type === 'SELL');
  const avgPlBuy    = avg(buyExpired.filter(h => h.pl_pct != null).map(h => Number(h.pl_pct)));
  const avgPlSell   = avg(sellExpired.filter(h => h.pl_pct != null).map(h => Number(h.pl_pct)));

  const holdOf = (subset: typeof expired) => {
    const mins = subset.map(h => {
      const s = new Date(h.generated_at).getTime();
      const e = new Date(h.evaluated_at ?? h.created_at).getTime();
      return (e - s) / 60000;
    }).filter(m => m > 0);
    return avg(mins);
  };
  const avgHoldBuy  = holdOf(buyExpired);
  const avgHoldSell = holdOf(sellExpired);

  // Avg confidence / strength
  const avgConfidence = avg(expired.filter(h => h.confidence != null).map(h => Number(h.confidence)));
  const avgStrength   = avg(expired.filter(h => h.signal_strength != null).map(h => Number(h.signal_strength)));

  // Hit rates across all evaluated
  const wins   = all.filter(h => h.result === 'WIN').length;
  const losses = all.filter(h => h.result === 'LOSS').length;
  const tpHitRate   = total > 0 ? (wins   / total) * 100 : null;
  const slHitRate   = total > 0 ? (losses / total) * 100 : null;
  const expiryRate  = total > 0 ? (expiredCount / total) * 100 : null;

  // Conclusion logic
  let conclusion = 'No clear expiry problem detected yet.';
  if (expiredCount >= 5) {
    const highExpiryRate  = expiryRate != null && expiryRate > 60;
    const tpTooAmbitious  = avgTpDistPct != null && avgHoldMin != null && avgTpDistPct > 3 && avgHoldMin < 30;
    const nearEntryExpiry = avgDistToTpAtExpiry != null && avgTpDistPct != null && avgDistToTpAtExpiry > avgTpDistPct * 0.75;
    const movingToTp      = closeToTpCount > expiredCount * 0.4;
    const movingToSl      = distToSlAtExpiry.filter(d => d < (avgSlDistPct ?? 999) * 0.3).length > expiredCount * 0.4;
    const shortWindow     = avgHoldMin != null && avgHoldMin < 15 && highExpiryRate;

    if (shortWindow)          conclusion = 'Expiry window may be too short.';
    else if (tpTooAmbitious)  conclusion = 'TP targets may be too ambitious for the observed holding period.';
    else if (nearEntryExpiry) conclusion = 'Signals frequently expire near entry — little price movement observed.';
    else if (movingToTp)      conclusion = 'Signals frequently move toward TP but expire before reaching it.';
    else if (movingToSl)      conclusion = 'Signals frequently move toward SL at expiry — increased directional risk.';
  }

  return {
    count: expiredCount, avgHoldMin, medianHoldMin, avgPL,
    avgTpDistPct, avgSlDistPct, avgDistToTpAtExpiry, avgDistToSlAtExpiry,
    pctPositive, pctNegative,
    buyCount: buyExpired.length, sellCount: sellExpired.length,
    avgConfidence, avgStrength, mostCommonHoldMin,
    closeToTpCount, closeToSlCount,
    avgPlBuy, avgPlSell, avgHoldBuy, avgHoldSell,
    tpHitRate, slHitRate, expiryRate,
    conclusion, analysedAt: new Date(),
  };
}

function ExpiredSignalAnalysisSection({ history }: { history: import('@/types/types').SignalHistory[] }) {
  const analysis = useMemo(() => computeExpiredAnalysis(history), [history]);

  const fmt = (v: number | null, decimals = 1, suffix = '') =>
    v != null ? `${v.toFixed(decimals)}${suffix}` : '—';
  const fmtPL = (v: number | null) =>
    v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
  const fmtMin = (v: number | null) =>
    v != null ? `${v.toFixed(0)} min` : '—';

  const MetricRow = ({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) => (
    <div className="flex items-start justify-between gap-2 py-1 border-b border-border last:border-0 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <div className="text-right min-w-0">
        <span className={cn('font-mono font-semibold', color ?? 'text-foreground')}>{value}</span>
        {sub && <div className="text-[10px] text-muted-foreground/60">{sub}</div>}
      </div>
    </div>
  );

  const expiredCount = history.filter(h => h.result === 'EXPIRED').length;

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <p className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-wide flex items-center gap-1.5">
        <Timer className="w-3 h-3" />
        EXPIRED Signal Analysis
      </p>
      {expiredCount < 3 ? (
        <p className="text-[10px] text-muted-foreground italic px-1">
          Not enough expired signals for reliable analysis. ({expiredCount} of 3 minimum)
        </p>
      ) : !analysis ? (
        <p className="text-[10px] text-muted-foreground italic px-1">Computing…</p>
      ) : (
        <div className="space-y-0">
          {/* Overview */}
          <MetricRow label="Signals analyzed" value={String(analysis.count)} />
          <MetricRow label="Last analysis" value={analysis.analysedAt.toLocaleTimeString()} />

          {/* Hold time */}
          <div className="mt-1.5 mb-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0">Hold Duration</p>
          </div>
          <MetricRow label="Avg hold time" value={fmtMin(analysis.avgHoldMin)} />
          <MetricRow label="Median hold time" value={fmtMin(analysis.medianHoldMin)} />
          <MetricRow label="Most common hold" value={fmtMin(analysis.mostCommonHoldMin)} />
          <MetricRow label="Avg hold (BUY)" value={fmtMin(analysis.avgHoldBuy)} />
          <MetricRow label="Avg hold (SELL)" value={fmtMin(analysis.avgHoldSell)} />

          {/* P/L */}
          <div className="mt-1.5 mb-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0">P/L at Expiry</p>
          </div>
          <MetricRow
            label="Avg P/L at expiry"
            value={fmtPL(analysis.avgPL)}
            color={analysis.avgPL != null ? (analysis.avgPL >= 0 ? 'text-positive' : 'text-negative') : undefined}
          />
          <MetricRow
            label="Avg P/L (BUY expired)"
            value={fmtPL(analysis.avgPlBuy)}
            color={analysis.avgPlBuy != null ? (analysis.avgPlBuy >= 0 ? 'text-positive' : 'text-negative') : undefined}
          />
          <MetricRow
            label="Avg P/L (SELL expired)"
            value={fmtPL(analysis.avgPlSell)}
            color={analysis.avgPlSell != null ? (analysis.avgPlSell >= 0 ? 'text-positive' : 'text-negative') : undefined}
          />
          <MetricRow
            label="Positive at expiry"
            value={fmt(analysis.pctPositive, 0, '%')}
            color="text-positive"
          />
          <MetricRow
            label="Negative at expiry"
            value={fmt(analysis.pctNegative, 0, '%')}
            color="text-negative"
          />

          {/* Target distances */}
          <div className="mt-1.5 mb-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0">Target Distance</p>
          </div>
          <MetricRow label="Avg TP distance from entry" value={fmt(analysis.avgTpDistPct, 2, '%')} />
          <MetricRow label="Avg SL distance from entry" value={fmt(analysis.avgSlDistPct, 2, '%')} />
          <MetricRow label="Avg dist to TP at expiry" value={fmt(analysis.avgDistToTpAtExpiry, 2, '%')} sub="remaining gap to TP" />
          <MetricRow label="Avg dist to SL at expiry" value={fmt(analysis.avgDistToSlAtExpiry, 2, '%')} sub="remaining gap to SL" />
          <MetricRow label="Signals nearing TP" value={`${analysis.closeToTpCount}`} sub="within 30% of TP gap" />
          <MetricRow label="Signals nearing SL" value={`${analysis.closeToSlCount}`} sub="within 30% of SL gap" />

          {/* BUY/SELL breakdown */}
          <div className="mt-1.5 mb-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0">Type Breakdown</p>
          </div>
          <MetricRow label="BUY expired" value={String(analysis.buyCount)} />
          <MetricRow label="SELL expired" value={String(analysis.sellCount)} />

          {/* Signal quality */}
          <div className="mt-1.5 mb-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0">Signal Quality</p>
          </div>
          <MetricRow label="Avg confidence" value={fmt(analysis.avgConfidence, 0, '%')} />
          <MetricRow label="Avg signal strength" value={fmt(analysis.avgStrength, 0)} />

          {/* Hit rates */}
          <div className="mt-1.5 mb-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0">Outcome Rates (all evaluated)</p>
          </div>
          <MetricRow label="TP hit rate (WIN)" value={fmt(analysis.tpHitRate, 0, '%')} color="text-positive" />
          <MetricRow label="SL hit rate (LOSS)" value={fmt(analysis.slHitRate, 0, '%')} color="text-negative" />
          <MetricRow label="Expiry rate" value={fmt(analysis.expiryRate, 0, '%')} />

          {/* Conclusion */}
          <div className="mt-2 p-2 rounded bg-muted/40 border border-border">
            <p className="text-[10px] font-semibold text-foreground mb-0.5">Diagnostic Conclusion</p>
            <p className="text-[10px] text-muted-foreground">{analysis.conclusion}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticPanel() {
  const { signalsCache, aiAnalysisStatus, lastAIUpdate, scanStats, marketPrices, marketDataStatus, lastAnalysisError, schedulerStatus, signalHistory } = useTrading();
  const [open, setOpen] = useState(false);

  const marketKeys = Object.keys(marketPrices).length;
  const pionexOk   = marketDataStatus === 'live' && marketKeys > 0;
  const pionexVal  = marketDataStatus === 'live'
    ? `${marketKeys} pairs live`
    : marketDataStatus === 'cached' ? 'Cached (EF reachable)' : 'Via market-data EF';

  const pairsScanned   = scanStats?.pairsScanned  ?? signalsCache?.pairs_scanned  ?? 0;
  const analyzedByAI   = scanStats?.analyzedByAI  ?? signalsCache?.analyzed_count ?? 0;
  const signalsCount   = (signalsCache?.signals ?? []).length;
  const lastSuccess    = lastAIUpdate ? lastAIUpdate.toLocaleTimeString() : 'Never';
  const errorMsg       = lastAnalysisError ?? signalsCache?.error_message ?? null;
  const resetAt        = signalsCache?.reset_at;

  const aiSource     = signalsCache?.ai_source     ?? null;
  const modelUsed    = signalsCache?.model_used    ?? null;
  const openaiStatus = signalsCache?.gemini_status ?? null;

  // v6 pipeline fields
  const openaiCount     = scanStats?.openaiCount   ?? signalsCache?.openai_count ?? signalsCache?.gemini_count ?? 0;
  const groqCount       = scanStats?.groqCount     ?? signalsCache?.groq_count     ?? 0;
  const cachedCount     = scanStats?.cachedCount   ?? signalsCache?.cached_count   ?? 0;
  const rotationCount   = scanStats?.rotationCount ?? signalsCache?.rotation_count ?? 0;
  const diag            = signalsCache?.diagnostics ?? null;

  // Sub-timers + error fields from v6 diagnostics
  const diagTyped = diag as {
    openai_error_category?: string | null;
    openai_error_detail?: string;
    /** @deprecated */ gemini_error_category?: string | null;
    /** @deprecated */ gemini_error_detail?: string;
    groq_error_category?: string | null;
    groq_error_detail?: string;
    klines_ms?: number;
    db_load_ms?: number;
    prompt_ms?: number;
    openai_request_ms?: number;
    /** @deprecated */ gemini_request_ms?: number;
    /** @deprecated */ gemini_stream_ms?: number;
    db_write_ms?: number;
  } | null;

  // Use exact error category from diagnostics when available, fall back to openai_status string
  const openaiErrCategory = diagTyped?.openai_error_category
    ?? diagTyped?.gemini_error_category
    ?? (openaiStatus !== 'connected' ? openaiStatus : null);
  const openaiErrDetail   = diagTyped?.openai_error_detail ?? diagTyped?.gemini_error_detail ?? '';

  // Groq error fields — surfaced when Groq fallback was attempted but failed
  const groqErrCategory = diagTyped?.groq_error_category ?? null;
  const groqErrDetail   = diagTyped?.groq_error_detail   ?? '';

  const isOpenAIRL    = openaiErrCategory === 'RATE_LIMIT' || errorMsg?.includes('429') || errorMsg?.includes('quota');
  const isOpenAIErr   = !!openaiErrCategory && openaiErrCategory !== 'connected';
  const openaiOk      = openaiStatus === 'connected' || (aiSource === 'openai' || aiSource === 'gemini') && !isOpenAIErr;
  const groqActive    = aiSource === 'groq';
  const groqFailed    = !!groqErrCategory && !groqActive;

  // Human-readable OpenAI status label — distinguishes RATE_LIMIT from other errors
  const openaiAnalysedLabel = openaiCount > 0
    ? `OK — ${openaiCount} analysed`
    : (aiAnalysisStatus !== 'updating' && (aiSource === 'openai' || aiSource === 'gemini'))
      ? `OK — 0 signals`
      : null;

  const openaiStatusLabel = aiAnalysisStatus === 'updating'
    ? 'Running…'
    : openaiOk
      ? (openaiAnalysedLabel ?? `OK — ${openaiCount} analysed`)
      : openaiErrCategory === 'RATE_LIMIT'
        ? 'RATE LIMITED'
        : openaiErrCategory
          ? `ERROR — ${openaiErrCategory}`
          : '—';

  // Groq status: always show RATE_LIMIT if Groq was attempted but rate-limited
  const groqStatusLabel = groqActive
    ? `OK — ${groqCount} analysed`
    : groqErrCategory === 'RATE_LIMIT'
      ? 'RATE LIMITED'
      : groqFailed
        ? `ERROR — ${groqErrCategory}`
        : '—';

  const activeAILabel = aiSource === 'groq' ? 'Groq (fallback)' : (aiSource === 'openai' || aiSource === 'gemini') ? 'OpenAI (Primary)' : 'Unknown';
  const activeAIColor = (aiSource === 'openai' || aiSource === 'gemini') ? 'text-positive' : 'text-warning';

  const isFallbackActive = groqActive;

  const Row = ({ label, ok, value, sub }: { label: string; ok: boolean | null; value: string; sub?: string }) => (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border last:border-0 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        {ok === null
          ? <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground shrink-0 mt-0.5" />
          : ok
            ? <CheckCircle2 className="w-3 h-3 text-positive shrink-0 mt-0.5" />
            : <XCircle className="w-3 h-3 text-negative shrink-0 mt-0.5" />}
        <div className="min-w-0">
          <span className="text-muted-foreground">{label}</span>
          {sub && <div className="text-[10px] text-muted-foreground/60 truncate">{sub}</div>}
        </div>
      </div>
      <span className={cn('font-mono font-semibold shrink-0', ok === false ? 'text-negative' : 'text-foreground')}>{value}</span>
    </div>
  );

  const hasError       = !!errorMsg;
  const isGroqFallback = aiSource === 'groq';

  return (
    <div>
      {/* ── Collapsed pill ── */}
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'flex items-center gap-1.5 text-[10px] transition-colors px-2 py-1 rounded border bg-muted/40',
          open && 'hidden',
          isFallbackActive
            ? 'text-warning border-warning/40 hover:text-warning/80'
            : 'text-muted-foreground border-border hover:text-foreground'
        )}
      >
        <Bug className="w-3 h-3" />
        {isGroqFallback ? 'AI: Groq (fallback)' : (aiSource === 'openai' || aiSource === 'gemini') ? 'AI: OpenAI' : 'Diagnostics'}
        {hasError && <span className="w-1.5 h-1.5 rounded-full bg-negative shrink-0" />}
        {isFallbackActive && !hasError && <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />}
      </button>

      {/* ── Expanded card ── */}
      <Card className={cn(
        'border',
        !open && 'hidden',
        isOpenAIRL || isFallbackActive ? 'border-warning/40 bg-warning/5' : 'border-border bg-muted/20'
      )}>
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-xs font-semibold flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Bug className="w-3.5 h-3.5 text-warning" />
              Pipeline Diagnostics
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground text-[10px]">Hide</button>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-0">
          {/* Active AI banner */}
          <div className={cn(
            'flex items-center gap-2 mb-3 px-2 py-1.5 rounded border text-xs font-semibold',
            groqActive ? 'border-warning/40 bg-warning/10 text-warning' : 'border-positive/30 bg-positive/5 text-positive'
          )}>
            <Brain className="w-3.5 h-3.5 shrink-0" />
            <span>Active AI: <span className={activeAIColor}>{activeAILabel}</span></span>
            {modelUsed && <span className="ml-auto font-normal text-muted-foreground text-[10px] truncate max-w-[140px]">{modelUsed}</span>}
          </div>

          {/* Scheduler status — server-side, browser-independent */}
          {(() => {
            const isActive = schedulerStatus?.is_active ?? false;
            const lastRun = schedulerStatus?.last_run_at
              ? new Date(schedulerStatus.last_run_at).toLocaleTimeString()
              : 'Never';
            const lastSuccess = schedulerStatus?.last_success_at
              ? new Date(schedulerStatus.last_success_at).toLocaleTimeString()
              : 'Never';
            const nextRun = schedulerStatus?.next_run_at
              ? new Date(schedulerStatus.next_run_at).toLocaleTimeString()
              : '—';
            const interval = schedulerStatus?.interval_minutes ?? 7;
            return (
              <div className="mt-2 mb-3 pt-2 border-t border-border">
                <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Scheduler</p>
                <div className="space-y-0">
                  <Row
                    label="Automatic scanning"
                    ok={isActive ? true : false}
                    value={isActive ? 'ACTIVE' : 'INACTIVE'}
                    sub={isActive ? 'pg_cron / Edge Function' : 'server scheduler not confirmed'}
                  />
                  <Row label="Execution mode" ok={null} value="BACKGROUND" sub="runs when browser is closed" />
                  <Row label="Scan interval" ok={null} value={`${interval} min`} />
                  <Row label="Last automatic scan" ok={null} value={lastRun} />
                  <Row label="Next scheduled scan" ok={null} value={nextRun} />
                  <Row label="Last successful run" ok={null} value={lastSuccess} />
                  {resetAt && (
                    <Row label="Performance reset" ok={null} value={new Date(resetAt).toLocaleString()} />
                  )}
                </div>
              </div>
            );
          })()}

          {/* Expired Signal Analysis */}
          <ExpiredSignalAnalysisSection history={signalHistory} />

          {/* Provider status rows */}
          <Row label="OpenAI (Primary)"
            ok={aiAnalysisStatus === 'updating' ? null : openaiOk ? true : openaiErrCategory === 'RATE_LIMIT' ? null : isOpenAIErr ? false : null}
            value={openaiStatusLabel}
            sub={openaiErrDetail ? openaiErrDetail.slice(0, 80) : 'api.openai.com / gpt-5.6-luna'} />
          <Row label="Groq (fallback)"
            ok={groqActive ? true : groqErrCategory === 'RATE_LIMIT' ? null : groqFailed ? false : null}
            value={groqStatusLabel}
            sub={groqErrDetail ? groqErrDetail.slice(0, 80) : 'api.groq.com / llama-3.3-70b'} />

          {/* Pipeline stats */}
          <Row label="Pionex API (via EF)" ok={pionexOk} value={pionexVal} sub="browser→EF→Pionex (no CORS)" />
          <Row label="Pairs scanned" ok={pairsScanned > 0} value={`${pairsScanned}`} />
          <Row label="Screened candidates" ok={analyzedByAI > 0} value={`${analyzedByAI}`} />
          <Row label="Signals generated" ok={signalsCount > 0} value={`${signalsCount}`} />

          {/* v6 pipeline breakdown */}
          {(openaiCount + groqCount + cachedCount + rotationCount) > 0 && (
            <div className="mt-2 mb-1 pt-2 border-t border-border">
              <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Analysis Breakdown</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                {openaiCount   > 0 && <Row label="OpenAI analyses"   ok={true}  value={`${openaiCount}`} />}
                {groqCount     > 0 && <Row label="Groq fallbacks"    ok={null}  value={`${groqCount}`} />}
                {cachedCount   > 0 && <Row label="Cache reused"      ok={true}  value={`${cachedCount}`} />}
                {rotationCount > 0 && <Row label="Rotation/explore"  ok={true}  value={`${rotationCount}`} />}
              </div>
            </div>
          )}

          {/* Timing breakdown */}
          {diag && (
            <div className="mt-2 pt-2 border-t border-border">
              <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Timing</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0">
                <Row label="TOTAL"           ok={true} value={`${(diag.total_duration_ms / 1000).toFixed(1)}s`} />
                <Row label="Market fetch"    ok={true} value={`${(diag.market_fetch_ms / 1000).toFixed(1)}s`} />
                <Row label="Screening"       ok={true} value={`${(diag.screening_ms / 1000).toFixed(1)}s`} />
                <Row label="Klines fetch"    ok={true} value={diagTyped?.klines_ms != null ? `${(diagTyped.klines_ms / 1000).toFixed(1)}s` : `${(diag.indicator_ms / 1000).toFixed(1)}s`} />
                <Row label="Indicators"      ok={true} value={`${(diag.indicator_ms / 1000).toFixed(1)}s`} />
                <Row label="DB load"         ok={true} value={diagTyped?.db_load_ms != null ? `${(diagTyped.db_load_ms / 1000).toFixed(1)}s` : '—'} />
                <Row label="Selection"       ok={true} value={`${(diag.selection_ms / 1000).toFixed(1)}s`} />
                <Row label="Prompt build"    ok={true} value={diagTyped?.prompt_ms != null ? `${(diagTyped.prompt_ms / 1000).toFixed(1)}s` : '—'} />
                <Row label="OpenAI (total)"  ok={true} value={`${(diag.ai_ms / 1000).toFixed(1)}s`} />
                <Row label="↳ HTTP connect"  ok={true} value={diagTyped?.openai_request_ms != null ? `${(diagTyped.openai_request_ms / 1000).toFixed(1)}s` : diagTyped?.gemini_request_ms != null ? `${(diagTyped.gemini_request_ms / 1000).toFixed(1)}s` : '—'} />
                <Row label="DB writes"       ok={true} value={diagTyped?.db_write_ms != null ? `${(diagTyped.db_write_ms / 1000).toFixed(1)}s` : '—'} />
              </div>
            </div>
          )}

          <Row label="Last successful run" ok={lastAIUpdate !== null} value={lastSuccess} />

          {/* Error box */}
          {errorMsg && (
            <div className="mt-2 p-2 rounded bg-negative/10 border border-negative/20">
              <p className="text-[10px] font-semibold text-negative mb-0.5">Last Error</p>
              <p className="text-[10px] text-foreground break-words font-mono leading-relaxed">
                {errorMsg.slice(0, 400)}{errorMsg.length > 400 ? '…' : ''}
              </p>
              {isOpenAIRL && (
                <p className="text-[10px] text-warning mt-1 font-medium">
                  ⚠ OpenAI quota exceeded — Groq fallback is active. OpenAI retries automatically.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── CmcMarketPanel placeholder ────────────────────────────────────────────────
export default function AISignalsPage() {
  const {
    signalsCache, liveSignals, openTrades, tradeHistory,
    signalHistory,
    aiAnalysisStatus, lastAIUpdate, loadingDemo, refreshSignals, lastAnalysisError,
    scanStats, autoTraderTradeId,
    isPionexLive, liveOrders, openLiveOrders, refreshLiveOrders, marketPrices,
  } = useTrading();
  const [selectedSignal, setSelectedSignal] = useState<AISignal | null>(null);
  const [manualSellOpen, setManualSellOpen] = useState(false);
  const [demoBuyOpen, setDemoBuyOpen] = useState(false);
  const [manualBuyOpen, setManualBuyOpen] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<DemoTrade | null>(null);
  const [demoSellOpen, setDemoSellOpen] = useState(false);
  // Track whether the last manual run just finished (for "Analysis Complete" state)
  const [analysisJustDone, setAnalysisJustDone] = useState(false);
  const analysisDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Filter state (persisted to localStorage) ────────────────────────────────
  const [filters, setFilters] = useState<SignalFilterState>(loadFilters);

  // Live Signals pagination (client-side — data already in memory)
  const [liveSignalsPage, setLiveSignalsPage] = useState(1);

  const filteredSignals = useMemo(
    () => applyFilters(liveSignals, filters),
    [liveSignals, filters]
  );

  // Always reset to page 1 when filters change or new signals arrive
  useEffect(() => { setLiveSignalsPage(1); }, [filters]);
  useEffect(() => { setLiveSignalsPage(1); }, [liveSignals.length]);

  const liveSignalsTotalPages = Math.max(1, Math.ceil(filteredSignals.length / PAGE_SIZE));
  const liveSignalsPageItems = useMemo(() => {
    const from = (liveSignalsPage - 1) * PAGE_SIZE;
    return filteredSignals.slice(from, from + PAGE_SIZE);
  }, [filteredSignals, liveSignalsPage]);

  const handleFilterChange = useCallback((f: SignalFilterState) => {
    setFilters(f);
    saveFilters(f);
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    saveFilters(DEFAULT_FILTERS);
  }, []);

  // ── Manual analysis trigger ──────────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (aiAnalysisStatus === 'updating') return;
    if (analysisDoneTimerRef.current) clearTimeout(analysisDoneTimerRef.current);
    setAnalysisJustDone(false);
    await refreshSignals();
    setAnalysisJustDone(true);
    // Reset "Analysis Complete" label after 8 seconds
    analysisDoneTimerRef.current = setTimeout(() => setAnalysisJustDone(false), 8_000);
  }, [aiAnalysisStatus, refreshSignals]);

  // ── Analyze Market button label + style ─────────────────────────────────────
  const isAnalyzing  = aiAnalysisStatus === 'updating';
  const isError      = aiAnalysisStatus === 'error' && !isAnalyzing && !analysisJustDone;
  const isRateLimited = isError && (
    lastAnalysisError?.includes('429') ||
    lastAnalysisError?.includes('quota') ||
    lastAnalysisError?.includes('rate')
  );

  const btnLabel = isAnalyzing
    ? 'Analyzing...'
    : analysisJustDone
      ? 'Analysis Complete'
      : isRateLimited
        ? 'Analysis Unavailable'
        : isError
          ? 'Retry Analysis'
          : '🔍 Analyze Market';

  const btnVariant = isError && !analysisJustDone ? 'outline' : 'default';
  const btnClass   = analysisJustDone
    ? 'bg-positive/90 hover:bg-positive text-white border-0'
    : isRateLimited
      ? 'border-warning/60 text-warning hover:border-warning'
      : isError
        ? 'border-negative/60 text-negative hover:border-negative'
        : '';

  // ── Stats for display ────────────────────────────────────────────────────────
  const lastAnalysisLabel = (() => {
    if (isAnalyzing) return 'Running…';
    if (!lastAIUpdate) return 'Never';
    const mins = Math.floor((Date.now() - lastAIUpdate.getTime()) / 60000);
    return mins < 1 ? 'Just now' : `${mins}m ago`;
  })();
  const pairsScanned  = scanStats?.pairsScanned  ?? signalsCache?.pairs_scanned  ?? 0;
  const analyzedByAI  = scanStats?.analyzedByAI  ?? signalsCache?.analyzed_count ?? 0;
  const signalsCount  = liveSignals.length;

  // ── V2: local setups ────────────────────────────────────────────────────────
  const localSetups      = signalsCache?.local_setups ?? [];
  const localSetupsCount = localSetups.length;
  const recommendedCount = signalsCache?.diagnostics?.recommended_count
    ?? liveSignals.filter(s => s.server_verdict === 'RECOMMENDED').length;
  const watchCount       = liveSignals.filter(s => s.server_verdict === 'WATCH').length;
  const aiVerifiedCount  = signalsCache?.diagnostics?.ai_verified_count ?? 0;

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-bold font-['Space_Grotesk'] text-foreground">AI Signals</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Background AI analysis — scans Pionex every 7 minutes
          </p>
        </div>
      </div>

      {/* ── Analyze Market button + stats card ─────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        {/* Button row */}
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            size="lg"
            variant={btnVariant as 'default' | 'outline'}
            className={cn('h-11 px-6 font-semibold text-sm min-w-[180px]', btnClass)}
            disabled={isAnalyzing}
            onClick={handleAnalyze}
          >
            {isAnalyzing && <RefreshCw className="w-4 h-4 mr-2 animate-spin" />}
            {analysisJustDone && <CheckCircle2 className="w-4 h-4 mr-2" />}
            {btnLabel}
          </Button>
          <span className="text-xs text-muted-foreground">
            {isAnalyzing
              ? 'Scanning Pionex pairs and running AI analysis…'
              : isRateLimited
                ? 'AI quota exceeded — try again later'
                : isError
                  ? (lastAnalysisError?.slice(0, 80) ?? 'Last run failed')
                  : 'Scans Pionex pairs, selects top candidates, runs OpenAI → Groq fallback'}
          </span>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Last analysis', value: lastAnalysisLabel },
            { label: 'Pairs scanned', value: pairsScanned > 0 ? String(pairsScanned) : '—' },
            { label: 'Analyzed by AI', value: analyzedByAI > 0 ? String(analyzedByAI) : '—' },
            { label: 'Live signals', value: signalsCount > 0 ? String(signalsCount) : '—' },
          ].map(({ label, value }) => (
            <div key={label} className="p-3 rounded-lg bg-muted/50 border border-border">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</div>
              <div className="text-sm font-semibold text-foreground font-['Space_Grotesk']">{value}</div>
            </div>
          ))}
        </div>
      </div>
      {/* V2 pipeline status bar
           TERMINOLOGY:
           - "Sent to AI"   = in AI batch this run (does NOT mean AI approved)
           - "AI Reviewed"  = AI responded and created signals (0 when rate-limited)
           - "AI Recommended" = AI ran + server approved (green only when aiVerifiedCount > 0)
           - "Server Qualified" = server approved but AI rate-limited (warning, NOT green)
      */}
      {isRateLimited && <RateLimitBanner />}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[
          {
            label: 'Local Setups',
            value: localSetupsCount || '—',
            tooltip: 'Pairs that passed local scoring gates this run. Not trading signals.',
            color: localSetupsCount > 0 ? 'text-primary' : 'text-muted-foreground',
            border: localSetupsCount > 0 ? 'border-primary/30' : 'border-border',
          },
          {
            label: 'Sent to AI',
            value: analyzedByAI || '—',
            tooltip: 'Top candidates submitted to AI this run. Does NOT mean AI approved them.',
            color: analyzedByAI > 0 ? 'text-primary' : 'text-muted-foreground',
            border: 'border-border',
          },
          {
            label: 'AI Reviewed',
            value: aiVerifiedCount || '—',
            tooltip: isRateLimited
              ? 'AI was rate-limited — 0 signals reviewed by AI this run.'
              : 'Signals AI actually reviewed and returned a verdict on.',
            color: aiVerifiedCount > 0 && !isRateLimited ? 'text-success' : 'text-muted-foreground',
            border: aiVerifiedCount > 0 && !isRateLimited ? 'border-success/30' : 'border-border',
          },
          {
            label: isRateLimited ? 'Server Qualified' : 'AI Recommended',
            value: recommendedCount || '—',
            tooltip: isRateLimited
              ? 'Server-scored only — AI rate-limited. NOT an AI recommendation.'
              : 'AI reviewed AND server-qualified. Eligible for Auto Trader.',
            color: recommendedCount > 0
              ? (isRateLimited ? 'text-warning' : 'text-success')
              : 'text-muted-foreground',
            border: recommendedCount > 0
              ? (isRateLimited ? 'border-warning/40' : 'border-success/40')
              : 'border-border',
          },
          {
            label: 'Watch',
            value: watchCount || '—',
            tooltip: 'Server verdict: Watch — monitor but do not trade.',
            color: watchCount > 0 ? 'text-warning' : 'text-muted-foreground',
            border: watchCount > 0 ? 'border-warning/30' : 'border-border',
          },
        ].map(({ label, value, color, border, tooltip }) => (
          <div key={label} title={tooltip} className={`p-3 rounded-xl border cursor-default ${border}`} style={{ background: 'hsl(var(--card))' }}>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{label}</div>
            <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      <DiagnosticPanel />

      <Tabs defaultValue="signals" className="space-y-4">
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          <TabsList className="bg-muted w-max min-w-full md:w-auto">
            <TabsTrigger value="signals" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <Activity className="w-3.5 h-3.5 mr-1" />
              Live Signals {liveSignals.length > 0 && `(${liveSignals.length})`}
            </TabsTrigger>
            <TabsTrigger value="signal-history" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <History className="w-3.5 h-3.5 mr-1" />
              Signal History {signalHistory.length > 0 && `(${signalHistory.length})`}
            </TabsTrigger>
            <TabsTrigger value="recommended" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <Star className="w-3.5 h-3.5 mr-1" />
              Recommended
            </TabsTrigger>
            <TabsTrigger value="open" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <TrendingUp className="w-3.5 h-3.5 mr-1" />
              Open {(openTrades.length + openLiveOrders.length) > 0 && `(${new Set(openTrades.map(t => t.id)).size + openLiveOrders.length})`}
            </TabsTrigger>
            <TabsTrigger value="demo-history" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <Clock className="w-3.5 h-3.5 mr-1" />
              Trades
            </TabsTrigger>
            <TabsTrigger value="live-history" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <ShieldAlert className="w-3.5 h-3.5 mr-1" />
              Live History {liveOrders.filter(o => !['NEW','PARTIALLY_FILLED','OPEN'].includes(o.status)).length > 0 && `(${liveOrders.filter(o => !['NEW','PARTIALLY_FILLED','OPEN'].includes(o.status)).length})`}
            </TabsTrigger>
            <TabsTrigger value="auto-trader" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <Zap className="w-3.5 h-3.5 mr-1" />
              Auto Trader
            </TabsTrigger>
            <TabsTrigger value="market" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <Globe className="w-3.5 h-3.5 mr-1" />
              Market
            </TabsTrigger>
            <TabsTrigger value="ai-performance" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <Trophy className="w-3.5 h-3.5 mr-1" />
              AI Performance
            </TabsTrigger>
            <TabsTrigger value="performance" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground whitespace-nowrap">
              <TrendingDown className="w-3.5 h-3.5 mr-1" />
              Demo Stats
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Live signals tab */}
        <TabsContent value="signals" className="space-y-3">
          {loadingDemo && liveSignals.length === 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[1, 2, 3].map(i => <CardSkeleton key={i} className="h-80" />)}
            </div>
          ) : liveSignals.length === 0 ? (
            <Card className="border-border p-6 md:p-8 text-center" style={{ background: 'hsl(var(--card))' }}>
              <Brain className="w-10 h-10 md:w-12 md:h-12 text-muted-foreground mx-auto mb-3 opacity-40" />
              <p className="text-foreground font-semibold mb-2 text-sm md:text-base">No Active Signals</p>
              <p className="text-xs md:text-sm text-muted-foreground mb-4">
                Signals remain active for their AI-recommended Hold Time. AI scans Pionex every 7 minutes.
                {signalsCache?.signals?.length ? ` Last batch had ${signalsCache.signals.length} signal(s) — they may have expired or are being evaluated.` : ''}
              </p>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
                Check Signal History for past results
              </div>
            </Card>
          ) : (
            <>
              {/* Filter bar — only shown when there are live signals */}
              <SignalFilters
                filters={filters}
                onChange={handleFilterChange}
                onClear={handleClearFilters}
                totalCount={liveSignals.length}
                filteredCount={filteredSignals.length}
              />

              {filteredSignals.length === 0 ? (
                <Card className="border-border p-6 text-center" style={{ background: 'hsl(var(--card))' }}>
                  <Filter className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                  <p className="text-foreground font-semibold text-sm mb-1">No signals match your filters</p>
                  <p className="text-xs text-muted-foreground mb-3">
                    {liveSignals.length} signal{liveSignals.length !== 1 ? 's are' : ' is'} live but hidden by current filters.
                  </p>
                  <Button variant="outline" size="sm" onClick={handleClearFilters} className="text-xs h-7">
                    <X className="w-3 h-3 mr-1" /> Clear filters
                  </Button>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {liveSignalsPageItems.map(sig => (
                    <ErrorBoundary key={sig.id} inline label={sig.pair}>
                      <SignalCard
                        signal={sig}
                        onDemoBuy={s => { setSelectedSignal(s); setDemoBuyOpen(true); }}
                        onLiveBuy={s => { setSelectedSignal(s); setManualBuyOpen(true); }}
                        onLiveSell={s => { setSelectedSignal(s); setManualSellOpen(true); }}
                      />
                    </ErrorBoundary>
                  ))}
                </div>
              )}
              {/* Pagination for Live Signals */}
              {filteredSignals.length > PAGE_SIZE && (
                <div className="pt-2 pb-1 flex flex-col items-center gap-1">
                  <Pagination
                    page={liveSignalsPage}
                    totalPages={liveSignalsTotalPages}
                    onChange={setLiveSignalsPage}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Showing {((liveSignalsPage - 1) * PAGE_SIZE) + 1}–{Math.min(liveSignalsPage * PAGE_SIZE, filteredSignals.length)} of {filteredSignals.length} signals
                  </p>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* Open trades tab */}
        <TabsContent value="open" className="space-y-4">

          {/* ── LIVE seksjon ── */}
          {isPionexLive && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-destructive bg-destructive/10 border border-destructive/30 rounded px-2 py-1">
                    🔴 LIVE TRADING – PIONEX / REAL MONEY
                  </span>
                  <span className="text-xs text-muted-foreground">Pionex-regler og tilgjengelig saldo</span>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={refreshLiveOrders}>
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Oppdater
                </Button>
              </div>

              {openLiveOrders.length === 0 ? (
                <Card className="border-destructive/20 bg-destructive/5 p-5 text-center">
                  <ShieldAlert className="w-8 h-8 text-destructive/40 mx-auto mb-2" />
                  <p className="text-sm font-medium text-muted-foreground">Ingen åpne live trades</p>
                  <p className="text-xs text-muted-foreground mt-1">Auto Trader åpner neste ekte trade ved neste FRESH + RECOMMENDED signal</p>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {openLiveOrders.map(order => (
                    <ErrorBoundary key={order.id} inline label={order.pair}>
                      <LiveOrderCard
                        order={order}
                        currentPrice={marketPrices[order.pair]?.price}
                      />
                    </ErrorBoundary>
                  ))}
                </div>
              )}
              <div className="border-t border-border" />
            </div>
          )}

          {/* ── DEMO seksjon ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <DemoBadge />
              <span className="text-xs text-muted-foreground">Live P/L oppdateres hvert 30. sekund</span>
            </div>
            {loadingDemo ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[1, 2].map(i => <CardSkeleton key={i} className="h-64" />)}
              </div>
            ) : openTrades.length === 0 ? (
              <Card className="border-border p-6 text-center" style={{ background: 'hsl(var(--card))' }}>
                <Activity className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
                <p className="text-sm font-medium text-muted-foreground">Ingen åpne demo trades</p>
                <p className="text-xs text-muted-foreground mt-1">Bruk Live Signals-fanen for å åpne din første demo trade</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(() => {
                  const seen = new Set<string>();
                  const unique = openTrades.filter(t => {
                    if (seen.has(t.id)) return false;
                    seen.add(t.id);
                    return true;
                  });
                  console.log('OPEN_TRADES', {
                    count: openTrades.length,
                    uniqueCount: unique.length,
                    ids: openTrades.map(t => t.id),
                    pairs: openTrades.map(t => t.pair),
                    autoTraderTradeId,
                  });
                  return unique.map(trade => (
                    <ErrorBoundary key={trade.id} inline label={trade.pair}>
                      <OpenTradeCard trade={trade} onClose={() => { setSelectedTrade(trade); setDemoSellOpen(true); }} />
                    </ErrorBoundary>
                  ));
                })()}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Demo trade history tab */}
        <TabsContent value="demo-history">
          <Card className="border-border overflow-hidden" style={{ background: 'hsl(var(--card))' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" />
                Demo Trade History
                <DemoBadge />
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {tradeHistory.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Ingen lukkede demo trades ennå</div>
              ) : (
                <div className="overflow-x-auto">
                  <div className="min-w-[360px]">
                    {tradeHistory.map(t => <HistoryRow key={t.id} trade={t} />)}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Live Trade History tab */}
        <TabsContent value="live-history">
          <Card className="border-destructive/30 overflow-hidden" style={{ background: 'hsl(var(--card))' }}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-destructive" />
                  Live Trade History
                  <span className="text-[10px] font-bold text-destructive bg-destructive/10 border border-destructive/30 rounded px-1.5 py-0.5">
                    🔴 REAL MONEY
                  </span>
                </CardTitle>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={refreshLiveOrders}>
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Oppdater
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {(() => {
                const closed = liveOrders.filter(o => !['NEW','PARTIALLY_FILLED','OPEN'].includes(o.status));
                if (closed.length === 0) {
                  return (
                    <div className="p-8 text-center">
                      <ShieldAlert className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground font-medium">Ingen lukkede live trades ennå</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Lukkede ekte Pionex-trades vil vises her med full rapport
                      </p>
                    </div>
                  );
                }
                return (
                  <div className="overflow-x-auto">
                    <div className="min-w-[400px]">
                      {closed.map(o => <LiveHistoryRow key={o.id} order={o} />)}
                    </div>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Signal History tab */}
        <TabsContent value="signal-history">
          <SignalHistoryTab />
        </TabsContent>

        {/* Recommended to Trade tab */}
        <TabsContent value="recommended" className="space-y-4">
          <ErrorBoundary inline label="Recommended to Trade">
            <RecommendedToTradePanel />
          </ErrorBoundary>
        </TabsContent>

        {/* AI Auto Trader tab */}
        <TabsContent value="auto-trader" className="space-y-4">
          <ErrorBoundary inline label="AI Auto Trader">
            <AIAutoTraderPanel />
          </ErrorBoundary>
        </TabsContent>

        {/* AI Performance tab */}
        <TabsContent value="ai-performance">
          <ErrorBoundary inline label="AI Performance">
            <SignalPerformancePanel />
          </ErrorBoundary>
        </TabsContent>

        {/* Demo Stats tab */}
        <TabsContent value="performance">
          <ErrorBoundary inline label="Performance">
            <PerformancePanel />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>

      {selectedSignal && (
        <DemoBuyModal open={demoBuyOpen} onClose={() => { setDemoBuyOpen(false); setSelectedSignal(null); }} signal={selectedSignal} />
      )}
      {selectedSignal && (
        <ManualBuyModal
          open={manualBuyOpen}
          onClose={() => {
            setManualBuyOpen(false);
            setSelectedSignal(null);
          }}
          signal={selectedSignal}
        />
      )}

      {selectedSignal && (
        <ManualSellModal
          open={manualSellOpen}
          onClose={() => {
            setManualSellOpen(false);
            setSelectedSignal(null);
          }}
          signal={selectedSignal}
        />
      )}

      {selectedTrade && (
        <DemoSellModal open={demoSellOpen} onClose={() => { setDemoSellOpen(false); setSelectedTrade(null); }} trade={selectedTrade} />
      )}
    </div>
  );
}
