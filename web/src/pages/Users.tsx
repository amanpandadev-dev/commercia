import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Download } from 'lucide-react';
import { api, exportExcel } from '../api';
import { useApp } from '../state';
import { Avatar, Bi, Empty, Field, Modal, Seg } from '../components/ui';
import { PayTag } from './Dashboard';
import { rs, timeOf, dateTimeOf } from '../format';
import { PERMISSIONS, ROLE_LABEL, type Role } from '../../../shared/perms';
import { istDate } from '../../../shared/dates';

const HIGHLIGHTS: { perm: keyof typeof PERMISSIONS; label: string }[] = [
  { perm: 'bill.create', label: 'Billing' },
  { perm: 'stock.in', label: 'Stock in' },
  { perm: 'price.set', label: 'Edit prices' },
  { perm: 'bill.cancel', label: 'Cancel bills' },
  { perm: 'reports.view', label: 'Reports' },
  { perm: 'settings.edit', label: 'Settings' },
  { perm: 'users.manage', label: 'Users' },
];

interface U {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  totpEnabled: boolean;
}

export function UsersPage() {
  const { me, lang, t, can } = useApp();
  const nav = useNavigate();
  const [users, setUsers] = useState<U[]>([]);
  const [bills, setBills] = useState<any[]>([]);
  const [log, setLog] = useState<any[]>([]);
  const [edit, setEdit] = useState<U | 'new' | null>(null);
  const [who, setWho] = useState('');
  const load = () => {
    api.get('/api/users').then(setUsers);
    api.get(`/api/bills?from=${istDate()}&to=${istDate()}`).then(setBills);
    if (can('activity.view')) api.get(`/api/activity?limit=300${who ? `&userId=${who}` : ''}`).then(setLog);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who]);
  return (
    <>
      <div className="grid grid-3">
        {users.map((u) => (
          <div key={u.id} className="card card-pad col" style={{ opacity: u.active ? 1 : 0.55, cursor: 'pointer' }} onClick={() => setEdit(u)}>
            <div className="row">
              <Avatar name={u.name} lg />
              <div className="grow">
                <b>{u.name}</b> {u.id === me.id && <span className="faint">(you)</span>}
                <div><span className={`tag ${u.role === 'entry' ? 'warn' : 'ok'}`}>{ROLE_LABEL[u.role][lang]}</span> {!u.active && <span className="tag neutral">Deactivated</span>} {u.totpEnabled && <span className="tag info">2-step</span>}</div>
              </div>
            </div>
            <div className="row wrap gap-4">
              {HIGHLIGHTS.map((h) => {
                const ok = (PERMISSIONS[h.perm] as readonly string[]).includes(u.role);
                return <span key={h.perm} className={`tag ${ok ? 'ok' : 'danger'}`}>{ok ? '✓' : '✕'} {h.label}</span>;
              })}
            </div>
          </div>
        ))}
        <button className="card card-pad col" style={{ alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', cursor: 'pointer', minHeight: 120 }} onClick={() => setEdit('new')}>
          <Plus size={22} />
          <Bi en="Add user" />
        </button>
      </div>

      <div className="card">
        <div className="card-head"><Bi en="Today's bills" as="h3" /></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Bill no.</th><th>Time</th><th>{t('Customer')}</th><th className="right">{t('Amount')}</th><th>Payment</th><th>Entered by</th></tr></thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id} className="click" onClick={() => nav(`/bills/${b.id}`)}>
                  <td><b style={{ fontWeight: 600 }}>{b.number}</b></td>
                  <td className="muted">{timeOf(b.created_at)}</td>
                  <td>{b.customer_name || 'Walk-in'}</td>
                  <td className="right num">{rs(b.total_paise)}</td>
                  <td><PayTag b={b} /></td>
                  <td><span className="row gap-4"><Avatar name={b.by ?? '?'} /> {b.by}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {bills.length === 0 && <Empty>No bills today yet</Empty>}
        </div>
      </div>

      {can('activity.view') && (
        <div className="card">
          <div className="card-head">
            <Bi en="Activity log" as="h3" />
            <div className="row">
              <select className="input sm" style={{ width: 'auto' }} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
                <option value="">Everyone</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <button className="btn sm" onClick={() => exportExcel('Activity log', [{ name: 'Activity', columns: [{ header: 'When', key: 'created_at' }, { header: 'Who', key: 'by' }, { header: 'Action', key: 'action' }, { header: 'What', key: 'summary' }], rows: log }])}><Download size={14} /></button>
            </div>
          </div>
          <div className="table-wrap" style={{ maxHeight: 480, overflowY: 'auto' }}>
            <table className="table">
              <tbody>
                {log.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap muted" style={{ width: 130 }}>{dateTimeOf(a.created_at)}</td>
                    <td className="nowrap" style={{ width: 150 }}>{a.by ?? 'System'}</td>
                    <td>{a.action === 'refused' ? <span className="tag danger">refused</span> : null} {a.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-pad faint" style={{ fontSize: 12, borderTop: '1px solid var(--border)' }}>The log can't be edited or deleted by anyone — the database refuses.</div>
        </div>
      )}
      {edit && <UserForm user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
    </>
  );
}

function UserForm({ user, onClose, onDone }: { user: U | null; onClose: () => void; onDone: () => void }) {
  const { me, toast } = useApp();
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? ('entry' as Role), password: '', active: user?.active ?? true });
  const [err, setErr] = useState('');
  const run = async (body: object, msg: string) => {
    setErr('');
    try {
      if (user) await api.patch(`/api/users/${user.id}`, body);
      else await api.post('/api/users', body);
      toast(msg);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const roles: Role[] = me.role === 'admin' ? ['admin', 'owner', 'entry'] : ['owner', 'entry'];
  return (
    <Modal
      title={user ? user.name : 'Add user'}
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          {user && user.id !== me.id && (
            <button className={`btn ${user.active ? 'danger' : ''}`} onClick={() => run({ active: !user.active }, user.active ? 'Deactivated and signed out' : 'Reactivated')}>
              {user.active ? 'Deactivate' : 'Reactivate'}
            </button>
          )}
          <div className="grow" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={() =>
              user
                ? run({ name: f.name, ...(f.role !== user.role && { role: f.role }), ...(f.password && { password: f.password }) }, 'Saved')
                : run({ name: f.name, email: f.email, role: f.role, password: f.password }, `${f.name} added`)
            }
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label="Email (used to log in)"><input className="input" type="email" value={f.email} disabled={!!user} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Role">
        <Seg value={f.role} onChange={(r) => setF({ ...f, role: r })} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r].en }))} />
      </Field>
      <Field label={user ? 'New password (leave empty to keep)' : 'Password (8+ characters)'} hint={user ? 'Setting a password signs them out everywhere' : undefined}>
        <input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      </Field>
      {user && (
        <div className="row wrap">
          <button className="btn sm" onClick={() => run({ signOutAll: true }, 'Signed out of all devices')}>Sign out of all devices</button>
          {user.totpEnabled && <button className="btn sm" onClick={() => run({ resetTotp: true }, 'Authenticator reset — they set it up again at next login')}>Reset authenticator</button>}
        </div>
      )}
    </Modal>
  );
}
