/**
 * LivePositionsSection — READ-ONLY Pionex USDT-M futures position viewer.
 *
 * Design contract:
 *  - Matches existing TradeMindMZ dark/purple card style.
 *  - Never calls create/modify/close endpoints — purely GET /uapi/v1/account/positions.
 *  - Gracefully handles empty state, loading, API errors.
 *  - Structured for future AI signal linkage (ai_signal_id field reserved in type).
 */
import { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, TrendingUp, TrendingDown, Activity, AlertTriangle, Bug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/db/supabase';
import type { PionexPosition } from '@/types/types';
import { formatDistanceToNow } from 'date-fns';

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null, decimals = 5): string {
  if (v === null || isNaN(v)) return '—';
  const d = v < 0.01 ? 6 : v < 1 ? 5 : v < 100 ? 4 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(decimals, d), maximumFractionDigits: Math.max(decimals, d) });
}

function fmtQty(v: number): string {
  if (!isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : v < 1000 ? 4 : 2 });
}

function fmtPct(v: number | null): string {
  if (v === null || isNaN(v)) return '';
  const pct = v * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function fmtPnl(v: number | null): string {
  if (v === null || isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(4)} USDT`;
}

// ─── Diag result type ─────────────────────────────────────────────────────────

interface DiagResult {
  endpoint: string;
  http_status: number;
  result: boolean | null;
  code: string | null;
  message: string | null;
  timestamp: number | null;
  data: unknown;
  top_level_keys: string[];
  positionCount: number;
  // Raw positions with ALL fields as returned by Pionex
  rawPositions: Record<string, unknown>[];
  // Keys on the first position object — shows actual Pionex field names
  positionKeys: string[];
  error?: string;
}

// ─── Diag panel component ─────────────────────────────────────────────────────

function DiagPanel({ diag, onClose }: { diag: DiagResult; onClose: () => void }) {
  const hasError = !!diag.error;
  const apiOkay  = !hasError && diag.result === true;
  const apiFailed = !hasError && diag.result === false;

  const Row = ({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) => (
    <div className="flex items-start gap-2 min-w-0">
      <span className="text-[10px] text-muted-foreground w-32 shrink-0">{label}</span>
      <span className={cn('text-[11px] font-mono break-all', valueClass ?? 'text-foreground')}>{value}</span>
    </div>
  );

  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
          <Bug className="w-3 h-3 text-primary" />
          Position API Diagnostics
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-[11px] px-1">✕</button>
      </div>

      <div className="border-t border-border/50 pt-2 space-y-1.5">
        {hasError && (
          <div className="flex items-start gap-1.5 p-2 rounded border border-destructive/30 bg-destructive/10">
            <AlertTriangle className="w-3 h-3 text-destructive shrink-0 mt-0.5" />
            <span className="text-destructive font-mono break-all">{diag.error}</span>
          </div>
        )}
        {!hasError && (
          <>
            <Row label="HTTP Status" value={String(diag.http_status)}
              valueClass={diag.http_status === 200 ? 'text-positive font-mono' : 'text-destructive font-mono'} />
            <Row label="Pionex result" value={diag.result === true ? 'true ✓' : diag.result === false ? 'false ✗' : 'null'}
              valueClass={diag.result === true ? 'text-positive font-mono' : 'text-destructive font-mono'} />
            <Row label="Pionex code"    value={diag.code ?? '—'} />
            <Row label="Pionex message" value={diag.message ?? '—'}
              valueClass={apiFailed ? 'text-destructive font-mono' : 'text-foreground font-mono'} />
            <Row label="Positions returned" value={String(diag.positionCount)}
              valueClass={diag.positionCount > 0 ? 'text-positive font-mono' : 'text-muted-foreground font-mono'} />
          </>
        )}
      </div>

      {/* Per-position raw data — shows ALL fields Pionex returned */}
      {diag.rawPositions.length > 0 && (
        <div className="border-t border-border/50 pt-2 space-y-2">
          {diag.rawPositions.map((p, i) => (
            <div key={i} className="space-y-1">
              {i > 0 && <div className="border-t border-border/30" />}
              {/* Show every field Pionex returned on this position */}
              {Object.entries(p).map(([k, v]) => (
                <Row key={k} label={k}
                  value={v === null || v === undefined ? '—' : String(v)}
                  valueClass={k === 'positionSide' || k === 'side'
                    ? 'text-primary font-mono'
                    : (k === 'symbol' || k === 'pair' || k === 'contract')
                    ? 'text-primary font-mono'
                    : 'text-foreground font-mono'} />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Position field names — shows what Pionex actually uses for quantity */}
      {diag.positionKeys.length > 0 && (
        <div className="border-t border-border/50 pt-2">
          <div className="text-[10px] text-muted-foreground mb-1">Feltnavner på posisjon:</div>
          <div className="font-mono text-[10px] text-foreground break-all">
            {diag.positionKeys.join(' · ')}
          </div>
        </div>
      )}

      <div className="border-t border-border/50 pt-2">
        {hasError && (
          <p className="text-[10px] text-destructive">⚠ Tilstandstype 3: API-request feilet (nettverk/EF-feil)</p>
        )}
        {!hasError && apiOkay && diag.positionCount === 0 && (
          <p className="text-[10px] text-muted-foreground">ℹ Tilstandstype 1: API OK — 0 posisjoner returnert</p>
        )}
        {!hasError && apiOkay && diag.positionCount > 0 && (
          <p className="text-[10px] text-positive">✓ Tilstandstype 2: API OK — {diag.positionCount} posisjon(er) returnert</p>
        )}
        {!hasError && apiFailed && (
          <p className="text-[10px] text-destructive">⚠ Tilstandstype 3: API-feil — Pionex returnerte result:false</p>
        )}
      </div>
    </div>
  );
}

// ─── Single position card ─────────────────────────────────────────────────────

function PositionCard({ pos }: { pos: PionexPosition }) {
  const isProfit = (pos.unrealized_pnl ?? 0) >= 0;
  const pnlColor = isProfit ? 'text-positive' : 'text-negative';

  return (
    <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground leading-snug truncate">
              {pos.symbol}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
            <Badge
              variant="outline"
              className={cn(
                'text-[11px] font-bold px-2 py-0.5 flex items-center gap-1',
                pos.side === 'LONG'
                  ? 'border-positive/40 text-positive bg-positive/10'
                  : 'border-negative/40 text-negative bg-negative/10',
              )}
            >
              {pos.side === 'LONG'
                ? <TrendingUp className="w-3 h-3" />
                : <TrendingDown className="w-3 h-3" />}
              {pos.side}
            </Badge>
            <Badge variant="outline" className="text-[10px] text-muted-foreground border-border px-1.5 py-0.5">
              {pos.margin_mode}
            </Badge>
            <Badge variant="outline" className="text-[10px] text-muted-foreground border-border px-1.5 py-0.5">
              {pos.leverage}x
            </Badge>
          </div>
        </div>

        <div className={cn('flex items-center gap-2 p-2 rounded-md border', isProfit ? 'border-positive/20 bg-positive/5' : 'border-negative/20 bg-negative/5')}>
          {isProfit
            ? <TrendingUp className="w-4 h-4 text-positive shrink-0" />
            : <TrendingDown className="w-4 h-4 text-negative shrink-0" />}
          <div className="min-w-0">
            <div className={cn('text-sm font-bold leading-snug', pnlColor)}>
              {fmtPnl(pos.unrealized_pnl)}
              {pos.unrealized_pnl_pct != null && (
                <span className="ml-1.5 text-xs font-medium">({fmtPct(pos.unrealized_pnl_pct)})</span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground">Unrealized PnL</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <PositionField label="Quantity"         value={`${pos.side === 'SHORT' ? '-' : ''}${fmtQty(pos.quantity)}`} />
          <PositionField label="Avg. Price"       value={`${fmtPrice(pos.avg_price)} USDT`} />
          <PositionField label="Mark Price"       value={pos.mark_price != null ? `${fmtPrice(pos.mark_price)} USDT` : '—'} />
          <PositionField label="Position Value"   value={pos.position_value != null ? `${pos.position_value.toFixed(2)} USDT` : '—'} />
          <PositionField label="Occupied Margin"  value={pos.occupied_margin != null ? `${pos.occupied_margin.toFixed(2)} USDT` : '—'} />
          <PositionField label="Liquidation Price"
            value={pos.liquidation_price != null ? `${fmtPrice(pos.liquidation_price)} USDT` : '—'}
            valueClass="text-destructive/80 font-medium" />
          <PositionField label="Leverage"         value={`${pos.leverage}x`} />
          <PositionField label="Margin Mode"      value={pos.margin_mode} />
        </div>
      </CardContent>
    </Card>
  );
}

function PositionField({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
      <div className={cn('font-medium text-foreground truncate', valueClass)}>{value}</div>
    </div>
  );
}

// ─── Main section ──────────────────────────────────────────────────────────────

interface LivePositionsSectionProps {
  initialPositions?: PionexPosition[];
  initialApiOk?: boolean;
  onSynced?: (positions: PionexPosition[]) => void;
}

export default function LivePositionsSection({ initialPositions, initialApiOk, onSynced }: LivePositionsSectionProps) {
  const [positions, setPositions]       = useState<PionexPosition[]>(initialPositions ?? []);
  const [loading, setLoading]           = useState(!initialPositions && initialApiOk === undefined);
  const [apiOk, setApiOk]               = useState<boolean | null>(initialApiOk ?? null);
  const [apiError, setApiError]         = useState<string | null>(null);
  const [lastSync, setLastSync]         = useState<Date | null>(initialPositions ? new Date() : null);
  const [diagResult, setDiagResult]     = useState<DiagResult | null>(null);
  const [diagLoading, setDiagLoading]   = useState(false);

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('pionex-proxy', {
        method: 'POST',
        body: { action: 'positions' },
      });
      if (fnErr) {
        const text = await fnErr.context?.text?.().catch(() => '');
        let parsed = fnErr.message;
        try { parsed = JSON.parse(text).error ?? text; } catch { parsed = text || fnErr.message; }
        throw new Error(parsed);
      }
      if (data?.positions_api_ok === false || data?.positions_api_error) {
        setApiOk(false);
        setApiError(data?.positions_api_error ?? 'Ukjent API-feil');
        setPositions([]);
      } else {
        setApiOk(true);
        setApiError(null);
        setPositions(Array.isArray(data?.positions) ? data.positions : []);
        // Auto-populate diag with raw fields from normal fetch — no separate diag call needed
        if (Array.isArray(data?._raw_positions) && data._raw_positions.length > 0) {
          const rawArr = data._raw_positions as Record<string, unknown>[];
          setDiagResult({
            endpoint: '/uapi/v1/account/positions', http_status: 200,
            result: true, code: null, message: null, timestamp: null,
            data: null, top_level_keys: [],
            positionCount: rawArr.length,
            rawPositions: rawArr,
            positionKeys: Object.keys(rawArr[0]),
          });
        }
      }
      setLastSync(new Date());
      onSynced?.(data?.positions ?? []);
    } catch (e) {
      setApiOk(false);
      setApiError(e instanceof Error ? e.message : 'Klarte ikke å hente posisjoner');
    } finally {
      setLoading(false);
    }
  }, [onSynced]);

  // Diag: calls diag_positions EF action and shows raw Pionex response directly in the card
  const runDiag = useCallback(async () => {
    setDiagLoading(true);
    setDiagResult(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('pionex-proxy', {
        method: 'POST',
        body: { action: 'diag_positions' },
      });
      if (fnErr) {
        const text = await fnErr.context?.text?.().catch(() => '');
        let errMsg = fnErr.message;
        try { const p = JSON.parse(text); errMsg = p.error ?? p.message ?? text; } catch { errMsg = text || fnErr.message; }
        setDiagResult({
          endpoint: '/uapi/v1/account/positions', http_status: 0,
          result: null, code: null, message: null, timestamp: null,
          data: null, top_level_keys: [], positionCount: 0,
          rawPositions: [], positionKeys: [],
          error: errMsg,
        });
        return;
      }
      // Extract raw positions from every known Pionex envelope shape
      setDiagResult({
        endpoint:       data?.endpoint ?? '/uapi/v1/account/positions',
        http_status:    data?.http_status ?? 0,
        result:         data?.result ?? null,
        code:           data?.code ?? null,
        message:        data?.message ?? null,
        timestamp:      data?.timestamp ?? null,
        data:           null,
        top_level_keys: data?.top_level_keys ?? [],
        positionCount:  data?.position_count ?? 0,
        // raw_positions contains every field Pionex returned — no pre-filtering
        rawPositions:   Array.isArray(data?.raw_positions) ? data.raw_positions : [],
        positionKeys:   Array.isArray(data?.position_keys) ? data.position_keys : [],
      });
    } catch (e) {
      setDiagResult({
        endpoint: '/uapi/v1/account/positions', http_status: 0,
        result: null, code: null, message: null, timestamp: null,
        data: null, top_level_keys: [], positionCount: 0,
        rawPositions: [], positionKeys: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDiagLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialPositions) fetchPositions();
  }, [fetchPositions, initialPositions]);

  const headerRight = (
    <div className="flex items-center gap-2 flex-wrap">
      {lastSync && (
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
          Sist oppdatert: {formatDistanceToNow(lastSync, { addSuffix: true })}
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={runDiag} disabled={diagLoading}
        className="gap-1 text-xs h-7 px-2 text-muted-foreground hover:text-foreground">
        <Bug className={cn('w-3 h-3', diagLoading && 'animate-spin')} />
        Diag
      </Button>
      <Button variant="outline" size="sm" onClick={fetchPositions} disabled={loading}
        className="gap-1.5 text-xs h-7 px-2">
        <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        Oppdater
      </Button>
    </div>
  );

  return (
    <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Live Positions
            {!loading && positions.length > 0 && (
              <span className="text-[11px] font-normal text-muted-foreground">({positions.length})</span>
            )}
          </CardTitle>
          {headerRight}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Diag panel — renders inline when runDiag completes, no DevTools needed */}
        {diagResult && (
          <DiagPanel diag={diagResult} onClose={() => setDiagResult(null)} />
        )}

        {/* API error banner */}
        {!loading && apiOk === false && apiError && (
          <div className="flex items-start gap-2 p-2.5 rounded-md border border-destructive/20 bg-destructive/5 text-xs text-destructive">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Kunne ikke hente live posisjoner: {apiError}</span>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-2">
            {[1, 2].map(i => (
              <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {/* Empty state — only when API responded with 0 positions */}
        {!loading && apiOk === true && positions.length === 0 && (
          <div className="py-6 flex flex-col items-center gap-2 text-center">
            <Activity className="w-8 h-8 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">Ingen aktive posisjoner</p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              Din Pionex-konto har for øyeblikket ingen åpne USDT-M futures-posisjoner.
            </p>
          </div>
        )}

        {/* Position cards */}
        {!loading && positions.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {positions.map((pos, i) => (
              <PositionCard key={`${pos.symbol}-${pos.side}-${i}`} pos={pos} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
