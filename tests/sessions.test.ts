import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { setup } from './helpers';
import { hashPassword, newTotpSecret, totpCode } from '../server/lib/crypto';
import { sealTotpSecret } from '../server/lib/secrets';
import { setMailer } from '../server/lib/mailer';

const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

describe('sessions', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let mails: { to: string; subject: string; text: string }[] = [];
  /** Peer 127.0.0.1 unless said otherwise. */
  const call = (method: string, url: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string>; peer?: string | null } = {}) =>
    ctx.app.request(
      url,
      { method, headers: { 'Content-Type': 'application/json', ...(o.cookie ? { Cookie: o.cookie } : {}), ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) },
      o.peer === null ? undefined : { incoming: { socket: { remoteAddress: o.peer ?? '127.0.0.1' } } },
    );
  const cookiesOf = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => [c.split('=')[0], c]));
  const pair = (res: Response, name: string) => cookiesOf(res)[name]?.split(';')[0];
  const login = (email: string, o: Parameters<typeof call>[2] = {}, password = 'password123') => call('POST', '/api/auth/login', { ...o, body: { email, password } });
  const me = async (cookie: string) => (await call('GET', '/api/account/me', { cookie })).status;

  beforeAll(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    delete process.env.TRUST_PROXY;
    delete process.env.TRUSTED_PROXIES;
    mails = [];
    await ctx.db.k.deleteFrom('auth_throttle').execute();
    setMailer(null);
  });

  describe('the cookie', () => {
    it('is HttpOnly, SameSite=Strict, Path=/ and not Secure over plain http (the shop Wi-Fi)', async () => {
      const c = cookiesOf(await login('sunil@shop.in'));
      expect(Object.keys(c)).toEqual(['commercia_session', 'commercia_device']); // the session first
      expect(c.commercia_session).toMatch(/HttpOnly/i);
      expect(c.commercia_session).toMatch(/SameSite=Strict/i);
      expect(c.commercia_session).toMatch(/Path=\//);
      expect(c.commercia_session).not.toMatch(/Secure/i);
    });

    it('is __Host- prefixed and Secure when a trusted proxy says the visitor used https, with no Domain', async () => {
      process.env.TRUST_PROXY = '1';
      const res = await login('sunil@shop.in', { headers: { 'X-Forwarded-Proto': 'https' } });
      const c = cookiesOf(res);
      expect(Object.keys(c)[0]).toBe('__Host-commercia_session');
      expect(Object.keys(c)).toEqual(expect.arrayContaining(['__Host-commercia_device', 'commercia_session'])); // (the plain cookie of an earlier http visit is cleared)
      expect(c.commercia_session).toMatch(/Max-Age=0/);
      expect(c['__Host-commercia_session']).toMatch(/Secure/);
      expect(c['__Host-commercia_session']).toMatch(/Path=\//);
      expect(c['__Host-commercia_session']).not.toMatch(/Domain/i);
      expect(c['__Host-commercia_session']).toMatch(/SameSite=Strict/i);
      expect(await me(pair(res, '__Host-commercia_session')!)).toBe(200); // and the server reads it back
      const viaCloudflare = await login('sunil@shop.in', { headers: { 'CF-Visitor': '{"scheme":"https"}' } });
      expect(Object.keys(cookiesOf(viaCloudflare))[0]).toBe('__Host-commercia_session');
    });

    it('ignores the proxy headers from anyone who is not a configured proxy', async () => {
      const headers = { 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '9.9.9.9' };
      expect(Object.keys(cookiesOf(await login('sunil@shop.in', { headers })))[0]).toBe('commercia_session'); // TRUST_PROXY is off
      process.env.TRUST_PROXY = '1';
      expect(Object.keys(cookiesOf(await login('sunil@shop.in', { headers, peer: '192.168.1.50' })))[0]).toBe('commercia_session'); // a phone on the Wi-Fi is no proxy
      const via = await login('sunil@shop.in', { headers, peer: '127.0.0.1' }); // the tunnel on this computer is
      expect(Object.keys(cookiesOf(via))[0]).toBe('__Host-commercia_session');
      process.env.TRUSTED_PROXIES = '10.1.2.3';
      expect(Object.keys(cookiesOf(await login('sunil@shop.in', { headers, peer: '10.1.2.3' })))[0]).toBe('__Host-commercia_session');
    });

    it('records the address the proxy reports, only when it is trusted', async () => {
      process.env.TRUST_PROXY = '1';
      await login('sunil@shop.in', { headers: { 'CF-Connecting-IP': '203.0.113.9' }, peer: '127.0.0.1' });
      await login('sunil@shop.in', { headers: { 'CF-Connecting-IP': '198.51.100.1' }, peer: '192.168.1.50' });
      const ips = (await ctx.db.k.selectFrom('sessions').select('ip').orderBy('created_at', 'desc').limit(2).execute()).map((r) => r.ip).sort();
      expect(ips).toEqual(['192.168.1.50', '203.0.113.9']);
    });
  });

  describe('a new token when trust grows', () => {
    it('is issued at login: the cookie from before stops working, and one planted by someone else never becomes valid', async () => {
      const first = pair(await login('sunil@shop.in'), 'commercia_session')!;
      expect(await me(first)).toBe(200);
      const second = pair(await login('sunil@shop.in', { cookie: first }), 'commercia_session')!;
      expect(second).not.toBe(first);
      expect(await me(first)).toBe(401);
      expect(await me(second)).toBe(200);
      const planted = 'commercia_session=attacker-chosen-token-attacker-chosen-token';
      const after = pair(await login('sunil@shop.in', { cookie: planted }), 'commercia_session')!;
      expect(after).not.toBe(planted);
      expect(await me(planted)).toBe(401);
    });

    it('is issued again when the second step is passed, so the half-open one cannot be used afterwards', async () => {
      const u = await ctx.db.k.selectFrom('users').select('id').where('email', '=', 'ramesh@shop.in').executeTakeFirstOrThrow();
      const secret = newTotpSecret();
      await ctx.db.k.updateTable('users').set({ totp_secret: sealTotpSecret(ctx.db.secrets, u.id, secret), totp_enabled: 1, totp_last_step: null }).where('id', '=', u.id).execute();
      const half = pair(await login('ramesh@shop.in'), 'commercia_session')!;
      expect(await me(half)).toBe(401); // not yet
      const res = await call('POST', '/api/auth/totp/verify', { cookie: half, body: { code: totpCode(secret) } });
      expect(res.status).toBe(200);
      const full = pair(res, 'commercia_session')!;
      expect(full).not.toBe(half);
      expect(await me(full)).toBe(200);
      expect(await me(half)).toBe(401);
      await ctx.db.k.updateTable('users').set({ totp_secret: null, totp_enabled: 0 }).where('id', '=', u.id).execute();
    });

    it('is issued when the password changes: other devices are signed out, this one carries on', async () => {
      const here = pair(await login('amit@shop.in'), 'commercia_session')!;
      const elsewhere = pair(await login('amit@shop.in', { headers: { 'User-Agent': UA_PHONE } }), 'commercia_session')!;
      expect(await me(elsewhere)).toBe(200);
      const res = await call('POST', '/api/account/password', { cookie: here, body: { current: 'password123', next: 'Marble-Otter-Canyon-3902' } });
      expect(res.status).toBe(200);
      const renewed = pair(res, 'commercia_session')!;
      expect(renewed).not.toBe(here);
      expect(await me(renewed)).toBe(200);
      expect(await me(here)).toBe(401);
      expect(await me(elsewhere)).toBe(401);
      await ctx.db.k.updateTable('users').set({ password_hash: hashPassword('password123') }).where('email', '=', 'amit@shop.in').execute(); // back to what the other tests use
    });
  });

  describe('your devices', () => {
    it('lists where you are signed in, names this one, and lets you end another', async () => {
      const pc = pair(await login('sunil@shop.in', { headers: { 'User-Agent': UA_PC } }), 'commercia_session')!;
      const phone = pair(await login('sunil@shop.in', { headers: { 'User-Agent': UA_PHONE } }), 'commercia_session')!;
      const list = await (await call('GET', '/api/account/sessions', { cookie: phone })).json();
      expect(list.map((s: any) => [s.device, s.current])).toEqual(expect.arrayContaining([['Chrome on Android', true], ['Edge on Windows', false]]));
      expect(JSON.stringify(list)).not.toContain(phone.split('=')[1]); // a token is never shown, only its hash
      const pcRow = list.find((s: any) => s.device === 'Edge on Windows');
      expect((await call('DELETE', `/api/account/sessions/${pcRow.id}`, { cookie: phone })).status).toBe(200);
      expect(await me(pc)).toBe(401);
      expect(await me(phone)).toBe(200);
      expect((await call('DELETE', `/api/account/sessions/${pcRow.id}`, { cookie: phone })).status).toBe(404); // already over
      expect((await call('DELETE', '/api/account/sessions/not-a-real-id', { cookie: phone })).status).toBe(404);
    });

    it("never lets you end someone else's", async () => {
      const mine = pair(await login('sunil@shop.in'), 'commercia_session')!;
      const theirs = pair(await login('amit@shop.in'), 'commercia_session')!;
      const row = await ctx.db.k.selectFrom('sessions').select('id').where('user_id', '=', (await ctx.db.k.selectFrom('users').select('id').where('email', '=', 'amit@shop.in').executeTakeFirstOrThrow()).id).executeTakeFirstOrThrow();
      expect((await call('DELETE', `/api/account/sessions/${row.id}`, { cookie: mine })).status).toBe(404);
      expect(await me(theirs)).toBe(200);
    });

    it('logs out by clearing both cookie names', async () => {
      const cookie = pair(await login('sunil@shop.in'), 'commercia_session')!;
      const out = await call('POST', '/api/auth/logout', { cookie });
      expect(out.headers.getSetCookie().join('\n')).toMatch(/commercia_session=;.*(Max-Age=0|Expires=)/s);
      expect(await me(cookie)).toBe(401);
    });
  });

  describe('a login from a device not seen before', () => {
    it('is only recorded the first time, then noticed: logged, and emailed to an Owner or Admin about their own account', async () => {
      setMailer({ sendMail: async (m) => void mails.push(m) });
      const first = await login('sunil@shop.in', { headers: { 'User-Agent': UA_PC } });
      const deviceCookie = pair(first, 'commercia_device')!;
      mails.length = 0; // (this account had used other browsers in the tests above, so the first login counted as new)
      const before = await ctx.db.k.selectFrom('activity').select('id').where('action', '=', 'login_new_device').execute();
      // The same browser again: nothing to say.
      await login('sunil@shop.in', { headers: { 'User-Agent': UA_PC }, cookie: deviceCookie });
      expect((await ctx.db.k.selectFrom('activity').select('id').where('action', '=', 'login_new_device').execute()).length).toBe(before.length);
      expect(mails).toHaveLength(0);
      // A different one.
      await login('sunil@shop.in', { headers: { 'User-Agent': UA_PHONE } });
      const log = await ctx.db.k.selectFrom('activity').select('summary').where('action', '=', 'login_new_device').orderBy('id', 'desc').executeTakeFirstOrThrow();
      expect(log.summary).toMatch(/Sunil Sharma logged in from a new device: Chrome on Android \(127\.0\.0\.1\)/);
      expect(mails.map((m) => m.to)).toEqual(['sunil@shop.in']);
      expect(mails[0].text).toMatch(/new device: Chrome on Android/);
    });

    it('is logged for an Entry person but not emailed', async () => {
      setMailer({ sendMail: async (m) => void mails.push(m) });
      await login('amit@shop.in', { headers: { 'User-Agent': UA_PC } });
      await login('amit@shop.in', { headers: { 'User-Agent': UA_PHONE } });
      expect(mails).toHaveLength(0);
      const owner = await ctx.client('sunil@shop.in');
      expect((await owner.get('/api/security')).events.some((e: any) => e.action === 'login_new_device' && /Amit Kumar/.test(e.summary))).toBe(true);
    });
  });
});
