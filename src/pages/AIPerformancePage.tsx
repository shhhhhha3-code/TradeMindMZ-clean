import { useEffect, useState } from 'react';
import { useTrading } from '@/contexts/TradingContext';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Bot, Brain, Activity,
  AlertCircle, BarChart2, Percent
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/db/supabase';

interface PerfRow {
  ai_source: string;
  total: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
}

interface ConfRow {
  confidence_range: string;
  total: number;
  wins: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
}

interface SummaryRow {
  total_signals: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_return_pct: number | null;
  best_trade_pct: number | null;
  total_pl_usdt: number | null;
}

function StatTile({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  return (
    <div className="p-3 rounded-lg border border-border/50" style={{ background: 'hsl(var(--muted))' }}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{label}</div>
      <div className={cn('text-xl font-bold font-mono leading-tight', color ?? 'text-foreground')}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function BarRow({ label, value, max, color, sub }: { label: string; value: number; max: number; color: string; sub?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-semibold font-mono', color)}>{value}{sub}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color.includes('success') ? 'hsl(var(--success))' : color.includes('warning') ? 'hsl(var(--warning))' : color.includes('primary') ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }} />
      </div>
    </div>
  );
}

export default function AIPerformancePage() {
  const { signalsCache, aiAnalysisStatus, lastAIUpdate } = useTrading();
  const diag = signalsCache?.diagnostics;

  const [summary, setSummary]     = useState<SummaryRow | null>(null);
  const [byAI, setByAI]           = useState<PerfRow[]>([]);
  const [byConf, setByConf]       = useState<ConfRow[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      const [s, a, c] = await Promise.all([
        supabase.from('signal_performance_summary').select('*').maybeSingle(),
        supabase.from('signal_performance_by_ai_source').select('*'),
        supabase.from('signal_performance_by_confidence').select('*'),
      ]);
      if (!mounted) return;
      setSummary((s.data as SummaryRow) ?? null);
      setByAI((a.data as PerfRow[]) ?? []);
      setByConf((c.data as ConfRow[]) ?? []);
      setLoading(false);
    };
    load();
    return () => { mounted = false; };
  }, []);

  const openaiCount  = diag?.openai_count ?? diag?.gemini_count ?? signalsCache?.openai_count ?? signalsCache?.gemini_count ?? 0;
  const groqCount    = diag?.groq_count     ?? signalsCache?.groq_count    ?? 0;
  const rateLimit    = diag?.ai_rate_limit  ?? 0;
  const aiSuccess    = diag?.ai_success     ?? 0;
  const aiTimeout    = diag?.ai_timeout     ?? 0;
  const aiError      = diag?.ai_error       ?? 0;
  const isRateLimited = signalsCache?.gemini_status === 'RATE_LIMIT';

  const totalCallsThisRun = openaiCount + groqCount;

  // Local setups vs AI verified count
  const localSetupsCount = signalsCache?.local_setups?.length ?? 0;
  const aiVerified = diag?.ai_verified_count ?? 0;
  const recommended = diag?.recommended_count ??
    (signalsCache?.signals?.filter(s => s.server_verdict === 'RECOMMENDED').length ?? 0);

  // WIN rates from byAI table
  const openaiRow = byAI.find(r => r.ai_source === 'openai') ?? byAI.find(r => r.ai_source === 'gemini');
  const groqRow   = byAI.find(r => r.ai_source === 'groq');

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-lg md:text-xl font-bold font-['Space_Grotesk'] text-foreground">AI Performance</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          AI analysis accuracy, call statistics, and win-rate comparison
        </p>
      </div>

      {/* This Run Stats */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bot className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Current Run</h2>
            {aiAnalysisStatus === 'updating' && (
              <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning text-[10px] ml-auto">
                <span className="status-dot-warning mr-1" /> Analyzing
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="AI Calls This Run" value={totalCallsThisRun} sub={`OpenAI: ${openaiCount} · Groq: ${groqCount}`} color="text-primary" />
            <StatTile label="AI Result" value={aiSuccess > 0 ? '✓ Success' : rateLimit > 0 ? '⚠ Rate Ltd' : aiTimeout > 0 ? '⚠ Timeout' : aiError > 0 ? '✗ Error' : '—'}
              color={aiSuccess > 0 ? 'text-success' : rateLimit > 0 || aiTimeout > 0 ? 'text-warning' : 'text-muted-foreground'} />
            <StatTile label="OpenAI Status" value={signalsCache?.gemini_status ?? '—'}
              color={signalsCache?.gemini_status === 'connected' ? 'text-success' : isRateLimited ? 'text-warning' : 'text-destructive'} />
            <StatTile label="Last Analysis" value={lastAIUpdate ? `${Math.floor((Date.now() - lastAIUpdate.getTime()) / 60000)}m ago` : '—'} />
          </div>

          {/* Progress: LOCAL → AI VERIFIED → RECOMMENDED */}
          <div className="mt-4 pt-3 border-t border-border space-y-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">This Run: Local → AI → Recommended</div>
            <BarRow label={`Local Setups (qualified)`} value={localSetupsCount} max={signalsCache?.pairs_scanned ?? 70} color="text-info" sub=" pairs" />
            <BarRow label={`Sent to AI`} value={signalsCache?.analyzed_count ?? 0} max={localSetupsCount || 1} color="text-primary" sub=" pairs" />
            <BarRow label={`AI Verified`} value={aiVerified} max={signalsCache?.analyzed_count ?? 5} color="text-primary" sub=" signals" />
            <BarRow label={`Recommended`} value={recommended} max={aiVerified || 5} color="text-success" sub=" signals" />
          </div>
        </CardContent>
      </Card>

      {/* Historical Performance */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Overall Summary */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart2 className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Overall Performance</h2>
            </div>
            {loading ? (
              <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-10 w-full bg-muted" />)}</div>
            ) : !summary || summary.total_signals < 5 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Activity className="w-10 h-10 text-muted-foreground mb-2 opacity-50" />
                <p className="text-sm text-muted-foreground">Insufficient data</p>
                <p className="text-xs text-muted-foreground mt-1">Need at least 5 resolved signals</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <StatTile label="Total Signals" value={summary.total_signals} />
                <StatTile label="Win Rate" value={`${summary.win_rate_pct}%`} color={summary.win_rate_pct >= 50 ? 'text-success' : 'text-warning'} />
                <StatTile label="Wins / Losses" value={`${summary.wins}W / ${summary.losses}L`} color="text-foreground" />
                <StatTile label="Avg Return" value={summary.avg_return_pct != null ? `${summary.avg_return_pct > 0 ? '+' : ''}${summary.avg_return_pct}%` : '—'}
                  color={summary.avg_return_pct != null && summary.avg_return_pct > 0 ? 'text-success' : 'text-destructive'} />
                <StatTile label="Best Trade" value={summary.best_trade_pct != null ? `+${summary.best_trade_pct}%` : '—'} color="text-success" />
                <StatTile label="Total P&L" value={summary.total_pl_usdt != null ? `${summary.total_pl_usdt > 0 ? '+' : ''}$${summary.total_pl_usdt.toFixed(2)}` : '—'}
                  color={summary.total_pl_usdt != null && summary.total_pl_usdt >= 0 ? 'text-success' : 'text-destructive'} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* By AI Source */}
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Brain className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Win Rate by AI Source</h2>
            </div>
            {loading ? (
              <div className="space-y-2">{[1,2].map(i => <Skeleton key={i} className="h-16 w-full bg-muted" />)}</div>
            ) : byAI.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">No data yet</p>
              </div>
            ) : (
              <div className="space-y-3">
                {[openaiRow, groqRow].filter(Boolean).map((row) => row && (
                  <div key={row.ai_source} className="p-3 rounded-lg border border-border/50" style={{ background: 'hsl(var(--muted))' }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Bot className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs font-semibold capitalize text-foreground">{row.ai_source}</span>
                        <Badge variant="outline" className="text-[10px] border-border">{row.total} signals</Badge>
                      </div>
                      <span className={cn('text-sm font-bold font-mono', row.win_rate_pct >= 50 ? 'text-success' : 'text-warning')}>
                        {row.win_rate_pct}%
                      </span>
                    </div>
                    <BarRow label="Win Rate" value={row.win_rate_pct} max={100} color={row.win_rate_pct >= 50 ? 'text-success' : 'text-warning'} sub="%" />
                    <div className="mt-2 flex gap-4 text-[10px] text-muted-foreground">
                      <span>{row.wins}W / {row.losses}L</span>
                      {row.avg_return_pct != null && (
                        <span className={row.avg_return_pct >= 0 ? 'text-success' : 'text-destructive'}>
                          Avg: {row.avg_return_pct > 0 ? '+' : ''}{row.avg_return_pct}%
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {byAI.filter(r => r.ai_source !== 'openai' && r.ai_source !== 'gemini' && r.ai_source !== 'groq').map(row => (
                  <div key={row.ai_source} className="p-3 rounded-lg border border-border/50" style={{ background: 'hsl(var(--muted))' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold capitalize text-foreground">{row.ai_source}</span>
                      <span className={cn('text-sm font-bold font-mono', row.win_rate_pct >= 50 ? 'text-success' : 'text-warning')}>{row.win_rate_pct}%</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">{row.total} signals · {row.wins}W/{row.losses}L</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* By Confidence Range */}
        <Card className="border-border md:col-span-2" style={{ background: 'hsl(var(--card))' }}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Percent className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold font-['Space_Grotesk'] uppercase tracking-wide text-foreground">Win Rate by Confidence Range</h2>
            </div>
            {loading ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[1,2,3,4].map(i => <Skeleton key={i} className="h-20 w-full bg-muted" />)}
              </div>
            ) : byConf.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">No data yet</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {byConf.map((row) => (
                  <div key={row.confidence_range} className="p-3 rounded-lg border border-border/50" style={{ background: 'hsl(var(--muted))' }}>
                    <div className="text-[10px] text-muted-foreground uppercase">{row.confidence_range}</div>
                    <div className={cn('text-xl font-bold font-mono mt-1', row.win_rate_pct >= 60 ? 'text-success' : row.win_rate_pct >= 45 ? 'text-warning' : 'text-destructive')}>
                      {row.win_rate_pct}%
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{row.total} signals</div>
                    {row.avg_return_pct != null && (
                      <div className={cn('text-[10px] mt-0.5', row.avg_return_pct >= 0 ? 'text-success' : 'text-destructive')}>
                        Avg: {row.avg_return_pct > 0 ? '+' : ''}{row.avg_return_pct}%
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Rate-limit info */}
      {isRateLimited && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-warning">OpenAI Rate-Limited</p>
              <p className="text-xs text-muted-foreground mt-1">
                AI analysis is paused due to OpenAI rate limits. Local setups are still computed and available.
                Existing live signals are preserved — the pipeline does NOT write empty signals on AI failure.
                Groq fallback will be attempted on the next run.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
