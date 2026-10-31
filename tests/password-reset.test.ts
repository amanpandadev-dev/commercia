import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, type Client } from './helpers';
import { setMailer } from '../server/lib/mailer';
import { openDb, nowIso } from '../server/db/index';
import { hashPassword, verifyPassword } from '../server/lib/crypto';

describe('forgot password', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client;
  let owner: Client;
  let ids: { admin: number; owner: number; entry: number };
  let outbox: { to: string; subject: string; text: string }[];

  const pub = async (url: string, body: unknown) => {
    const res = await ctx.app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const login = (email: string, password: string) => pub('/api/auth/login', { email, password });
  const codeIn = (mail: { text: string }) => mail.text.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)![1];
  const forgot = (who: keyof typeof ids) => pub('/api/auth/forgot', { userId: ids[who] });
  const rows = (who: keyof typeof ids) => ctx.db.k.selectFrom('password_resets').selectAll().where('user_id', '=', ids[who]).orderBy('id').execute();

  beforeAll(async () => {
    ctx = await setup();
    admin = await ctx.client('ramesh@shop.in');
    owner = await ctx.client('sunil@shop.in');
    const u = await ctx.db.k.selectFrom('users').select(['id', 'role']).execute();
    ids = { admin: u.find((x) => x.role === 'admin')!.id, owner: u.find((x) => x.role === 'owner')!.id, entry: u.find((x) => x.role === 'entry')!.id };
  });
  beforeEach(async () => {
    outbox = [];
    setMailer(null);
    await ctx.db.k.deleteFrom('password_resets').execute();
    await ctx.db.k.deleteFrom('auth_throttle').execute(); // these tests are about the code's own rules; the lockouts have their own tests
    await ctx.db.k.updateTable('users').set({ password_hash: hashPassword('password123') }).execute();
  });
  afterEach(() => setMailer(null));

  describe('without email (the offline pilot)', () => {
    it('leaves a request for the Owner, who makes a one-time code to read out; the person then sets a new password', async () => {
      const entry = await ctx.client('amit@shop.in'); // already logged in on another device
      const r = await forgot('entry');
      expect(r.json).toEqual({ ok: true, via: 'owner' });
      await forgot('entry'); // asking again does not pile up requests
      expect((await owner.get('/api/users/password-requests')).map((q: any) => q.name)).toEqual(['Amit Kumar']);
      expect((await owner.get('/api/dashboard')).passwordRequests).toBe(1);

      const made = await owner.post(`/api/users/${ids.entry}/reset-code`);
      expect(made.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(made.name).toBe('Amit Kumar');
      expect(await owner.get('/api/users/password-requests')).toEqual([]);

      const done = await pub('/api/auth/reset', { userId: ids.entry, code: made.code.toLowerCase().replace('-', ' '), password: 'brand-new-pass' });
      expect(done.status).toBe(200);
      expect((await login('amit@shop.in', 'password123')).status).toBe(401);
      expect((await login('amit@shop.in', 'brand-new-pass')).status).toBe(200);
      expect((await entry.req('GET', '/api/dashboard')).status).toBe(401); // the old session ended
      // Once only.
      expect((await pub('/api/auth/reset', { userId: ids.entry, code: made.code, password: 'another-pass-1' })).status).toBe(400);
      const log = await owner.get('/api/activity');
      expect(log.some((a: any) => a.summary.includes('made a password reset code for Amit'))).toBe(true);
      expect(log.some((a: any) => a.summary.includes('Amit Kumar chose a new password with a reset code'))).toBe(true);
    });

    it('lets only people who manage users see requests or make codes, and keeps the Admin out of the Owner\'s hands', async () => {
      const entry = await ctx.client('amit@shop.in');
      expect((await entry.req('GET', '/api/users/password-requests')).status).toBe(403);
      expect((await entry.req('POST', `/api/users/${ids.owner}/reset-code`)).status).toBe(403);
      await forgot('admin');
      await forgot('entry');
      expect((await owner.get('/api/users/password-requests')).map((q: any) => q.role)).toEqual(['entry']);
      expect((await admin.get('/api/users/password-requests')).map((q: any) => q.role)).toEqual(['admin', 'entry']);
      expect((await owner.req('POST', `/api/users/${ids.admin}/reset-code`)).status).toBe(403);
      expect((await admin.req('POST', `/api/users/${ids.owner}/reset-code`)).status).toBe(200);
    });

    it('can be dismissed, and is not offered for someone who is deactivated', async () => {
      await forgot('entry');
      const [req] = await owner.get('/api/users/password-requests');
      await owner.post(`/api/users/password-requests/${req.id}/dismiss`);
      expect(await owner.get('/api/users/password-requests')).toEqual([]);
      await owner.patch(`/api/users/${ids.entry}`, { active: false });
      expect((await owner.req('POST', `/api/users/${ids.entry}/reset-code`)).status).toBe(400);
      await owner.patch(`/api/users/${ids.entry}`, { active: true });
    });
  });

  describe('safety of the code', () => {
    it('is dead after five wrong tries, even for the right code', async () => {
      await forgot('entry');
      const { code } = await owner.post(`/api/users/${ids.entry}/reset-code`);
      for (let i = 0; i < 5; i++) expect((await pub('/api/auth/reset', { userId: ids.entry, code: 'AAAA-BBBB', password: 'whatever-pass' })).status).toBe(400);
      // The brake in front also locks after five wrong tries (tests/throttle.test.ts); with that lifted, the code is dead on its own.
      expect((await pub('/api/auth/reset', { userId: ids.entry, code, password: 'whatever-pass' })).status).toBe(429);
      await ctx.db.k.deleteFrom('auth_throttle').execute();
      expect((await pub('/api/auth/reset', { userId: ids.entry, code, password: 'whatever-pass' })).status).toBe(400);
      expect((await login('amit@shop.in', 'password123')).status).toBe(200);
    });

    it('expires, and a newer code replaces an older one', async () => {
      const first = await owner.post(`/api/users/${ids.entry}/reset-code`);
      const second = await owner.post(`/api/users/${ids.entry}/reset-code`);
      expect((await pub('/api/auth/reset', { userId: ids.entry, code: first.code, password: 'whatever-pass' })).status).toBe(400);
      await ctx.db.k.updateTable('password_resets').set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where('user_id', '=', ids.entry).execute();
      expect((await pub('/api/auth/reset', { userId: ids.entry, code: second.code, password: 'whatever-pass' })).status).toBe(400);
    });

    it('stores only a hash, and keeps the password rules', async () => {
      const { code } = await owner.post(`/api/users/${ids.entry}/reset-code`);
      const row = (await rows('entry'))[0];
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(code.replace('-', ''));
      expect((await pub('/api/auth/reset', { userId: ids.entry, code, password: 'short' })).status).toBe(400);
      expect((await pub('/api/auth/reset', { userId: ids.entry, code, password: 'long-enough-1' })).status).toBe(200);
    });

    it('does not reveal who has an account', async () => {
      const real = await pub('/api/auth/forgot', { email: 'amit@shop.in' });
      const fake = await pub('/api/auth/forgot', { email: 'nobody@nowhere.in' });
      expect(fake).toEqual(real);
      expect((await ctx.db.k.selectFrom('password_resets').select('id').execute()).length).toBe(1);
      const wrong = await pub('/api/auth/reset', { email: 'nobody@nowhere.in', code: 'AAAA-BBBB', password: 'whatever-pass' });
      const wrongReal = await pub('/api/auth/reset', { email: 'amit@shop.in', code: 'AAAA-BBBB', password: 'whatever-pass' });
      expect(wrong.json.error).toBe(wrongReal.json.error);
    });

    it('leaves the authenticator as it was', async () => {
      await ctx.db.k.updateTable('users').set({ totp_enabled: 1, totp_secret: 'ABCDEFGHIJKLMNOP' }).where('id', '=', ids.entry).execute();
      const { code } = await admin.post(`/api/users/${ids.entry}/reset-code`);
      await pub('/api/auth/reset', { userId: ids.entry, code, password: 'long-enough-1' });
      const u = await ctx.db.k.selectFrom('users').select(['totp_enabled', 'totp_secret']).where('id', '=', ids.entry).executeTakeFirstOrThrow();
      expect(u).toEqual({ totp_enabled: 1, totp_secret: 'ABCDEFGHIJKLMNOP' });
      await ctx.db.k.updateTable('users').set({ totp_enabled: 0, totp_secret: null }).where('id', '=', ids.entry).execute();
    });
  });

  describe('with email set up', () => {
    beforeEach(() => setMailer({ sendMail: async (m) => void outbox.push(m) }));

    it('emails a code to the address on the account, which works once', async () => {
      const r = await forgot('entry');
      expect(r.json).toEqual({ ok: true, via: 'email' });
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe('amit@shop.in');
      expect(outbox[0].subject).toContain('Sharma Kirana Store');
      expect(await owner.get('/api/users/password-requests')).toEqual([]); // nothing for an Owner to do
      const code = codeIn(outbox[0]);
      expect((await pub('/api/auth/reset', { userId: ids.entry, code, password: 'emailed-pass-1' })).status).toBe(200);
      expect((await login('amit@shop.in', 'emailed-pass-1')).status).toBe(200);
      expect(outbox.at(-1)!.subject).toContain('password was changed');
      expect((await pub('/api/auth/reset', { userId: ids.entry, code, password: 'emailed-pass-2' })).status).toBe(400);
    });

    it('asking again replaces the earlier code, and no more than three asks an hour are answered', async () => {
      await forgot('entry');
      const first = codeIn(outbox[0]);
      await forgot('entry');
      const second = codeIn(outbox[1]);
      expect(first).not.toBe(second);
      expect((await pub('/api/auth/reset', { userId: ids.entry, code: first, password: 'emailed-pass-1' })).status).toBe(400);
      await forgot('entry');
      await forgot('entry'); // the fourth
      expect(outbox).toHaveLength(3);
      expect((await rows('entry')).length).toBe(3);
    });

    it('falls back to a request for the Owner when the email cannot be sent', async () => {
      setMailer({ sendMail: async () => { throw new Error('SMTP down'); } });
      const r = await forgot('entry');
      expect(r.json.ok).toBe(true);
      expect((await owner.get('/api/users/password-requests')).map((q: any) => q.name)).toEqual(['Amit Kumar']);
    });
  });

  describe('from the shop computer', () => {
    it('resets the Admin password without email, signs them out, and can clear a lost authenticator', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-reset-'));
      const file = path.join(dir, 'c.db');
      const db = await openDb({ file });
      await db.k.insertInto('users').values({ name: 'Ramesh Sharma', email: 'ramesh@shop.in', role: 'admin', password_hash: hashPassword('forgotten'), active: 1, lang: 'en', totp_enabled: 1, totp_secret: 'SECRET', session_epoch: 3, created_at: nowIso() }).execute();
      await db.k.destroy();
      const run = (...args: string[]) => execFileSync('npx', ['tsx', 'server/scripts/reset-password.ts', ...args], { env: { ...process.env, COMMERCIA_DB: file }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const out = run('Ramesh@Shop.in');
      const printed = out.match(/is now:\s+(\S+)/)![1];
      expect(printed).toHaveLength(12);
      const after = await openDb({ file });
      let u = await after.k.selectFrom('users').selectAll().executeTakeFirstOrThrow();
      expect(verifyPassword(printed, u.password_hash)).toBe(true);
      expect(u.session_epoch).toBe(4);
      expect(u.totp_enabled).toBe(1); // untouched unless asked
      run('ramesh@shop.in', 'my chosen pass', '--reset-2fa');
      u = await after.k.selectFrom('users').selectAll().executeTakeFirstOrThrow();
      expect(verifyPassword('my chosen pass', u.password_hash)).toBe(true);
      expect(u.totp_enabled).toBe(0);
      expect(() => run('nobody@shop.in')).toThrow();
      await after.k.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }, 30_000);
  });
});
