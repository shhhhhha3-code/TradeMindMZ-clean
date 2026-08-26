import { cn } from '@/lib/utils';
import type { SignalType, RiskLevel } from '@/types/types';

// ─── Confidence Ring ─────────────────────────────────────────────────────────
export function ConfidenceRing({ value, size = 80 }: { value: number; size?: number }) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  const color = value >= 75 ? 'hsl(var(--success))' : value >= 50 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))';

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke="hsl(var(--border))" strokeWidth={6} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={6} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          className="confidence-ring" />
      </svg>
      <div className="absolute text-center">
        <div className="text-lg font-bold font-['Space_Grotesk'] leading-none" style={{ color }}>{value}</div>
        <div className="text-xs text-muted-foreground leading-none mt-0.5">/100</div>
      </div>
    </div>
  );
}

// ─── Signal Badge ─────────────────────────────────────────────────────────────
export function SignalBadge({ type, size = 'sm' }: { type: SignalType; size?: 'sm' | 'lg' }) {
  const classes = {
    BUY: 'signal-buy',
    SELL: 'signal-sell',
    HOLD: 'signal-hold',
    WAIT: 'signal-wait',
  }[type];

  return (
    <span className={cn(
      'inline-flex items-center font-bold rounded-md tracking-wide',
      size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs',
      classes
    )}>
      {type === 'BUY' ? '▲ BUY' : type === 'SELL' ? '▼ SELL' : type}
    </span>
  );
}

// ─── Risk Badge ───────────────────────────────────────────────────────────────
export function RiskBadge({ level }: { level: RiskLevel }) {
  const classes = {
    Low: 'text-success border-success/30 bg-success/10',
    Medium: 'text-warning border-warning/30 bg-warning/10',
    High: 'text-destructive border-destructive/30 bg-destructive/10',
  }[level];
  return (
    <span className={cn('inline-flex items-center text-xs font-medium px-2 py-0.5 rounded border', classes)}>
      {level}
    </span>
  );
}

// ─── PnL Display ─────────────────────────────────────────────────────────────
export function PnLValue({ value, suffix = ' USDT', showSign = true }: { value: number; suffix?: string; showSign?: boolean }) {
  const positive = value >= 0;
  return (
    <span className={positive ? 'text-positive' : 'text-negative'}>
      {showSign && (positive ? '+' : '')}{value.toFixed(2)}{suffix}
    </span>
  );
}

export function PnLPct({ value }: { value: number }) {
  const positive = value >= 0;
  return (
    <span className={cn('text-xs font-medium', positive ? 'text-positive' : 'text-negative')}>
      {positive ? '+' : ''}{value.toFixed(2)}%
    </span>
  );
}

// ─── Sparkline ────────────────────────────────────────────────────────────────
export function Sparkline({ data, positive = true, width = 80, height = 32 }: {
  data: number[]; positive?: boolean; width?: number; height?: number;
}) {
  if (!data || data.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');
  const color = positive ? 'hsl(var(--success))' : 'hsl(var(--destructive))';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-xl border border-border bg-card p-4', className)}>
      <div className="h-4 bg-muted rounded w-1/3 mb-3" />
      <div className="h-8 bg-muted rounded w-2/3 mb-2" />
      <div className="h-3 bg-muted rounded w-1/2" />
    </div>
  );
}

// ─── Stat Row ─────────────────────────────────────────────────────────────────
export function StatRow({ label, value, valueClass = '' }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-xs font-medium text-foreground', valueClass)}>{value}</span>
    </div>
  );
}

// ─── Coin Logo Placeholder ────────────────────────────────────────────────────
const COIN_COLORS: Record<string, string> = {
  BTC: '#F7931A', ETH: '#627EEA', SOL: '#9945FF', BNB: '#F3BA2F',
  XRP: '#0085C0', ADA: '#0033AD', DOGE: '#C2A633', DOT: '#E6007A',
};

export function CoinLogo({ symbol, size = 32 }: { symbol?: string; size?: number }) {
  const sym = symbol ?? '';
  const color = COIN_COLORS[sym] ?? '#7C3AED';
  return (
    <div className="rounded-full flex items-center justify-center shrink-0 font-bold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.3 }}>
      {sym.slice(0, 1)}
    </div>
  );
}

// ─── Status Pill ──────────────────────────────────────────────────────────────
export function StatusPill({ connected }: { connected: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border',
      connected
        ? 'text-success border-success/30 bg-success/10'
        : 'text-muted-foreground border-border bg-muted'
    )}>
      <span className={connected ? 'status-dot-live' : 'status-dot-error'} />
      {connected ? 'Connected' : 'Not Connected'}
    </span>
  );
}

// ─── Demo Balance Badge ───────────────────────────────────────────────────────
export function DemoBadge() {
  return (
    <span className="demo-badge">
      <span className="status-dot-warning" />
      DEMO · SIMULATED FUNDS
    </span>
  );
}
