import { describe, expect, it, beforeAll } from 'vitest';
import { setup, type Client } from './helpers';

describe('the Security screen and the Dashboard alert', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let entry: Client;
  const login = (email: string, password: string) =>
    ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    entry = await ctx.client('amit@shop.in');
    for (let i = 0; i < 6; i++) await login('amit@shop.in', 'wrong'); // five wrong tries lock Amit, and are all on record
  });

  it('shows failed logins, the lockout and who is locked right now, to Owners', async () => {
    const s = await owner.get('/api/security');
    expect(s.summary).toMatchObject({ failedLogins: 5, lockouts: 1, locksNow: 1 });
    expect(s.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['login_failed', 'lockout']));
    expect(s.locks).toHaveLength(1);
    expect(s.locks[0].label).toBe('Amit Kumar: password');
    const only = await owner.get('/api/security?type=lockout');
    expect(only.events.every((e: any) => e.action === 'lockout')).toBe(true);
  });

  it('puts the same numbers in the Dashboard for Owners, and nothing for the Entry person', async () => {
    expect((await owner.get('/api/dashboard')).security).toMatchObject({ failedLogins: 5, lockouts: 1, locksNow: 1 });
    expect((await entry.req('GET', '/api/security')).status).toBe(403); // an Entry person has no business here
    await ctx.db.k.deleteFrom('auth_throttle').execute();
    expect((await entry.get('/api/dashboard')).security).toBeNull();
  });

  it('has every kind of event it promises: refused actions, exports, backup downloads, resets, and the rest', async () => {
    await ctx.db.k.deleteFrom('auth_throttle').execute();
    const sunil = await ctx.client('sunil@shop.in');
    const amit = await ctx.client('amit@shop.in');
    await amit.req('POST', '/api/users', { name: 'X Y', email: 'x@y.in', role: 'entry', password: 'Cobalt-Fennel-Marble-8801' }); // 403: refused
    await sunil.req('GET', '/api/admin/export.json');
    const postgres = !!process.env.TEST_DATABASE_URL; // file backups are the SQLite pilot's
    if (!postgres) await sunil.req('GET', '/api/backup/download');
    await ctx.app.request('/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'amit@shop.in' }) });
    const entry = await ctx.db.k.selectFrom('users').select('id').where('email', '=', 'amit@shop.in').executeTakeFirstOrThrow();
    const { code } = await sunil.post(`/api/users/${entry.id}/reset-code`);
    await ctx.app.request('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: entry.id, code, password: 'Quartz-Meadow-Lantern-6642' }) });
    const seen = async (type: string) => (await sunil.get(`/api/security?type=${type}`)).events;
    expect((await seen('refused'))[0].summary).toMatch(/Refused users\.manage for Amit Kumar \(entry\)/);
    expect((await seen('export'))[0].summary).toMatch(/Sunil Sharma exported all data/);
    if (!postgres) expect((await seen('backup_download'))[0].summary).toMatch(/Sunil Sharma downloaded a backup/);
    expect((await seen('password_forgot'))[0].summary).toMatch(/Amit Kumar asked to reset their password/);
    expect((await seen('password_reset')).map((e: any) => e.summary).join('|')).toMatch(/made a password reset code for Amit Kumar.*chose a new password|chose a new password.*made a password reset code/s);
    const s = (await sunil.get('/api/security')).summary;
    expect(s.refused).toBeGreaterThanOrEqual(1);
    expect(s.exports).toBe(postgres ? 1 : 2);
    expect(s.resets).toBeGreaterThanOrEqual(3);
  });
});
