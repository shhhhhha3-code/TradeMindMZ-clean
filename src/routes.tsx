import type { ReactNode } from 'react';
import DashboardPage from './pages/DashboardPage';
import AISignalsPage from './pages/AISignalsPage';
import ExchangeConnectionsPage from './pages/ExchangeConnectionsPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import PipelineDiagnosticsPage from './pages/PipelineDiagnosticsPage';
import AIPerformancePage from './pages/AIPerformancePage';
import MarketOverviewPage from './pages/MarketOverviewPage';
import TradeMindMainPage from './pages/TradeMindMainPage';

export interface RouteConfig {
  name: string;
  path: string;
  element: ReactNode;
  visible?: boolean;
  public?: boolean;
}

export const routes: RouteConfig[] = [
  { name: 'Login',                path: '/login',                element: <LoginPage />,                public: true },
  { name: 'Forgot Password',      path: '/forgot-password',      element: <ForgotPasswordPage />,        public: true },
  { name: 'Reset Password',       path: '/reset-password',       element: <ResetPasswordPage />,         public: true },
  { name: 'Dashboard',            path: '/',                     element: <TradeMindMainPage /> },
  { name: 'AI Signals',           path: '/ai-signals',           element: <AISignalsPage /> },
  { name: 'Exchange',             path: '/exchange',             element: <ExchangeConnectionsPage /> },
  { name: 'Settings',             path: '/settings',             element: <SettingsPage /> },
  { name: 'Pipeline Diagnostics', path: '/pipeline',             element: <PipelineDiagnosticsPage /> },
  { name: 'AI Performance',       path: '/ai-performance',       element: <AIPerformancePage /> },
  { name: 'Market Overview',      path: '/market',               element: <MarketOverviewPage /> },
];
