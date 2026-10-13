import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, onAuthLost } from './api';
import { AppProvider, type Me } from './state';
import { AuthScreen, type AuthState } from './pages/Login';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { StockIn } from './pages/StockIn';
import { Billing } from './pages/Billing';
import { Bills } from './pages/Bills';
import { Ledger } from './pages/Ledger';
import { Reports } from './pages/Reports';
import { Review } from './pages/Review';
import { Rates } from './pages/Rates';
import { UsersPage } from './pages/Users';
import { SettingsPage } from './pages/Settings';
import { ImportPage } from './pages/Import';
import { Losses } from './pages/Losses';

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const load = useCallback(async () => {
    try {
      setAuth(await api.get<AuthState>('/api/auth/state'));
    } catch {
      setAuth(null);
      setTimeout(load, 3000);
    }
  }, []);
  useEffect(() => {
    load();
    return onAuthLost(() => load());
  }, [load]);

  if (!auth) return <div className="auth-page"><div className="muted">Loading Commercia…</div></div>;
  if (auth.step !== 'done' || !auth.me) return <AuthScreen state={auth} onDone={load} />;

  return (
    <BrowserRouter>
      <AppProvider me={auth.me as Me} onLogout={load}>
        <Layout shopName={auth.shop.name}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/stock-in" element={<StockIn />} />
            <Route path="/losses" element={<Losses />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/bills" element={<Bills />} />
            <Route path="/bills/:id" element={<Bills />} />
            <Route path="/ledger" element={<Ledger />} />
            <Route path="/ledger/:id" element={<Ledger />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/review" element={<Review />} />
            <Route path="/rates" element={<Rates />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Layout>
      </AppProvider>
    </BrowserRouter>
  );
}
