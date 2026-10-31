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
});
