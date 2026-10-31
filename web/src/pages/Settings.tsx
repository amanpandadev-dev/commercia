import { useEffect, useState } from 'react';
import { Database, Download, ShieldCheck } from 'lucide-react';
import { api, download } from '../api';
import { useApp, type Settings } from '../state';
import { Field, Modal, Seg } from '../components/ui';
import { AuthenticatorSetup } from '../components/AuthenticatorSetup';
import { BillDoc, type BillDetail } from '../components/BillDoc';
import { dateTimeOf } from '../format';
import { istDate } from '../../../shared/dates';
import { allPackKinds } from '../../../shared/units';

const SAMPLE = (shop: Settings): BillDetail => ({
  bill: {
    number: `${shop.prefix_invoice}/26-27/1042`, print_as: 'tax_invoice', status: 'active', bill_date: istDate(), created_at: new Date().toISOString(),
    customer_name: 'Sunita Devi', customer_gstin: '', subtotal_paise: 90000, discount_paise: 0, taxable_paise: 90000, cgst_paise: 1550, sgst_paise: 1550,
    round_off_paise: 0, total_paise: 93100, paid_paise: 50000, credit_paise: 43100, paper_ref: '',
  },
  lines: [
    { id: 1, name_en: 'Sugar', name_hi: 'चीनी', hsn: '1701', qty_milli: 4000, unit_name: 'kg', rate_paise: 4500, gst_bp: 500, amount_paise: 18000, taxable_paise: 18000, cgst_paise: 450, sgst_paise: 450 },
    { id: 2, name_en: 'Mustard Oil', name_hi: 'सरसों तेल', hsn: '1514', qty_milli: 2000, unit_name: 'L', rate_paise: 16000, gst_bp: 500, amount_paise: 32000, taxable_paise: 32000, cgst_paise: 800, sgst_paise: 800 },
    { id: 3, name_en: 'Toor Dal', name_hi: 'अरहर दाल', hsn: '0713', qty_milli: 2000, unit_name: 'kg', rate_paise: 14000, gst_bp: 0, amount_paise: 28000, taxable_paise: 28000, cgst_paise: 0, sgst_paise: 0 },
    { id: 4, name_en: 'Bath Soap', name_hi: 'साबुन', hsn: '3401', qty_milli: 3000, unit_name: 'pc', rate_paise: 4000, gst_bp: 500, amount_paise: 12000, taxable_paise: 12000, cgst_paise: 300, sgst_paise: 300 },
  ],
  payments: [{ id: 1, parts: [{ mode: 'upi', amount_paise: 50000, reference: '' }], reversal_of: null, at_billing: 1, total_paise: 50000, date: istDate() }],
  customer: null, balance: 168100, converted: null, history: [], shop,
});

export function SettingsPage() {
  const { t, lang, setLang, theme, setTheme, settings, reloadSettings, can, toast, me } = useApp();
  const [s, setS] = useState<Settings | null>(settings);
  const [backup, setBackup] = useState<any>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [schemeForm, setSchemeForm] = useState({ scheme: 'regular', from: istDate() });
  const [reset, setReset] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const edit = can('settings.edit');
  useEffect(() => setS(settings), [settings]);
  useEffect(() => {
    if (can('backup.run')) api.get('/api/backup').then(setBackup).catch(() => {});
  }, [can]);
  if (!s) return <div className="muted">Loading…</div>;

  const save = async (patch: Partial<Settings>) => {
    try {
      await api.patch('/api/settings', patch);
      await reloadSettings();
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const schemes: { from: string; scheme: string }[] = JSON.parse(s.gst_schemes);

  return (
    <div className="split">
      <div className="col gap-16">
        <div className="card card-pad col">
          <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{t('Appearance').toUpperCase()}</div>
          <div className="row between"><span>{t('Theme')}</span><Seg value={theme} onChange={setTheme} options={[{ value: 'light', label: t('Light') }, { value: 'dark', label: t('Dark') }]} /></div>
          <div className="row between"><span>{t('Language')}</span><Seg value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }]} /></div>
        </div>

        <div className="card card-pad col">
          <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{t('Printing').toUpperCase()}</div>
          <div className="row between"><span>{t('Paper size')}</span><Seg value={s.paper} onChange={(v) => edit && save({ paper: v })} options={[{ value: 'A4', label: 'A4' }, { value: 'thermal', label: 'Thermal 80 mm' }]} /></div>
          <div className="grid grid-3">
            <Field label="Receipt prefix"><input className="input" disabled={!edit} value={s.prefix_receipt} onChange={(e) => setS({ ...s, prefix_receipt: e.target.value })} onBlur={() => edit && save({ prefix_receipt: s.prefix_receipt })} /></Field>
            <Field label="Invoice prefix"><input className="input" disabled={!edit} value={s.prefix_invoice} onChange={(e) => setS({ ...s, prefix_invoice: e.target.value })} onBlur={() => edit && save({ prefix_invoice: s.prefix_invoice })} /></Field>
            <Field label="Estimate prefix"><input className="input" disabled={!edit} value={s.prefix_estimate} onChange={(e) => setS({ ...s, prefix_estimate: e.target.value })} onBlur={() => edit && save({ prefix_estimate: s.prefix_estimate })} /></Field>
          </div>
          <span className="faint" style={{ fontSize: 12 }}>Numbers restart each April with the year: {s.prefix_invoice}/26-27/0001.</span>
        </div>

        <div className="card card-pad col">
          <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{t('Shop').toUpperCase()}</div>
          <div className="grid grid-2">
            <Field label="Shop name"><input className="input" disabled={!edit} value={s.shop_name} onChange={(e) => setS({ ...s, shop_name: e.target.value })} /></Field>
            <Field label="Shop name (Hindi)"><input className="input" disabled={!edit} value={s.shop_name_hi} onChange={(e) => setS({ ...s, shop_name_hi: e.target.value })} /></Field>
            <Field label="Address"><input className="input" disabled={!edit} value={s.shop_address} onChange={(e) => setS({ ...s, shop_address: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" disabled={!edit} value={s.shop_phone} onChange={(e) => setS({ ...s, shop_phone: e.target.value })} /></Field>
            <Field label="GSTIN"><input className="input" disabled={!edit} value={s.shop_gstin} onChange={(e) => setS({ ...s, shop_gstin: e.target.value.toUpperCase() })} /></Field>
          </div>
          {edit && <div><button className="btn primary" onClick={() => save({ shop_name: s.shop_name, shop_name_hi: s.shop_name_hi, shop_address: s.shop_address, shop_phone: s.shop_phone, shop_gstin: s.shop_gstin })}>Save shop details</button></div>}
        </div>

        <div className="card card-pad col">
          <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{t('GST scheme').toUpperCase()}</div>
          <div className="row between">
            <span>{t('Prices include GST')}<span className="faint" style={{ display: 'block', fontSize: 12 }}>{s.prices_include_gst === '0' ? 'Bills add GST on top of the price.' : 'Shelf prices (MRP) already contain GST; the bill takes the tax back out.'}</span></span>
            <Seg value={s.prices_include_gst ?? '1'} onChange={(v) => edit && save({ prices_include_gst: v })} options={[{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }]} />
          </div>
          <div className="row between">
            <span>Default GST % for items from the products sheet<span className="faint" style={{ display: 'block', fontSize: 12 }}>The sheet has no GST column. Change a single item later in Add Product.</span></span>
            <select className="input sm" style={{ width: 'auto' }} value={s.default_gst ?? '5'} disabled={!edit} onChange={(e) => save({ default_gst: e.target.value })} aria-label="Default GST">
              {['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}
            </select>
          </div>
          <div className="col gap-4">
            {schemes.map((p) => (
              <div key={p.from} className="row"><span className="tag neutral">{p.from === '2000-01-01' ? 'From the start' : `From ${p.from}`}</span> {p.scheme === 'regular' ? 'Regular GST' : p.scheme === 'composition' ? 'Composition scheme' : 'Not registered'}</div>
            ))}
          </div>
          {can('gst.edit') && (
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="Change to">
                <select className="input" value={schemeForm.scheme} onChange={(e) => setSchemeForm({ ...schemeForm, scheme: e.target.value })}>
                  <option value="regular">Regular GST</option>
                  <option value="composition">Composition scheme</option>
                  <option value="unregistered">Not registered</option>
                </select>
              </Field>
              <Field label="From"><input type="date" className="input" value={schemeForm.from} onChange={(e) => setSchemeForm({ ...schemeForm, from: e.target.value })} /></Field>
              <button className="btn" onClick={async () => { await api.post('/api/settings/gst-scheme', schemeForm); await reloadSettings(); toast('GST scheme saved'); }}>Save</button>
            </div>
          )}
          <span className="faint" style={{ fontSize: 12 }}>Bills dated before a change keep their old type. Rates and declarations come from your accountant; Commercia stores what you enter.</span>
        </div>

        <PackTypes />

        <div className="card card-pad col">
          <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{t('Security').toUpperCase()}</div>
          {edit && (
            <label className="check">
              <input type="checkbox" checked={s.require_2fa === '1'} onChange={(e) => save({ require_2fa: e.target.checked ? '1' : '0' })} />
              Owners and the Admin must enter an authenticator code at login
            </label>
          )}
          <div className="row wrap">
            <ShieldCheck size={16} /> Your authenticator: {me.totpEnabled ? <span className="tag ok">On</span> : <span className="tag neutral">Off</span>}
            {!me.totpEnabled && <button className="btn sm" onClick={() => setEnroll(true)}>Set up</button>}
            {me.totpEnabled && <RecoveryCodes />}
          </div>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
            <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <button className="btn" disabled={!pw.current || pw.next.length < 10} onClick={async () => { try { await api.post('/api/account/password', pw); setPw({ current: '', next: '' }); toast('Password changed'); } catch (e) { toast((e as Error).message, 'error'); } }}>{t('Change password')}</button>
          </div>
          <div><button className="btn" onClick={async () => { await api.post('/api/account/logout-all'); window.location.reload(); }}>{t('Sign out of all devices')}</button></div>
        </div>

        {can('backup.run') && backup && (
          <div className="card card-pad col">
            <div className="label-sm" style={{ color: 'var(--accent-text)' }}>{t('Backup').toUpperCase()}</div>
            <div>Last backup: <b>{s.last_backup_at ? dateTimeOf(s.last_backup_at) : 'never'}</b></div>
            <div className="faint" style={{ fontSize: 12 }}>A copy is saved every night after 9 pm (and at start-up if the last one is over a day old). The last 30 are kept.</div>
            <Field label="Backup folder" hint="Point this at a USB drive or a Google Drive / OneDrive synced folder">
              <div className="row">
                <input className="input" disabled={!edit} value={s.backup_dir || backup.dir} onChange={(e) => setS({ ...s, backup_dir: e.target.value })} />
                {edit && <button className="btn" onClick={() => save({ backup_dir: s.backup_dir })}>Save</button>}
              </div>
            </Field>
            <div className="row wrap">
              <button className="btn primary big" onClick={async () => { try { const r = await api.post('/api/backup/now'); toast(`Backed up to ${r.file}`); reloadSettings(); setBackup(await api.get('/api/backup')); } catch (e) { toast((e as Error).message, 'error'); } }}><Database size={16} /> {t('Back up now')}</button>
              <button className="btn" onClick={() => download('/api/backup/download')}><Download size={16} /> Download a copy</button>
              <button className="btn" onClick={() => download('/api/admin/export.json')}><Download size={16} /> Export all data (JSON)</button>
            </div>
            {backup.files.length > 0 && <div className="faint" style={{ fontSize: 12 }}>{backup.files.length} copies in {backup.dir}. Newest: {backup.files[0].name}</div>}
          </div>
        )}

        {can('data.reset') && (
          <div className="card card-pad col" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border))' }}>
            <div className="label-sm" style={{ color: 'var(--danger)' }}>BEFORE GO-LIVE</div>
            <span className="muted">Wipe all test bills, stock, customers and products, keeping users and settings. A backup is taken first.</span>
            <div><button className="btn danger" onClick={() => setReset(true)}>Reset test data…</button></div>
          </div>
        )}
      </div>

      <div className="card card-pad col" style={{ position: 'sticky', top: 80 }}>
        <div className="row between"><b>Print preview</b><span className="muted">{s.paper === 'thermal' ? 'Thermal 80 mm' : 'A4'}</span></div>
        <div className="preview-pane"><BillDoc d={SAMPLE(s)} paper={s.paper} /></div>
      </div>

      {reset && <ResetDialog shopName={s.shop_name} onClose={() => setReset(false)} />}
      {enroll && (
        <Modal title="Set up your authenticator" onClose={() => setEnroll(false)}>
          <AuthenticatorSetup onFinished={() => window.location.reload()} />
        </Modal>
      )}
    </div>
  );
}

/** New recovery codes for a lost phone: needs the password, replaces the old set, and shows the new ones once. */
function RecoveryCodes() {
  const { toast } = useApp();
  const [left, setLeft] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/api/account/security').then((r) => setLeft(r.recoveryLeft)).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <span className="muted">{left === null ? '' : left === 0 ? 'No recovery codes left.' : `${left} recovery code${left === 1 ? '' : 's'} left.`}</span>
      <button className="btn sm" onClick={() => { setOpen(true); setCodes(null); setPassword(''); setErr(''); }}>Make new recovery codes</button>
      {open && (
        <Modal
          title="Recovery codes"
          onClose={() => { setOpen(false); load(); }}
          foot={
            codes ? <button className="btn primary" onClick={() => { setOpen(false); load(); }}>I have saved them</button> : (
              <>
                {err && <span className="err grow">{err}</span>}
                <button className="btn primary" disabled={!password} onClick={async () => { try { setCodes((await api.post('/api/account/recovery-codes', { password })).recoveryCodes); toast('New recovery codes made'); } catch (e) { setErr((e as Error).message); } }}>Make new codes</button>
              </>
            )
          }
        >
          {codes ? (
            <>
              <p className="muted" style={{ margin: 0 }}>Each works once, in place of an authenticator code, if you lose your phone. The old ones no longer work. They are shown only now: write them down and keep them safe.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontFamily: 'monospace', fontSize: 15 }}>{codes.map((c) => <span key={c}>{c}</span>)}</div>
            </>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>This makes ten new codes and cancels the ones you have. Type your password to confirm.</p>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Your password" autoFocus />
            </>
          )}
        </Modal>
      )}
    </>
  );
}

function ResetDialog({ shopName, onClose }: { shopName: string; onClose: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal
      title="Reset test data"
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger solid" disabled={confirm.trim() !== shopName.trim()} onClick={async () => { try { await api.post('/api/admin/reset', { confirm }); window.location.href = '/'; } catch (e) { setErr((e as Error).message); } }}>Wipe test data</button>
        </>
      }
    >
      <p style={{ margin: 0 }}>Type the shop name <b>{shopName}</b> to confirm. Users and settings stay; everything else is removed after a backup.</p>
      <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
    </Modal>
  );
}

/** The pack types in the product form and the dropdown of the products sheet: the built-in ones, and this shop's own. */
function PackTypes() {
  const { settings, can, toast, reloadSettings } = useApp();
  const [name, setName] = useState('');
  let custom: string[] = [];
  try {
    custom = JSON.parse(settings?.pack_types ?? '[]');
  } catch {
    /* none */
  }
  const kinds = allPackKinds(custom);
  const add = async () => {
    try {
      await api.post('/api/pack-types', { name });
      await reloadSettings();
      setName('');
      toast(`${name.trim()} added. Download the products template again to see it in the dropdown.`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card card-pad col">
      <div className="label-sm" style={{ color: 'var(--accent-text)' }}>PACK TYPES</div>
      <div className="row wrap gap-4">
        {kinds.map((k) => <span key={k.value} className={`tag ${custom.includes(k.value) ? 'info' : 'neutral'}`}>{k.name}</span>)}
        <span className="tag neutral">Loose</span>
      </div>
      <span className="faint" style={{ fontSize: 12 }}>Used in Add Product and in the Pack type dropdown of the products sheet. Loose is for things sold by the kg or litre.</span>
      {can('catalog.add') && (
        <div className="row">
          <input className="input" style={{ maxWidth: 220 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New type, e.g. sack" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) add(); }} />
          <button className="btn" onClick={add} disabled={!name.trim()}>Add</button>
        </div>
      )}
    </div>
  );
}
