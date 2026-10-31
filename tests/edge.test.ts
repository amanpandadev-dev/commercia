import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openDb } from '../server/db/index';
import { createApp } from '../server/app';
import { CSP, RateLimiter, maxBody, requestTimeout } from '../server/lib/edge';
import { mountStatic } from '../server/lib/static';
import { hashPassword } from '../server/lib/crypto';
import { nowIso } from '../server/db/index';
import type { AppEnv } from '../server/lib/core';

/** A fresh app with one user, and a way to call it from a chosen address with chosen headers. */
async function shop(limits?: Parameters<typeof createApp>[1]) {
  const db = await openDb({ file: ':memory:' });
  await db.k.insertInto('settings').values({ key: 'require_2fa', value: '0' }).execute();
  await db.k.insertInto('users').values({ name: 'Sunil Sharma', email: 'sunil@shop.in', role: 'owner', password_hash: hashPassword('password123'), active: 1, lang: 'en', totp_enabled: 0, totp_secret: null, session_epoch: 0, created_at: nowIso() }).execute();
  const app = createApp(db, limits);
  const call = async (method: string, url: string, o: { peer?: string | null; headers?: Record<string, string>; body?: BodyInit; json?: unknown } = {}) =>
    app.request(
      url,
      { method, headers: { ...(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...o.headers }, body: o.json !== undefined ? JSON.stringify(o.json) : o.body, duplex: 'half' } as RequestInit,
      o.peer === null ? undefined : { incoming: { socket: { remoteAddress: o.peer ?? '127.0.0.1' } } },
    );
  return { db, app, call };
}

const ENV_KEYS = ['ALLOWED_IPS', 'ALLOWED_ORIGINS', 'TRUST_PROXY', 'TRUSTED_PROXIES', 'SHOW_USERS_ON_LAN'];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe('who may connect', () => {
  it('lets in this computer, the shop network and Tailscale, and nobody else', async () => {
    const { call } = await shop();
    for (const ip of ['127.0.0.1', '::1', '192.168.1.5', '10.0.0.7', '172.16.4.4', '100.64.12.1', '::ffff:192.168.1.5', 'fd12:3456::1', 'fe80::1']) expect((await call('GET', '/api/health', { peer: ip })).status, ip).toBe(200);
    for (const ip of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1']) {
      const r = await call('GET', '/api/health', { peer: ip });
      expect(r.status, ip).toBe(403);
      expect(await r.text()).toMatch(/not allowed/);
    }
  });

  it('can be narrowed or widened with ALLOWED_IPS', async () => {
    const { call } = await shop();
    process.env.ALLOWED_IPS = '192.168.1.0/24, 10.9.9.9';
    expect((await call('GET', '/api/health', { peer: '192.168.1.200' })).status).toBe(200);
    expect((await call('GET', '/api/health', { peer: '10.9.9.9' })).status).toBe(200);
    expect((await call('GET', '/api/health', { peer: '192.168.2.5' })).status).toBe(403);
    expect((await call('GET', '/api/health', { peer: '127.0.0.1' })).status).toBe(403); // not listed, so not allowed
  });

  it('checks the connection itself, never a forwarding header, so a tunnel on this computer gets through and a forged header gets nothing', async () => {
    const { call } = await shop();
    expect((await call('GET', '/api/health', { peer: '127.0.0.1', headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status).toBe(200); // the tunnel
    expect((await call('GET', '/api/health', { peer: '203.0.113.9', headers: { 'X-Forwarded-For': '192.168.1.5' } })).status).toBe(403); // a stranger saying they are local
  });
});

describe('security headers', () => {
  const must = (h: Headers) => {
    expect(h.get('content-security-policy')).toBe(CSP);
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('referrer-policy')).toBe('no-referrer');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('permissions-policy')).toMatch(/camera=\(\)/);
    expect(h.get('cross-origin-opener-policy')).toBeNull(); // over plain http (the Wi-Fi) it would only make the browser complain
    expect(h.get('origin-agent-cluster')).toBeNull();
    expect(h.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(h.get('access-control-allow-origin')).toBeNull(); // no CORS
  };

  it('has a strict Content-Security-Policy: own scripts only, no framing, no other form targets', () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("form-action 'self'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("base-uri 'self'");
  });

  it('are on every response: success, refusal, not found, a refused address, and a failed call', async () => {
    const { call } = await shop();
    must((await call('GET', '/api/health')).headers);
    must((await call('GET', '/api/account/me')).headers); // 401
    must((await call('GET', '/api/nothing-here')).headers); // 404
    must((await call('POST', '/api/auth/login', { json: { email: 'x' } })).headers); // 400
    must((await call('POST', '/api/auth/login', { json: { email: 'sunil@shop.in', password: 'wrong' } })).headers); // 401
    must((await call('GET', '/api/health', { peer: '203.0.113.9' })).headers); // 403
  });

  it('keeps everything under /api out of any cache, and sends HSTS only when the visitor is on https', async () => {
    const { call } = await shop();
    const plain = await call('GET', '/api/health');
    expect(plain.headers.get('cache-control')).toBe('no-store');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    expect((await call('GET', '/api/account/me')).headers.get('cache-control')).toBe('no-store');
    expect((await call('GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get('strict-transport-security')).toBeNull(); // not a trusted proxy
    process.env.TRUST_PROXY = '1';
    const secure = await call('GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    expect(secure.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
    expect(secure.headers.get('cross-origin-opener-policy')).toBe('same-origin'); // and over https the rest of the isolation headers
    expect(secure.headers.get('origin-agent-cluster')).toBe('?1');
  });

  it('answers an unknown address under /api with JSON, not the web page (a login is asked for first)', async () => {
    const { call } = await shop();
    expect((await call('GET', '/api/anything/at/all')).status).toBe(401);
    const login = await call('POST', '/api/auth/login', { json: { email: 'sunil@shop.in', password: 'password123' } });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const r = await call('GET', '/api/anything/at/all', { headers: { Cookie: cookie } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Not found', code: 'not_found' });
    expect((await call('GET', '/api/auth/anything')).headers.get('content-type')).toMatch(/json/);
  });
});

describe('same origin only', () => {
  const login = { json: { email: 'sunil@shop.in', password: 'password123' } };

  it('refuses a change that comes from another site, with or without cookies', async () => {
    const { call } = await shop();
    for (const origin of ['https://evil.example', 'http://localhost:9999', 'null', 'https://shop.example.com.evil.example']) {
      const r = await call('POST', '/api/auth/login', { ...login, headers: { Origin: origin, Host: 'shop.example.com' } });
      expect(r.status, origin).toBe(403);
      expect((await r.json()).code).toBe('cross_origin');
    }
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect((await call(method, '/api/users/1', { headers: { Origin: 'https://evil.example' }, ...login })).status).toBe(403);
  });

  it("allows the site's own pages, on any host name it is reached by", async () => {
    const { call } = await shop();
    expect((await call('POST', '/api/auth/login', { ...login, headers: { Origin: 'http://192.168.1.20:8787', Host: '192.168.1.20:8787' } })).status).toBe(200);
    expect((await call('POST', '/api/auth/login', { ...login, headers: { Origin: 'https://shop.example.com', Host: 'shop.example.com' } })).status).toBe(200);
    expect((await call('POST', '/api/auth/login', { ...login, headers: { Origin: 'http://localhost:8787', Host: 'localhost:8787' } })).status).toBe(200);
  });

  it('uses the proxy\'s original Host only when the proxy is trusted, and ALLOWED_ORIGINS for anything else', async () => {
    const { call } = await shop();
    const via = { Origin: 'https://shop.example.com', Host: 'localhost:8787', 'X-Forwarded-Host': 'shop.example.com' };
    expect((await call('POST', '/api/auth/login', { ...login, headers: via })).status).toBe(403); // nobody vouches for the forwarded host
    process.env.TRUST_PROXY = '1';
    expect((await call('POST', '/api/auth/login', { ...login, headers: via })).status).toBe(200);
    expect((await call('POST', '/api/auth/login', { ...login, headers: via, peer: '192.168.1.50' })).status).toBe(403); // a phone on the Wi-Fi is no proxy
    delete process.env.TRUST_PROXY;
    process.env.ALLOWED_ORIGINS = 'https://shop.example.com';
    expect((await call('POST', '/api/auth/login', { ...login, headers: { Origin: 'https://shop.example.com', Host: 'localhost:8787' } })).status).toBe(200);
  });

  it('judges a change with no Origin by Sec-Fetch-Site, and lets scripts and curl (no browser) through', async () => {
    const { call } = await shop();
    expect((await call('POST', '/api/auth/login', { ...login, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await call('POST', '/api/auth/login', { ...login, headers: { 'Sec-Fetch-Site': 'same-site' } })).status).toBe(403);
    expect((await call('POST', '/api/auth/login', { ...login, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
    expect((await call('POST', '/api/auth/login', login)).status).toBe(200);
  });

  it('never answers a preflight or sends a CORS header', async () => {
    const { call } = await shop();
    const r = await call('OPTIONS', '/api/auth/login', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('access-control-allow-methods')).toBeNull();
    const get = await call('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull(); // so the other site cannot read the answer
  });
});

describe('body size', () => {
  it('has a small limit for ordinary calls and larger ones only where a spreadsheet goes', () => {
    expect(maxBody('/api/auth/login')).toBe(256 * 1024);
    expect(maxBody('/api/bills')).toBe(256 * 1024);
    expect(maxBody('/api/import/preview')).toBe(12 * 1024 * 1024);
    expect(maxBody('/api/import/commit')).toBe(6 * 1024 * 1024);
  });

  it('answers 413 to a body over the limit, however it is sent', async () => {
    const { call } = await shop();
    const big = JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(300 * 1024) });
    const r = await call('POST', '/api/auth/login', { body: big, headers: { 'Content-Type': 'application/json', 'Content-Length': String(big.length) } });
    expect(r.status).toBe(413);
    expect((await r.json()).code).toBe('too_large');
    // No Content-Length (a stream): counted as it arrives.
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const r2 = await call('POST', '/api/auth/login', { body: stream as never, headers: { 'Content-Type': 'application/json' } });
    expect(r2.status).toBe(413);
  });

  it('lets a spreadsheet-sized body through to the import routes (which then ask for a login)', async () => {
    const { call } = await shop();
    const form = new FormData();
    form.append('file', new File([new Uint8Array(1024 * 1024)], 'big.xlsx'));
    expect((await call('POST', '/api/import/preview', { body: form })).status).toBe(401);
  });
});

describe('how often', () => {
  it('counts in windows and says when to come back', () => {
    const l = new RateLimiter(3, 60_000);
    expect([1, 2, 3, 4].map((i) => l.hit('a', 1000 + i).ok)).toEqual([true, true, true, false]);
    expect(l.hit('a', 1010).retryAfter).toBe(60);
    expect(l.hit('b', 1010).ok).toBe(true);
    expect(l.hit('a', 1000 + 60_001).ok).toBe(true); // a new window
  });

  it('limits each visitor separately, and login, reset, import and export tighter than the rest', async () => {
    const { call } = await shop({ limits: { global: 12, auth: 5, reset: 2, imports: 3, exports: 2 } });
    const statuses = async (n: number, f: () => Promise<Response>) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await f()).status);
      return out;
    };
    // login: the 6th in a minute is refused, with Retry-After
    const logins = await statuses(6, () => call('POST', '/api/auth/login', { json: { email: 'nobody@shop.in', password: 'x' }, peer: '192.168.1.10' }));
    expect(logins.slice(0, 5)).not.toContain(429);
    expect(logins[5]).toBe(429);
    const refused = await call('POST', '/api/auth/login', { json: { email: 'nobody@shop.in', password: 'x' }, peer: '192.168.1.10' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await refused.json()).code).toBe('rate_limited');
    // another visitor is not affected
    expect((await call('POST', '/api/auth/login', { json: { email: 'someone.else@shop.in', password: 'x' }, peer: '192.168.1.11' })).status).toBe(401);
    // forgot password: the 3rd is refused
    expect(await statuses(3, () => call('POST', '/api/auth/forgot', { json: { email: 'x@y.z' }, peer: '192.168.1.12' }))).toEqual([200, 200, 429]);
    // import and export
    expect(await statuses(4, () => call('GET', '/api/imports', { peer: '192.168.1.13' }))).toEqual([401, 401, 401, 401]); // not under /api/import/
    expect(await statuses(4, () => call('POST', '/api/import/validate', { json: {}, peer: '192.168.1.13' }))).toEqual([401, 401, 401, 429]);
    expect(await statuses(3, () => call('GET', '/api/admin/export.json', { peer: '192.168.1.14' }))).toEqual([401, 401, 429]);
    expect(await statuses(3, () => call('GET', '/api/backup/download', { peer: '192.168.1.14' }))).toEqual([429, 429, 429]); // the same export budget
    // overall
    const { call: call2 } = await shop({ limits: { global: 5, auth: 99, reset: 99, imports: 99, exports: 99 } });
    expect(await statuses(7, () => call2('GET', '/api/health', { peer: '192.168.1.15' }))).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it('keys on the real visitor behind a trusted tunnel, not on the tunnel', async () => {
    process.env.TRUST_PROXY = '1';
    const { call } = await shop({ limits: { global: 3, auth: 99, reset: 99, imports: 99, exports: 99 } });
    const from = (ip: string) => call('GET', '/api/health', { peer: '127.0.0.1', headers: { 'CF-Connecting-IP': ip } });
    expect([(await from('203.0.113.1')).status, (await from('203.0.113.1')).status, (await from('203.0.113.1')).status, (await from('203.0.113.1')).status]).toEqual([200, 200, 200, 429]);
    expect((await from('203.0.113.2')).status).toBe(200);
  });
});

describe('a request that hangs', () => {
  it('is answered with a 504 after its time, and not before', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', requestTimeout(() => 50));
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 200));
      return c.text('late');
    });
    app.get('/quick', (c) => c.text('ok'));
    expect((await app.request('/quick')).status).toBe(200);
    const slow = await app.request('/slow');
    expect(slow.status).toBe(504);
    expect((await slow.json()).code).toBe('timeout');
  });
});

describe('the login screen', () => {
  it('lists the names to tap on the shop computer only; elsewhere people type their email, and through a tunnel never', async () => {
    const { call } = await shop();
    const state = async (o: Parameters<typeof call>[2]) => (await call('GET', '/api/auth/state', o)).json();
    expect(await state({ peer: '127.0.0.1' })).toMatchObject({ listUsers: true, users: [{ name: 'Sunil Sharma', role: 'owner' }] });
    expect(await state({ peer: '192.168.1.40' })).toMatchObject({ listUsers: false, users: [] });
    expect(await state({ peer: '127.0.0.1', headers: { 'CF-Connecting-IP': '203.0.113.9' } })).toMatchObject({ listUsers: false, users: [] });
    process.env.SHOW_USERS_ON_LAN = '1';
    expect(await state({ peer: '192.168.1.40' })).toMatchObject({ listUsers: true, users: [{ name: 'Sunil Sharma' }] }); // the old behaviour, if asked for
    expect(await state({ peer: '127.0.0.1', headers: { 'CF-Connecting-IP': '203.0.113.9' } })).toMatchObject({ listUsers: false, users: [] }); // never through a tunnel
    expect(JSON.stringify(await state({ peer: '192.168.1.40' }))).not.toContain('sunil@shop.in');
  });
});

describe('the built web app', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-static-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Commercia</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js.map'), '{"sources":["../src/secret.ts"]}');
  fs.writeFileSync(path.join(dist, '.env'), 'COMMERCIA_SECRET_KEY=leak');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP-SECRET-OUTSIDE-THE-BUILD');
  let app: Hono<AppEnv>;
  let cwd = '';
  beforeAll(async () => {
    cwd = process.cwd();
    process.chdir(root);
    const s = await shop();
    app = s.app as unknown as Hono<AppEnv>;
    expect(mountStatic(app, dist)).toBe(true);
  });
  afterEach(() => process.chdir(root));
  it('serves the page and its files, with the security headers, and the page for any other path', async () => {
    const page = await app.request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe(CSP);
    expect(await page.text()).toContain('id="root"');
    expect(await (await app.request('/assets/app.js')).text()).toBe('console.log(1)');
    expect(await (await app.request('/ledger/12')).text()).toContain('id="root"');
  });
  it('gives nothing outside the build folder, whatever the spelling of the path', async () => {
    const attempts = ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/../../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/%252e%252e/secret.txt', '/..\\secret.txt', '/assets/..%5c..%5csecret.txt', '//secret.txt', '/%00/../secret.txt', '/....//secret.txt', '/.%2e/secret.txt'];
    for (const p of attempts) {
      const r = await app.request(p);
      expect(await r.text(), p).not.toContain('TOP-SECRET');
    }
  });
  it('refuses hidden files and source maps even though they are in the folder', async () => {
    for (const p of ['/.env', '/%2eenv', '/assets/app.js.map', '/assets/.hidden']) {
      const r = await app.request(p);
      expect(r.status, p).toBe(404);
      expect(await r.text(), p).not.toMatch(/leak|secret\.ts/);
    }
  });
});
