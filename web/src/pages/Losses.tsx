import { useEffect, useState } from 'react';
import { Plus, Trash2, Undo2 } from 'lucide-react';
import { api } from '../api';
import { useApp, type CProduct } from '../state';
import { Empty, Field, Modal, ProductSearch } from '../components/ui';
import { rs, qty, unitShort, baseUnitOf, dateTimeOf } from '../format';
import { parseQty } from '../../../shared/money';
import { istDate } from '../../../shared/dates';

const REASONS = ['theft', 'missing', 'damaged', 'expired', 'other'] as const;
const REASON_LABEL: Record<string, string> = { theft: 'Theft', missing: 'Missing in count', damaged: 'Damaged', expired: 'Expired', other: 'Other' };

/** Losses and theft (LOSS-1..3, LOSS-5): kept apart from sales, never deleted. */
export function Losses() {
  const { can, t } = useApp();
  const [rows, setRows] = useState<any[] | null>(null);
  const [report, setReport] = useState<any[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [reversing, setReversing] = useState<any>(null);
  const load = () => {
    api.get('/api/losses').then(setRows);
    if (can('reports.view')) api.get('/api/reports/losses').then(setReport);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="row">
        <span className="muted grow">{can('loss.record') ? 'Record stolen, missing, damaged or expired goods. Stock drops at once.' : 'Report a shortage. An Owner confirms it before stock changes.'}</span>
        <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> {can('loss.record') ? t('Record loss') : t('Report shortage')}</button>
      </div>
      {report && report.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>By month and reason</h3></div>
          <table className="table">
            <thead><tr><th>Month</th><th>Reason</th><th className="right">Records</th><th className="right">Value</th></tr></thead>
            <tbody>{report.map((r) => <tr key={`${r.month}${r.reason}`}><td>{r.month}</td><td>{REASON_LABEL[r.reason]}</td><td className="right">{r.count}</td><td className="right num">{rs(r.value)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Reason</th><th>Items</th><th className="right">Value</th><th>Status</th><th>By</th><th /></tr></thead>
            <tbody>
              {(rows ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{l.date}</td>
                  <td>{l.reverses_id ? <span className="tag ok">Goods found</span> : REASON_LABEL[l.reason]}{l.notes && <div className="faint" style={{ fontSize: 12 }}>{l.notes}</div>}</td>
                  <td>{l.lines.map((x: any) => `${qty(x.qty_milli)} ${x.unit} ${x.name_en}`).join(', ')}</td>
                  <td className="right num">{rs(l.value_paise)}</td>
                  <td><span className={`tag ${l.status === 'confirmed' ? 'danger' : l.status === 'reported' ? 'warn' : 'neutral'}`}>{l.status}</span></td>
                  <td className="muted">{l.reportedBy}{l.confirmedBy && l.confirmedBy !== l.reportedBy ? ` · ✓ ${l.confirmedBy}` : ''}<div className="faint" style={{ fontSize: 11 }}>{dateTimeOf(l.created_at)}</div></td>
                  <td>{can('loss.record') && l.status === 'confirmed' && !l.reverses_id && <button className="btn sm ghost" title="Goods found" onClick={() => setReversing(l)}><Undo2 size={14} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && rows.length === 0 && <Empty>No losses recorded</Empty>}
        </div>
      </div>
      {adding && <LossForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {reversing && <LossForm reverse={reversing} onClose={() => setReversing(null)} onDone={() => { setReversing(null); load(); }} />}
    </>
  );
}

function LossForm({ reverse, onClose, onDone }: { reverse?: any; onClose: () => void; onDone: () => void }) {
  const { products, toast, reloadCatalog, can, reloadCounts } = useApp();
  const [reason, setReason] = useState<(typeof REASONS)[number]>(reverse?.reason ?? 'missing');
  const [date, setDate] = useState(istDate());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ productId: number; unitId: number; qty: string }[]>(
    reverse ? reverse.lines.map((x: any) => ({ productId: x.product_id, unitId: x.unit_id, qty: qty(x.qty_milli) })) : [],
  );
  const [err, setErr] = useState('');
  const add = (p: CProduct) => setLines([...lines, { productId: p.id, unitId: baseUnitOf(p).id, qty: '' }]);
  const save = async () => {
    const body = lines.map((l) => ({ productId: l.productId, unitId: l.unitId, qtyMilli: parseQty(l.qty) }));
    if (!body.length || body.some((l) => !(l.qtyMilli > 0))) return setErr('Add items with quantities');
    try {
      if (reverse) await api.post(`/api/losses/${reverse.id}/reverse`, { reason: notes, date, lines: body });
      else await api.post('/api/losses', { reason, date, notes, lines: body });
      toast(reverse ? 'Goods found recorded' : can('loss.record') ? 'Loss recorded' : 'Reported to the Owners');
      reloadCatalog();
      reloadCounts();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal
      wide
      title={reverse ? 'Goods found' : can('loss.record') ? 'Record a loss' : 'Report a shortage'}
      sub={reverse ? 'Restores stock; both records stay visible' : undefined}
      onClose={onClose}
      foot={<>{err && <span className="err grow">{err}</span>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={reverse && !notes.trim()}>Save</button></>}
    >
      <div className="grid grid-3">
        {!reverse && (
          <Field label="Reason">
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>{REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}</select>
          </Field>
        )}
        <Field label={reverse ? 'Date found' : 'Date discovered'}><input type="date" className="input" value={date} max={istDate()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={reverse ? 'Reason (required)' : 'Notes'}><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={reverse ? '2 bags found in the godown' : ''} /></Field>
      </div>
      {!reverse && <ProductSearch onPick={add} showPrice={false} autoFocus={false} />}
      {lines.map((l, i) => {
        const p = products.find((x) => x.id === l.productId);
        if (!p) return null;
        return (
          <div key={i} className="row">
            <span className="grow">{p.nameEn}</span>
            <input className="input sm num" style={{ width: 90 }} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <select className="input sm" style={{ width: 'auto' }} value={l.unitId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitId: Number(e.target.value) } : x)))}>
              {p.units.map((u) => <option key={u.id} value={u.id}>{unitShort(u, p)}</option>)}
            </select>
            <button className="btn ghost sm icon" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={14} /></button>
          </div>
        );
      })}
    </Modal>
  );
}
