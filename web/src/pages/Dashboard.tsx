import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ReceiptText, Wallet, NotebookText, TriangleAlert, PackagePlus, Plus, ClipboardCheck, Tags, Truck, KeyRound, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../state';
import { Bi, Empty } from '../components/ui';
import { rs, rsShort, timeOf, MODE_LABEL, reorderLabel } from '../format';
import type { CProduct } from '../state';
import { stockLabel } from '../../../shared/units';

interface Dash {
  today: string;
  todaySales: { total: number; count: number };
  monthSales: { total: number; count: number };
  collected: Record<string, number>;
  due: number;
  dueCustomers: number;
  passwordRequests: number;
  security: { failedLogins: number; lockouts: number; locksNow: number } | null;
  payable: number | null;
  payableSuppliers: number;
  low: { id: number; nameEn: string; nameHi: string; stockMilli: number; reorderMilli: number; reorderUnitId: number | null; baseUnit: 'kg' | 'L' | 'pc'; packKind: string; units: { id: number; name: string; factorMilli: number; isBase: boolean }[] }[];
  days: { date: string; total: number }[];
  recent: { id: number; number: string; customer_name: string; total_paise: number; credit_paise: number; paid_paise: number; status: string; bill_date: string; created_at: string; modes: string[] }[];
  pendingRates: number;
  reviewCount: number;
  monthLoss: number;
}

export function Dashboard() {
  const { t, sub, can, lang, reloadCounts } = useApp();
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  useEffect(() => {
    api.get<Dash>('/api/dashboard').then(setD).catch((e) => setErr(e.message));
    reloadCounts();
  }, [reloadCounts]);

  if (err) return <div className="banner danger">{err}</div>;
  if (!d) return <div className="muted">Loading…</div>;

  const collectedTotal = Object.values(d.collected).reduce((a, b) => a + b, 0);
  const max = Math.max(...d.days.map((x) => x.total), 1);
  const dayName = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' });
  const lowNames = d.low.slice(0, 3).map((l) => l.nameEn.split(' ')[0]).join(', ');

  return (
    <>
      {d.security && (d.security.lockouts > 0 || d.security.locksNow > 0 || d.security.failedLogins >= 5) && (
        <div className="banner danger row wrap">
          <Link to="/security" className="row" style={{ color: 'inherit' }}>
            <ShieldAlert size={16} /> <b>{d.security.failedLogins}</b> failed login{d.security.failedLogins === 1 ? '' : 's'} in the last day
            {d.security.lockouts > 0 && <>, <b>{d.security.lockouts}</b> lockout{d.security.lockouts === 1 ? '' : 's'}</>}
            {d.security.locksNow > 0 && <> ({d.security.locksNow} in force now)</>}. See Security.
          </Link>
        </div>
      )}
      {d.passwordRequests > 0 && (
        <div className="banner row wrap">
          <Link to="/users" className="row" style={{ color: 'inherit' }}>
            <KeyRound size={16} /> <b>{d.passwordRequests}</b> password reset request{d.passwordRequests > 1 ? 's' : ''} waiting
          </Link>
        </div>
      )}
      {can('rates.approve') && (d.pendingRates > 0 || d.reviewCount > 0) && (
        <div className="banner row wrap">
          {d.pendingRates > 0 && (
            <Link to="/rates?tab=approvals" className="row" style={{ color: 'inherit' }}>
              <Tags size={16} /> <b>{d.pendingRates}</b> rate change{d.pendingRates > 1 ? 's' : ''} waiting for approval
            </Link>
          )}
          {d.reviewCount > 0 && (
            <Link to="/review" className="row" style={{ color: 'inherit', marginLeft: 12 }}>
              <ClipboardCheck size={16} /> <b>{d.reviewCount}</b> entr{d.reviewCount > 1 ? 'ies' : 'y'} to review
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-auto">
        <div className="card stat">
          <div className="label"><span className="ic"><ReceiptText size={17} /></span><Bi en="Today's Sales" /></div>
          <div className="value num">{rs(d.todaySales.total, false)}</div>
          <div className="sub">{d.todaySales.count} bills today · month {rsShort(d.monthSales.total)}</div>
        </div>
        <div className="card stat">
          <div className="label"><span className="ic"><Wallet size={17} /></span><Bi en="Collected" /></div>
          <div className="value num">{rs(collectedTotal, false)}</div>
          <div className="sub">
            {(['cash', 'upi', 'card', 'bank', 'cheque'] as const).filter((m) => d.collected[m]).map((m) => `${MODE_LABEL[m]} ${rs(d.collected[m], false)}`).join(' · ') || 'Nothing yet'}
          </div>
        </div>
        <div className="card stat warn" role="button" style={{ cursor: 'pointer' }} onClick={() => nav('/ledger')}>
          <div className="label"><span className="ic"><NotebookText size={17} /></span><Bi en="Credit Due" /></div>
          <div className="value num">{rs(d.due, false)}</div>
          <div className="sub">{d.dueCustomers} customers</div>
        </div>
        {d.payable != null && (
          <div className="card stat" role="button" style={{ cursor: 'pointer' }} onClick={() => nav('/ledger/suppliers')}>
            <div className="label"><span className="ic"><Truck size={17} /></span><Bi en="To pay suppliers" /></div>
            <div className="value num">{rs(d.payable, false)}</div>
            <div className="sub">{d.payableSuppliers} supplier{d.payableSuppliers === 1 ? '' : 's'}</div>
          </div>
        )}
        <div className={`card stat ${d.low.length ? 'danger' : ''}`} role="button" style={{ cursor: 'pointer' }} onClick={() => nav('/inventory?filter=low')}>
          <div className="label"><span className="ic"><TriangleAlert size={17} /></span><Bi en="Low Stock" /></div>
          <div className="value">{d.low.length} items</div>
          <div className="sub">{lowNames || 'All stocked'}</div>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <div className="card-head"><Bi en="Sales — last 7 days" as="h3" /></div>
          <div className="bars" role="img" aria-label="Sales for the last 7 days">
            {d.days.map((x, i) => (
              <div key={x.date} className={`bar ${i === d.days.length - 1 ? 'today' : ''}`}>
                <span className="v num">{rsShort(x.total)}</span>
                <div className="fill" style={{ height: `${Math.max(2, (x.total / max) * 100)}%` }} />
                <span className="d">{i === d.days.length - 1 ? 'Today' : dayName(x.date)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><Bi en="Recent bills" as="h3" /><Link to="/bills" className="muted" style={{ fontSize: 13 }}>All bills →</Link></div>
          {d.recent.length === 0 ? (
            <Empty>No bills yet</Empty>
          ) : (
            d.recent.map((b) => (
              <div key={b.id} className="list-item" onClick={() => nav(`/bills/${b.id}`)}>
                <div className="grow">
                  <b style={{ fontWeight: 600 }}>{b.number}</b>
                  <div className="faint" style={{ fontSize: 12 }}>{b.customer_name || 'Walk-in'} · {b.bill_date === d.today ? timeOf(b.created_at) : b.bill_date}</div>
                </div>
                <span className="num">{rs(b.total_paise, false)}</span>
                <PayTag b={b} />
              </div>
            ))
          )}
        </div>
      </div>

      {d.low.length > 0 && (
        <div className="card">
          <div className="card-head">
            <Bi en="Low stock — reorder soon" as="h3" />
            {can('stock.in') && (
              <button className="btn sm" onClick={() => nav(`/stock-in?items=${d.low.map((l) => l.id).join(',')}`)}>
                <PackagePlus size={15} /> {t('Stock in for all low items')}
              </button>
            )}
          </div>
          {d.low.map((l) => (
            <div key={l.id} className="list-item" onClick={() => nav(`/inventory?id=${l.id}`)}>
              <div className="grow">
                <b style={{ fontWeight: 500 }}>{lang === 'hi' && l.nameHi ? l.nameHi : l.nameEn}</b>
                <div className="hi">{lang === 'hi' ? l.nameEn : l.nameHi}</div>
              </div>
              <span className="err num" style={{ fontWeight: 600, fontSize: 14 }}>{stockLabel(l.stockMilli, l.baseUnit, l.units, l.packKind)}</span>
              <span className="muted hide-sm" style={{ width: 150, fontSize: 12 }}>reorder at {reorderLabel(l as unknown as CProduct)}</span>
              <div className="meter hide-sm" style={{ width: 90 }}><i style={{ width: `${Math.min(100, Math.max(5, (l.stockMilli / l.reorderMilli) * 100))}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-4">
        {can('bill.create') && <QuickAction primary onClick={() => nav('/billing')} icon={<ReceiptText size={18} />} en="New Bill" k="F2" sub={sub} t={t} />}
        {can('stock.in') && <QuickAction onClick={() => nav('/stock-in')} icon={<PackagePlus size={18} />} en="Stock In" k="F3" sub={sub} t={t} />}
        <QuickAction onClick={() => nav('/ledger?pay=1')} icon={<Wallet size={18} />} en="Receive Payment" k="F4" sub={sub} t={t} />
        {can('catalog.add') && <QuickAction onClick={() => nav('/inventory?add=1')} icon={<Plus size={18} />} en="Add Product" k="F5" sub={sub} t={t} />}
      </div>
      {d.monthLoss > 0 && can('reports.view') && <div className="muted" style={{ fontSize: 13 }}>Losses recorded this month: {rs(d.monthLoss)} · <Link to="/losses">see losses</Link></div>}
    </>
  );
}

function QuickAction({ primary, onClick, icon, en, k, t, sub }: { primary?: boolean; onClick: () => void; icon: React.ReactNode; en: string; k: string; t: (s: string) => string; sub: (s: string) => string }) {
  return (
    <button className={`btn big ${primary ? 'primary' : ''}`} style={{ justifyContent: 'flex-start', padding: '10px 16px', minHeight: 56 }} onClick={onClick}>
      {icon}
      <span className="grow" style={{ textAlign: 'left', lineHeight: 1.2 }}>
        {t(en)}
        <span style={{ display: 'block', fontSize: 11, opacity: 0.75, fontWeight: 400 }}>{sub(en)}</span>
      </span>
      <kbd className="hide-sm">{k}</kbd>
    </button>
  );
}

export function PayTag({ b }: { b: { status: string; credit_paise: number; paid_paise: number; modes: string[] } }) {
  if (b.status === 'cancelled') return <span className="tag danger">Cancelled</span>;
  if (b.credit_paise > 0 && b.paid_paise > 0) return <span className="tag warn">{b.modes.map((m) => MODE_LABEL[m]).join('+')} + Credit</span>;
  if (b.credit_paise > 0) return <span className="tag warn">Credit</span>;
  if (b.modes.length === 1) return <span className={`tag ${b.modes[0] === 'cash' ? 'ok' : 'info'}`}>{MODE_LABEL[b.modes[0]]}</span>;
  if (b.modes.length > 1) return <span className="tag info">{b.modes.map((m) => MODE_LABEL[m]).join(' + ')}</span>;
  return <span className="tag ok">Paid</span>;
}
