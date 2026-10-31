import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, type Db } from '../server/db/index';
import { POLICY, activeLocks, checkThrottle, clearThrottle, recordFailure, unlockEverything, unlockUser } from '../server/lib/throttle';
import { hashPassword } from '../server/lib/crypto';
import { nowIso } from '../server/db/index';
import { setMailer } from '../server/lib/mailer';
import { setup } from './helpers';

const MIN = 60_000;

describe('the brake itself', () => {
  let db: Db;
  const t0 = Date.parse('2026-10-30T10:00:00Z');
  beforeAll(async () => {
    db = await openDb({ file: ':memory:' });
  });
  const fail = (key: string, at: number, policy = POLICY.account) => recordFailure(db.k, key, policy, at);
  const lockedFor = async (key: string, at: number) => {
    try {
      await checkThrottle(db.k, key, at);
      return 0;
    } catch (e: any) {
      expect(e.status).toBe(429);
      expect(e.code).toBe('rate_limited');
      return e.retryAfter as number;
    }
  };

  it('locks after the allowed wrong tries, with Retry-After, and not before', async () => {
    for (let i = 0; i < 4; i++) expect((await fail('a', t0 + i * 1000)).locked).toBe(false);
    expect(await lockedFor('a', t0 + 5000)).toBe(0);
    expect((await fail('a', t0 + 5000)).locked).toBe(true);
    expect(await lockedFor('a', t0 + 6000)).toBe(5 * 60 - 1);
    expect(await lockedFor('other', t0 + 6000)).toBe(0);
    expect(await lockedFor('a', t0 + 5000 + 5 * MIN)).toBe(0); // over
  });

  it('makes each lock longer than the last, and never longer than an hour', async () => {
    const lengths: number[] = [];
    let now = t0 + 10 * 60 * MIN;
    for (let round = 0; round < 6; round++) {
      let f;
      for (let i = 0; i < 5; i++) f = await fail('esc', now + i);
      const secs = await lockedFor('esc', now + 10);
      lengths.push(Math.round(secs / 60));
      expect(f!.locked).toBe(true);
      now += secs * 1000 + 1000;
    }
    expect(lengths).toEqual([5, 15, 45, 60, 60, 60]);
  });

  it('forgets the wrong tries outside the window, and a quiet day forgets the history', async () => {
    const t = t0 + 100 * 60 * MIN;
    for (let i = 0; i < 4; i++) await fail('slow', t + i * 20 * MIN); // one every 20 minutes never adds up to five in 15
    expect(await lockedFor('slow', t + 90 * MIN)).toBe(0);
    let now = t + 200 * 60 * MIN;
    for (let i = 0; i < 5; i++) await fail('old', now + i);
    now += 6 * MIN;
    for (let i = 0; i < 5; i++) await fail('old', now + i); // second lock: 15 minutes
    expect(Math.round((await lockedFor('old', now + 10)) / 60)).toBe(15);
    now += 25 * 60 * MIN; // more than a day later
    for (let i = 0; i < 5; i++) await fail('old', now + i);
    expect(Math.round((await lockedFor('old', now + 10)) / 60)).toBe(5); // back to the first lock
  });

  it('is cleared by a good login, and can be lifted for a person or for everyone', async () => {
    for (let i = 0; i < 5; i++) await fail('login:u7', t0 + 1000 * MIN + i);
    for (let i = 0; i < 5; i++) await fail('code:u7', t0 + 1000 * MIN + i);
    for (let i = 0; i < 5; i++) await fail('login:u8', t0 + 1000 * MIN + i);
    expect((await activeLocks(db.k, t0 + 1000 * MIN + 100)).map((l) => l.key).filter((key) => /^(login|code):u\d/.test(key)).sort()).toEqual(['code:u7', 'login:u7', 'login:u8']);
    expect(await unlockUser(db.k, 7)).toBe(2);
    expect(await lockedFor('login:u7', t0 + 1000 * MIN + 100)).toBe(0);
    expect(await lockedFor('login:u8', t0 + 1000 * MIN + 100)).toBeGreaterThan(0);
    await clearThrottle(db.k, 'login:u8');
    expect(await lockedFor('login:u8', t0 + 1000 * MIN + 100)).toBe(0);
    for (let i = 0; i < 5; i++) await fail('x', t0 + 2000 * MIN + i);
    expect(await unlockEverything(db.k)).toBeGreaterThan(0);
    expect(await activeLocks(db.k, t0 + 2000 * MIN + 100)).toEqual([]);
  });

  it('survives a restart of the server', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-th-')), 'commercia.db');
    const a = await openDb({ file });
    for (let i = 0; i < 5; i++) await recordFailure(a.k, 'login:u1', POLICY.account, Date.now());
    await a.k.destroy();
    const b = await openDb({ file });
    await expect(checkThrottle(b.k, 'login:u1')).rejects.toMatchObject({ status: 429 });
    await b.k.destroy();
  });
});

describe('through the app', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    ctx.app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const login = (email: string, password: string, headers: Record<string, string> = {}) => post('/api/auth/login', { email, password }, headers);
  const mails: { to: string; text: string }[] = [];

  beforeAll(async () => {
    ctx = await setup();
    setMailer({ sendMail: async (m) => void mails.push(m) });
  });
  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it('locks an account after five wrong passwords, even for the right one, with a 429 and Retry-After', async () => {
    for (let i = 0; i < 5; i++) expect((await login('amit@shop.in', 'wrong-password')).status).toBe(401);
    const locked = await login('amit@shop.in', 'password123');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await locked.json()).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/Too many attempts/) });
    expect((await login('sunil@shop.in', 'password123')).status).toBe(200); // someone else is not affected
  });

  it('counts wrong passwords for names that are not users, and answers them the same way, so names cannot be probed', async () => {
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) answers.push(`${(await login('nobody@shop.in', 'x')).status}`);
    expect(answers).toEqual(['401', '401', '401', '401', '401', '429']);
  });

  it('tells the Owners and the Admin: an activity-log entry, and an email when email is set up (once)', async () => {
    const log = (await (await ctx.client('sunil@shop.in')).get('/api/activity')).filter((a: any) => a.action === 'lockout');
    expect(log.some((a: any) => /Amit Kumar's account was locked for \d+ minutes/.test(a.summary))).toBe(true);
    const lockMails = mails.filter((m) => /was locked/.test(m.text));
    expect(new Set(lockMails.map((m) => m.to))).toEqual(new Set(['ramesh@shop.in', 'sunil@shop.in'])); // Owners and Admin, not the Entry person
  });

  it('starts the count again after a good login', async () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) expect((await login('ramesh@shop.in', 'wrong-password')).status).toBe(401);
      expect((await login('ramesh@shop.in', 'password123')).status).toBe(200);
    }
  });

  it('limits an address across all accounts (the real visitor behind a trusted proxy)', async () => {
    process.env.TRUST_PROXY = '1';
    const from = (ip: string) => ({ 'CF-Connecting-IP': ip });
    for (let i = 0; i < 30; i++) await login(`guess${i}@shop.in`, 'x', from('203.0.113.9'));
    expect((await login('ramesh@shop.in', 'password123', from('203.0.113.9'))).status).toBe(429);
    expect((await login('ramesh@shop.in', 'password123', from('198.51.100.7'))).status).toBe(200);
  });

  it('limits forgot-password requests and wrong reset codes, and says the same thing whoever is asked about', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post('/api/auth/forgot', { email: i % 2 ? 'nobody@shop.in' : 'sunil@shop.in' }, { 'CF-Connecting-IP': '203.0.113.50' })).status);
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/reset', { email: 'sunil@shop.in', code: 'WRNG-CODE', password: 'Another-Long-Pass-77' })).status).toBe(400);
    expect((await post('/api/auth/reset', { email: 'sunil@shop.in', code: 'WRNG-CODE', password: 'Another-Long-Pass-77' })).status).toBe(429);
  });
});

describe('the Admin can always get back in', () => {
  it('npm run reset-password -- <email> --unlock lifts a lock without changing the password; --unlock-all lifts every one', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-un-')), 'commercia.db');
    const db = await openDb({ file });
    const { id } = await db.k.insertInto('users').values({ name: 'Ramesh Sharma', email: 'ramesh@shop.in', role: 'admin', password_hash: hashPassword('password123'), active: 1, lang: 'en', totp_enabled: 0, totp_secret: null, session_epoch: 0, created_at: nowIso() }).returning('id').executeTakeFirstOrThrow();
    for (let i = 0; i < 5; i++) await recordFailure(db.k, `login:u${id}`, POLICY.account);
    for (let i = 0; i < 30; i++) await recordFailure(db.k, 'ip:203.0.113.9', POLICY.address);
    const before = (await db.k.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow()).password_hash;
    await db.k.destroy();

    const run = (...args: string[]) => execFileSync(process.execPath, ['--import', path.resolve('node_modules/tsx/dist/esm/index.mjs'), path.resolve('server/scripts/reset-password.ts'), ...args], { env: { ...process.env, COMMERCIA_DB: file }, encoding: 'utf8' });
    expect(run('ramesh@shop.in', '--unlock')).toMatch(/can try again now.*Their password was not changed/s);
    const again = await openDb({ file });
    await expect(checkThrottle(again.k, `login:u${id}`)).resolves.toBeUndefined();
    await expect(checkThrottle(again.k, 'ip:203.0.113.9')).rejects.toMatchObject({ status: 429 }); // the address is another lock
    expect((await again.k.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow()).password_hash).toBe(before);
    await again.k.destroy();
    expect(run('--unlock-all')).toMatch(/Every lock is lifted/);
    const last = await openDb({ file });
    await expect(checkThrottle(last.k, 'ip:203.0.113.9')).resolves.toBeUndefined();
    await last.k.destroy();
  });
});
