import React from 'react';
import TradeMindShell from '@/components/layouts/TradeMindShell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <TradeMindShell>{children}</TradeMindShell>;
}
