import { useTrading } from '@/contexts/TradingContext';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, ArrowRight, CheckCircle2, AlertCircle, Clock, Cpu, Brain, Zap, Bot, Activity, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

function fmtMs(ms: number | undefined | null): string {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return '—'; }
}

interface StageProps {
  icon: React.ElementType;
  label: string;
  sublabel?: string;
  count: number | string;
  timing?: string;
  status: 'success' | 'warning' | 'muted' | 'info' | 'primary';
  detail?: string;
  isLast?: boolean;
}

function FunnelStage({ icon: Icon, label, sublabel, count, timing, status, detail, isLast }: StageProps) {
  const statusStyles = {
    success: 'border-success/30 bg-success/5',
    warning: 'border-warning/30 bg-warning/5',
    muted:   'border-border bg-muted/30',
    info:    'border-info/30 bg-info/5',
    primary: 'border-primary/30 bg-primary/5',
  };
  const countStyles = {
    success: 'text-success',
    warning: 'text-warning',
    muted:   'text-muted-foreground',
    info:    'text-info',
    primary: 'text-primary',
  };
  const dotStyles = {
    success: 'bg-success shadow-[0_0_6px_hsl(var(--success))]',
    warning: 'bg-warning shadow-[0_0_6px_hsl(var(--warning))]',
    muted:   'bg-muted-foreground',
    info:    'bg-info shadow-[0_0_6px_hsl(var(--info))]',
    primary: 'bg-primary shadow-[0_0_6px_hsl(var(--primary))]',
  };

  return (
    <div className="flex items-center gap-2">
      <div className={cn('flex flex-col items-center gap-1.5 min-w-[100px] max-w-[130px] px-3 py-3 rounded-xl border', statusStyles[status])}>
        <div className="flex items-center gap-1.5">
          <span className={cn('w-2 h-2 rounded-full shrink-0', dotStyles[status])} />
          <Icon className={cn('w-3.5 h-3.5 shrink-0', countStyles[status])} />
        </div>
        <div className="text-[10px] font-bold text-center text-foreground uppercase tracking-wide leading-tight">{label}</div>
        {sublabel && <div className="text-[9px] text-muted-foreground text-center leading-tight">{sublabel}</div>}
        <div className={cn('text-lg font-bold font-mono leading-none', countStyles[status])}>{count}</div>
        {timing && <div className="text-[9px] text-muted-foreground text-center">{timing}</div>}
        {detail && <div className="text-[9px] text-center leading-tight" style={{ color: 'hsl(var(--muted-foreground))' }}>{detail}</div>}
      </div>
      {!isLast && (
        <div className="flex items-center shrink-0 pipeline-arrow">
          <div className="w-3 h-px bg-border" />
          <ArrowRight className="w-4 h-4 -ml-1.5" />
        </div>
      )}
    </div>
  );
}

function TimingRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-2 border-b border-border/50 last:border-0')}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-xs font-mono font-semibold', highlight ? 'text-primary' : 'text-foreground')}>{value}</span>
    </div>
  );
}

function CounterRow({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-xs font-mono font-semibold', color ?? 'text-foreground')}>{value}</span>
    </div>
  );
}

export default function PipelineDiagnosticsPage() {
  const { signalsCache, aiAnalysisStatus, lastAIUpdate, refreshSignals } = useTrading();
  const diag = signalsCache?.diagnostics;

  const handleRefresh = async () => {
    toast.info('Triggering AI analysis…');
    await refreshSignals();
  };

  // AI status
  const aiRunning = aiAnalysisStatus === 'updating';
  const openaiOk = signalsCache?.gemini_status === 'connected';
  const groqOk = (signalsCache?.groq_count ?? 0) > 0;

  // Pipeline stage counts
  const pairsScanned       = diag?.market_pairs_scanned ?? signalsCache?.pairs_scanned ?? 0;
  const localSetupsCount   = signalsCache?.local_setups?.length ?? diag?.qualified_count ?? 0;
  const qualifiedCount     = diag?.qualified_count ?? localSetupsCount;
  const sentToAI           = diag?.candidates_sent_to_ai ?? signalsCache?.analyzed_count ?? 0;
  const aiVerifiedCount    = diag?.ai_verified_count ?? 0;
  const recommendedCount   = diag?.recommended_count ??
    (signalsCache?.signals?.filter(s => s.server_verdict === 'RECOMMENDED').length ?? 0);
  const autoTraderActive   = recommendedCount > 0;

  // Timing
  const totalMs      = diag?.total_duration_ms;
  const marketMs     = diag?.market_fetch_ms;
  const screenMs     = diag?.screening_ms;
  const indicatorMs  = diag?.indicator_ms ?? diag?.klines_ms;
  const selectionMs  = diag?.selection_ms;
  const aiMs         = diag?.ai_ms;
  const dbWriteMs    = diag?.db_write_ms;

  // AI counters
  const openaiCount  = diag?.openai_count ?? diag?.gemini_count ?? signalsCache?.openai_count ?? signalsCache?.gemini_count ?? 0;
  const groqCount    = diag?.groq_count   ?? signalsCache?.groq_count   ?? 0;
  const cacheHits    = diag?.ai_cache_hits ?? 0;
  const cacheMisses  = diag?.ai_cache_misses ?? 0;
  const aiSuccess    = diag?.ai_success ?? 0;
  const aiRateLimit  = diag?.ai_rate_limit ?? 0;
  const aiTimeout    = diag?.ai_timeout ?? 0;
  const aiError      = diag?.ai_error ?? 0;
  const freshSignals = diag?.fresh_signals ?? 0;
  const staleSignals = diag?.stale_signals ?? 0;

  // AI availability — used to label "Recommended" correctly
  const aiRateLimited  = !openaiOk && !groqOk;
  const aiAvailable    = aiVerifiedCount > 0 && !aiRateLimited;

  const stages: StageProps[] = [
    {
      icon: Activity,
      label: 'Market Scan',
      sublabel: 'Pionex USDT pairs',
      count: pairsScanned || '—',
      timing: fmtMs(marketMs),
      status: pairsScanned > 0 ? 'success' : 'muted',
    },
    {
      icon: Cpu,
      label: 'Local Analysis',
      sublabel: 'Indicators + scoring',
      count: pairsScanned || '—',
      timing: fmtMs(indicatorMs),
      status: pairsScanned > 0 ? 'info' : 'muted',
    },
    {
      icon: TrendingUp,
      label: 'Qualified',
      sublabel: 'Server verdict ≠ NO_TRADE',
      count: qualifiedCount || '—',
      timing: fmtMs(selectionMs),
      status: qualifiedCount > 0 ? 'primary' : 'muted',
    },
    {
      icon: Zap,
      label: 'Top Candidates',
      sublabel: 'Sent to AI',
      count: sentToAI || '—',
      status: sentToAI > 0 ? 'primary' : 'muted',
      detail: `${pairsScanned - sentToAI || 0} filtered`,
    },
    {
      icon: Bot,
      label: 'AI Analysis',
      sublabel: openaiOk ? 'OpenAI' : groqOk ? 'Groq' : 'Rate-limited',
      // sentToAI = candidates dispatched to the AI batch call
      count: sentToAI || '—',
      timing: fmtMs(aiMs),
      status: aiSuccess > 0 ? 'success' : aiRateLimit > 0 ? 'warning' : 'muted',
    },
    {
      icon: CheckCircle2,
      // aiVerifiedCount = actual verdicts returned by AI (RECOMMENDED + WATCH + NO_TRADE)
      label: 'AI Reviewed',
      sublabel: aiRateLimited ? 'Rate-limited — 0 this run' : 'Verdicts returned by AI',
      count: aiSuccess > 0 ? (aiVerifiedCount || 0) : '—',
      status: aiVerifiedCount > 0 ? 'success' : aiRateLimited ? 'warning' : 'muted',
    },
    {
      icon: Brain,
      // "AI Recommended" only when AI actually ran. "Server Qualified" when rate-limited.
      label: aiAvailable ? 'AI Recommended' : 'Server Qualified',
      sublabel: aiAvailable
        ? 'AI reviewed + all gates passed'
        : 'Server gates passed — AI rate-limited, not AI-reviewed',
      count: recommendedCount || '—',
      status: recommendedCount > 0 ? (aiAvailable ? 'success' : 'warning') : 'muted',
    },
    {
      icon: TrendingUp,
      label: 'Auto Trader',
      sublabel: 'Eligible for execution',
      count: autoTraderActive ? recommendedCount : 0,
      status: autoTraderActive ? 'success' : 'muted',
      isLast: true,
    },
  ];

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg md:text-xl font-bold font-['Space_Grotesk'] text-foreground">Pipeline Diagnostics</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Last run: {lastAIUpdate ? fmtTime(lastAIUpdate.toISOString()) : '—'}
            {totalMs ? ` · Total: ${fmtMs(totalMs)}` : ''}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={handleRefresh} disabled={aiRunning}
          className="shrink-0 gap-2 h-8">
          <RefreshCw className={cn('w-3.5 h-3.5', aiRunning && 'animate-spin')} />
          {aiRunning ? 'Running…' : 'Run Now'}
        </Button>
      </div>

      {/* Funnel visualization */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">
              8-Stage Pipeline Funnel
            </h2>
            {aiRunning && (
              <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning text-[10px] ml-auto">
                <span className="status-dot-warning mr-1" /> ANALYZING
              </Badge>
            )}
          </div>
          <div className="overflow-x-auto pb-2 -mx-1 px-1">
            <div className="flex items-center gap-1.5 min-w-max">
              {stages.map((stage) => (
                <FunnelStage key={stage.label} {...stage} />
              ))}
            </div>
          </div>
          {/* Reduction label */}
          {pairsScanned > 0 && recommendedCount > 0 && (
            <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-2 text-xs text-muted-foreground">
              <TrendingUp className="w-3.5 h-3.5 text-success shrink-0" />
              <span>
                <span className="font-semibold text-foreground">{pairsScanned}</span> pairs →{' '}
                <span className="font-semibold text-primary">{qualifiedCount}</span> qualified →{' '}
                <span className="font-semibold text-success">{recommendedCount}</span> recommended
                {' '}({((recommendedCount / pairsScanned) * 100).toFixed(1)}% pass rate)
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Timing Breakdown */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Timing Breakdown</h2>
            </div>
            <TimingRow label="Market Fetch (Pionex tickers)" value={fmtMs(marketMs)} />
            <TimingRow label="Pre-screening" value={fmtMs(screenMs)} />
            <TimingRow label="Klines + Indicators" value={fmtMs(indicatorMs)} />
            <TimingRow label="Candidate Selection" value={fmtMs(selectionMs)} />
            <TimingRow label="AI Analysis (OpenAI/Groq)" value={fmtMs(aiMs)} />
            <TimingRow label="Database Write" value={fmtMs(dbWriteMs)} />
            <div className="mt-3 pt-2 border-t border-border flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">Total Pipeline</span>
              <span className="text-sm font-bold font-mono text-primary">{fmtMs(totalMs)}</span>
            </div>
          </CardContent>
        </Card>

        {/* AI Stage Counters */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">AI Stage Counters</h2>
            </div>
            <CounterRow label="OpenAI calls" value={openaiCount} color={openaiCount > 0 ? 'text-success' : undefined} />
            <CounterRow label="Groq fallback calls" value={groqCount} color={groqCount > 0 ? 'text-warning' : undefined} />
            <CounterRow label="Cache hits (skipped AI)" value={cacheHits} />
            <CounterRow label="Cache misses (sent to AI)" value={cacheMisses} />
            <CounterRow label="AI success" value={aiSuccess > 0 ? '✓ YES' : '✗ NO'} color={aiSuccess > 0 ? 'text-success' : 'text-destructive'} />
            <CounterRow label="Rate limited" value={aiRateLimit > 0 ? '⚠ YES' : 'No'} color={aiRateLimit > 0 ? 'text-warning' : 'text-muted-foreground'} />
            <CounterRow label="Timeout" value={aiTimeout > 0 ? '⚠ YES' : 'No'} color={aiTimeout > 0 ? 'text-warning' : 'text-muted-foreground'} />
            <CounterRow label="AI error" value={aiError > 0 ? '✗ YES' : 'No'} color={aiError > 0 ? 'text-destructive' : 'text-muted-foreground'} />
          </CardContent>
        </Card>

        {/* Signal Output */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Signal Output</h2>
            </div>
            <CounterRow label="Total signals in cache" value={signalsCache?.signals?.length ?? 0} />
            <CounterRow label="Fresh signals" value={freshSignals} color={freshSignals > 0 ? 'text-success' : undefined} />
            <CounterRow label="Stale signals (preserved)" value={staleSignals} color={staleSignals > 0 ? 'text-warning' : undefined} />
            <CounterRow label="Best current setup" value={diag?.best_current_setup ?? '—'} color="text-primary" />
            <CounterRow label="Local setups found" value={localSetupsCount} />
            <CounterRow label="Qualified (≠ NO_TRADE)" value={qualifiedCount} color="text-primary" />
            <CounterRow label="Strong setups (RECOMMENDED + score ≥70)" value={diag?.strong_setups_count ?? 0} color="text-success" />
          </CardContent>
        </Card>

        {/* AI Provider Status */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Brain className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Provider Status</h2>
            </div>

            {/* OpenAI */}
            <div className="p-3 rounded-lg border border-border/50 mb-2" style={{ background: 'hsl(var(--muted))' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-foreground">OpenAI (Primary)</span>
                <Badge variant="outline" className={cn('text-[10px]', openaiOk ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning')}>
                  {signalsCache?.gemini_status ?? '—'}
                </Badge>
              </div>
              {(diag?.openai_error_category ?? diag?.gemini_error_category) && (
                <div className="text-[10px] text-destructive mt-0.5">
                  Error: {diag?.openai_error_category ?? diag?.gemini_error_category}
                  {(diag?.openai_error_detail ?? diag?.gemini_error_detail) ? ` — ${diag?.openai_error_detail ?? diag?.gemini_error_detail}` : ''}
                </div>
              )}
            </div>

            {/* Groq */}
            <div className="p-3 rounded-lg border border-border/50" style={{ background: 'hsl(var(--muted))' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-foreground">Groq (Fallback)</span>
                <Badge variant="outline" className={cn('text-[10px]', groqCount > 0 ? 'border-success/40 bg-success/10 text-success' : 'border-border text-muted-foreground')}>
                  {groqCount > 0 ? `Used (${groqCount})` : 'Not Used'}
                </Badge>
              </div>
              {diag?.groq_error_category && (
                <div className="text-[10px] text-warning mt-0.5">
                  Fallback error: {diag.groq_error_category}
                </div>
              )}
            </div>

            {/* Rate-limit guard note */}
            {aiRateLimit > 0 && (
              <div className="mt-3 p-2.5 rounded-lg border border-warning/25 bg-warning/5 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                <p className="text-[11px] text-warning leading-relaxed">
                  Rate-limit guard active — existing live signals preserved. LOCAL_SETUP data is still available.
                </p>
              </div>
            )}
            {aiRateLimit === 0 && aiSuccess > 0 && (
              <div className="mt-3 p-2.5 rounded-lg border border-success/25 bg-success/5 flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
                <p className="text-[11px] text-success leading-relaxed">
                  AI analysis completed successfully. All {sentToAI} candidates reviewed.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* WATCH/NO_TRADE Verdicts (if any) */}
      {Array.isArray(diag?.ai_verdicts) && diag.ai_verdicts.length > 0 && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-4 h-4 text-warning" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">
                AI Verdicts — WATCH / NO_TRADE
              </h2>
            </div>
            <div className="space-y-2">
              {(diag.ai_verdicts as Array<{ pair?: string; verdict?: string; reason?: string }>).map((v, i) => (
                <div key={i} className="flex items-start gap-3 p-2.5 rounded-lg border border-border/50" style={{ background: 'hsl(var(--muted))' }}>
                  <Badge variant="outline" className={cn('text-[10px] shrink-0 mt-0.5',
                    v.verdict === 'WATCH' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-destructive/40 bg-destructive/10 text-destructive'
                  )}>
                    {v.verdict ?? '—'}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-semibold text-foreground mr-2">{v.pair ?? '—'}</span>
                    <span className="text-xs text-muted-foreground">{v.reason ?? '—'}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
