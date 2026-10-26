import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Wallet, Plus, Pencil, Search, Undo2, Download, SlidersHorizontal } from 'lucide-react';
import { api, exportExcel } from '../api';
import { useApp } from '../state';
import { ItemsBought } from '../components/ItemsBought';
import { Avatar, Bi, Empty, Field, Modal, ReasonDialog } from '../components/ui';
import { rs, MODE_LABEL, MODES, type Mode } from '../format';
import { parseRupees } from '../../../shared/money';
import { istDate, shortDate } from '../../../shared/dates';

interface SupplierRow {
  id: number;
  name: string;
  phone: string;
  area: string;
  active: number;
  balance: number;
  lastPurchase: string | null;
  ageing: { b0: number; b30: number; b60: number; b90: number; oldest: string | null } | null;
}

/** The Purchase side of the ledger: what the shop owes each supplier. */
export function SupplierLedger() {
  const { t, can } = useApp();
  const { id } = useParams();
  const nav = useNavigate();
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [q, setQ] = useState('');
  const [dues, setDues] = useState(true);
  const [overdue, setOverdue] = useState('0');
  const [adding, setAdding] = useState(false);
  const [payFor, setPayFor] = useState<SupplierRow | null>(null);
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ ...(q.trim() && { q: q.trim() }), ...(dues && { due: '1' }), ...(overdue !== '0' && { overdue }) });
    const h = setTimeout(() => api.get<SupplierRow[]>(`/api/supplier-ledger?${qs}`).then((r) => live && (setRows(r), setReady(true))).catch(() => {}), q ? 200 : 0);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [q, dues, overdue, version]);

  const total = rows.filter((s) => s.balance > 0).reduce((a, s) => a + s.balance, 0);
  const selected = rows.find((s) => s.id === Number(id));

  return (
    <div className="split-r">
      <div className="card">
        <div className="card-head">
          <div>
            <Bi en="Suppliers" as="h3" />
            <span className="tag warn num" style={{ marginTop: 4 }}>You owe {rs(total, false)} · {rows.filter((s) => s.balance > 0).length}</span>
          </div>
          {can('supplier.edit') && <button className="btn sm" onClick={() => setAdding(true)} title="Add supplier"><Plus size={15} /></button>}
        </div>
        <div className="card-pad col" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="input-wrap">
            <Search size={16} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or area" />
          </div>
          <div className="row wrap gap-4">
            <button className={`chip ${dues ? 'on' : ''}`} onClick={() => setDues(true)}>We owe</button>
            <button className={`chip ${!dues ? 'on' : ''}`} onClick={() => setDues(false)}>All</button>
            <select className="input sm" style={{ width: 'auto' }} value={overdue} onChange={(e) => setOverdue(e.target.value)} aria-label="Overdue">
              <option value="0">Any age</option>
              <option value="30">Unpaid 30+ days</option>
              <option value="60">Unpaid 60+ days</option>
              <option value="90">Unpaid 90+ days</option>
            </select>
          </div>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {rows.map((s) => (
            <div key={s.id} className={`list-item ${s.id === selected?.id ? 'sel' : ''}`} onClick={() => nav(`/ledger/suppliers/${s.id}`)}>
              <Avatar name={s.name} />
              <div className="grow">
                <b style={{ fontWeight: 500 }}>{s.name}</b>
                <div className="faint" style={{ fontSize: 12 }}>{[s.area, s.phone && `…${s.phone.slice(-4)}`, s.ageing?.oldest && `since ${shortDate(s.ageing.oldest)}`].filter(Boolean).join(' · ') || ' '}</div>
              </div>
              <span className="num" style={{ color: s.balance > 0 ? 'var(--accent-text)' : s.balance < 0 ? 'var(--ok)' : 'var(--muted)', fontWeight: 600 }}>
                {s.balance < 0 ? `+${rs(-s.balance, false)}` : rs(s.balance, false)}
              </span>
            </div>
          ))}
          {ready && rows.length === 0 && <Empty>{q || dues || overdue !== '0' ? 'No supplier matches these filters' : 'No suppliers yet. They appear when you record a stock in, or add one with +.'}</Empty>}
        </div>
        <div className="card-pad row" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            className="btn sm"
            onClick={() =>
              exportExcel('Supplier dues', [{
                name: 'Suppliers',
                columns: [
                  { header: 'Supplier', key: 'name' }, { header: 'Phone', key: 'phone' }, { header: 'Area', key: 'area' }, { header: 'We owe', key: 'balance', type: 'money' },
                  { header: '0–30 days', key: 'b0', type: 'money' }, { header: '31–60', key: 'b30', type: 'money' }, { header: '61–90', key: 'b60', type: 'money' }, { header: 'Over 90', key: 'b90', type: 'money' },
                ],
                rows: rows.map((s) => ({ ...s, ...(s.ageing ?? {}) })),
              }])
            }
          >
            <Download size={14} /> Excel
          </button>
        </div>
      </div>

      {selected || id ? (
        <SupplierPanel key={id} supplierId={Number(id)} row={selected} onPay={(s) => setPayFor(s)} onChanged={() => setVersion((v) => v + 1)} />
      ) : (
        <div className="card card-pad col">
          <Bi en="Pay a supplier" as="h3" />
          <span className="muted">Pick a supplier to see what you owe them and what you have paid.</span>
          {can('supplier.pay') && (
            <div className="col gap-4">
              {rows.filter((s) => s.balance > 0).slice(0, 5).map((s) => (
                <button key={s.id} className="btn" style={{ justifyContent: 'space-between' }} onClick={() => setPayFor(s)}>
                  <span><Wallet size={15} /> {s.name}</span><span className="num">{rs(s.balance, false)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {adding && <SupplierForm onClose={() => setAdding(false)} onSaved={(newId) => { setAdding(false); setVersion((v) => v + 1); nav(`/ledger/suppliers/${newId}`); }} />}
      {payFor && <PaySupplier supplier={payFor} onClose={() => setPayFor(null)} onDone={() => { const sid = payFor.id; setPayFor(null); setVersion((v) => v + 1); nav(`/ledger/suppliers/${sid}`); }} />}
    </div>
  );
}

function SupplierPanel({ supplierId, row, onPay, onChanged }: { supplierId: number; row?: SupplierRow; onPay: (s: SupplierRow) => void; onChanged: () => void }) {
  const { can, toast } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [mode, setMode] = useState('');
  const [d, setD] = useState<any>(null);
  const [edit, setEdit] = useState(false);
  const [correct, setCorrect] = useState(false);
  const [reverse, setReverse] = useState<number | null>(null);

  const load = () => {
    const qs = new URLSearchParams({ ...(from && { from }), ...(to && { to }), ...(type && { type }), ...(mode && { mode }) });
    api.get(`/api/supplier-ledger/${supplierId}?${qs}`).then(setD).catch(() => setD(null));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId, from, to, type, mode, row?.balance]);

  const filtered = !!(from || to || type || mode);
  const entries = useMemo(() => d?.entries ?? [], [d]);
  if (!d) return <div className="card card-pad muted">Loading…</div>;
  const s = d.supplier;
  const asRow: SupplierRow = row ?? { ...s, balance: d.balance, lastPurchase: null, ageing: d.ageing };
  const age = d.ageing;

  return (
    <div className="card">
      <div className="card-pad row between wrap" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="row">
          <Avatar name={s.name} lg />
          <div>
            <h2 style={{ fontSize: 20 }}>{s.name}</h2>
            <div className="muted" style={{ fontSize: 12 }}>{[`Supplier since ${s.created_at.slice(0, 4)}`, s.phone, s.area].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
        <div className="card card-pad" style={{ background: 'var(--accent-soft)', border: 0, boxShadow: 'none', textAlign: 'right' }}>
          <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{d.balance < 0 ? 'Paid in advance' : 'You owe'}</div>
          <div className="num" style={{ fontSize: 24, fontWeight: 600, color: 'var(--accent-text)' }}>{rs(Math.abs(d.balance))}</div>
        </div>
      </div>
      {age && d.balance > 0 && (
        <div className="card-pad row wrap" style={{ borderBottom: '1px solid var(--border)', fontSize: 13 }}>
          <span className="muted">Ageing:</span>
          <span>0–30 days <b className="num">{rs(age.b0, false)}</b></span>
          <span>31–60 <b className="num">{rs(age.b30, false)}</b></span>
          <span>61–90 <b className="num">{rs(age.b60, false)}</b></span>
          <span className={age.b90 > 0 ? 'err' : ''}>90+ <b className="num">{rs(age.b90, false)}</b></span>
        </div>
      )}
      <div className="card-pad row wrap" style={{ alignItems: 'center' }}>
        <SlidersHorizontal size={15} className="muted" />
        <input type="date" className="input sm" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span className="muted">to</span>
        <input type="date" className="input sm" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <select className="input sm" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">Purchases and payments</option>
          <option value="purchases">Purchases only</option>
          <option value="payments">Payments only</option>
        </select>
        <select className="input sm" style={{ width: 'auto' }} value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Payment mode">
          <option value="">Any mode</option>
          {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>
        {filtered && <button className="btn sm ghost" onClick={() => { setFrom(''); setTo(''); setType(''); setMode(''); }}>Clear</button>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Particulars</th><th className="right">Bought</th><th className="right">Paid</th><th className="right">You owe</th><th /></tr></thead>
          <tbody>
            {from && !type && !mode && <tr><td>{shortDate(from)}</td><td><b style={{ fontWeight: 500 }}>Opening balance</b></td><td /><td /><td className="right num">{(d.opening / 100).toFixed(2)}</td><td /></tr>}
            {entries.map((e: any) => (
              <tr key={e.id} style={{ opacity: e.reversed ? 0.55 : 1 }}>
                <td className="nowrap">{shortDate(e.date)}</td>
                <td>
                  <b style={{ fontWeight: 500 }}>{e.note.split(' · ')[0]}</b>
                  {e.mode && <span className="tag neutral" style={{ marginLeft: 6 }}>{MODE_LABEL[e.mode]}</span>}
                  {e.reversed ? <span className="tag neutral" style={{ marginLeft: 6 }}>reversed</span> : null}
                  {e.kind === 'reversal' && <span className="tag danger" style={{ marginLeft: 6 }}>reversal</span>}
                  <div className="faint" style={{ fontSize: 12 }}>{[...e.note.split(' · ').slice(1), e.by].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="right num" style={{ color: 'var(--accent-text)' }}>{e.owed_paise ? (e.owed_paise / 100).toFixed(2) : '—'}</td>
                <td className="right num" style={{ color: 'var(--ok)' }}>{e.paid_paise ? (e.paid_paise / 100).toFixed(2) : '—'}</td>
                <td className="right num">{(e.balance / 100).toFixed(2)}</td>
                <td>{can('supplier.pay') && e.kind === 'payment' && !e.reversed && <button className="btn sm ghost" onClick={() => setReverse(e.id)} title="Reverse this payment"><Undo2 size={14} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <Empty>{filtered ? 'Nothing matches these filters' : 'No entries yet'}</Empty>}
      </div>
      {type !== 'payments' && <ItemsBought items={d.items ?? []} title={from || to ? 'Items bought in this period' : 'Items bought from this supplier'} times="deliveries" />}
      {filtered && entries.length > 0 && (
        <div className="card-pad faint" style={{ fontSize: 13 }}>
          In this view: bought <b className="num">{rs(d.totals.purchased, false)}</b> · paid <b className="num">{rs(d.totals.paid, false)}</b>. The balance column is always the real balance after that entry.
        </div>
      )}
      <div className="card-pad row wrap" style={{ borderTop: '1px solid var(--border)' }}>
        {can('supplier.pay') && <button className="btn primary" onClick={() => onPay(asRow)}><Wallet size={16} /> Pay supplier</button>}
        {can('supplier.pay') && <button className="btn" onClick={() => setCorrect(true)}>Correction</button>}
        <button
          className="btn"
          onClick={() =>
            exportExcel(`${s.name} ledger`, [{
              name: 'Ledger',
              columns: [{ header: 'Date', key: 'date' }, { header: 'Particulars', key: 'note' }, { header: 'Invoice', key: 'invoiceNo' }, { header: 'Bought', key: 'owed', type: 'money' }, { header: 'Paid', key: 'paid', type: 'money' }, { header: 'You owe', key: 'balance', type: 'money' }],
              rows: entries.map((e: any) => ({ date: e.date, note: e.note, invoiceNo: e.invoiceNo ?? '', owed: e.owed_paise, paid: e.paid_paise, balance: e.balance })),
            }, {
              name: 'Items bought',
              columns: [{ header: 'Item', key: 'name' }, { header: 'Quantity', key: 'qty' }, { header: 'Unit', key: 'unit' }, { header: 'Deliveries', key: 'times' }, { header: 'Last', key: 'last' }, { header: 'Amount', key: 'amount', type: 'money' }],
              rows: (d.items ?? []).map((i: any) => ({ name: i.name, qty: i.qtyMilli / 1000, unit: i.unit, times: i.times, last: i.lastDate, amount: i.amountPaise })),
            }])
          }
        >
          <Download size={15} /> Excel
        </button>
        <div className="grow" />
        {can('supplier.edit') && <button className="btn ghost" onClick={() => setEdit(true)}><Pencil size={15} /> Edit</button>}
      </div>
      {edit && <SupplierForm supplier={s} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); load(); }} />}
      {correct && <Correction supplierId={s.id} onClose={() => setCorrect(false)} onDone={() => { setCorrect(false); onChanged(); load(); }} />}
      {reverse && (
        <ReasonDialog
          title="Reverse this payment?"
          label="Reason (both rows stay visible in the ledger and the day book)"
          confirmText="Reverse payment"
          danger
          onClose={() => setReverse(null)}
          onConfirm={async (reason) => {
            await api.post(`/api/supplier-ledger/entries/${reverse}/reverse`, { reason });
            toast('Payment reversed');
            onChanged();
            load();
          }}
        />
      )}
    </div>
  );
}

function SupplierForm({ supplier, onClose, onSaved }: { supplier?: { id: number; name: string; phone: string; area: string }; onClose: () => void; onSaved: (id: number) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [area, setArea] = useState(supplier?.area ?? '');
  const [opening, setOpening] = useState('');
  const [asOf, setAsOf] = useState(istDate());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr('');
    const openingPaise = opening.trim() ? parseRupees(opening) : 0;
    if (Number.isNaN(openingPaise) || openingPaise < 0) return setErr('Check the opening balance');
    setBusy(true);
    try {
      const res = supplier
        ? await api.patch(`/api/suppliers/${supplier.id}`, { name, phone, area })
        : await api.post('/api/suppliers', { name, phone, area, openingPaise, asOf });
      toast(supplier ? 'Supplier saved' : 'Supplier added');
      onSaved(res.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={supplier ? `Edit ${supplier.name}` : 'Add supplier'}
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>Save</button>
        </>
      }
    >
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="grid grid-2">
        <Field label="Phone"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>
        <Field label="Area"><input className="input" value={area} onChange={(e) => setArea(e.target.value)} /></Field>
      </div>
      {!supplier && (
        <div className="grid grid-2">
          <Field label="You owe them today ₹" hint="Optional. Leave empty if nothing is pending."><input className="input num" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} /></Field>
          <Field label="As on"><input type="date" className="input" value={asOf} max={istDate()} onChange={(e) => setAsOf(e.target.value)} /></Field>
        </div>
      )}
    </Modal>
  );
}

/** Pay a supplier in any mix of modes. */
function PaySupplier({ supplier, onClose, onDone }: { supplier: SupplierRow; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [date, setDate] = useState(istDate());
  const [amounts, setAmounts] = useState<Record<Mode, string>>({ cash: '', upi: '', card: '', bank: '', cheque: '' });
  const [refs, setRefs] = useState<Record<Mode, string>>({ cash: '', upi: '', card: '', bank: '', cheque: '' });
  const [shown, setShown] = useState<Mode[]>(['cash', 'upi']);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const parts = MODES.map((m) => ({ mode: m, amountPaise: amounts[m].trim() ? parseRupees(amounts[m]) : 0, reference: refs[m] })).filter((p) => p.amountPaise > 0);
  const total = parts.reduce((a, p) => a + p.amountPaise, 0);
  return (
    <Modal
      title={`Pay supplier · ${supplier.name}`}
      sub={supplier.balance > 0 ? `You owe ${rs(supplier.balance)}` : supplier.balance < 0 ? `Paid in advance ${rs(-supplier.balance)}` : 'Nothing owed'}
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!total || busy || parts.some((p) => Number.isNaN(p.amountPaise))}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/suppliers/${supplier.id}/payments`, { date, parts, note });
                toast(`${rs(total)} paid to ${supplier.name}`);
                onDone();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save {total > 0 && rs(total, false)}
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
          <Field label={`${MODE_LABEL[m]} ₹`}><input className="input num" inputMode="decimal" value={amounts[m]} autoFocus={i === 0} onChange={(e) => setAmounts({ ...amounts, [m]: e.target.value })} /></Field>
          {m !== 'cash' && <Field label={m === 'cheque' ? 'Cheque no. / bank' : 'Reference no.'}><input className="input" value={refs[m]} onChange={(e) => setRefs({ ...refs, [m]: e.target.value })} /></Field>}
        </div>
      ))}
      <div className="grid grid-2">
        <Field label="Date"><input type="date" className="input" value={date} max={istDate()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {supplier.balance > 0 && total > 0 && <div className="muted">You will still owe: <b className="num">{rs(supplier.balance - total)}</b></div>}
    </Modal>
  );
}

function Correction({ supplierId, onClose, onDone }: { supplierId: number; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [direction, setDirection] = useState<'owed' | 'paid'>('paid');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(istDate());
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const paise = parseRupees(amount);
  return (
    <Modal
      title="Correction"
      sub="For a wrong invoice amount. The ledger is never edited; a correction row is added."
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || !(paise > 0) || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/suppliers/${supplierId}/corrections`, { date, direction, amountPaise: paise, reason });
                toast('Correction added');
                onDone();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Add correction
          </button>
        </>
      }
    >
      <Field label="Effect">
        <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'owed' | 'paid')}>
          <option value="paid">Take off what I owe (invoice was less, or a credit note)</option>
          <option value="owed">Add to what I owe (invoice was more)</option>
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="Amount ₹"><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        <Field label="Date"><input type="date" className="input" value={date} max={istDate()} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Reason (shown in the ledger)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
