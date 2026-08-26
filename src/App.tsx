import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import IntersectObserver from '@/components/common/IntersectObserver';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/contexts/AuthContext';
import { TradingProvider } from '@/contexts/TradingContext';
import { RouteGuard } from '@/components/common/RouteGuard';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { routes } from './routes';

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <TradingProvider>
          <IntersectObserver />
          <ErrorBoundary>
            <Routes>
              {routes.map((route, index) => (
                <Route
                  key={index}
                  path={route.path}
                  element={
                    <ErrorBoundary inline={false} label={route.path}>
                      <RouteGuard route={route} />
                    </ErrorBoundary>
                  }
                />
              ))}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
          <Toaster richColors position="top-right" />
        </TradingProvider>
      </AuthProvider>
    </Router>
  );
};

export default App;
