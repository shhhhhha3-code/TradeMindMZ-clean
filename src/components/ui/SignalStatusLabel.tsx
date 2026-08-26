/**
 * SignalStatusLabel — Single source of truth for all signal/setup status display.
 *
 * STRICT TERMINOLOGY RULES (never deviate):
 *
 *  SERVER_RECOMMENDED  = server_verdict === 'RECOMMENDED'
 *                        ⚠️  Server-only qualification. No AI review has occurred.
 *                        Label: "Server Qualified"  (NOT "AI Recommended", NOT "Recommended")
 *
 *  AI_REVIEWED         = sent_to_ai === true (in the AI batch this run)
 *                        ⚠️  Means the pair was submitted to AI — NOT that AI approved it.
 *                        Label: "Sent to AI"
 *
 *  AI_VERIFIED         = AI responded AND signal was created (ai_verified_count > 0)
 *                        Label: "AI Reviewed"  (NOT "AI Verified" — avoids implying AI endorsed it)
 *
 *  AI_RECOMMENDED      = AI responded AND server_verdict === RECOMMENDED for a signal
 *                        = The only state that earns a green "AI Recommended" label.
 *                        Label: "AI Recommended"
 *
 *  WATCH               = server_verdict === 'WATCH'
 *                        Label: "Watch"
 *
 *  NO_TRADE            = server_verdict === 'NO_TRADE'
 *                        Label: "No Trade"
 *
 *  RR_INELIGIBLE       = estimated_rr < RR_MIN_THRESHOLD
 *                        Label: "Not Eligible (RR)"  — shown regardless of local_score
 *
 * KEY INVARIANT:
 *   When AI is rate-limited (ai_verified_count === 0), no signal may show "AI Recommended".
 *   Server-qualified setups show "Server Qualified" only.
 */

import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, Bot, Eye, XCircle, ShieldAlert, Clock } from 'lucide-react';

/** Minimum RR for a setup to be considered trading-eligible */
export const RR_MIN_THRESHOLD = 1.5;

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalStatusVariant =
  | 'ai-recommended'      // AI responded + server_verdict = RECOMMENDED
  | 'server-qualified'    // server_verdict = RECOMMENDED but AI rate-limited / not yet reviewed
  | 'ai-reviewed'         // AI responded (signal created), verdict not RECOMMENDED
  | 'sent-to-ai'          // in AI batch this run (sent_to_ai=true) but no AI response yet
  | 'watch'               // server_verdict = WATCH
  | 'no-trade'            // server_verdict = NO_TRADE
  | 'local-only'          // local setup, not sent to AI
  | 'rr-ineligible'       // RR < threshold (regardless of score)
  | 'rate-limited';       // AI unavailable this run

interface SignalStatusLabelProps {
  variant: SignalStatusVariant;
  className?: string;
  showIcon?: boolean;
  size?: 'sm' | 'xs';
}

const CONFIG: Record<SignalStatusVariant, {
  label: string;
  tooltip: string;
  icon: React.ElementType;
  classes: string;
}> = {
  'ai-recommended': {
    label: 'AI Recommended',
    tooltip: 'AI reviewed this setup and the server confirmed it passes all gates. Eligible for Auto Trader.',
    icon: CheckCircle2,
    classes: 'border-success/40 bg-success/10 text-success',
  },
  'server-qualified': {
    label: 'Server Qualified',
    tooltip: 'Server scoring passed all gates — but AI has NOT reviewed this setup yet (rate-limited or not in AI batch). Not an AI recommendation.',
    icon: ShieldAlert,
    classes: 'border-warning/40 bg-warning/10 text-warning',
  },
  'ai-reviewed': {
    label: 'AI Reviewed',
    tooltip: 'AI reviewed this setup. Verdict: Watch or No Trade. Not recommended for trading.',
    icon: Eye,
    classes: 'border-primary/30 bg-primary/5 text-primary',
  },
  'sent-to-ai': {
    label: 'Sent to AI',
    tooltip: 'This setup was submitted to AI this run. AI response pending or unavailable.',
    icon: Bot,
    classes: 'border-primary/25 bg-primary/5 text-primary',
  },
  'watch': {
    label: 'Watch',
    tooltip: 'Server scoring: Watch — monitor but do not trade.',
    icon: Clock,
    classes: 'border-warning/30 bg-warning/5 text-warning',
  },
  'no-trade': {
    label: 'No Trade',
    tooltip: 'Server scoring: No Trade — does not meet qualification gates.',
    icon: XCircle,
    classes: 'border-destructive/30 bg-destructive/5 text-destructive',
  },
  'local-only': {
    label: 'Local Setup',
    tooltip: 'Local analysis only — not yet scored by the server or reviewed by AI. Not a trading signal.',
    icon: Bot,
    classes: 'border-border bg-muted/50 text-muted-foreground',
  },
  'rr-ineligible': {
    label: `Not Eligible (RR < ${RR_MIN_THRESHOLD})`,
    tooltip: `Risk/Reward ratio is below the required ${RR_MIN_THRESHOLD}. This setup cannot be traded regardless of its local score.`,
    icon: AlertTriangle,
    classes: 'border-destructive/40 bg-destructive/5 text-destructive',
  },
  'rate-limited': {
    label: 'AI Rate-Limited',
    tooltip: 'AI is unavailable this run due to rate limits. Server-qualified setups are shown but have NOT been AI-reviewed.',
    icon: AlertTriangle,
    classes: 'border-warning/40 bg-warning/10 text-warning',
  },
};

export function SignalStatusLabel({ variant, className, showIcon = true, size = 'xs' }: SignalStatusLabelProps) {
  const cfg = CONFIG[variant];
  const Icon = cfg.icon;
  const textSize = size === 'xs' ? 'text-[10px]' : 'text-xs';
  const iconSize = size === 'xs' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const px = size === 'xs' ? 'px-1.5 py-0.5' : 'px-2 py-0.5';

  return (
    <span
      title={cfg.tooltip}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-semibold leading-tight',
        textSize, px, cfg.classes, className
      )}
    >
      {showIcon && <Icon className={cn('shrink-0', iconSize)} />}
      {cfg.label}
    </span>
  );
}

// ─── RR Eligibility Block ─────────────────────────────────────────────────────

interface RREligibilityProps {
  estimatedRr: number | null | undefined;
  localScore?: number | null;
  className?: string;
}

/**
 * Shows an explicit trading eligibility status based on RR.
 * A high local score DOES NOT imply trading eligibility.
 */
export function RREligibility({ estimatedRr, localScore, className }: RREligibilityProps) {
  const rr = estimatedRr ?? 0;
  const eligible = rr >= RR_MIN_THRESHOLD;

  return (
    <div className={cn(
      'rounded-lg border p-2.5 text-xs',
      eligible
        ? 'border-success/25 bg-success/5'
        : 'border-destructive/25 bg-destructive/5',
      className
    )}>
      <div className="flex items-start gap-2">
        {eligible
          ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
          : <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
        }
        <div className="min-w-0">
          <div className={cn('font-bold', eligible ? 'text-success' : 'text-destructive')}>
            TRADING ELIGIBILITY: {eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}
          </div>
          <div className="text-muted-foreground mt-0.5 space-y-0.5">
            <div>RR: <span className={cn('font-mono font-semibold', eligible ? 'text-success' : 'text-destructive')}>{rr.toFixed(2)}</span> (required ≥ {RR_MIN_THRESHOLD})</div>
            {!eligible && (
              <div className="text-destructive/80">
                Reason: RR {rr.toFixed(2)} is below required {RR_MIN_THRESHOLD}
                {localScore != null && localScore >= 70 && (
                  <span className="block text-muted-foreground mt-0.5">
                    ⚠ High local score ({localScore}/100) does not override RR requirement.
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AI Rate-Limit Banner ─────────────────────────────────────────────────────

interface RateLimitBannerProps { className?: string }

/**
 * Shown whenever AI is rate-limited.
 * Prevents any server-qualified setup from appearing AI-confirmed.
 */
export function RateLimitBanner({ className }: RateLimitBannerProps) {
  return (
    <div className={cn(
      'flex items-start gap-2.5 p-3 rounded-lg border border-warning/30 bg-warning/5',
      className
    )}>
      <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-warning">AI Rate-Limited This Run</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
          Setups marked <span className="font-semibold text-warning">Server Qualified</span> have
          passed the server scoring gates but have <span className="font-semibold">NOT been reviewed by AI</span>.
          They are <span className="font-semibold">not AI recommendations</span>.
          Local setups are still shown. AI will review on the next successful run.
        </p>
      </div>
    </div>
  );
}

// ─── Helper: derive variant from a LocalSetup ─────────────────────────────────

interface LocalSetupLike {
  server_verdict: 'RECOMMENDED' | 'WATCH' | 'NO_TRADE';
  sent_to_ai: boolean;
  estimated_rr: number;
}

/**
 * Derives the correct SignalStatusVariant for a LocalSetup.
 * @param setup  The local setup object
 * @param aiAvailable  Whether AI ran successfully this run (ai_verified_count > 0)
 */
export function localSetupVariant(setup: LocalSetupLike, aiAvailable: boolean): SignalStatusVariant {
  if (setup.estimated_rr < RR_MIN_THRESHOLD) return 'rr-ineligible';
  if (setup.server_verdict === 'NO_TRADE') return 'no-trade';
  if (setup.server_verdict === 'WATCH') return 'watch';
  // RECOMMENDED path
  if (setup.server_verdict === 'RECOMMENDED') {
    if (!aiAvailable) return 'server-qualified';  // AI didn't run — must not say "AI Recommended"
    if (setup.sent_to_ai) return 'ai-recommended'; // AI ran AND this was in the batch AND server approved
    return 'server-qualified'; // Server approved but wasn't in AI batch
  }
  if (setup.sent_to_ai) return 'sent-to-ai';
  return 'local-only';
}

// ─── Helper: derive variant for an AISignal (full signal from cache) ──────────

interface AISignalLike {
  server_verdict?: 'RECOMMENDED' | 'WATCH' | 'NO_TRADE' | null;
  ai_source?: string | null;
  risk_reward?: string | null;
}

/**
 * Derives the correct SignalStatusVariant for a full AISignal (in liveSignals).
 * A signal in liveSignals was ALREADY reviewed by AI (it was created by AI).
 * The only distinction is whether AI endorsed it (server_verdict = RECOMMENDED).
 */
export function aiSignalVariant(signal: AISignalLike, aiAvailable: boolean): SignalStatusVariant {
  const rr = parseFloat(signal.risk_reward ?? '0');
  if (!isNaN(rr) && rr < RR_MIN_THRESHOLD) return 'rr-ineligible';

  if (!aiAvailable) {
    // Existing signals preserved from a previous run — may have server_verdict but AI didn't run this run
    if (signal.server_verdict === 'RECOMMENDED') return 'server-qualified';
    if (signal.server_verdict === 'WATCH') return 'watch';
    return 'ai-reviewed';
  }

  if (signal.server_verdict === 'RECOMMENDED') return 'ai-recommended';
  if (signal.server_verdict === 'WATCH') return 'watch';
  if (signal.server_verdict === 'NO_TRADE') return 'no-trade';
  // Signal exists (AI created it), no server_verdict — AI reviewed but not categorized
  return 'ai-reviewed';
}
