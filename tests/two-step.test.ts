import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { setup } from './helpers';
import { newTotpSecret, totpCode } from '../server/lib/crypto';
import { readTotpSecret, sealTotpSecret } from '../server/lib/secrets';
import { setMailer } from '../server/lib/mailer';

const STEP = 30_000;

describe('authenticator: enrolment gate, replay, recovery codes', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  const ids = {} as Record<'admin' | 'owner' | 'entry', number>;
  let mails: { to: string; text: string }[] = [];

  const call = (method: string, url: string, body?: unknown, cookie = '') =>
    ctx.app.request(url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response) => ({ status: r.status, headers: r.headers, body: (await r.json().catch(() => null)) as any });
  /** Like the app's screen: follows the session cookie when it is renewed, and when a risky action asks for the password again, types it. */
  const as = (start: string) => {
    let cookie = start;
    const send = async (method: string, url: string, body: unknown) => {
      const res = await call(method, url, body, cookie);
      const renewed = res.headers.get('set-cookie')?.match(/(?:__Host-)?commercia_session=[^;]+/)?.[0];
      if (renewed) cookie = renewed;
      return json(res);
    };
    const withReauth = async (method: string, url: string, body: unknown) => {
      const r = await send(method, url, body);
      if (r.status === 403 && r.body?.code === 'reauth_required') {
        await send('POST', '/api/account/reauth', { password: 'password123' });
        return send(method, url, body);
      }
      return r;
    };
    return {
      post: (url: string, body: unknown = {}) => withReauth('POST', url, body),
      get: (url: string) => withReauth('GET', url, undefined),
      patch: (url: string, body: unknown = {}) => withReauth('PATCH', url, body),
    };
  };
  /** Password login: the cookie of a session that still needs an authenticator step. */
  const login = async (email: string, password = 'password123') => {
    const r = await call('POST', '/api/auth/login', { email, password });
    expect(r.status).toBe(200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const secretOf = async (id: number) => readTotpSecret(ctx.db.secrets, await ctx.db.k.selectFrom('users').select(['id', 'totp_secret']).where('id', '=', id).executeTakeFirstOrThrow());
  const clearBrakes = () => ctx.db.k.deleteFrom('auth_throttle').execute();
  /** Gives a person an authenticator the way a finished set-up would have. */
  const enrolled = async (id: number) => {
    const secret = newTotpSecret();
    await ctx.db.k.updateTable('users').set({ totp_secret: sealTotpSecret(ctx.db.secrets, id, secret), totp_enabled: 1, totp_last_step: null }).where('id', '=', id).execute();
    return secret;
  };
  /** A full login as someone who has an authenticator (time is not simulated, so forget which step was last used). */
  const fullLogin = async (email: string, id: number, secret: string) => {
    await ctx.db.k.updateTable('users').set({ totp_last_step: null }).where('id', '=', id).execute();
    const s = as(await login(email));
    expect((await s.post('/api/auth/totp/verify', { code: totpCode(secret) })).status).toBe(200);
    return s;
  };

  let adminSecret = '';
  let admin: ReturnType<typeof as>;
  beforeAll(async () => {
    ctx = await setup();
    await ctx.db.k.insertInto('settings').values({ key: 'require_2fa', value: '1' }).onConflict((oc) => oc.column('key').doUpdateSet({ value: '1' })).execute();
    for (const u of await ctx.db.k.selectFrom('users').select(['id', 'role']).execute()) ids[u.role] = u.id;
    adminSecret = await enrolled(ids.admin);
    admin = await fullLogin('ramesh@shop.in', ids.admin, adminSecret);
    setMailer({ sendMail: async (m) => void mails.push(m) });
  });
  afterEach(async () => {
    await clearBrakes();
    mails = [];
  });

  describe('setting one up needs an enrolment code', () => {
    it('refuses the QR to someone who only has the password', async () => {
      const sunil = as(await login('sunil@shop.in'));
      expect((await sunil.get('/api/auth/state')).body).toMatchObject({ step: 'enroll', enrol: { codeRequired: true, canEmail: true } });
      const r = await sunil.post('/api/auth/totp/enroll');
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('enrol_code_required');
      expect(r.body).not.toHaveProperty('qr');
      expect((await sunil.post('/api/auth/totp/confirm', { code: '123456' })).status).toBe(403);
      expect((await sunil.post('/api/auth/totp/enrol-code', { code: 'AAAA-BBBB' })).status).toBe(400);
    });

    it('lets an Admin hand over a one-time code that works once, only for that person, and then shows the QR', async () => {
      const made = await admin.post(`/api/users/${ids.owner}/enrolment-code`);
      expect(made.status).toBe(200);
      expect(made.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const row = await ctx.db.k.selectFrom('enrolment_codes').selectAll().where('user_id', '=', ids.owner).executeTakeFirstOrThrow();
      expect(JSON.stringify(row)).not.toContain(made.body.code.replace('-', '')); // only a hash is stored

      const amit = as(await login('amit@shop.in'));
      expect((await amit.post('/api/auth/totp/enrol-code', { code: made.body.code })).status).toBe(400); // another person's code
      const sunil = as(await login('sunil@shop.in'));
      expect((await sunil.post('/api/auth/totp/enrol-code', { code: made.body.code.toLowerCase() })).status).toBe(200);
      const qr = await sunil.post('/api/auth/totp/enroll');
      expect(qr.status).toBe(200);
      expect(qr.body.qr).toMatch(/^data:image/);
      const again = as(await login('sunil@shop.in'));
      expect((await again.post('/api/auth/totp/enrol-code', { code: made.body.code })).status).toBe(400); // used up
    });

    it('is not open to an Entry person without a code either, and an Owner may only issue what they may manage', async () => {
      const amit = as(await login('amit@shop.in'));
      expect((await amit.post('/api/auth/totp/enroll')).status).toBe(403);
      const sunilFull = await (async () => {
        const secret = await enrolled(ids.owner);
        return fullLogin('sunil@shop.in', ids.owner, secret);
      })();
      expect((await sunilFull.post(`/api/users/${ids.admin}/enrolment-code`)).status).toBe(403); // not an Owner's to manage
      expect((await sunilFull.post(`/api/users/${ids.entry}/enrolment-code`)).status).toBe(200);
      expect((await amit.post(`/api/users/${ids.entry}/enrolment-code`)).status).toBe(403);
      await ctx.db.k.updateTable('users').set({ totp_secret: null, totp_enabled: 0 }).where('id', '=', ids.owner).execute();
    });

    it('can be emailed to the address on the account (proof of email control), and expires', async () => {
      const amit = as(await login('amit@shop.in'));
      expect((await amit.post('/api/auth/totp/enrol-code/email')).body).toEqual({ via: 'email', sentTo: 'a***@shop.in' }); // masked: enough to recognise, not to learn it
      expect(mails).toHaveLength(1);
      expect(mails[0].to).toBe('amit@shop.in');
      const code = mails[0].text.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)![1];
      await ctx.db.k.updateTable('enrolment_codes').set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where('user_id', '=', ids.entry).execute();
      expect((await amit.post('/api/auth/totp/enrol-code', { code })).status).toBe(400); // too late
      await amit.post('/api/auth/totp/enrol-code/email');
      const fresh = mails.at(-1)!.text.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)![1];
      expect((await amit.post('/api/auth/totp/enrol-code', { code: fresh })).status).toBe(200);
    });

    it('answers "admin" when email is not set up, and tries are limited', async () => {
      setMailer(null);
      const amit = as(await login('amit@shop.in'));
      expect((await amit.post('/api/auth/totp/enrol-code/email')).body).toEqual({ via: 'admin' });
      for (let i = 0; i < 5; i++) expect((await amit.post('/api/auth/totp/enrol-code', { code: 'AAAA-BBBB' })).status).toBe(400);
      expect((await amit.post('/api/auth/totp/enrol-code', { code: 'AAAA-BBBB' })).status).toBe(429);
      setMailer({ sendMail: async (m) => void mails.push(m) });
    });

    it('is first-time-setup free for the Admin who sets the shop up, and a reset of the authenticator needs a new code', async () => {
      const code = (await admin.patch(`/api/users/${ids.entry}`, { resetTotp: true }));
      expect(code.status).toBe(200);
      expect(code.body.enrolment.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const amit = as(await login('amit@shop.in'));
      expect((await amit.post('/api/auth/totp/enroll')).status).toBe(403); // the window is not open again
      expect((await amit.post('/api/auth/totp/enrol-code', { code: code.body.enrolment.code })).status).toBe(200);
      expect((await amit.post('/api/auth/totp/enroll')).status).toBe(200);
    });
  });

  describe('a code is never accepted twice', () => {
    it('rejects the same step again, and the earlier ones, but takes the next', async () => {
      const secret = await enrolled(ids.entry);
      await ctx.db.k.updateTable('users').set({ totp_last_step: null }).where('id', '=', ids.entry).execute();
      const now = Date.now();
      const first = as(await login('amit@shop.in'));
      expect((await first.post('/api/auth/totp/verify', { code: totpCode(secret, now) })).status).toBe(200);
      const replay = as(await login('amit@shop.in')); // someone who saw the code over a shoulder
      expect((await replay.post('/api/auth/totp/verify', { code: totpCode(secret, now) })).status).toBe(401);
      expect((await replay.post('/api/auth/totp/verify', { code: totpCode(secret, now - STEP) })).status).toBe(401); // an earlier step
      const next = as(await login('amit@shop.in'));
      expect((await next.post('/api/auth/totp/verify', { code: totpCode(secret, now + STEP) })).status).toBe(200);
      const log = (await admin.get('/api/activity')).body.map((a: any) => a.summary).join('\n');
      expect(log).toMatch(/An authenticator code was used a second time for Amit Kumar/);
    });

    it('lets only one of two simultaneous tries with the same code through', async () => {
      const secret = await enrolled(ids.entry);
      await ctx.db.k.updateTable('users').set({ totp_last_step: null }).where('id', '=', ids.entry).execute();
      const a = as(await login('amit@shop.in'));
      const b = as(await login('amit@shop.in'));
      const code = totpCode(secret);
      const results = await Promise.all([a.post('/api/auth/totp/verify', { code }), b.post('/api/auth/totp/verify', { code })]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('limits guessing: five wrong codes lock the codes, even for the right one', async () => {
      const secret = await enrolled(ids.entry);
      await ctx.db.k.updateTable('users').set({ totp_last_step: null }).where('id', '=', ids.entry).execute();
      const s = as(await login('amit@shop.in'));
      for (let i = 0; i < 5; i++) expect((await s.post('/api/auth/totp/verify', { code: '000000' })).status).toBe(401);
      const locked = await s.post('/api/auth/totp/verify', { code: totpCode(secret) });
      expect(locked.status).toBe(429);
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    });
  });

  describe('recovery codes', () => {
    let secret = '';
    let codes: string[] = [];

    it('are given once, when the authenticator is confirmed', async () => {
      await ctx.db.k.updateTable('users').set({ totp_secret: null, totp_enabled: 0 }).where('id', '=', ids.entry).execute();
      const issued = await admin.post(`/api/users/${ids.entry}/enrolment-code`);
      const amit = as(await login('amit@shop.in'));
      await amit.post('/api/auth/totp/enrol-code', { code: issued.body.code });
      const qr = await amit.post('/api/auth/totp/enroll');
      secret = qr.body.secret;
      expect((await ctx.db.k.selectFrom('users').select(['totp_secret', 'totp_pending']).where('id', '=', ids.entry).executeTakeFirstOrThrow()).totp_secret).toBeNull(); // not live until confirmed
      expect((await amit.post('/api/auth/totp/confirm', { code: '000000' })).status).toBe(400);
      const done = await amit.post('/api/auth/totp/confirm', { code: totpCode(secret) });
      expect(done.status).toBe(200);
      codes = done.body.recoveryCodes;
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      expect(codes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c))).toBe(true);
      expect((await amit.get('/api/account/security')).body).toEqual({ totpEnabled: true, recoveryLeft: 10 });
      const stored = JSON.stringify(await ctx.db.k.selectFrom('recovery_codes').selectAll().execute());
      for (const c of codes) expect(stored).not.toContain(c.replace('-', '')); // only hashes
      expect((await ctx.db.k.selectFrom('users').select('totp_pending').where('id', '=', ids.entry).executeTakeFirstOrThrow()).totp_pending).toBeNull();
    });

    it('let you in once each, in any case or spacing, and the Owners and Admin are told', async () => {
      await ctx.db.k.updateTable('users').set({ totp_last_step: null }).where('id', '=', ids.entry).execute();
      const s = as(await login('amit@shop.in'));
      expect((await s.post('/api/auth/totp/recover', { code: codes[0].toLowerCase().replace('-', ' ') })).body).toMatchObject({ ok: true, left: 9 });
      expect((await s.get('/api/auth/state')).body.step).toBe('done');
      const again = as(await login('amit@shop.in'));
      expect((await again.post('/api/auth/totp/recover', { code: codes[0] })).status).toBe(401); // used
      expect((await again.post('/api/auth/totp/recover', { code: codes[1] })).body.left).toBe(8);
      expect(mails.some((m) => /logged in with a recovery code/.test(m.text) && m.to === 'sunil@shop.in')).toBe(true);
      expect((await admin.get('/api/security')).body.events.some((e: any) => e.action === 'recovery_used')).toBe(true);
    });

    it('are limited like any code, and replaced when you ask (with your password)', async () => {
      const s = as(await login('amit@shop.in'));
      for (let i = 0; i < 5; i++) expect((await s.post('/api/auth/totp/recover', { code: 'AAAAA-BBBBB' })).status).toBe(401);
      expect((await s.post('/api/auth/totp/recover', { code: codes[2] })).status).toBe(429);
      await clearBrakes();
      await s.post('/api/auth/totp/recover', { code: codes[2] });
      expect((await s.post('/api/account/recovery-codes', { password: 'wrong' })).status).toBe(400);
      const fresh = await s.post('/api/account/recovery-codes', { password: 'password123' });
      expect(fresh.body.recoveryCodes).toHaveLength(10);
      expect((await s.get('/api/account/security')).body.recoveryLeft).toBe(10);
      const other = as(await login('amit@shop.in'));
      expect((await other.post('/api/auth/totp/recover', { code: codes[3] })).status).toBe(401); // the old set is dead
    });

    it('are cancelled when the authenticator is reset', async () => {
      await admin.patch(`/api/users/${ids.entry}`, { resetTotp: true });
      expect((await ctx.db.k.selectFrom('recovery_codes').selectAll().where('user_id', '=', ids.entry).execute()).length).toBe(0);
    });
  });

  it('keeps a half-finished replacement from breaking the authenticator in use', async () => {
    const secret = await enrolled(ids.entry);
    const s = await fullLogin('amit@shop.in', ids.entry, secret);
    expect((await s.post('/api/auth/totp/enroll')).status).toBe(200); // starts a new one, but...
    expect(await secretOf(ids.entry)).toBe(secret); // ...the old one still works until the new one is confirmed
  });
});
