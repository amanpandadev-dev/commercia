import { useEffect, useState, type ReactNode } from 'react';
import { Mail, Copy, Printer } from 'lucide-react';
import { api, ApiError } from '../api';

type Stage = 'start' | 'code' | 'qr' | 'codes';

/**
 * Setting up an authenticator app: first a one-time enrolment code (from the Admin or an Owner, or emailed), then the
 * QR code and its first code, then the recovery codes, which are shown once. Used on the login screen and in Settings.
 */
export function AuthenticatorSetup({ canEmail: given, onFinished, footer }: { canEmail?: boolean; onFinished: () => void; footer?: ReactNode }) {
  const [fetched, setFetched] = useState(false);
  const canEmail = given ?? fetched;
  const [stage, setStage] = useState<Stage>('start');
  const [qr, setQr] = useState<{ secret: string; qr: string } | null>(null);
  const [enrolCode, setEnrolCode] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setErr('');
    try {
      setQr(await api.post('/api/auth/totp/enroll'));
      setStage('qr');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'enrol_code_required') setStage('code');
      else setErr((e as Error).message);
    }
  };
  useEffect(() => {
    begin();
    if (given === undefined) api.get('/api/auth/state').then((st) => setFetched(!!st.emailEnabled)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitEnrolCode = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.post('/api/auth/totp/enrol-code', { code: enrolCode });
      await begin();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const emailMe = async () => {
    setErr('');
    try {
      const r = await api.post('/api/auth/totp/enrol-code/email');
      setNote(r.via === 'email' ? 'A code was emailed to the address on your account. It works for 30 minutes.' : 'Email is not set up here. Ask the Admin or an Owner for a code.');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const confirm = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await api.post('/api/auth/totp/confirm', { code });
      setRecovery(r.recoveryCodes);
      setStage('codes');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'codes') {
    return (
      <div className="col gap-16">
        <h2 style={{ fontSize: 20 }}>Keep your recovery codes</h2>
        <p className="muted" style={{ margin: 0 }}>If you lose your phone, each of these logs you in once, in place of an authenticator code. They are shown only now. Write them down or print them, and keep them somewhere safe, apart from your phone.</p>
        <div className="print-area" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontFamily: 'monospace', fontSize: 15, background: 'var(--surface-2, #f3f4f6)', padding: 12, borderRadius: 8 }}>
          {recovery.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="row wrap">
          <button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(recovery.join('\n'))}><Copy size={14} /> Copy</button>
          <button type="button" className="btn sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
        </div>
        <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes</label>
        <button type="button" className="btn primary big" disabled={!saved} onClick={onFinished}>Continue</button>
      </div>
    );
  }

  if (stage === 'code') {
    return (
      <form className="col gap-16" onSubmit={(e) => { e.preventDefault(); submitEnrolCode(); }}>
        <h2 style={{ fontSize: 20 }}>Set up your authenticator</h2>
        <p className="muted" style={{ margin: 0 }}>First, a one-time enrolment code, to show it is really you. Ask the Admin or an Owner to make one for you (under Users), or have one emailed to the address on your account.</p>
        <input className="input" value={enrolCode} onChange={(e) => setEnrolCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" autoComplete="one-time-code" autoFocus style={{ letterSpacing: 3, fontSize: 18 }} maxLength={12} aria-label="Enrolment code" />
        {note && <div className="banner info">{note}</div>}
        {err && <div className="err">{err}</div>}
        <button className="btn primary big" disabled={busy || !enrolCode.trim()}>Continue</button>
        {canEmail && <button type="button" className="btn ghost" onClick={emailMe}><Mail size={15} /> Email me a code</button>}
        {footer}
      </form>
    );
  }

  return (
    <form className="col gap-16" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
      <h2 style={{ fontSize: 20 }}>Set up your authenticator</h2>
      <p className="muted" style={{ margin: 0 }}>
        Owners and the Admin confirm each login with a code. Scan this with Google Authenticator, Microsoft Authenticator or any TOTP app, then type the code it shows.
      </p>
      {qr && (
        <div className="row top">
          <img src={qr.qr} alt="QR code for your authenticator app" width={160} height={160} style={{ borderRadius: 8, background: '#fff' }} />
          <div className="col gap-4">
            <span className="label-sm">Or type this key</span>
            <code style={{ wordBreak: 'break-all', fontSize: 13 }}>{qr.secret.match(/.{1,4}/g)?.join(' ')}</code>
          </div>
        </div>
      )}
      <input className="input" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center' }} aria-label="6-digit code" />
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={busy || code.length !== 6}>Turn on and continue</button>
      {footer}
    </form>
  );
}
