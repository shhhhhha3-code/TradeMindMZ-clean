import { useMemo } from 'react';
import { useTrading } from '@/contexts/TradingContext';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TrendingUp, TrendingDown, Activity, Globe, BarChart2,
  ArrowUp, ArrowDown, Minus
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LocalSetup } from '@/types/types';
import {
  SignalStatusLabel, RREligibility, RateLimitBanner,
  localSetupVariant, RR_MIN_THRESHOLD,
} from '@/components/ui/SignalStatusLabel';

interface RegimeStat {
  label: string;
  count: number;
  color: string;
  bg: string;
  icon: React.ElementType;
}

interface SetupCardProps {
  setup: LocalSetup;
  rank: number;
  aiAvailable: boolean;
}

function fmt(n: number | null | undefined, digits = 1): string {
  if (n == null) return '—';
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function ScorePip({ score }: { score: number }) {
  const color = score >= 70 ? 'text-success' : score >= 55 ? 'text-warning' : 'text-muted-foreground';
  return <span className={cn('font-bold font-mono text-sm', color)}>{score}</span>;
}

function SetupCard({ setup, rank, aiAvailable }: SetupCardProps) {
  const isBuy = setup.signal_type === 'BUY';
  const statusVariant = localSetupVariant(setup, aiAvailable);
  const rrIneligible  = setup.estimated_rr < RR_MIN_THRESHOLD;

  // Border/bg reflects true status: ineligible → red, server-only → warning, ai-recommended → green
  const verdictColor = rrIneligible
    ? 'border-destructive/25 bg-destructive/5'
    : setup.server_verdict === 'RECOMMENDED' && aiAvailable
      ? 'border-success/30 bg-success/5'
      : setup.server_verdict === 'RECOMMENDED'
        ? 'border-warning/25 bg-warning/5'          // server-only — NOT green
        : setup.server_verdict === 'WATCH'
          ? 'border-warning/30 bg-warning/5'
          : 'border-border bg-muted/30';
  const tierBadge = setup.setup_tier === 'STRONG_SETUP' ? 'setup-tier-strong'
    : setup.setup_tier === 'GOOD_SETUP' ? 'setup-tier-good'
    : setup.setup_tier === 'WATCH' ? 'setup-tier-watch'
    : 'setup-tier-explore';

  return (
    <div className={cn('p-3 rounded-lg border', verdictColor)}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono text-muted-foreground shrink-0 w-5">#{rank}</span>
          <div className="min-w-0">
            <div className="text-xs font-bold text-foreground leading-tight truncate">{setup.pair}</div>
            <div className="text-[10px] text-muted-foreground truncate">{setup.coin_name}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className={cn('flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded',
            isBuy ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
            {isBuy ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
            {setup.signal_type}
          </div>
          <Badge variant="outline" className={cn('text-[9px] px-1 py-0', tierBadge)}>
            {setup.setup_tier.replace('_', ' ')}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5 text-[10px]">
        <div className="text-center">
          <div className="text-muted-foreground">Score</div>
          <ScorePip score={setup.local_score} />
        </div>
        <div className="text-center">
          {/* RR shown in warning/red color when below threshold */}
          <div className="text-muted-foreground">RR</div>
          <span className={cn('font-mono font-semibold',
            rrIneligible ? 'text-destructive' : 'text-foreground')}>
            {fmt(setup.estimated_rr)}
          </span>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">RSI</div>
          <span className={cn('font-mono font-semibold',
            setup.rsi_14 > 70 ? 'text-destructive' : setup.rsi_14 < 30 ? 'text-success' : 'text-foreground')}>
            {fmt(setup.rsi_14, 0)}
          </span>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">24h</div>
          <span className={cn('font-mono font-semibold', setup.change_pct_24h >= 0 ? 'text-success' : 'text-destructive')}>
            {fmtPct(setup.change_pct_24h)}
          </span>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">WR</div>
          <span className={cn('font-mono font-semibold',
            setup.hist_win_rate != null && setup.hist_win_rate >= 50 ? 'text-success' : 'text-muted-foreground')}>
            {setup.hist_win_rate != null ? `${setup.hist_win_rate}%` : '—'}
          </span>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">Regime</div>
          <span className="font-semibold text-foreground truncate text-[9px]">{setup.market_regime || '—'}</span>
        </div>
      </div>

      {/* Status label row — explicit about what "RECOMMENDED" actually means */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <SignalStatusLabel variant={statusVariant} size="xs" />
      </div>

      {/* Explicit RR eligibility block — high score alone does NOT mean tradable */}
      {rrIneligible && (
        <div className="mt-2">
          <RREligibility
            estimatedRr={setup.estimated_rr}
            localScore={setup.local_score}
          />
        </div>
      )}
    </div>
  );
}

export default function MarketOverviewPage() {
  const { signalsCache, aiAnalysisStatus } = useTrading();
  const loading = aiAnalysisStatus === 'updating' && !signalsCache;
  const localSetups: LocalSetup[] = signalsCache?.local_setups ?? [];

  // AI availability: true only if AI actually ran and returned signals this run
  const aiVerifiedCount = signalsCache?.diagnostics?.ai_verified_count ?? 0;
  const aiRateLimited   = signalsCache?.gemini_status === 'RATE_LIMIT';
  const aiAvailable     = aiVerifiedCount > 0 && !aiRateLimited;

  // Regime distribution from local setups
  const regimeStats = useMemo((): RegimeStat[] => {
    const counts: Record<string, number> = {};
    for (const s of localSetups) {
      const r = (s.market_regime || 'UNKNOWN').toUpperCase();
      counts[r] = (counts[r] ?? 0) + 1;
    }
    const make = (key: string, label: string, color: string, bg: string, icon: React.ElementType): RegimeStat => ({
      label, count: counts[key] ?? 0, color, bg, icon,
    });
    return [
      make('BULL', 'Bullish', 'text-success', 'border-success/30 bg-success/5', TrendingUp),
      make('BEAR', 'Bearish', 'text-destructive', 'border-destructive/30 bg-destructive/5', TrendingDown),
      make('RANGING', 'Ranging', 'text-warning', 'border-warning/30 bg-warning/5', Minus),
      make('VOLATILE', 'Volatile', 'text-primary', 'border-primary/30 bg-primary/5', Activity),
      ...Object.entries(counts)
        .filter(([k]) => !['BULL','BEAR','RANGING','VOLATILE'].includes(k))
        .map(([k, v]) => ({
          label: k.charAt(0) + k.slice(1).toLowerCase(),
          count: v,
          color: 'text-muted-foreground',
          bg: 'border-border bg-muted/30',
          icon: Activity,
        })),
    ].filter(r => r.count > 0 || ['Bullish','Bearish','Ranging','Volatile'].includes(r.label));
    return regimeStats; // satisfy TS
  }, [localSetups]);

  // BUY/SELL opportunities
  const buySetups  = localSetups.filter(s => s.signal_type === 'BUY');
  const sellSetups = localSetups.filter(s => s.signal_type === 'SELL');
  const recSetups  = localSetups.filter(s => s.server_verdict === 'RECOMMENDED');
  const watchSetups = localSetups.filter(s => s.server_verdict === 'WATCH');

  // Top 10 setups sorted by local_score
  const top10 = useMemo(() =>
    [...localSetups].sort((a, b) => b.local_score - a.local_score).slice(0, 10),
    [localSetups]);

  // Show all qualified (expand) - top 10 by default, up to all
  const totalMarketPairs = signalsCache?.pairs_scanned ?? 0;
  const avgScore = localSetups.length > 0
    ? (localSetups.reduce((s, c) => s + c.local_score, 0) / localSetups.length).toFixed(1)
    : '—';

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-lg md:text-xl font-bold font-['Space_Grotesk'] text-foreground">Market Overview</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Local analysis results for all {totalMarketPairs} scanned pairs
        </p>
      </div>

      {/* Rate-limit banner — prevents server-qualified setups looking AI-confirmed */}
      {aiRateLimited && <RateLimitBanner />}

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Pairs Scanned', value: totalMarketPairs || '—', color: 'text-foreground', icon: Globe },
          { label: 'Local Setups', value: localSetups.length || '—', color: 'text-primary', icon: BarChart2 },
          { label: 'BUY Opps', value: buySetups.length || '—', color: 'text-success', icon: TrendingUp },
          { label: 'SELL Opps', value: sellSetups.length || '—', color: 'text-destructive', icon: TrendingDown },
        ].map(({ label, value, color, icon: Icon }) => (
          <div key={label} className="p-3 rounded-lg border border-border/50" style={{ background: 'hsl(var(--card))' }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
              <Icon className={cn('w-3.5 h-3.5 shrink-0', color)} />
            </div>
            <div className={cn('text-2xl font-bold font-mono leading-tight', color)}>{value}</div>
          </div>
        ))}
      </div>

      {/* Regime distribution */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Market Regime Distribution</h2>
            {localSetups.length > 0 && (
              <span className="ml-auto text-xs text-muted-foreground">avg score: <span className="text-foreground font-semibold">{avgScore}</span></span>
            )}
          </div>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[1,2,3,4].map(i => <Skeleton key={i} className="h-20 bg-muted" />)}
            </div>
          ) : localSetups.length === 0 ? (
            <div className="py-8 text-center">
              <Globe className="w-10 h-10 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">No local setups available yet</p>
              <p className="text-xs text-muted-foreground mt-1">Trigger an AI analysis to populate market data</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {regimeStats.map(r => (
                  <div key={r.label} className={cn('p-3 rounded-lg border', r.bg)}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <r.icon className={cn('w-3.5 h-3.5 shrink-0', r.color)} />
                      <span className={cn('text-xs font-semibold', r.color)}>{r.label}</span>
                    </div>
                    <div className={cn('text-2xl font-bold font-mono', r.color)}>{r.count}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {totalMarketPairs > 0 ? `${((r.count / totalMarketPairs) * 100).toFixed(0)}% of market` : 'pairs'}
                    </div>
                  </div>
                ))}
              </div>

              {/* Regime bar */}
              {totalMarketPairs > 0 && (
                <div className="h-3 rounded-full overflow-hidden flex">
                  {regimeStats.filter(r => r.count > 0).map(r => (
                    <div key={r.label} style={{ width: `${(r.count / totalMarketPairs) * 100}%` }}
                      className={cn('h-full transition-all', r.color.replace('text-', 'bg-').replace('-foreground',''))}
                      title={`${r.label}: ${r.count}`} />
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* BUY / SELL opportunity summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4 text-success" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">BUY Opportunities</h2>
              <Badge variant="outline" className="ml-auto border-success/40 bg-success/10 text-success text-[10px]">{buySetups.length}</Badge>
            </div>
            {buySetups.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No BUY setups identified</p>
            ) : (
              <div className="space-y-2">
                {buySetups.sort((a,b) => b.local_score - a.local_score).slice(0,5).map((s, i) => (
                  <div key={s.pair} className="flex items-center justify-between gap-2 py-1.5 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] text-muted-foreground w-4 shrink-0">#{i+1}</span>
                      <span className="text-xs font-semibold text-foreground truncate">{s.pair}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Use SignalStatusLabel — never show raw "RECOMMENDED" on server-only setups */}
                      <SignalStatusLabel variant={localSetupVariant(s, aiAvailable)} size="xs" showIcon={false} />
                      <ScorePip score={s.local_score} />
                    </div>
                  </div>
                ))}
                {buySetups.length > 5 && (
                  <p className="text-[10px] text-muted-foreground pt-1">+{buySetups.length - 5} more BUY setups</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingDown className="w-4 h-4 text-destructive" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">SELL Opportunities</h2>
              <Badge variant="outline" className="ml-auto border-destructive/40 bg-destructive/10 text-destructive text-[10px]">{sellSetups.length}</Badge>
            </div>
            {sellSetups.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No SELL setups identified</p>
            ) : (
              <div className="space-y-2">
                {sellSetups.sort((a,b) => b.local_score - a.local_score).slice(0,5).map((s, i) => (
                  <div key={s.pair} className="flex items-center justify-between gap-2 py-1.5 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] text-muted-foreground w-4 shrink-0">#{i+1}</span>
                      <span className="text-xs font-semibold text-foreground truncate">{s.pair}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Use SignalStatusLabel — never show raw "RECOMMENDED" on server-only setups */}
                      <SignalStatusLabel variant={localSetupVariant(s, aiAvailable)} size="xs" showIcon={false} />
                      <ScorePip score={s.local_score} />
                    </div>
                  </div>
                ))}
                {sellSetups.length > 5 && (
                  <p className="text-[10px] text-muted-foreground pt-1">+{sellSetups.length - 5} more SELL setups</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top 10 local setups */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4">
          {/* Badge label: "AI Recommended" only when AI actually ran */}
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">
                Top Local Setups
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn(
                'text-[10px]',
                aiAvailable
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-warning/40 bg-warning/10 text-warning'
              )}>
                {recSetups.length} {aiAvailable ? 'AI Recommended' : 'Server Qualified'}
              </Badge>
              <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning text-[10px]">
                {watchSetups.length} WATCH
              </Badge>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[1,2,3,4].map(i => <Skeleton key={i} className="h-28 bg-muted" />)}
            </div>
          ) : top10.length === 0 ? (
            <div className="py-8 text-center">
              <BarChart2 className="w-10 h-10 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">No local setups yet</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {top10.map((setup, i) => (
                <SetupCard key={setup.pair} setup={setup} rank={i + 1} aiAvailable={aiAvailable} />
              ))}
            </div>
          )}

          {localSetups.length > 10 && (
            <div className="mt-4 pt-3 border-t border-border text-xs text-muted-foreground text-center">
              Showing top 10 of <span className="font-semibold text-foreground">{localSetups.length}</span> qualified setups
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
