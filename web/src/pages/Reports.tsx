import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Plus } from 'lucide-react';
import { api, exportExcel } from '../api';
import { useApp } from '../state';
import { Empty, Field, Modal, Seg } from '../components/ui';
import { categoryOptions } from '../components/ProductForm';
import { rs, timeOf, MODE_LABEL, MODES, type Mode } from '../format';
import { formatRate, parseRupees } from '../../../shared/money';
import { addDays, istDate } from '../../../shared/dates';

type Tab = 'daybook' | 'sales' | 'gst' | 'payments' | 'cashflow' | 'stock';

export function Reports() {
  const { t, can } = useApp();
  const full = can('reports.view');
  const [tab, setTab] = useState<Tab>('daybook');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'daybook', label: t('Day book') },
    ...(full
      ? ([
          { id: 'sales', label: t('Sales') },
          { id: 'gst', label: t('GST summary') },
          { id: 'payments', label: t('Payments register') },
          { id: 'cashflow', label: t('Cash flow') },
          { id: 'stock', label: t('Stock value') },
        ] as { id: Tab; label: string }[])
      : []),
  ];
  return (
    <>
      <div className="tabs">{tabs.map((x) => <button key={x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>{x.label}</button>)}</div>
      {tab === 'daybook' && <DayBook />}
      {tab === 'sales' && <SalesReport />}
      {tab === 'gst' && <GstSummary />}
      {tab === 'payments' && <PaymentsRegister />}
      {tab === 'cashflow' && <CashFlow />}
      {tab === 'stock' && <StockValue />}
    </>
  );
}

function Range({ from, to, setFrom, setTo, children }: { from: string; to: string; setFrom: (s: string) => void; setTo: (s: string) => void; children?: React.ReactNode }) {
  const today = istDate();
  const monthStart = `${today.slice(0, 8)}01`;
  return (
    <div className="row wrap">
      <input type="date" className="input" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
      <span className="muted">to</span>
      <input type="date" className="input" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      <button className="chip" onClick={() => { setFrom(today); setTo(today); }}>Today</button>
      <button className="chip" onClick={() => { setFrom(addDays(today, -6)); setTo(today); }}>7 days</button>
      <button className="chip" onClick={() => { setFrom(monthStart); setTo(today); }}>This month</button>
      <div className="grow" />
      {children}
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  bill: 'Bill', cancel: 'Cancellation', payment: 'Payment in', reversal: 'Reversal', cash_out: 'Paid out', stock_in: 'Stock in', loss: 'Loss', adjustment: 'Adjustment',
};

/** Day book: every entry for the date in time order, with the day's totals (DAY-1..3, DAY-6, DAY-7). */
function DayBook() {
  const { t } = useApp();
  const nav = useNavigate();
  const [from, setFrom] = useState(istDate());
  const [to, setTo] = useState(istDate());
  const [type, setType] = useState('');
  const [person, setPerson] = useState('');
  const [d, setD] = useState<any>(null);
  const [cashOut, setCashOut] = useState(false);
  const load = () => api.get(`/api/reports/daybook?from=${from}&to=${to}`).then(setD);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);
  const people = useMemo(() => [...new Set((d?.entries ?? []).map((e: any) => e.by).filter(Boolean))] as string[], [d]);
  if (!d) return <div className="muted">Loading…</div>;
  const entries = d.entries.filter((e: any) => (!type || e.type === type) && (!person || e.by === person));
  const tot = d.totals;
  const open = (e: any) => {
    if (e.type === 'bill' || e.type === 'cancel') nav(`/bills/${e.id}`);
  };
  return (
    <>
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <button className="btn" onClick={() => setCashOut(true)}><Plus size={15} /> {t('Cash out')}</button>
        <button
          className="btn"
          onClick={() =>
            exportExcel(`Day book ${from}${from !== to ? ` to ${to}` : ''}`, [
              { name: 'Entries', columns: [{ header: 'Date', key: 'date' }, { header: 'Time', key: 'time' }, { header: 'Type', key: 'type' }, { header: 'Entry', key: 'title' }, { header: 'Party / note', key: 'party' }, { header: 'Amount', key: 'amount', type: 'money' }, { header: 'Method', key: 'method' }, { header: 'By', key: 'by' }], rows: entries.map((e: any) => ({ ...e, time: timeOf(e.at), type: TYPE_LABEL[e.type] ?? e.type })) },
              { name: 'Totals', columns: [{ header: 'Item', key: 'k' }, { header: 'Amount', key: 'v', type: 'money' }], rows: [
                { k: 'Sales', v: tot.sales }, ...MODES.map((m) => ({ k: `Sales by ${MODE_LABEL[m]}`, v: tot.salesSplit[m] })), { k: 'Sales on credit', v: tot.salesSplit.credit },
                { k: 'Collections received', v: tot.receivedTotal }, { k: 'Paid out', v: tot.paidOutTotal }, { k: 'Net cash', v: tot.netCash },
              ] },
            ])
          }
        >
          <Download size={15} /> Excel
        </button>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </Range>
      <div className="grid grid-4">
        <div className="card stat"><div className="label">{t('Sales')}</div><div className="value num">{rs(tot.sales, false)}</div><div className="sub">{MODES.filter((m) => tot.salesSplit[m]).map((m) => `${MODE_LABEL[m]} ${rs(tot.salesSplit[m], false)}`).concat(tot.salesSplit.credit ? [`Credit ${rs(tot.salesSplit.credit, false)}`] : []).join(' · ') || '—'}</div></div>
        <div className="card stat"><div className="label">Collections received</div><div className="value num">{rs(tot.receivedTotal, false)}</div><div className="sub">{MODES.filter((m) => tot.received[m]).map((m) => `${MODE_LABEL[m]} ${rs(tot.received[m], false)}`).join(' · ') || 'Dues paid by customers'}</div></div>
        <div className="card stat warn"><div className="label">{t('Paid out')}</div><div className="value num">{rs(tot.paidOutTotal, false)}</div><div className="sub">Cash {rs(tot.paidOut.cash, false)}</div></div>
        <div className="card stat"><div className="label">Net cash for the day</div><div className="value num">{rs(tot.netCash, false)}</div><div className="sub">Cash in {rs(tot.cashIn, false)} − cash out {rs(tot.paidOut.cash, false)}</div></div>
      </div>
      <div className="card print-area" style={{ position: 'static' }}>
        <div className="card-head no-print">
          <div className="row wrap gap-4">
            <button className={`chip ${!type ? 'on' : ''}`} onClick={() => setType('')}>{t('All')}</button>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <button key={k} className={`chip ${type === k ? 'on' : ''}`} onClick={() => setType(k)}>{v}</button>)}
          </div>
          <select className="input sm" style={{ width: 'auto' }} value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Time</th><th>Entry</th><th>Party / note</th><th className="right">{t('Amount')}</th><th>Method</th><th>By</th></tr></thead>
            <tbody>
              {entries.map((e: any, i: number) => {
                const prevDate = i > 0 ? entries[i - 1].date : null;
                return (
                  <Fragment key={`${e.type}${e.id}`}>
                    {from !== to && e.date !== prevDate && <tr><td colSpan={6} style={{ background: 'var(--surface-2)', fontWeight: 600 }}>{e.date}</td></tr>}
                    <tr className={e.type === 'bill' || e.type === 'cancel' ? 'click' : ''} onClick={() => open(e)}>
                      <td className="nowrap muted">{timeOf(e.at)}</td>
                      <td><span className={`tag ${e.type === 'bill' ? 'ok' : e.type === 'payment' ? 'info' : e.type === 'stock_in' ? 'neutral' : 'warn'}`}>{TYPE_LABEL[e.type] ?? e.type}</span> {e.title}</td>
                      <td className="muted">{e.party}</td>
                      <td className={`right num ${e.amount < 0 ? 'err' : ''}`}>{e.amount ? rs(e.amount) : ''}</td>
                      <td className="muted">{e.method}</td>
                      <td className="muted">{e.by}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
            {person && <tfoot><tr><td colSpan={3}>{person}'s entries</td><td className="right num">{rs(entries.reduce((a: number, e: any) => a + (e.type === 'bill' ? e.amount : 0), 0))}</td><td colSpan={2} className="muted">bills total</td></tr></tfoot>}
          </table>
          {entries.length === 0 && <Empty>Nothing recorded for this date</Empty>}
        </div>
      </div>
      {cashOut && <CashOutForm onClose={() => setCashOut(false)} onDone={() => { setCashOut(false); load(); }} />}
    </>
  );
}

function CashOutForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [f, setF] = useState({ date: istDate(), category: 'supplier', payee: '', mode: 'cash' as Mode, amount: '', note: '' });
  const [err, setErr] = useState('');
  return (
    <Modal
      title="Money paid out"
      sub="Payments to suppliers and shop expenses. This is a record of money paid, not supplier accounts."
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!f.amount} onClick={async () => {
            const amountPaise = parseRupees(f.amount);
            if (!(amountPaise > 0)) return setErr('Enter an amount');
            try {
              await api.post('/api/cash-outs', { ...f, amountPaise });
              toast('Saved');
              onDone();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}>Save</button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label="For">
          <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {['supplier', 'rent', 'wages', 'transport', 'electricity', 'other'].map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
          </select>
        </Field>
        <Field label="Paid to"><input className="input" value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} placeholder="Gupta Traders" /></Field>
        <Field label="Amount ₹"><input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></Field>
        <Field label="Paid by">
          <select className="input" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as Mode })}>{MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select>
        </Field>
        <Field label="Date"><input type="date" className="input" value={f.date} max={istDate()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function SalesReport() {
  const { categories } = useApp();
  const [from, setFrom] = useState(`${istDate().slice(0, 8)}01`);
  const [to, setTo] = useState(istDate());
  const [groupBy, setGroupBy] = useState<'day' | 'month' | 'category' | 'brand' | 'product'>('day');
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api.get(`/api/reports/sales?from=${from}&to=${to}&groupBy=${groupBy}${categoryId ? `&categoryId=${categoryId}` : ''}`).then(setD);
  }, [from, to, groupBy, categoryId]);
  const cats = categoryOptions(categories);
  const max = Math.max(1, ...(d?.rows ?? []).map((r: any) => r.total));
  return (
    <>
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <Seg value={groupBy} onChange={setGroupBy} options={[{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }, { value: 'category', label: 'Category' }, { value: 'brand', label: 'Brand' }, { value: 'product', label: 'Item' }]} />
        <select className="input" style={{ width: 'auto' }} value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')} aria-label="Category">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {d && (
          <button className="btn" onClick={() => exportExcel(`Sales ${from} to ${to}`, [{ name: 'Sales', columns: [{ header: groupBy, key: 'key' }, { header: 'Before GST', key: 'taxable', type: 'money' }, { header: 'GST', key: 'gst', type: 'money' }, { header: 'Total', key: 'total', type: 'money' }, { header: 'Lines', key: 'lines', type: 'number' }], rows: d.rows }])}>
            <Download size={15} /> Excel
          </button>
        )}
      </Range>
      {d && (
        <div className="card">
          <div className="card-head"><h3>{rs(d.billTotal, false)} <span className="hi">from {d.billCount} bills (line totals below exclude round-off)</span></h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{groupBy}</th><th className="right">Before GST</th><th className="right">GST</th><th className="right">Total</th><th className="hide-sm" style={{ width: '30%' }} /></tr></thead>
              <tbody>
                {d.rows.map((r: any) => (
                  <tr key={r.key}><td>{r.key}</td><td className="right num">{rs(r.taxable)}</td><td className="right num">{rs(r.gst)}</td><td className="right num"><b>{rs(r.total)}</b></td><td className="hide-sm"><div className="meter"><i style={{ width: `${(r.total / max) * 100}%`, background: 'var(--brand)' }} /></div></td></tr>
                ))}
              </tbody>
              <tfoot><tr><td>Total</td><td className="right num">{rs(d.rows.reduce((a: number, r: any) => a + r.taxable, 0))}</td><td className="right num">{rs(d.rows.reduce((a: number, r: any) => a + r.gst, 0))}</td><td className="right num">{rs(d.rows.reduce((a: number, r: any) => a + r.total, 0))}</td><td className="hide-sm" /></tr></tfoot>
            </table>
            {d.rows.length === 0 && <Empty>No sales in this range</Empty>}
          </div>
        </div>
      )}
    </>
  );
}

/** Monthly GST summary by rate and HSN for the accountant (REP-3). */
function GstSummary() {
  const [month, setMonth] = useState(istDate().slice(0, 7));
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api.get(`/api/reports/gst?month=${month}`).then(setD);
  }, [month]);
  const exportIt = () =>
    exportExcel(`GST summary ${month}`, [
      { name: 'By rate', columns: [{ header: 'GST %', key: 'rate', type: 'number' }, { header: 'Taxable', key: 'taxable', type: 'money' }, { header: 'CGST', key: 'cgst', type: 'money' }, { header: 'SGST', key: 'sgst', type: 'money' }], rows: d.byRate.map((r: any) => ({ ...r, rate: r.gstBp / 100 })) },
      { name: 'By HSN', columns: [{ header: 'HSN', key: 'hsn' }, { header: 'GST %', key: 'rate', type: 'number' }, { header: 'Taxable', key: 'taxable', type: 'money' }, { header: 'CGST', key: 'cgst', type: 'money' }, { header: 'SGST', key: 'sgst', type: 'money' }], rows: d.byHsn.map((r: any) => ({ ...r, rate: r.gstBp / 100 })) },
    ]);
  return (
    <>
      <div className="row wrap">
        <input type="month" className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} />
        <span className="muted">Cancelled bills and estimates are left out. Kaccha slips are included.</span>
        <div className="grow" />
        {d && <button className="btn" onClick={exportIt}><Download size={15} /> Excel for the accountant</button>}
      </div>
      {d && (
        <>
          <div className="grid grid-4">
            <div className="card stat"><div className="label">Taxable value</div><div className="value num">{rs(d.totals.taxable, false)}</div></div>
            <div className="card stat"><div className="label">CGST</div><div className="value num">{rs(d.totals.cgst)}</div></div>
            <div className="card stat"><div className="label">SGST</div><div className="value num">{rs(d.totals.sgst)}</div></div>
            <div className="card stat"><div className="label">Total GST</div><div className="value num">{rs(d.totals.cgst + d.totals.sgst)}</div></div>
          </div>
          <div className="grid grid-2">
            <div className="card">
              <div className="card-head"><h3>By rate</h3></div>
              <table className="table">
                <thead><tr><th>GST</th><th className="right">Taxable</th><th className="right">CGST</th><th className="right">SGST</th></tr></thead>
                <tbody>{d.byRate.map((r: any) => <tr key={r.gstBp}><td>{formatRate(r.gstBp)}</td><td className="right num">{rs(r.taxable)}</td><td className="right num">{rs(r.cgst)}</td><td className="right num">{rs(r.sgst)}</td></tr>)}</tbody>
              </table>
              {d.byRate.length === 0 && <Empty>No sales this month</Empty>}
            </div>
            <div className="card">
              <div className="card-head"><h3>By HSN</h3></div>
              <table className="table">
                <thead><tr><th>HSN</th><th>GST</th><th className="right">Taxable</th><th className="right">CGST + SGST</th></tr></thead>
                <tbody>{d.byHsn.map((r: any) => <tr key={`${r.hsn}${r.gstBp}`}><td>{r.hsn}</td><td>{formatRate(r.gstBp)}</td><td className="right num">{rs(r.taxable)}</td><td className="right num">{rs(r.cgst + r.sgst)}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** One row per payment, a column per mode (PAY-4). */
function PaymentsRegister() {
  const [from, setFrom] = useState(istDate());
  const [to, setTo] = useState(istDate());
  const [mode, setMode] = useState('');
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api.get(`/api/reports/payments?from=${from}&to=${to}${mode ? `&mode=${mode}` : ''}`).then(setD);
  }, [from, to, mode]);
  return (
    <>
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <select className="input" style={{ width: 'auto' }} value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode">
          <option value="">All modes</option>
          {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>
        {d && (
          <button className="btn" onClick={() => exportExcel(`Payments ${from} to ${to}`, [{ name: 'Payments', columns: [{ header: 'Date', key: 'date' }, { header: 'Customer', key: 'customer' }, { header: 'Bill', key: 'billNumber' }, ...MODES.map((m) => ({ header: MODE_LABEL[m], key: m, type: 'money' as const })), { header: 'Total', key: 'total_paise', type: 'money' }, { header: 'Reference', key: 'refs' }, { header: 'By', key: 'by' }], rows: d.rows.map((r: any) => ({ ...r, ...r.modes })) }])}>
            <Download size={15} /> Excel
          </button>
        )}
      </Range>
      {d && (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Customer</th><th>Bill</th>{MODES.map((m) => <th key={m} className="right">{MODE_LABEL[m]}</th>)}<th className="right">Total</th></tr></thead>
              <tbody>
                {d.rows.map((r: any) => (
                  <tr key={r.id}><td className="nowrap">{r.date}</td><td>{r.customer}{r.reversal_of && <span className="tag danger"> reversal</span>}</td><td className="muted">{r.billNumber ?? '—'}</td>{MODES.map((m) => <td key={m} className="right num">{r.modes[m] ? rs(r.modes[m], false) : ''}</td>)}<td className="right num">{rs(r.total_paise, false)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3}>Totals</td>{MODES.map((m) => <td key={m} className="right num">{rs(d.totals[m], false)}</td>)}<td className="right num">{rs(d.total, false)}</td></tr></tfoot>
            </table>
            {d.rows.length === 0 && <Empty>No payments in this range</Empty>}
          </div>
        </div>
      )}
    </>
  );
}

/** Money in under each mode with who paid, money out, net per mode (PAY-5). */
function CashFlow() {
  const [from, setFrom] = useState(istDate());
  const [to, setTo] = useState(istDate());
  const [d, setD] = useState<any>(null);
  const [open, setOpen] = useState<string | null>('cash');
  useEffect(() => {
    api.get(`/api/reports/cashflow?from=${from}&to=${to}`).then(setD);
  }, [from, to]);
  return (
    <>
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {d && (
        <div className="card">
          <table className="table">
            <thead><tr><th>Mode</th><th className="right">In</th><th className="right">Out</th><th className="right">Net</th></tr></thead>
            <tbody>
              {d.modes.map((m: any) => (
                <Fragment key={m.mode}>
                  <tr className="click" onClick={() => setOpen(open === m.mode ? null : m.mode)}>
                    <td><b style={{ fontWeight: 600 }}>{MODE_LABEL[m.mode]}</b> <span className="faint">{open === m.mode ? '▾' : '▸'}</span></td>
                    <td className="right num" style={{ color: 'var(--ok)' }}>{rs(m.inTotal)}</td>
                    <td className="right num err">{rs(m.outTotal)}</td>
                    <td className="right num"><b>{rs(m.net)}</b></td>
                  </tr>
                  {open === m.mode && (
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--surface-2)' }}>
                        <div className="grid grid-2">
                          <div>{m.in.length ? m.in.map((x: any) => <div key={x.name} className="row between"><span>{x.name}</span><span className="num">{rs(x.amount)}</span></div>) : <span className="faint">No money in</span>}</div>
                          <div>{m.out.map((x: any, i: number) => <div key={i} className="row between"><span>{x.name} <span className="faint">({x.category})</span></span><span className="num err">{rs(x.amount)}</span></div>)}</div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function StockValue() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api.get('/api/reports/stock-value').then(setRows);
  }, []);
  if (!rows) return <div className="muted">Loading…</div>;
  return (
    <div className="card">
      <table className="table">
        <thead><tr><th>Category</th><th className="right">At purchase cost</th><th className="right">At selling price</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.category}><td>{r.category}{r.missingCost > 0 && <span className="faint"> · {r.missingCost} items without a purchase rate</span>}</td><td className="right num">{rs(r.cost, false)}</td><td className="right num">{rs(r.selling, false)}</td></tr>)}</tbody>
        <tfoot><tr><td>Total</td><td className="right num">{rs(rows.reduce((a, r) => a + r.cost, 0), false)}</td><td className="right num">{rs(rows.reduce((a, r) => a + r.selling, 0), false)}</td></tr></tfoot>
      </table>
      {rows.length === 0 && <Empty>No stock yet</Empty>}
    </div>
  );
}
