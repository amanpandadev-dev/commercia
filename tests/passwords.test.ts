import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { hashPassword, hashPasswordAsync, passwordNeedsRehash, verifyPassword, verifyPasswordAsync } from '../server/lib/crypto';
import { MIN_LENGTH, checkPassword } from '../server/lib/passwordPolicy';
import { config } from '../server/lib/config';
import { setup, type Client } from './helpers';

/** A hash as versions before this one made them: scrypt N=16384 with no cost written in. */
const legacyHash = (pw: string) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
};

describe('password hashing', () => {
  it('writes its cost into the hash, and reads an old hash too', async () => {
    const h = hashPassword('a fine long password');
    expect(h).toMatch(/^scrypt\$4096\$8\$1\$/); // the test setting; the real default is checked below
    expect(verifyPassword('a fine long password', h)).toBe(true);
    expect(verifyPassword('another one', h)).toBe(false);
    expect(await verifyPasswordAsync('a fine long password', h)).toBe(true);
    const old = legacyHash('an old password');
    expect(verifyPassword('an old password', old)).toBe(true);
    expect(await verifyPasswordAsync('wrong', old)).toBe(false);
    expect((await hashPasswordAsync('x')).startsWith('scrypt$4096$')).toBe(true);
  });

  it('knows when a hash is cheaper than the cost in force, or in the old format', () => {
    expect(passwordNeedsRehash(hashPassword('x'))).toBe(false);
    expect(passwordNeedsRehash(legacyHash('x'))).toBe(true);
    expect(passwordNeedsRehash(`scrypt$2048$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`)).toBe(true);
  });

  it('refuses garbage and absurd costs instead of working on them', () => {
    for (const bad of ['', 'plain', 'scrypt$x$y', 'scrypt$4096$8$1$AA==$', 'bcrypt$1$2$3$4$5', 'scrypt$999999999$8$1$AA==$AA==', 'scrypt$-5$8$1$AA==$AA==']) expect(verifyPassword('x', bad)).toBe(false);
  });

  it('is much costlier by default: scrypt N=2^17 (128 MiB), as OWASP recommends', () => {
    expect(config({}).scryptLog2).toBe(17);
    const t = Date.now();
    const h = crypto.scryptSync('x', Buffer.alloc(16), 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 129 * 2 ** 17 * 8 + 4 * 1024 * 1024 });
    expect(h.length).toBe(32);
    expect(Date.now() - t).toBeLessThan(10_000); // it must still be usable on a shop laptop
  });
});

describe('what is an acceptable password', () => {
  const who = { name: 'Sunil Sharma', email: 'sunil.sharma@gmail.com', shopName: 'Sharma Kirana Store' };

  it('needs at least ten characters', () => {
    expect(MIN_LENGTH).toBe(10);
    expect(checkPassword('Short9!x', who)).toMatch(/at least 10/);
    expect(checkPassword('x'.repeat(129), who)).toMatch(/at most 128/);
  });

  it('refuses common passwords, however dressed up', () => {
    for (const p of ['password123', 'Password123!', 'P@ssw0rd2024!', 'qwertyuiop', 'iloveyou123', 'Welcome@123', 'admin12345', 'jaishreeram123', 'Kirana@1234', '1234567890', 'letmein1234', 'Qwerty@12345', 'p4ssw0rd!!!!']) {
      expect(checkPassword(p, { name: 'Zed', email: 'zed@x.in' }), p).toMatch(/too common|too simple|in order/);
    }
  });

  it('refuses repeated characters and runs of keys', () => {
    for (const p of ['aaaaaaaaaaaa', 'abababababab', 'abcdefghijkl', '0987654321', 'zxcvbnmasdfg']) expect(checkPassword(p, {}), p).not.toBeNull();
  });

  it('refuses the person\'s own name, email or the shop name, in any case or with look-alike letters', () => {
    for (const p of ['SunilIsTheBest77', 'my-sharma-secret-12', 'Kirana!Store#2026', 'sunil.sharma-2026-x', 'Sh@rm@-Ledger-91', 'Sun1l-R0cks-2026']) {
      expect(checkPassword(p, who), p).toMatch(/must not contain/);
    }
  });

  it('accepts long, unrelated passwords and passphrases', () => {
    for (const p of ['Orchid-Lantern-Ridge-4417', 'correct horse battery staple', 'tU7#vq2LmZ9!xA', 'riverstonebluefish88']) expect(checkPassword(p, who), p).toBeNull();
  });
});

describe('through the app', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let admin: Client;
  const login = (email: string, password: string) => ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    admin = await ctx.client('ramesh@shop.in');
  });
  afterEach(() => ctx.db.k.deleteFrom('auth_throttle').execute());

  it('applies when a person is added, when a password is set for them, and when they change it', async () => {
    const add = (password: string) => owner.req('POST', '/api/users', { name: 'New Person', email: 'new.person@shop.in', role: 'entry', password });
    expect((await add('short')).status).toBe(400);
    expect((await add('password123')).json.code).toBe('weak_password');
    expect((await add('NewPerson-9999-xx')).json.error).toMatch(/must not contain/);
    const made = await add('Teal-Walnut-Harbor-5521');
    expect(made.status).toBe(200);
    expect((await owner.req('PATCH', `/api/users/${made.json.id}`, { password: 'letmein1234' })).json.code).toBe('weak_password');
    expect((await owner.req('PATCH', `/api/users/${made.json.id}`, { password: 'Pewter-Anchor-Ladder-7788' })).status).toBe(200);
    const me = await ctx.client('new.person@shop.in', 'Pewter-Anchor-Ladder-7788');
    expect((await me.req('POST', '/api/account/password', { current: 'Pewter-Anchor-Ladder-7788', next: 'qwerty12345' })).json.code).toBe('weak_password');
    expect((await me.req('POST', '/api/account/password', { current: 'Pewter-Anchor-Ladder-7788', next: 'Maple-Copper-Violin-3310' })).status).toBe(200);
    expect((await login('new.person@shop.in', 'Maple-Copper-Violin-3310')).status).toBe(200);
  });

  it('applies to a reset with a code too, and to the first-time setup', async () => {
    const entry = await ctx.db.k.selectFrom('users').select('id').where('email', '=', 'amit@shop.in').executeTakeFirstOrThrow();
    const { code } = await owner.post(`/api/users/${entry.id}/reset-code`);
    const reset = (password: string) => ctx.app.request('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: entry.id, code, password }) });
    expect((await (await reset('password123')).json()).code).toBe('weak_password'); // refused before the code is used up
    expect((await reset('Quartz-Meadow-Lantern-6642')).status).toBe(200);
  });

  it('re-hashes an old password with the current cost at the next good login, and it still works', async () => {
    const old = legacyHash('Granite-Willow-Pencil-2025');
    const u = await ctx.db.k.selectFrom('users').select('id').where('email', '=', 'ramesh@shop.in').executeTakeFirstOrThrow();
    await ctx.db.k.updateTable('users').set({ password_hash: old }).where('id', '=', u.id).execute();
    expect((await login('ramesh@shop.in', 'wrong-password-here')).status).toBe(401);
    expect((await ctx.db.k.selectFrom('users').select('password_hash').where('id', '=', u.id).executeTakeFirstOrThrow()).password_hash).toBe(old); // a wrong password changes nothing
    expect((await login('ramesh@shop.in', 'Granite-Willow-Pencil-2025')).status).toBe(200);
    const now = (await ctx.db.k.selectFrom('users').select('password_hash').where('id', '=', u.id).executeTakeFirstOrThrow()).password_hash;
    expect(now).toMatch(/^scrypt\$4096\$8\$1\$/);
    expect(await verifyPasswordAsync('Granite-Willow-Pencil-2025', now)).toBe(true);
    expect((await login('ramesh@shop.in', 'Granite-Willow-Pencil-2025')).status).toBe(200); // and logs in with the new hash
  });

  it('asks for the password again for risky actions, for a few minutes, and counts wrong tries', async () => {
    const raw = async (email: string, password: string) => (await login(email, password)).headers.get('set-cookie')!.split(';')[0];
    const cookie = await raw('sunil@shop.in', 'password123');
    const call = (method: string, url: string, body?: unknown) => ctx.app.request(url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const risky = () => call('POST', '/api/users', { name: 'Reauth Person', email: `r${Math.random().toString(36).slice(2, 8)}@shop.in`, role: 'entry', password: 'Cobalt-Fennel-Marble-8801' });
    const refused = await risky();
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('reauth_required');
    expect((await call('GET', '/api/admin/export.json')).status).toBe(403);
    expect((await call('GET', '/api/backup/download')).status).toBe(403);
    const wrong = await call('POST', '/api/account/reauth', { password: 'not the password' });
    expect(wrong.status).toBe(400); // not 401: the session is fine
    expect((await call('POST', '/api/account/reauth', { password: 'password123' })).status).toBe(200);
    expect((await risky()).status).toBe(200);
    // It runs out.
    await ctx.db.k.updateTable('sessions').set({ reauth_until: new Date(Date.now() - 1000).toISOString() }).execute();
    expect((await risky()).status).toBe(403);
    // Five wrong passwords at the prompt lock the account like at the login.
    for (let i = 0; i < 5; i++) await call('POST', '/api/account/reauth', { password: 'not the password' });
    expect((await call('POST', '/api/account/reauth', { password: 'password123' })).status).toBe(429);
    const log = (await admin.get('/api/security')).events.filter((e: any) => e.action === 'reauth_failed');
    expect(log.length).toBeGreaterThanOrEqual(5);
  });

  it('does not ask an Entry person (who has no such actions) and does not let them past by asking', async () => {
    const entry = await ctx.client('amit@shop.in', 'Quartz-Meadow-Lantern-6642'); // the password set by the reset above
    expect((await entry.req('POST', '/api/users', { name: 'X Y', email: 'xy@shop.in', role: 'entry', password: 'Cobalt-Fennel-Marble-8801' })).status).toBe(403);
    expect((await entry.req('GET', '/api/admin/export.json')).status).toBe(403);
  });
});
