import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Search, Ban, History, ArrowRightLeft, CheckCheck } from 'lucide-react';
import { api, exportExcel } from '../api';
import { useApp } from '../state';
import { Empty, Modal, ReasonDialog, Seg } from '../components/ui';
import { PrintModal, type BillDetail } from '../components/BillDoc';
import { VersionList } from './Inventory';
import { PayTag } from './Dashboard';
import { rs, timeOf, PRINT_AS_LABEL } from '../format';
import { addDays, istDate } from '../../../shared/dates';

export function Bills() {
  const { t } = useApp();
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [from, setFrom] = useState(params.get('q') ? addDays(istDate(), -365) : addDays(istDate(), -7));
  const [to, setTo] = useState(istDate());
  const [status, setStatus] = useState<'' | 'estimate' | 'cancelled'>('');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams({ from, to, ...(q.trim() && { q: q.trim() }), ...(status && { status }) });
    api.get(`/api/bills?${qs}`).then(setRows).finally(() => setLoading(false));
  };
  useEffect(() => {
    const id = setTimeout(load, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, from, to, status]);

  const total = rows.filter((r) => r.status === 'active').reduce((a, r) => a + r.total_paise, 0);

  return (
    <>
      <div className="row wrap">
        <div className="input-wrap grow" style={{ maxWidth: 360 }}>
          <Search size={16} />
          <input className="input" placeholder="Bill no., paper bill no. or customer" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <input type="date" className="input" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" className="input" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <Seg value={status} onChange={setStatus} options={[{ value: '', label: t('Bills') }, { value: 'estimate', label: t('Estimate') }, { value: 'cancelled', label: t('Cancelled') }]} />
        <div className="grow" />
        <button
          className="btn"
          onClick={() =>
            exportExcel(`Bills ${from} to ${to}`, [{
              name: 'Bills',
              columns: [
                { header: 'Number', key: 'number' }, { header: 'Date', key: 'bill_date' }, { header: 'Customer', key: 'customer_name' }, { header: 'Type', key: 'print_as' },
                { header: 'Total', key: 'total_paise', type: 'money' }, { header: 'Paid', key: 'paid_paise', type: 'money' }, { header: 'Credit', key: 'credit_paise', type: 'money' },
                { header: 'Status', key: 'status' }, { header: 'Paper bill', key: 'paper_ref' }, { header: 'Entered by', key: 'by' },
              ],
              rows,
            }])
          }
        >
          Excel
        </button>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Bill no.</th><th>{t('Date')}</th><th>{t('Customer')}</th><th className="right">{t('Amount')}</th><th>Payment</th><th className="hide-sm">By</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="click" onClick={() => nav(`/bills/${r.id}`)}>
                  <td><b style={{ fontWeight: 600 }}>{r.number}</b>{r.paper_ref && <div className="faint" style={{ fontSize: 12 }}>Paper {r.paper_ref}</div>}</td>
                  <td className="nowrap">{r.bill_date} <span className="faint">{timeOf(r.created_at)}</span></td>
                  <td>
                    {r.customer_name || 'Walk-in'}
                    {r.rate_pending ? <div><span className="tag warn">{t('rate awaiting approval')}</span></div> : null}
                    {r.needs_review ? <div><span className="tag warn">needs review</span></div> : null}
                  </td>
                  <td className="right num">{rs(r.total_paise)}</td>
                  <td>{r.status === 'estimate' ? <span className="tag neutral">Estimate</span> : r.status === 'converted' ? <span className="tag neutral">Converted</span> : <PayTag b={r} />}</td>
                  <td className="hide-sm muted">{r.by}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && <tfoot><tr><td colSpan={3}>{rows.length} bills</td><td className="right num">{rs(total)}</td><td colSpan={2} /></tr></tfoot>}
          </table>
          {!loading && rows.length === 0 && <Empty>No bills in this range</Empty>}
        </div>
      </div>
      {id && <BillView id={Number(id)} onClose={() => nav('/bills' + (q ? `?q=${encodeURIComponent(q)}` : ''))} onChanged={load} />}
    </>
  );
}

function BillView({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can, toast, reloadCatalog, reloadCounts } = useApp();
  const [d, setD] = useState<BillDetail | null>(null);
  const [cancel, setCancel] = useState(false);
  const [hist, setHist] = useState(false);
  const [convert, setConvert] = useState(false);
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'credit'>('cash');
  const [err, setErr] = useState('');
  const load = () => api.get<BillDetail>(`/api/bills/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (err) return <Modal title="Bill" onClose={onClose}><div className="err">{err}</div></Modal>;
  if (!d) return null;
  const b = d.bill;
  if (hist) return <Modal wide title={`History · ${b.number}`} onClose={() => setHist(false)}><VersionList versions={d.history} /></Modal>;
  if (convert)
    return (
      <Modal
        title={`Convert ${b.number} to a bill`}
        sub={`${b.customer_name || 'Walk-in'} · ${rs(b.total_paise)} at today's date`}
        onClose={() => setConvert(false)}
        foot={
          <>
            <button className="btn" onClick={() => setConvert(false)}>Back</button>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  const res = await api.post(`/api/bills/${id}/convert`, { payments: mode === 'credit' ? [] : [{ mode, amountPaise: b.total_paise }] });
                  toast(`Converted to ${res.number}`);
                  setConvert(false);
                  load();
                  onChanged();
                  reloadCatalog();
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
            >
              Convert
            </button>
          </>
        }
      >
        <div className="muted">Same lines and rates as the estimate. Stock goes out when you convert.</div>
        <Seg value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }, ...(b.customer_id ? [{ value: 'credit' as const, label: 'Credit' }] : [])]} />
      </Modal>
    );
  if (cancel)
    return (
      <ReasonDialog
        title={`Cancel ${b.number}?`}
        label="Reason (stock and the customer's balance will be reversed; the number stays)"
        confirmText="Cancel bill"
        danger
        onClose={() => setCancel(false)}
        onConfirm={async (reason) => {
          await api.post(`/api/bills/${id}/cancel`, { reason });
          toast(`${b.number} cancelled`);
          await load();
          onChanged();
          reloadCatalog();
        }}
      />
    );
  return (
    <PrintModal
      d={d}
      onClose={onClose}
      extra={
        <>
          <span className="hide-sm muted" style={{ fontSize: 12 }}>
            {PRINT_AS_LABEL[b.print_as]} · by {(b as any).by}
            {b.status === 'cancelled' && ` · cancelled: ${b.cancel_reason}`}
            {d.converted && ` · converted to ${d.converted.number}`}
          </span>
          <button className="btn" onClick={() => setHist(true)}><History size={15} /></button>
          {b.needs_review === 1 && can('review.view') && (
            <button className="btn" onClick={async () => { await api.post(`/api/bills/${id}/reviewed`); toast('Marked as checked'); load(); onChanged(); reloadCounts(); }}><CheckCheck size={15} /> Checked</button>
          )}
          {b.status === 'estimate' && can('bill.create') && (
            <button className="btn" onClick={() => setConvert(true)}><ArrowRightLeft size={15} /> Convert to bill</button>
          )}
          {b.status === 'active' && can('bill.cancel') && <button className="btn danger" onClick={() => setCancel(true)}><Ban size={15} /> Cancel bill</button>}
        </>
      }
    />
  );
}
