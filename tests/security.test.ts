import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { setup } from './helpers';
import { AttemptLimiter } from '../server/lib/rateLimit';

describe('guessing is slowed down, and the site is ready to sit behind a proxy', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  const login = (email: string, password: string, headers: Record<string, string> = {}) =>
    ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ email, password }) });

  beforeAll(async () => {
    ctx = await setup();
  });
  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  describe('the limiter', () => {
    it('locks after the allowed number of wrong tries, for the lock time, and not before', () => {
      const l = new AttemptLimiter(3, 60_000, 120_000);
      const t = 1_000_000;
      l.fail('a', t);
      l.fail('a', t + 1000);
      expect(() => l.check('a', t + 2000)).not.toThrow();
      l.fail('a', t + 2000);
      expect(() => l.check('a', t + 3000)).toThrow(/Try again in 2 minutes/);
      expect(() => l.check('b', t + 3000)).not.toThrow(); // another key is untouched
      expect(() => l.check('a', t + 2000 + 120_000)).not.toThrow(); // over
    });

    it('forgets old failures, and a success clears the count', () => {
      const l = new AttemptLimiter(3, 60_000, 120_000);
      l.fail('a', 0);
      l.fail('a', 1000);
      l.fail('a', 70_000); // the first two are older than the window
      expect(() => l.check('a', 71_000)).not.toThrow();
      l.clear('a');
      l.fail('a', 72_000);
      l.fail('a', 73_000);
      expect(() => l.check('a', 74_000)).not.toThrow();
    });
  });

  describe('logging in', () => {
    it('locks an account after five wrong passwords, even for the right one, with a 429', async () => {
      for (let i = 0; i < 5; i++) expect((await login('amit@shop.in', 'wrong-password')).status).toBe(401);
      const locked = await login('amit@shop.in', 'password123');
      expect(locked.status).toBe(429);
      expect(await locked.json()).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/Too many wrong attempts/) });
      expect((await login('sunil@shop.in', 'password123')).status).toBe(200); // someone else is not affected
    });

    it('counts wrong passwords for names that are not users too, so guessing names is limited', async () => {
      for (let i = 0; i < 5; i++) expect((await login('nobody@shop.in', 'x')).status).toBe(401);
      expect((await login('nobody@shop.in', 'x')).status).toBe(429);
    });

    it('starts the count again after a good login', async () => {
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 4; i++) expect((await login('ramesh@shop.in', 'wrong-password')).status).toBe(401);
        expect((await login('ramesh@shop.in', 'password123')).status).toBe(200); // never reaches five in a row
      }
    });

    it('also limits wrong authenticator codes', async () => {
      const res = await login('sunil@shop.in', 'password123');
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
      const confirm = (code: string) => ctx.app.request('/api/auth/totp/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ code }) });
      await ctx.app.request('/api/auth/totp/enroll', { method: 'POST', headers: { Cookie: cookie } });
      for (let i = 0; i < 5; i++) expect((await confirm('000000')).status).toBe(400);
      expect((await confirm('000000')).status).toBe(429);
    });
  });

  describe('behind a proxy such as Cloudflare Tunnel', () => {
    it('marks the login cookie Secure when the proxy says the visitor used https, and only if told to trust it', async () => {
      const header = { 'X-Forwarded-Proto': 'https' };
      expect((await login('ramesh@shop.in', 'password123', header)).headers.get('set-cookie')).not.toMatch(/Secure/i); // not trusted by default
      process.env.TRUST_PROXY = '1';
      expect((await login('ramesh@shop.in', 'password123', header)).headers.get('set-cookie')).toMatch(/Secure/i);
      expect((await login('ramesh@shop.in', 'password123', { 'CF-Visitor': '{"scheme":"https"}' })).headers.get('set-cookie')).toMatch(/Secure/i);
      expect((await login('ramesh@shop.in', 'password123', { 'X-Forwarded-Proto': 'http' })).headers.get('set-cookie')).not.toMatch(/Secure/i);
    });

    it('keys the address limit on the real visitor behind a trusted proxy', async () => {
      process.env.TRUST_PROXY = '1';
      const from = (ip: string) => ({ 'CF-Connecting-IP': ip });
      for (let i = 0; i < 30; i++) await login(`guess${i}@shop.in`, 'x', from('203.0.113.9'));
      expect((await login('ramesh@shop.in', 'password123', from('203.0.113.9'))).status).toBe(429); // that address is locked
      expect((await login('ramesh@shop.in', 'password123', from('198.51.100.7'))).status).toBe(200); // another visitor is not
    });
  });

  it('sends headers that stop framing and sniffing', async () => {
    const res = await ctx.app.request('/api/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
