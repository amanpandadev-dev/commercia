import { useEffect, useState, type FormEvent } from 'react';
import { Lock, WifiOff, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { translate, type Lang } from '../i18n';
import { storedLang } from '../state';
import { Avatar, Seg } from '../components/ui';
import { ROLE_LABEL, type Role } from '../../../shared/perms';

export interface AuthState {
  setupNeeded: boolean;
  shop: { name: string; nameHi: string; address: string; gstin: string };
  defaultLang: Lang;
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
          <Setup t={t} onDone={onDone} />
        ) : state.step === 'totp' ? (
          <Totp t={t} onDone={onDone} />
        ) : state.step === 'enroll' ? (
          <Enroll onDone={onDone} />
        ) : (
          <Login state={state} t={t} lang={lang} onDone={onDone} />
        )}
        <div className="row mt-16 faint" style={{ fontSize: 12 }}>
          <WifiOff size={14} /> {t('Works without internet · data stays on this PC')}
        </div>
      </div>
    </div>
  );
}

function Login({ state, t, lang, onDone }: { state: AuthState; t: (s: string) => string; lang: Lang; onDone: () => void }) {
  const [userId, setUserId] = useState<number | null>(state.users.length === 1 ? state.users[0].id : null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const many = state.users.length > 6;

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
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={busy || (!many && !userId) || !password}>
        {t('Log in')}
      </button>
    </form>
  );
}

function Totp({ t, onDone }: { t: (s: string) => string; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  return (
    <form
      className="col gap-16"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/auth/totp/verify', { code });
          onDone();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <h2 style={{ fontSize: 20 }}>
        <ShieldCheck size={20} style={{ verticalAlign: -3 }} /> Authenticator code
      </h2>
      <p className="muted" style={{ margin: 0 }}>Open your authenticator app and type the 6-digit code for Commercia.</p>
      <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }} />
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={code.length !== 6}>{t('Log in')}</button>
      <button type="button" className="btn ghost" onClick={async () => { await api.post('/api/auth/logout'); onDone(); }}>Use another account</button>
    </form>
  );
}

/** Owners and the Admin set up an authenticator app on first login (AUTH-2). */
function Enroll({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.post('/api/auth/totp/enroll').then(setData).catch((e) => setErr(e.message));
  }, []);
  return (
    <form
      className="col gap-16"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/auth/totp/confirm', { code });
          onDone();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <h2 style={{ fontSize: 20 }}>Set up your authenticator</h2>
      <p className="muted" style={{ margin: 0 }}>
        Owners and the Admin confirm each login with a code. Scan this with Google Authenticator, Microsoft Authenticator or any TOTP app, then type the code it shows.
      </p>
      {data && (
        <div className="row top">
          <img src={data.qr} alt="QR code for your authenticator app" width={160} height={160} style={{ borderRadius: 8, background: '#fff' }} />
          <div className="col gap-4">
            <span className="label-sm">Or type this key</span>
            <code style={{ wordBreak: 'break-all', fontSize: 13 }}>{data.secret.match(/.{1,4}/g)?.join(' ')}</code>
          </div>
        </div>
      )}
      <input className="input" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center' }} />
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={code.length !== 6}>Turn on and continue</button>
      <button type="button" className="btn ghost" onClick={async () => { await api.post('/api/auth/logout'); onDone(); }}>Log out</button>
    </form>
  );
}

function Setup({ t, onDone }: { t: (s: string) => string; onDone: () => void }) {
  const [f, setF] = useState({ shopName: '', name: '', email: '', password: '' });
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
      <div className="field"><label>{t('Password')} (8+ characters)</label><input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></div>
      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={!f.shopName || !f.name || !f.email || f.password.length < 8}>Create shop</button>
    </form>
  );
}
