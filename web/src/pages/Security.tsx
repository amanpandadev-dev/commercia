import { useEffect, useState } from 'react';
import { ShieldAlert, Lock } from 'lucide-react';
import { api } from '../api';
import { Empty } from '../components/ui';
import { dateTimeOf } from '../format';

interface Event {
  id: number;
  action: string;
  summary: string;
  created_at: string;
  by: string | null;
}
interface Summary {
  failedLogins: number;
  lockouts: number;
  refused: number;
  resets: number;
  exports: number;
  newDevices: number;
  locksNow: number;
}

const TYPES: { value: string; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'login_failed', label: 'Failed logins' },
  { value: 'lockout', label: 'Lockouts' },
  { value: 'refused', label: 'Refused actions' },
  { value: 'login_new_device', label: 'New devices' },
  { value: 'password_forgot', label: 'Password requests' },
  { value: 'password_reset', label: 'Password resets' },
  { value: 'totp_reset', label: 'Authenticator resets' },
  { value: 'enrolment_code', label: 'Enrolment codes' },
  { value: 'recovery_used', label: 'Recovery codes used' },
  { value: 'export', label: 'Exports' },
  { value: 'backup_download', label: 'Backup downloads' },
];
const DANGER = new Set(['lockout', 'login_failed', 'refused', 'reauth_failed', 'setup_refused']);

/** Security: what to look at if you wonder whether someone is trying to get in. Owners and the Admin. */
export function SecurityPage() {
  const [type, setType] = useState('');
  const [days, setDays] = useState('30');
  const [d, setD] = useState<{ events: Event[]; locks: { label: string; until: string; strikes: number }[]; summary: Summary } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/api/security?days=${days}${type ? `&type=${type}` : ''}`).then(setD).catch((e) => setErr(e.message));
  }, [type, days]);
  if (err) return <div className="banner danger">{err}</div>;
  if (!d) return <div className="muted">Loading…</div>;
  const s = d.summary;
  const chip = (n: number, label: string, bad = false) => <span className={`tag ${bad && n > 0 ? 'danger' : 'neutral'}`}>{n} {label}</span>;

  return (
    <>
      <div className="card card-pad col">
        <div className="row wrap">
          <ShieldAlert size={18} /> <b>Last 24 hours</b>
          {chip(s.failedLogins, 'failed logins', true)}
          {chip(s.lockouts, 'lockouts', true)}
          {chip(s.refused, 'refused actions')}
          {chip(s.newDevices, 'new devices')}
          {chip(s.resets, 'password / authenticator resets')}
          {chip(s.exports, 'exports and backup downloads')}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          A lockout is automatic and lifts itself (at most an hour). If someone is locked out and cannot wait, run <code>npm run reset-password -- their@email --unlock</code> on the shop computer.
        </div>
        {d.locks.length > 0 && (
          <div className="banner danger">
            <b><Lock size={14} /> Locked right now</b>
            {d.locks.map((l) => <div key={l.label + l.until}>{l.label}: until {dateTimeOf(l.until)}{l.strikes > 1 ? ` (locked ${l.strikes} times lately)` : ''}</div>)}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head row wrap">
          <h3>Events</h3>
          <div className="grow" />
          <select className="input sm" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select className="input sm" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period">
            <option value="1">Last day</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="365">Last year</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>
              {d.events.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{dateTimeOf(e.created_at)}</td>
                  <td>{e.by ?? <span className="faint">—</span>}</td>
                  <td><span className={`tag ${DANGER.has(e.action) ? 'danger' : 'neutral'}`} style={{ marginRight: 6 }}>{TYPES.find((t) => t.value === e.action)?.label ?? e.action}</span>{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.events.length === 0 && <Empty>Nothing here. That is good.</Empty>}
        </div>
      </div>
    </>
  );
}
