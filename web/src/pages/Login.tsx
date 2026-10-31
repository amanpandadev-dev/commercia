import { useEffect, useState, type FormEvent } from 'react';
import { Lock, WifiOff, ShieldCheck, KeyRound, ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { translate, type Lang } from '../i18n';
import { storedLang } from '../state';
import { Avatar, Seg } from '../components/ui';
import { AuthenticatorSetup } from '../components/AuthenticatorSetup';
import { ROLE_LABEL, type Role } from '../../../shared/perms';

export interface AuthState {
  setupNeeded: boolean;
  setupCodeRequired: boolean;
  emailEnabled: boolean;
  enrol: { codeRequired: boolean; canEmail: boolean } | null;
  shop: { name: string; nameHi: string; address: string; gstin: string };
  defaultLang: Lang;
  /** False when this device is not the shop computer: names are not listed, and people type their email. */
  listUsers: boolean;
  users: { id: number; name: string; role: Role }[];
  me: { id: number; name: string; role: Role; lang: Lang; email: string; totpEnabled: boolean } | null;
  step: 'login' | 'totp' | 'enroll' | 'done';
}

function Logo() {
  return (
    <span className="logo" style={{ width: 30, height: 30, gap: 3 }}>
      <i /><i /><i /><i />
    </span>
  );
}

export function AuthScreen({ state, onDone }: { state: AuthState; onDone: () => void }) {
  const [lang, setLang] = useState<Lang>(storedLang() ?? state.defaultLang ?? 'en');
  const [forgot, setForgot] = useState<{ userId: number | null; email: string } | null>(null);
  const [notice, setNotice] = useState('');
  const t = (s: string) => translate(lang, s);
  const changeLang = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem('commercia.lang', l);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="row between mb-16">
          <div className="row">
            <Logo />
            <div>
              <b style={{ fontSize: 18 }}>Commercia</b>
              <div className="hi">{lang === 'hi' && state.shop.nameHi ? state.shop.nameHi : state.shop.name}</div>
            </div>
          </div>
          <Seg value={lang} onChange={changeLang} options={[{ value: 'en', label: 'EN' }, { value: 'hi', label: 'हिं' }]} />
        </div>
        {state.setupNeeded ? (
          <Setup t={t} onDone={onDone} codeRequired={state.setupCodeRequired} />
        ) : state.step === 'totp' ? (
          <Totp t={t} onDone={onDone} />
        ) : state.step === 'enroll' ? (
          <Enroll canEmail={state.emailEnabled} onDone={onDone} />
        ) : forgot ? (
          <Forgot state={state} t={t} lang={lang} start={forgot} onBack={() => setForgot(null)} onChanged={() => { setForgot(null); setNotice('Password changed. Log in with the new one.'); }} />
        ) : (
          <Login state={state} t={t} lang={lang} onDone={onDone} notice={notice} onForgot={(who) => { setNotice(''); setForgot(who); }} />
        )}
        <div className="row mt-16 faint" style={{ fontSize: 12 }}>
          <WifiOff size={14} /> {t('Works without internet · data stays on this PC')}
        </div>
      </div>
    </div>
  );
}

function Login({ state, t, lang, onDone, notice, onForgot }: { state: AuthState; t: (s: string) => string; lang: Lang; onDone: () => void; notice: string; onForgot: (who: { userId: number | null; email: string }) => void }) {
  const [userId, setUserId] = useState<number | null>(state.users.length === 1 ? state.users[0].id : null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const many = !state.listUsers || state.users.length > 6;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.post('/api/auth/login', many ? { email, password } : { userId, password });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="col gap-16">
      <h2 style={{ fontSize: 22 }}>{t('Welcome back')}</h2>
      {many ? (
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
        </div>
      ) : (
        <div className="field">
          <label>{t('Choose user')}</label>
          <div className="user-tiles">
            {state.users.map((u) => (
              <button type="button" key={u.id} className={`user-tile ${userId === u.id ? 'on' : ''}`} onClick={() => setUserId(u.id)}>
                <Avatar name={u.name} lg />
                <div>
                  <b style={{ fontWeight: 600 }}>{u.name}</b>
                  <div className="hi">{ROLE_LABEL[u.role][lang]}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="pw">{t('Password')}</label>
        <div className="input-wrap">
          <Lock size={16} />
          <input id="pw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!userId} />
        </div>
      </div>
      {notice && <div className="banner ok">{t(notice)}</div>}
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={busy || (!many && !userId) || !password}>
        {t('Log in')}
      </button>
      <button type="button" className="btn ghost" onClick={() => onForgot({ userId, email })}>
        <KeyRound size={15} /> {t('Forgot password?')}
      </button>
    </form>
  );
}

/** "Forgot password?": ask for a code (emailed, or given by the Owner), then type it with a new password. */
function Forgot({ state, t, lang, start, onBack, onChanged }: { state: AuthState; t: (s: string) => string; lang: Lang; start: { userId: number | null; email: string }; onBack: () => void; onChanged: () => void }) {
  const many = !state.listUsers || state.users.length > 6;
  const [userId, setUserId] = useState<number | null>(start.userId ?? (state.users.length === 1 ? state.users[0].id : null));
  const [email, setEmail] = useState(start.email);
  const [via, setVia] = useState<'email' | 'owner' | null>(null);
  const [haveCode, setHaveCode] = useState(false);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const who = many ? { email } : { userId };
  const stage = via || haveCode ? 'code' : 'ask';

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api.post('/api/auth/forgot', who);
      setVia(r.via);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reset = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw.length < 10) return setErr('The password must be at least 10 characters');
    if (pw !== pw2) return setErr('The two passwords are not the same');
    setBusy(true);
    try {
      await api.post('/api/auth/reset', { ...who, code, password: pw });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col gap-16">
      <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}><ArrowLeft size={14} /> {t('Back to login')}</button>
      <h2 style={{ fontSize: 22 }}>{t('Forgot password?')}</h2>
      {stage === 'ask' ? (
        <form onSubmit={ask} className="col gap-16">
          {many ? (
            <div className="field"><label>Email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
          ) : (
            <div className="field">
              <label>{t('Who forgot their password?')}</label>
              <div className="user-tiles">
                {state.users.map((u) => (
                  <button type="button" key={u.id} className={`user-tile ${userId === u.id ? 'on' : ''}`} onClick={() => setUserId(u.id)}>
                    <Avatar name={u.name} lg />
                    <div><b style={{ fontWeight: 600 }}>{u.name}</b><div className="hi">{ROLE_LABEL[u.role][lang]}</div></div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {err && <div className="err">{err}</div>}
          <button className="btn primary big" disabled={busy || (many ? !email.trim() : !userId)}>{t('Get a reset code')}</button>
          <button type="button" className="btn ghost" onClick={() => setHaveCode(true)}>{t('I already have a code')}</button>
        </form>
      ) : (
        <form onSubmit={reset} className="col gap-16">
          {via === 'email' && <div className="banner info"><div>If this address is registered, a code has been emailed to it. It works for 30 minutes. Not arrived? Ask the Owner for one.</div></div>}
          {via === 'owner' && <div className="banner info"><div>Ask the shop Owner for a reset code. They will see your request under <b>Users</b> and on their Dashboard, and read a code out to you. If you are the Admin, run <code>npm run reset-password -- your@email</code> on the shop computer.</div></div>}
          {haveCode && !via && many && <div className="field"><label>Email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>}
          {haveCode && !via && !many && (
            <div className="field">
              <label>{t('Who forgot their password?')}</label>
              <div className="user-tiles">
                {state.users.map((u) => (
                  <button type="button" key={u.id} className={`user-tile ${userId === u.id ? 'on' : ''}`} onClick={() => setUserId(u.id)}>
                    <Avatar name={u.name} lg />
                    <div><b style={{ fontWeight: 600 }}>{u.name}</b><div className="hi">{ROLE_LABEL[u.role][lang]}</div></div>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <label>{t('Reset code')}</label>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" autoComplete="one-time-code" autoFocus style={{ letterSpacing: 3, fontSize: 18 }} maxLength={12} />
          </div>
          <div className="field"><label>{t('New password')} (10+ characters)</label><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></div>
          <div className="field"><label>{t('Type it again')}</label><input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></div>
          {err && <div className="err">{err}</div>}
          <button className="btn primary big" disabled={busy || !code.trim() || !pw || (haveCode && !via && (many ? !email.trim() : !userId))}>{t('Set new password')}</button>
          <div className="faint" style={{ fontSize: 12 }}>You will be signed out everywhere. If you use an authenticator app, you still need its code to log in.</div>
        </form>
      )}
    </div>
  );
}

function Totp({ t, onDone }: { t: (s: string) => string; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [err, setErr] = useState('');
  return (
    <form
      className="col gap-16"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr('');
        try {
          await api.post(recovery ? '/api/auth/totp/recover' : '/api/auth/totp/verify', { code });
          onDone();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <h2 style={{ fontSize: 20 }}>
        <ShieldCheck size={20} style={{ verticalAlign: -3 }} /> {recovery ? 'Recovery code' : 'Authenticator code'}
      </h2>
      {recovery ? (
        <>
          <p className="muted" style={{ margin: 0 }}>Lost your phone? Type one of the recovery codes you saved when you set up the authenticator. Each works once.</p>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX" autoFocus maxLength={12} aria-label="Recovery code" style={{ fontSize: 20, letterSpacing: 3, textAlign: 'center' }} />
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>Open your authenticator app and type the 6-digit code for Commercia.</p>
          <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }} aria-label="Authenticator code" />
        </>
      )}
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={recovery ? code.replace(/[^A-Z0-9]/gi, '').length < 10 : code.length !== 6}>{t('Log in')}</button>
      <button type="button" className="btn ghost" onClick={() => { setRecovery(!recovery); setCode(''); setErr(''); }}>{recovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}</button>
      <button type="button" className="btn ghost" onClick={async () => { await api.post('/api/auth/logout'); onDone(); }}>Use another account</button>
    </form>
  );
}

/** Owners and the Admin set up an authenticator app on first login (AUTH-2): an enrolment code first, then the QR code. */
function Enroll({ canEmail, onDone }: { canEmail: boolean; onDone: () => void }) {
  return (
    <AuthenticatorSetup
      canEmail={canEmail}
      onFinished={onDone}
      footer={<button type="button" className="btn ghost" onClick={async () => { await api.post('/api/auth/logout'); onDone(); }}>Log out</button>}
    />
  );
}

function Setup({ t, onDone, codeRequired }: { t: (s: string) => string; onDone: () => void; codeRequired: boolean }) {
  const [f, setF] = useState({ shopName: '', name: '', email: '', password: '', setupCode: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="col"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/auth/setup', f);
          onDone();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <h2 style={{ fontSize: 20 }}>Set up your shop</h2>
      <p className="muted" style={{ margin: 0 }}>You'll be the Admin. You can add the owners and the entry person next.</p>
      <div className="field"><label>Shop name</label><input className="input" value={f.shopName} onChange={set('shopName')} autoFocus placeholder="Sharma Kirana Store" /></div>
      <div className="field"><label>Your name</label><input className="input" value={f.name} onChange={set('name')} /></div>
      <div className="field"><label>Email</label><input className="input" type="email" value={f.email} onChange={set('email')} autoComplete="username" /></div>
      <div className="field"><label>{t('Password')} (10+ characters)</label><input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></div>
      {codeRequired && (
        <div className="field">
          <label>Setup code</label>
          <input className="input" value={f.setupCode} onChange={(e) => setF({ ...f, setupCode: e.target.value.toUpperCase() })} placeholder="XXXX-XXXX" maxLength={12} />
          <span className="faint" style={{ fontSize: 12 }}>You are not on the shop computer. The code is shown in the window where Commercia is running there.</span>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={!f.shopName || !f.name || !f.email || f.password.length < 10 || (codeRequired && !f.setupCode.trim())}>Create shop</button>
    </form>
  );
}
