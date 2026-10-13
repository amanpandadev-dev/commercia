import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Wallet, Printer, Plus, Pencil, Search, Undo2, Share2 } from 'lucide-react';
import { api, exportExcel } from '../api';
import { useApp } from '../state';
import { Avatar, Bi, CustomerSearch, Empty, Field, Modal, ReasonDialog, customerIndex, type CustomerRow } from '../components/ui';
import { CustomerForm } from '../components/CustomerForm';
import { VersionList } from './Inventory';
import { rs, MODE_LABEL, MODES, type Mode } from '../format';
import { parseRupees } from '../../../shared/money';
import { addDays, formatDate, istDate, shortDate } from '../../../shared/dates';

export function Ledger() {
  const { t } = useApp();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [sort, setSort] = useState<'amount' | 'oldest' | 'name'>('amount');
  const [filter, setFilter] = useState<'dues' | 'all' | 'old'>('dues');
  const [minDue, setMinDue] = useState('');
  const [adding, setAdding] = useState(false);
  const [payFor, setPayFor] = useState<CustomerRow | null>(null);
  const [pickPay, setPickPay] = useState(params.get('pay') === '1');
  const [version, setVersion] = useState(0);

  const load = () => api.get<CustomerRow[]>('/api/customers').then(setCustomers);
  useEffect(() => {
    load();
  }, [version]);

  const idx = useMemo(() => customerIndex(customers), [customers]);
  const list = useMemo(() => {
    let l = q.trim() ? idx.search(q, 200) : customers;
    if (filter === 'dues') l = l.filter((c) => c.balance > 0);
    if (filter === 'old') l = l.filter((c) => c.balance > 0 && c.ageing?.oldest && c.ageing.oldest < addDays(istDate(), -30));
    const min = parseRupees(minDue);
    if (minDue.trim() && !Number.isNaN(min)) l = l.filter((c) => c.balance >= min);
    if (!q.trim()) {
      l = [...l].sort((a, b) =>
        sort === 'amount' ? b.balance - a.balance : sort === 'oldest' ? (a.ageing?.oldest ?? '9').localeCompare(b.ageing?.oldest ?? '9') : a.name.localeCompare(b.name),
      );
    }
    return l;
  }, [q, idx, customers, filter, sort, minDue]);
  const totalDue = customers.filter((c) => c.balance > 0).reduce((a, c) => a + c.balance, 0);
  const dueCount = customers.filter((c) => c.balance > 0).length;
  const selected = customers.find((c) => c.id === Number(id));

  return (
    <div className="split-r">
      <div className="card">
        <div className="card-head">
          <div>
            <Bi en="Customers with dues" as="h3" />
            <span className="tag warn num" style={{ marginTop: 4 }}>Total due {rs(totalDue, false)} · {dueCount}</span>
          </div>
          <button className="btn sm" onClick={() => setAdding(true)} title={t('Add customer')}><Plus size={15} /></button>
        </div>
        <div className="card-pad col" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="input-wrap">
            <Search size={16} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, nickname or last 4 digits" />
          </div>
          <div className="row wrap gap-4">
            <button className={`chip ${filter === 'dues' ? 'on' : ''}`} onClick={() => setFilter('dues')}>With dues</button>
            <button className={`chip ${filter === 'old' ? 'on' : ''}`} onClick={() => setFilter('old')}>Unpaid 30+ days</button>
            <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All</button>
          </div>
          <div className="row">
            <select className="input sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
              <option value="amount">Biggest due first</option>
              <option value="oldest">Oldest unpaid first</option>
              <option value="name">By name</option>
            </select>
            <input className="input sm num" style={{ width: 110 }} placeholder="Due above ₹" value={minDue} onChange={(e) => setMinDue(e.target.value)} />
          </div>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {list.map((c) => (
            <div key={c.id} className={`list-item ${c.id === selected?.id ? 'sel' : ''}`} onClick={() => nav(`/ledger/${c.id}`)}>
              <Avatar name={c.name} />
              <div className="grow">
                <b style={{ fontWeight: 500 }}>{c.name}</b>
                {c.nickname && <span className="muted"> ({c.nickname})</span>}
                <div className="faint" style={{ fontSize: 12 }}>{[c.area, c.phone && `…${c.phone.slice(-4)}`, c.ageing?.oldest && `since ${shortDate(c.ageing.oldest)}`].filter(Boolean).join(' · ')}</div>
              </div>
              <span className="num" style={{ color: c.balance > 0 ? 'var(--accent-text)' : c.balance < 0 ? 'var(--ok)' : 'var(--muted)', fontWeight: 600 }}>
                {c.balance < 0 ? `+${rs(-c.balance, false)}` : rs(c.balance, false)}
              </span>
            </div>
          ))}
          {list.length === 0 && <Empty>{customers.length ? 'No one here' : 'No customers yet. Add them, or import the khata on the Import page.'}</Empty>}
        </div>
        <div className="card-pad row" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            className="btn sm"
            onClick={() =>
              exportExcel('Dues', [{
                name: 'Dues',
                columns: [
                  { header: 'Name', key: 'name' }, { header: 'Nickname', key: 'nickname' }, { header: 'Phone', key: 'phone' }, { header: 'Area', key: 'area' },
                  { header: 'Balance', key: 'balance', type: 'money' }, { header: '0–30 days', key: 'b0', type: 'money' }, { header: '31–60', key: 'b30', type: 'money' },
                  { header: '61–90', key: 'b60', type: 'money' }, { header: 'Over 90', key: 'b90', type: 'money' },
                ],
                rows: list.map((c) => ({ ...c, ...(c.ageing ?? {}) })),
              }])
            }
          >
            Excel
          </button>
          <span className="faint" style={{ fontSize: 12 }}>List total {rs(list.filter((c) => c.balance > 0).reduce((a, c) => a + c.balance, 0), false)}</span>
        </div>
      </div>

      {selected ? (
        <CustomerPanel key={selected.id} customer={selected} onPay={() => setPayFor(selected)} onChanged={() => setVersion((v) => v + 1)} />
      ) : (
        <div className="card card-pad col">
          <Bi en="Receive Payment" as="h3" />
          <CustomerSearch customers={customers} autoFocus={pickPay} onPick={(c) => nav(`/ledger/${c.id}`)} onPay={(c) => setPayFor(c)} />
          <span className="muted">Pick a customer to see their khata, or tap “Receive payment”.</span>
        </div>
      )}

      {adding && <CustomerForm onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); setVersion((v) => v + 1); nav(`/ledger/${id}`); }} />}
      {payFor && (
        <ReceivePayment
          customer={payFor}
          onClose={() => { setPayFor(null); setPickPay(false); if (params.get('pay')) setParams({}); }}
          onDone={() => { setPayFor(null); setVersion((v) => v + 1); nav(`/ledger/${payFor.id}`); }}
        />
      )}
    </div>
  );
}

function CustomerPanel({ customer, onPay, onChanged }: { customer: CustomerRow; onPay: () => void; onChanged: () => void }) {
  const { t, can, toast, settings } = useApp();
  const [tab, setTab] = useState<'ledger' | 'payments' | 'history'>('ledger');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [d, setD] = useState<any>(null);
  const [edit, setEdit] = useState(false);
  const [reverse, setReverse] = useState<number | null>(null);
  const [statement, setStatement] = useState(false);
  const nav = useNavigate();
  const load = () => {
    const qs = new URLSearchParams({ ...(from && { from }), ...(to && { to }) });
    api.get(`/api/customers/${customer.id}/ledger?${qs}`).then(setD);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.id, customer.balance, from, to]);

  const yearStart = `${Number(istDate().slice(0, 4)) - (Number(istDate().slice(5, 7)) < 4 ? 1 : 0)}-04-01`;
  const mix = useMemo(() => {
    if (!d) return null;
    const m: Record<string, number> = {};
    let total = 0;
    for (const p of d.payments) {
      if (p.date < yearStart || p.reversed || p.reversal_of) continue;
      for (const x of p.parts) {
        m[x.mode] = (m[x.mode] ?? 0) + x.amount_paise;
        total += x.amount_paise;
      }
    }
    return { m, total };
  }, [d, yearStart]);

  if (!d) return <div className="card card-pad muted">Loading…</div>;
  const c = d.customer;
  const shareText = `Namaste ${c.name} ji, ${settings?.shop_name ?? ''}: your balance as on ${formatDate(istDate())} is ${rs(d.balance)}. Thank you.`;

  return (
    <div className="card">
      <div className="card-pad row between wrap" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="row">
          <Avatar name={c.name} lg />
          <div>
            <h2 style={{ fontSize: 20 }}>{c.name} {c.nickname && <span className="muted" style={{ fontSize: 14 }}>({c.nickname})</span>}</h2>
            <div className="muted" style={{ fontSize: 12 }}>
              {[`Customer since ${c.created_at.slice(0, 4)}`, c.phone, c.area, c.gstin && `GSTIN ${c.gstin}`, c.price_list === 'wholesale' && 'Wholesale prices'].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
        <div className="card card-pad" style={{ background: 'var(--accent-soft)', border: 0, boxShadow: 'none', textAlign: 'right' }}>
          <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{d.balance < 0 ? 'Advance' : t('Balance due')}</div>
          <div className="num" style={{ fontSize: 24, fontWeight: 600, color: 'var(--accent-text)' }}>{rs(Math.abs(d.balance))}</div>
        </div>
      </div>
      {customer.ageing && customer.balance > 0 && (
        <div className="card-pad row wrap" style={{ borderBottom: '1px solid var(--border)', fontSize: 13 }}>
          <span className="muted">Ageing:</span>
          <span>0–30 days <b className="num">{rs(customer.ageing.b0, false)}</b></span>
          <span>31–60 <b className="num">{rs(customer.ageing.b30, false)}</b></span>
          <span>61–90 <b className="num">{rs(customer.ageing.b60, false)}</b></span>
          <span className={customer.ageing.b90 > 0 ? 'err' : ''}>90+ <b className="num">{rs(customer.ageing.b90, false)}</b></span>
        </div>
      )}
      <div className="tabs" style={{ padding: '0 8px' }}>
        <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>{t('Ledger')}</button>
        <button className={tab === 'payments' ? 'on' : ''} onClick={() => setTab('payments')}>Payments</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>{t('History')}</button>
      </div>
      {tab === 'ledger' && (
        <>
          <div className="card-pad row wrap">
            <input type="date" className="input sm" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" className="input sm" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            {(from || to) && <button className="btn sm ghost" onClick={() => { setFrom(''); setTo(''); }}>Clear</button>}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Date')}</th><th>{t('Particulars')}</th><th className="right">{t('Debit')}</th><th className="right">{t('Credit')}</th><th className="right">{t('Balance')}</th></tr></thead>
              <tbody>
                {from && <tr><td>{shortDate(from)}</td><td><b style={{ fontWeight: 500 }}>{t('Opening balance')}</b></td><td /><td /><td className="right num">{(d.opening / 100).toFixed(2)}</td></tr>}
                {d.entries.map((e: any) => (
                  <tr key={e.id} className={e.ref_type === 'bill' ? 'click' : ''} onClick={() => e.ref_type === 'bill' && nav(`/bills/${e.ref_id}`)}>
                    <td className="nowrap">{shortDate(e.date)}</td>
                    <td>
                      <b style={{ fontWeight: 500 }}>{e.kind === 'bill' ? `Bill ${e.note}` : e.kind === 'opening' ? e.note : e.note.split(' · ')[0]}</b>
                      <div className="faint" style={{ fontSize: 12 }}>{[e.kind !== 'bill' && e.note.split(' · ').slice(1).join(' · '), e.by].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="right num" style={{ color: 'var(--accent-text)' }}>{e.debit_paise ? (e.debit_paise / 100).toFixed(2) : '—'}</td>
                    <td className="right num" style={{ color: 'var(--ok)' }}>{e.credit_paise ? (e.credit_paise / 100).toFixed(2) : '—'}</td>
                    <td className="right num">{(e.balance / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.entries.length === 0 && !from && <Empty>No entries yet</Empty>}
          </div>
        </>
      )}
      {tab === 'payments' && (
        <div className="card-pad col">
          {mix && mix.total > 0 && (
            <div className="banner info">
              This year: <b className="num">{rs(mix.total, false)}</b> — {Object.entries(mix.m).sort((a, b) => b[1] - a[1]).map(([m, v]) => `${Math.round((v / mix.total) * 100)}% ${MODE_LABEL[m]}`).join(', ')}
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Date')}</th><th className="right">{t('Amount')}</th><th>Modes</th><th>For</th><th>By</th><th /></tr></thead>
              <tbody>
                {d.payments.map((p: any) => (
                  <tr key={p.id} style={{ opacity: p.reversed ? 0.55 : 1 }}>
                    <td className="nowrap">{shortDate(p.date)}</td>
                    <td className="right num">{rs(p.total_paise)}</td>
                    <td>{p.parts.map((x: any) => `${MODE_LABEL[x.mode]} ${rs(x.amount_paise, false)}${x.reference ? ` (${x.reference})` : ''}`).join(' + ')}{p.reversal_of && <span className="tag danger"> reversal</span>}{p.reversed ? <span className="tag neutral"> reversed</span> : null}</td>
                    <td className="muted">{p.billNumber ?? '—'}</td>
                    <td className="muted">{p.by}</td>
                    <td>{can('payment.reverse') && !p.reversed && !p.reversal_of && <button className="btn sm ghost" onClick={() => setReverse(p.id)} title="Reverse"><Undo2 size={14} /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.payments.length === 0 && <Empty>No payments yet</Empty>}
          </div>
        </div>
      )}
      {tab === 'history' && <div className="card-pad"><VersionList versions={d.history} /></div>}
      <div className="card-pad row wrap" style={{ borderTop: '1px solid var(--border)' }}>
        {can('payment.receive') && <button className="btn primary" onClick={onPay}><Wallet size={16} /> {t('Receive Payment')}</button>}
        <button className="btn" onClick={() => setStatement(true)}><Printer size={16} /> {t('Print Statement')}</button>
        {c.phone && (
          <a className="btn" href={`https://wa.me/91${c.phone.replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer"><Share2 size={16} /> WhatsApp</a>
        )}
        <div className="grow" />
        {can('customer.edit') && <button className="btn ghost" onClick={() => setEdit(true)}><Pencil size={15} /> {t('Edit')}</button>}
      </div>
      {edit && <CustomerForm customer={customer} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); load(); }} />}
      {reverse && (
        <ReasonDialog
          title="Reverse this payment?"
          label="Reason (both rows stay visible in the khata)"
          confirmText="Reverse payment"
          danger
          onClose={() => setReverse(null)}
          onConfirm={async (reason) => {
            await api.post(`/api/payments/${reverse}/reverse`, { reason });
            toast('Payment reversed');
            onChanged();
            load();
          }}
        />
      )}
      {statement && <Statement customer={c} onClose={() => setStatement(false)} />}
    </div>
  );
}

/** Customer statement for a date range (LED-6). */
function Statement({ customer, onClose }: { customer: any; onClose: () => void }) {
  const { settings } = useApp();
  const [from, setFrom] = useState(addDays(istDate(), -30));
  const [to, setTo] = useState(istDate());
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api.get(`/api/customers/${customer.id}/ledger?from=${from}&to=${to}`).then(setD);
  }, [customer.id, from, to]);
  return (
    <Modal
      wide
      title={`Statement · ${customer.name}`}
      onClose={onClose}
      foot={
        <>
          <input type="date" className="input sm" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="input sm" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="grow" />
          <button className="btn primary" onClick={() => window.print()}><Printer size={16} /> Print / PDF</button>
        </>
      }
    >
      <div className="preview-pane">
        <div className="print-area">
          {d && (
            <div className="doc a4">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{settings?.shop_name}</div>
                  <div>{settings?.shop_address}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 600, color: '#0e7a6e' }}>STATEMENT OF ACCOUNT</div>
                  <div>{formatDate(from)} to {formatDate(to)}</div>
                </div>
              </div>
              <div style={{ margin: '12px 0' }}><b>{customer.name}</b>{customer.phone && ` · ${customer.phone}`}{customer.area && ` · ${customer.area}`}</div>
              <table>
                <thead><tr><th>Date</th><th>Particulars</th><th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance</th></tr></thead>
                <tbody>
                  <tr><td>{formatDate(from)}</td><td><b>Opening balance</b></td><td /><td /><td className="r">{(d.opening / 100).toFixed(2)}</td></tr>
                  {d.entries.map((e: any) => (
                    <tr key={e.id}><td>{formatDate(e.date)}</td><td>{e.kind === 'bill' ? `Bill ${e.note}` : e.note}</td><td className="r">{e.debit_paise ? (e.debit_paise / 100).toFixed(2) : ''}</td><td className="r">{e.credit_paise ? (e.credit_paise / 100).toFixed(2) : ''}</td><td className="r">{(e.balance / 100).toFixed(2)}</td></tr>
                  ))}
                  <tr><td /><td><b>Closing balance</b></td><td /><td /><td className="r"><b>{(d.closing / 100).toFixed(2)}</b></td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Receive a payment in any mix of modes, against the customer or one of their bills (LED-3, PAY-1, PAY-2). */
export function ReceivePayment({ customer, onClose, onDone }: { customer: CustomerRow; onClose: () => void; onDone: () => void }) {
  const { t, toast } = useApp();
  const [date, setDate] = useState(istDate());
  const [amounts, setAmounts] = useState<Record<Mode, string>>({ cash: '', upi: '', card: '', bank: '', cheque: '' });
  const [refs, setRefs] = useState<Record<Mode, string>>({ cash: '', upi: '', card: '', bank: '', cheque: '' });
  const [shown, setShown] = useState<Mode[]>(['cash', 'upi']);
  const [note, setNote] = useState('');
  const [billId, setBillId] = useState<number | ''>('');
  const [bills, setBills] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/api/bills?customerId=${customer.id}&status=active&limit=30`).then((b) => setBills(b.filter((x: any) => x.credit_paise > 0)));
  }, [customer.id]);
  const parts = MODES.map((m) => ({ mode: m, amountPaise: amounts[m].trim() ? parseRupees(amounts[m]) : 0, reference: refs[m] })).filter((p) => p.amountPaise > 0);
  const total = parts.reduce((a, p) => a + p.amountPaise, 0);
  const pct = (v: number) => (total ? Math.round((v / total) * 100) : 0);
  return (
    <Modal
      title={`${t('Receive Payment')} · ${customer.name}`}
      sub={customer.balance > 0 ? `Due ${rs(customer.balance)}` : customer.balance < 0 ? `Advance ${rs(-customer.balance)}` : 'No dues'}
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button
            className="btn primary"
            disabled={!total || busy || parts.some((p) => Number.isNaN(p.amountPaise))}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/payments', { customerId: customer.id, billId: billId || null, date, parts, note });
                toast(`${rs(total)} received from ${customer.name}`);
                onDone();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('Save')} {total > 0 && rs(total, false)}
          </button>
        </>
      }
    >
      <div className="row wrap gap-4">
        {MODES.map((m) => (
          <button key={m} className={`chip ${shown.includes(m) ? 'on' : ''}`} onClick={() => setShown(shown.includes(m) ? shown.filter((x) => x !== m) : [...shown, m])}>{MODE_LABEL[m]}</button>
        ))}
      </div>
      {shown.map((m, i) => (
        <div key={m} className="row">
          <Field label={`${MODE_LABEL[m]} ₹`}>
            <input className="input num" inputMode="decimal" value={amounts[m]} autoFocus={i === 0} onChange={(e) => setAmounts({ ...amounts, [m]: e.target.value })} />
          </Field>
          {m !== 'cash' && (
            <Field label={m === 'cheque' ? 'Cheque no. / bank' : m === 'card' ? 'Card last 4' : 'Reference no.'}>
              <input className="input" value={refs[m]} onChange={(e) => setRefs({ ...refs, [m]: e.target.value })} />
            </Field>
          )}
        </div>
      ))}
      {parts.length > 1 && <div className="muted">{parts.map((p) => `${pct(p.amountPaise)}% ${MODE_LABEL[p.mode]}`).join(' · ')}</div>}
      <div className="grid grid-2">
        <Field label={t('Date')}><input type="date" className="input" value={date} max={istDate()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Against bill (optional)">
          <select className="input" value={billId} onChange={(e) => setBillId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— Their account —</option>
            {bills.map((b) => <option key={b.id} value={b.id}>{b.number} · {rs(b.credit_paise, false)} on credit</option>)}
          </select>
        </Field>
      </div>
      <Field label={t('Note')}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {customer.balance > 0 && total > 0 && <div className="muted">New balance: <b className="num">{rs(customer.balance - total)}</b></div>}
    </Modal>
  );
}
