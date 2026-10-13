import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, X, CheckCheck } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../state';
import { Empty, Seg } from '../components/ui';
import { rs, unitShort, dateTimeOf } from '../format';
import { parseRupees } from '../../../shared/money';
import { istDate, shortDate } from '../../../shared/dates';

export function Rates() {
  const { can, t, counts } = useApp();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'update' | 'approvals' | 'history'>(params.get('tab') === 'approvals' && can('rates.approve') ? 'approvals' : 'update');
  return (
    <>
      <div className="tabs">
        <button className={tab === 'update' ? 'on' : ''} onClick={() => setTab('update')}>{t('Update rates')}</button>
        {can('rates.approve') && <button className={tab === 'approvals' ? 'on' : ''} onClick={() => setTab('approvals')}>{t('Pending approvals')} {counts.pendingRates > 0 && <span className="badge">{counts.pendingRates}</span>}</button>}
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>{t('History')}</button>
      </div>
      {tab === 'update' && <UpdateRates />}
      {tab === 'approvals' && <Approvals />}
      {tab === 'history' && <RequestHistory />}
    </>
  );
}

/** All items with today's rate per unit, most-sold first; edit many at once; "No change today" confirms the rest (RATE-4). */
function UpdateRates() {
  const { products, categories, can, toast, reloadCatalog, reloadCounts, lang } = useApp();
  const [date, setDate] = useState(istDate());
  const [cat, setCat] = useState<string>('');
  const [list, setList] = useState<'retail' | 'wholesale'>('retail');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [rates, setRates] = useState(products);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (date === istDate()) setRates(products);
    else api.get(`/api/catalog?date=${date}`).then((d) => setRates(d.products));
    api.get<string[]>(`/api/rates/checks?date=${date}`).then((x) => setChecked(new Set(x)));
  }, [date, products]);

  const rows = useMemo(() => {
    const ps = [...rates].filter((p) => !cat || p.categoryPath[0] === cat).sort((a, b) => b.freq - a.freq || a.nameEn.localeCompare(b.nameEn));
    return ps.flatMap((p) => p.units.map((u) => ({ p, u, key: `${u.id}:${list}`, current: list === 'wholesale' ? (u.wholesale ?? u.retail) : u.retail })));
  }, [rates, cat, list]);

  const changes = rows
    .filter((r) => edits[r.key]?.trim() && parseRupees(edits[r.key]) !== r.current && !Number.isNaN(parseRupees(edits[r.key])))
    .map((r) => ({ unitId: r.u.id, list, pricePaise: parseRupees(edits[r.key]) }));

  const submit = async (confirmRest: boolean) => {
    setBusy(true);
    try {
      const changedIds = new Set(changes.map((c) => c.unitId));
      const confirm = confirmRest ? rows.filter((r) => !changedIds.has(r.u.id) && !checked.has(r.key)).map((r) => ({ unitId: r.u.id, list })) : [];
      const res = await api.post('/api/rates/bulk', { date, changes, confirmUnitIds: confirm });
      toast(`${res.applied} rate(s) changed${res.requested ? `, ${res.requested} sent to an Owner for approval` : ''}${confirm.length ? `, ${confirm.length} confirmed unchanged` : ''}`);
      setEdits({});
      await reloadCatalog();
      reloadCounts();
      api.get<string[]>(`/api/rates/checks?date=${date}`).then((x) => setChecked(new Set(x)));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row wrap">
        <input type="date" className="input" style={{ width: 'auto' }} value={date} max={istDate()} onChange={(e) => setDate(e.target.value)} />
        <Seg value={list} onChange={setList} options={[{ value: 'retail', label: 'Retail' }, { value: 'wholesale', label: 'Wholesale' }]} />
        <select className="input" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.filter((c) => c.parent_id === null).map((c) => <option key={c.id} value={c.name_en}>{c.name_en}</option>)}
        </select>
        <div className="grow" />
        {!can('price.set') && <span className="tag warn">Your changes go to an Owner for approval</span>}
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Item</th><th>Unit</th><th className="right">Rate on {shortDate(date)}</th><th className="right">New rate ₹</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="name"><b>{lang === 'hi' && r.p.nameHi ? r.p.nameHi : r.p.nameEn}</b></td>
                  <td className="muted">{unitShort(r.u, r.p)}</td>
                  <td className="right num">{rs(r.current)}</td>
                  <td className="right" style={{ width: 130 }}>
                    <input className="input sm num" inputMode="decimal" value={edits[r.key] ?? ''} placeholder={r.current != null ? (r.current / 100).toFixed(2) : ''} onChange={(e) => setEdits({ ...edits, [r.key]: e.target.value })} />
                  </td>
                  <td style={{ width: 40 }}>{checked.has(r.key) && <Check size={16} color="var(--ok)" aria-label="Checked today" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <Empty>No items</Empty>}
        </div>
        <div className="card-pad row wrap" style={{ borderTop: '1px solid var(--border)' }}>
          <span className="muted grow">{changes.length} changed</span>
          <button className="btn" disabled={busy || !changes.length} onClick={() => submit(false)}>Save changes</button>
          <button className="btn primary" disabled={busy} onClick={() => submit(true)}><CheckCheck size={16} /> {changes.length ? 'Save, and no change for the rest' : 'No change today'}</button>
        </div>
      </div>
    </>
  );
}

function Approvals() {
  const { toast, reloadCatalog, reloadCounts } = useApp();
  const [rows, setRows] = useState<any[] | null>(null);
  const [own, setOwn] = useState<Record<number, string>>({});
  const load = () => api.get('/api/rates/requests?status=pending').then(setRows);
  useEffect(() => {
    load();
  }, []);
  const decide = async (decisions: { id: number; approve: boolean; finalPaise?: number }[]) => {
    try {
      await api.post('/api/rates/requests/decide', { decisions });
      toast(`${decisions.length} decided`);
      await load();
      reloadCatalog();
      reloadCounts();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (!rows) return <div className="muted">Loading…</div>;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Rate changes asked by the Entry person</h3>
        {rows.length > 1 && <button className="btn sm primary" onClick={() => decide(rows.map((r) => ({ id: r.id, approve: true })))}>Approve all</button>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Item</th><th>Unit</th><th>From</th><th className="right">Old → asked</th><th>Bill</th><th>Asked by</th><th>Reject with rate ₹</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name_en} <span className="hi">{r.name_hi}</span></td>
                <td>{r.unit}{r.list === 'wholesale' && <span className="tag info"> wholesale</span>}</td>
                <td className="nowrap">{shortDate(r.for_date)}</td>
                <td className="right num nowrap">{rs(r.old_paise)} → <b>{rs(r.new_paise)}</b></td>
                <td className="muted">{r.billNumber ?? '—'}</td>
                <td className="muted">{r.requestedBy} · {dateTimeOf(r.created_at)}</td>
                <td style={{ width: 120 }}><input className="input sm num" inputMode="decimal" placeholder={(r.old_paise / 100).toFixed(2)} value={own[r.id] ?? ''} onChange={(e) => setOwn({ ...own, [r.id]: e.target.value })} /></td>
                <td className="nowrap">
                  <button className="btn sm" onClick={() => decide([{ id: r.id, approve: true }])} title="Approve"><Check size={15} /></button>{' '}
                  <button className="btn sm danger" onClick={() => decide([{ id: r.id, approve: false, finalPaise: own[r.id]?.trim() ? parseRupees(own[r.id]) : r.old_paise }])} title="Reject — use the rate typed, or keep the old rate"><X size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty>Nothing waiting. Bills are never blocked by a pending rate.</Empty>}
      </div>
      <div className="card-pad faint" style={{ fontSize: 12, borderTop: '1px solid var(--border)' }}>
        Approving makes the asked rate official from that date. Rejecting sets your rate (or keeps the old one) and corrects the bill it came from; the customer's balance is adjusted and the old version stays in the bill's history.
      </div>
    </div>
  );
}

function RequestHistory() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api.get('/api/rates/requests?status=all').then(setRows);
  }, []);
  if (!rows) return <div className="muted">Loading…</div>;
  return (
    <div className="card">
      <table className="table">
        <thead><tr><th>Item</th><th>From</th><th className="right">Old → asked → final</th><th>Status</th><th>Asked by</th><th>Decided by</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name_en} · {r.unit}</td>
              <td>{shortDate(r.for_date)}</td>
              <td className="right num">{rs(r.old_paise)} → {rs(r.new_paise)}{r.final_paise != null && <> → <b>{rs(r.final_paise)}</b></>}</td>
              <td><span className={`tag ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : 'warn'}`}>{r.status}</span></td>
              <td className="muted">{r.requestedBy}</td>
              <td className="muted">{r.decidedBy ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>No rate requests yet</Empty>}
    </div>
  );
}
