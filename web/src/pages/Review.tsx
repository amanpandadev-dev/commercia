import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../state';
import { Empty } from '../components/ui';
import { rs, dateTimeOf } from '../format';
import { addDays, istDate } from '../../../shared/dates';

/** Owners review the Entry person's work (REP-4), flagged bills (RATE-6) and shortage reports (LOSS-2). */
export function Review() {
  const { toast, reloadCounts, counts, reloadCatalog } = useApp();
  const nav = useNavigate();
  const [from, setFrom] = useState(addDays(istDate(), -1));
  const [to, setTo] = useState(istDate());
  const [userId, setUserId] = useState('');
  const [d, setD] = useState<any>(null);
  const load = () => api.get(`/api/reports/review?from=${from}&to=${to}${userId ? `&userId=${userId}` : ''}`).then(setD);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, userId]);
  if (!d) return <div className="muted">Loading…</div>;
  const decideLoss = async (id: number, confirm: boolean) => {
    await api.post(`/api/losses/${id}/confirm`, { confirm });
    toast(confirm ? 'Loss confirmed — stock reduced' : 'Report dismissed');
    load();
    reloadCounts();
    reloadCatalog();
  };
  return (
    <>
      {counts.pendingRates > 0 && <div className="banner"><Link to="/rates?tab=approvals" style={{ color: 'inherit' }}><b>{counts.pendingRates}</b> rate change(s) are waiting for approval →</Link></div>}
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h3>Bills to check</h3><span className="muted" style={{ fontSize: 12 }}>Rate awaiting approval, or corrected after a rejected rate</span></div>
          {d.flagged.length === 0 ? <Empty>Nothing flagged</Empty> : d.flagged.map((b: any) => (
            <div key={b.id} className="list-item" onClick={() => nav(`/bills/${b.id}`)}>
              <div className="grow"><b style={{ fontWeight: 600 }}>{b.number}</b> <span className="muted">{b.customer_name || 'Walk-in'}</span><div className="faint" style={{ fontSize: 12 }}>{b.bill_date} · {b.by}</div></div>
              <span className="num">{rs(b.total_paise, false)}</span>
              {b.rate_pending ? <span className="tag warn">rate pending</span> : <span className="tag info">corrected</span>}
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-head"><h3>Shortage reports</h3><span className="muted" style={{ fontSize: 12 }}>Stock changes only when you confirm</span></div>
          {d.reported.length === 0 ? <Empty>No reports waiting</Empty> : d.reported.map((l: any) => (
            <div key={l.id} className="list-item" style={{ cursor: 'default' }}>
              <div className="grow"><b style={{ fontWeight: 500, textTransform: 'capitalize' }}>{l.reason}</b> <span className="muted">· {l.date} · {l.by}</span><div className="faint" style={{ fontSize: 12 }}>{l.notes || ' '}{l.value_paise ? ` · ${rs(l.value_paise)}` : ''}</div></div>
              <button className="btn sm" onClick={() => decideLoss(l.id, false)}>Dismiss</button>
              <button className="btn sm primary" onClick={() => decideLoss(l.id, true)}>Confirm</button>
            </div>
          ))}
          <div className="card-pad"><Link to="/losses">All losses →</Link></div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Entry person's work</h3>
          <div className="row wrap">
            <input type="date" className="input sm" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" className="input sm" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
            <select className="input sm" style={{ width: 'auto' }} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">All entry people</option>
              {d.entryUsers.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>
              {d.activity.map((a: any) => (
                <tr key={a.id} className={a.entity === 'bill' ? 'click' : ''} onClick={() => a.entity === 'bill' && nav(`/bills/${a.entity_id}`)}>
                  <td className="nowrap muted">{dateTimeOf(a.created_at)}</td>
                  <td>{a.by}</td>
                  <td>{a.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.activity.length === 0 && <Empty>No entries in this period</Empty>}
        </div>
      </div>
    </>
  );
}
