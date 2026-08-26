import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import type { RouteConfig } from '@/routes';
import AppLayout from '@/components/layouts/AppLayout';

const PUBLIC_PATHS = new Set(['/login', '/forgot-password', '/reset-password']);

export function RouteGuard({ route }: { route: RouteConfig }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'var(--gradient-primary)' }}>
            <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 text-white" stroke="currentColor" strokeWidth={2}>
              <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-sm text-muted-foreground animate-pulse">Loading TradeMindMZ...</p>
        </div>
      </div>
    );
  }

  // Not logged in → go to login (unless it's a public route)
  if (!session && !route.public) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Already logged in → don't show login/register pages
  if (session && PUBLIC_PATHS.has(location.pathname)) {
    return <Navigate to="/" replace />;
  }

  // Public routes (login, forgot-pw, reset-pw) without layout
  if (route.public) {
    return <>{route.element}</>;
  }

  // Protected routes wrapped in the app layout
  return <AppLayout>{route.element}</AppLayout>;
}
