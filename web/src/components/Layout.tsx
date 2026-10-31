import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutGrid, Package, PackagePlus, ReceiptText, BookOpen, BarChart3, Users, Settings, Menu, Search, Sun, Moon,
  ClipboardCheck, Tags, FileSpreadsheet, FileText, LogOut, TriangleAlert, ShieldAlert,
} from 'lucide-react';
import { useApp } from '../state';
import { Avatar, Seg } from './ui';
import { ROLE_LABEL } from '../../../shared/perms';
import type { Permission } from '../../../shared/perms';
import { productStock } from '../format';

interface NavItem {
  to: string;
  en: string;
  icon: ReactNode;
  perm?: Permission;
  badge?: 'rates' | 'review';
}

const NAV: NavItem[] = [
  { to: '/', en: 'Dashboard', icon: <LayoutGrid size={18} /> },
  { to: '/inventory', en: 'Inventory', icon: <Package size={18} /> },
  { to: '/stock-in', en: 'Stock In', icon: <PackagePlus size={18} />, perm: 'stock.in' },
  { to: '/billing', en: 'Billing', icon: <ReceiptText size={18} />, perm: 'bill.create' },
  { to: '/bills', en: 'Bills', icon: <FileText size={18} /> },
  { to: '/ledger', en: 'Ledger', icon: <BookOpen size={18} /> },
  { to: '/rates', en: 'Rates', icon: <Tags size={18} />, badge: 'rates' },
  { to: '/reports', en: 'Reports', icon: <BarChart3 size={18} />, perm: 'daybook.view' },
  { to: '/losses', en: 'Losses', icon: <TriangleAlert size={18} />, perm: 'loss.report' },
  { to: '/review', en: 'Review', icon: <ClipboardCheck size={18} />, perm: 'review.view', badge: 'review' },
  { to: '/import', en: 'Import', icon: <FileSpreadsheet size={18} />, perm: 'import.stock' },
  { to: '/users', en: 'Users', icon: <Users size={18} />, perm: 'users.manage' },
  { to: '/security', en: 'Security', icon: <ShieldAlert size={18} />, perm: 'security.view' },
  { to: '/settings', en: 'Settings', icon: <Settings size={18} /> },
];

const TITLES: Record<string, string> = {
  '/': 'Dashboard', '/inventory': 'Inventory', '/stock-in': 'Stock In', '/billing': 'New Bill', '/bills': 'Bills', '/ledger': 'Ledger',
  '/reports': 'Reports', '/review': 'Review', '/rates': 'Update rates', '/users': 'Users & Activity', '/security': 'Security', '/settings': 'Settings', '/import': 'Import', '/losses': 'Losses',
};

export function Layout({ shopName, children }: { shopName: string; children: ReactNode }) {
  const { me, t, sub, lang, setLang, theme, setTheme, can, counts, settings, logout } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const base = '/' + (loc.pathname.split('/')[1] ?? '');
  const title = TITLES[base] ?? 'Commercia';

  useEffect(() => setOpen(false), [loc.pathname]);

  // Keyboard shortcuts from the dashboard: F2 new bill, F3 stock in, F4 receive payment, F5 add product.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2' && can('bill.create')) { e.preventDefault(); nav('/billing'); }
      else if (e.key === 'F3' && can('stock.in')) { e.preventDefault(); nav('/stock-in'); }
      else if (e.key === 'F4') { e.preventDefault(); nav('/ledger?pay=1'); }
      else if (e.key === 'F5' && can('catalog.add')) { e.preventDefault(); nav('/inventory?add=1'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [nav, can]);

  const today = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const gstReg = settings?.shop_gstin ? 'GST registered' : '';

  return (
    <div className="shell">
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar no-print ${open ? 'open' : ''}`}>
        <div className="brand">
          <span className="logo"><i /><i /><i /><i /></span> Commercia
        </div>
        <div className="shop-card">
          <b>{lang === 'hi' && settings?.shop_name_hi ? settings.shop_name_hi : (settings?.shop_name ?? shopName)}</b>
          <span>{[settings?.shop_address?.split(',').slice(-1)[0]?.trim(), gstReg].filter(Boolean).join(' · ') || ' '}</span>
        </div>
        <nav className="nav col gap-4" aria-label="Main">
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => {
            const badge = n.badge === 'rates' ? counts.pendingRates : n.badge === 'review' ? counts.review : 0;
            return (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
                {n.icon}
                <span>{t(n.en)}</span>
                {badge > 0 && can('rates.approve') && <span className="badge">{badge}</span>}
              </NavLink>
            );
          })}
        </nav>
        <div className="user-card">
          <Avatar name={me.name} />
          <div className="grow">
            <b>{me.name}</b>
            <span>{ROLE_LABEL[me.role][lang]}</span>
          </div>
          <button className="btn ghost sm icon" onClick={logout} title={t('Log out')} aria-label={t('Log out')}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar no-print">
          <button className="btn ghost icon menu-btn" onClick={() => setOpen(true)} aria-label="Menu">
            <Menu size={20} />
          </button>
          <div className="page-title grow">
            <h1>{t(title)}</h1>
            {sub(title) && <span className="hi">{sub(title)}</span>}
          </div>
          <GlobalSearch />
          <Seg value={lang} onChange={setLang} options={[{ value: 'en', label: 'EN' }, { value: 'hi', label: 'हिं' }]} />
          <button className="btn ghost icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Switch theme" title={theme === 'dark' ? t('Light') : t('Dark')}>
            {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <span className="muted hide-sm nowrap" style={{ fontSize: 13 }}>{today}</span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

/** Ctrl+K: jump to any item, customer or bill. */
function GlobalSearch() {
  const { productIndex, t, lang } = useApp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const results = useMemo(() => (q.trim() ? productIndex.search(q, 6) : []), [q, productIndex]);
  return (
    <div className="search-box hide-sm" style={{ width: 240 }}>
      <div className="input-wrap">
        <Search size={15} />
        <input
          ref={ref}
          className="input sm"
          style={{ paddingLeft: 34, minHeight: 36 }}
          placeholder={`${t('Search…')}`}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q.trim()) {
              if (results[0]) nav(`/inventory?id=${results[0].id}`);
              else nav(`/bills?q=${encodeURIComponent(q.trim())}`);
              setQ('');
              setOpen(false);
            }
          }}
          aria-label="Search everything"
        />
        <kbd style={{ position: 'absolute', right: 8 }}>Ctrl K</kbd>
      </div>
      {open && q.trim() && (
        <div className="results">
          {results.map((p) => (
            <div key={p.id} className="result" onMouseDown={(e) => e.preventDefault()} onClick={() => { nav(`/inventory?id=${p.id}`); setQ(''); setOpen(false); }}>
              <div className="grow">
                {lang === 'hi' && p.nameHi ? p.nameHi : p.nameEn}
                <div className="meta">{productStock(p)}</div>
              </div>
            </div>
          ))}
          <div className="result" onMouseDown={(e) => e.preventDefault()} onClick={() => { nav(`/bills?q=${encodeURIComponent(q.trim())}`); setQ(''); setOpen(false); }}>
            <span className="muted">Find bills matching “{q}”</span>
          </div>
          <div className="result" onMouseDown={(e) => e.preventDefault()} onClick={() => { nav(`/ledger?q=${encodeURIComponent(q.trim())}`); setQ(''); setOpen(false); }}>
            <span className="muted">Find customers matching “{q}”</span>
          </div>
        </div>
      )}
    </div>
  );
}
