import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bot,
  Brain,
  ChevronRight,
  Clock3,
  LayoutDashboard,
  Link2,
  Menu,
  Settings,
  Terminal,
  Wallet,
  X,
  BrainCircuit,
} from 'lucide-react';
import { useTrading } from '@/contexts/TradingContext';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

type ShellProps = {
  children: React.ReactNode;
  onMobileClose?: () => void;
};

const PRIMARY_NAV = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/market', label: 'Trading', icon: Activity },
  { path: '/ai-signals', label: 'Signals', icon: BarChart3 },
  { path: '/exchange', label: 'Pionex', icon: Link2 },
  { path: '/settings', label: 'Settings', icon: Settings },
];

const SECONDARY_NAV = [
  { path: '/market', label: 'Market Overview', icon: Terminal },
  { path: '/ai-performance', label: 'AI Performance', icon: Brain },
  { path: '/pipeline', label: 'Diagnostics', icon: Clock3 },
];

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        active
          ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.8)]'
          : 'bg-slate-600'
      )}
    />
  );
}

function SidebarLink({
  path,
  label,
  icon: Icon,
  onClick,
}: {
  path: string;
  label: string;
  icon: React.ElementType;
  onClick?: () => void;
}) {
  const location = useLocation();
  const active = location.pathname === path;

  return (
    <Link
      to={path}
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
        active
          ? 'text-white shadow-[inset_2px_0_0_#6d63ff] bg-[linear-gradient(90deg,rgba(109,99,255,.22),rgba(109,99,255,.04))]'
          : 'text-slate-400 hover:bg-white/[.03] hover:text-slate-100'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      {active && <ChevronRight className="ml-auto h-3.5 w-3.5 text-emerald-300" />}
    </Link>
  );
}

export default function TradeMindShell({ children }: ShellProps) {
  const trading = useTrading();
  const { signOut, profile, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const live = Boolean(trading?.isPionexLive);
  const openPositions = Array.isArray(trading?.liveOrders)
    ? trading.liveOrders.filter((o: any) =>
        ['NEW', 'PARTIALLY_FILLED', 'OPEN'].includes(
          String(o?.status ?? '').toUpperCase()
        )
      ).length
    : 0;

  const signalCount = Array.isArray(trading?.liveSignals)
    ? trading.liveSignals.length
    : 0;

  const pageName =
    [...PRIMARY_NAV, ...SECONDARY_NAV].find(
      item => item.path === location.pathname
    )?.label ?? 'TradeMindMZ';

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const displayName =
    profile?.display_name ||
    profile?.username ||
    user?.email?.split('@')[0] ||
    'TradeMindMZ';

  return (
    <div className="matrix-shell min-h-screen w-full text-white">
      <div className="flex min-h-screen">
        <aside
          className={[
            'fixed inset-y-0 left-0 z-50 flex w-[250px] shrink-0 flex-col',
            'border-r border-emerald-400/10 bg-[#020805]/95 backdrop-blur-xl',
            'transform transition-transform duration-200 md:static md:z-auto md:flex md:translate-x-0',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          ].join(' ')}
        >
          <div className="flex min-h-screen flex-col p-4">
            <div className="mb-7 flex items-center gap-3 px-2">
              <img
                src="/assets/trademindmz-logo.svg"
                alt="TradeMindMZ"
                className="h-10 w-10 drop-shadow-[0_0_16px_rgba(109,99,255,.45)]"
              />
              <div className="min-w-0">
                <div className="font-['Space_Grotesk'] text-sm font-bold">
                  TRADE<span className="text-emerald-300">MIND</span>
                  <span className="text-emerald-400">MZ</span>
                </div>
                <div className="text-[8px] font-bold uppercase tracking-[.18em] text-slate-600">
                  AI-powered trading
                </div>
              </div>
            </div>

            <div className="mb-5 rounded-xl border border-white/[.07] bg-white/[.025] p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <StatusDot active={live} />
                  <span>Live Trading</span>
                </div>
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 text-[8px] font-bold',
                    live
                      ? 'bg-emerald-400/10 text-emerald-300'
                      : 'bg-slate-700/40 text-slate-400'
                  )}
                >
                  {live ? 'LIVE' : 'OFF'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[8px]">
                <div className="rounded-lg bg-black/10 p-2">
                  <span className="block text-slate-600">Positions</span>
                  <strong className="mt-1 block text-slate-200">{openPositions}</strong>
                </div>
                <div className="rounded-lg bg-black/10 p-2">
                  <span className="block text-slate-600">Signals</span>
                  <strong className="mt-1 block text-slate-200">{signalCount}</strong>
                </div>
              </div>
            </div>

            <nav className="space-y-1">
              {PRIMARY_NAV.map(item => (
                <SidebarLink
                  key={item.path}
                  {...item}
                  onClick={() => setMobileOpen(false)}
                />
              ))}
            </nav>

            <div className="mt-6 border-t border-white/[.06] pt-4">
              <div className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[.16em] text-slate-600">
                Analysis
              </div>
              <div className="space-y-1">
                {SECONDARY_NAV.map(item => (
                  <SidebarLink
                    key={item.path}
                    {...item}
                    onClick={() => setMobileOpen(false)}
                  />
                ))}
              </div>
            </div>

            <div className="mt-auto pt-4">
              <div className="rounded-xl border border-white/[.07] bg-white/[.02] p-3">
                <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold text-slate-200">
                  <Wallet className="h-3.5 w-3.5 text-emerald-300" />
                  System Status
                </div>

                <div className="space-y-2 text-[9px]">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-600">Pionex</span>
                    <span className="flex items-center gap-1 text-emerald-300">
                      <StatusDot active={trading?.marketDataStatus === 'live'} />
                      {String(trading?.marketDataStatus ?? 'unknown').toUpperCase()}
                    </span>
                  </div>

                  <div className="flex justify-between gap-2">
                    <span className="text-slate-600">Account</span>
                    <span className="text-slate-300">
                      {String(trading?.pionexAccountStatus ?? 'unknown').toUpperCase()}
                    </span>
                  </div>

                  <div className="flex justify-between gap-2">
                    <span className="text-slate-600">AI</span>
                    <span className="text-slate-300">
                      {trading?.aiAnalysisEnabled === false ? 'OFF / SERVER' : String(trading?.aiAnalysisStatus ?? 'idle').toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 px-2 text-[10px] text-slate-400">
                <div className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-400 font-bold text-white">
                  {displayName.slice(0, 2).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-slate-200">{displayName}</div>
                  <div className="truncate text-[8px] text-slate-600">
                    Premium
                  </div>
                </div>

                <button
                  onClick={handleSignOut}
                  className="text-[9px] text-slate-500 transition hover:text-white"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        </aside>

        {mobileOpen && (
          <button
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col bg-transparent">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-emerald-400/10 bg-[#020805]/80 px-3 backdrop-blur-xl md:px-6">
            <button
              onClick={() => setMobileOpen(value => !value)}
              className="grid h-9 w-9 place-items-center rounded-lg border border-white/[.08] bg-white/[.03] text-slate-400 md:hidden"
              aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            >
              {mobileOpen ? (
                <X className="h-4 w-4" />
              ) : (
                <Menu className="h-4 w-4" />
              )}
            </button>

            <div className="min-w-0 flex-1">
              <div className="text-[8px] font-bold uppercase tracking-[.18em] text-slate-600">
                TRADEMINDMZ / TERMINAL
              </div>
              <div className="mt-1 font-['Space_Grotesk'] text-lg font-bold md:text-xl">
                {pageName}
              </div>
            </div>

            <div className="hidden items-center gap-3 text-[8px] md:flex">
              <div className="flex items-center gap-1.5">
                <StatusDot active={trading?.marketDataStatus === 'live'} />
                <span className="text-slate-600">Pionex</span>
                <strong className="text-emerald-300">
                  {String(trading?.marketDataStatus ?? 'unknown').toUpperCase()}
                </strong>
              </div>

              <div className="h-4 w-px bg-white/[.08]" />

              <button
                type="button"
                onClick={() => trading?.setAiAnalysisEnabled?.(!trading?.aiAnalysisEnabled)}
                title={trading?.aiAnalysisEnabled === false ? 'Enable AI model analysis' : 'Disable AI model analysis and use server-only scoring'}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-semibold transition',
                  trading?.aiAnalysisEnabled === false
                    ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
                    : 'border-cyan-400/20 bg-cyan-400/5 text-cyan-300 hover:border-cyan-300/40'
                )}
              >
                <BrainCircuit className="h-3 w-3" />
                {trading?.aiAnalysisEnabled === false ? 'SERVER ONLY' : 'AI ON'}
              </button>

              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-300 shadow-[0_0_18px_rgba(45,255,150,.25)]" />
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6 md:py-6">
            {children}
          </main>

          <footer className="border-t border-white/[.06] px-4 py-2">
            <p className="text-center text-[8px] leading-relaxed text-slate-600">
              TradeMindMZ — AI market analysis. Data: Pionex. AI: OpenAI. Not financial advice.
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
