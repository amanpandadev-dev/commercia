import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../server/db/index';
import { createApp } from '../server/app';
import { clearSetupCode, setupCode } from '../server/lib/setup';
import { formatCode } from '../server/lib/passwordReset';

const body = { shopName: 'Test Store', name: 'Admin One', email: 'admin@test.in', password: 'a-long-first-password' };

async function fresh() {
  const db = await openDb({ file: ':memory:' });
  const app = createApp(db);
  /** A call as if it came over the network from `ip`, with any extra headers (a tunnel adds some). */
  const from = (ip: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) }, ip === null ? undefined : { incoming: { socket: { remoteAddress: ip } } });
  return { db, app, from };
}

describe('first-time setup', () => {
  beforeEach(() => clearSetupCode());

  it('is allowed from a browser on the shop computer itself', async () => {
    const { from, db } = await fresh();
    const state = await (await from('127.0.0.1', 'GET', '/api/auth/state')).json();
    expect(state).toMatchObject({ setupNeeded: true, setupCodeRequired: false });
    const r = await from('::1', 'POST', '/api/auth/setup', body);
    expect(r.status).toBe(200);
    expect((await db.k.selectFrom('users').select('role').executeTakeFirstOrThrow()).role).toBe('admin');
    // The Admin who set the shop up may set up an authenticator at once, with no code.
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await from('127.0.0.1', 'POST', '/api/auth/totp/enroll', {}, { Cookie: cookie })).status).toBe(200);
  });

  it('is refused from another address without the setup code, and says why', async () => {
    const { from, db } = await fresh();
    expect((await (await from('192.168.1.40', 'GET', '/api/auth/state')).json()).setupCodeRequired).toBe(true);
    for (const ip of ['192.168.1.40', '203.0.113.9', '10.0.0.7']) {
      const r = await from(ip, 'POST', '/api/auth/setup', body);
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe('setup_forbidden');
    }
    expect(await db.k.selectFrom('users').select('id').executeTakeFirst()).toBeUndefined(); // nobody was created
    const log = await db.k.selectFrom('activity').select('summary').where('action', '=', 'setup_refused').execute();
    expect(log.length).toBe(3);
    expect(log[0].summary).toMatch(/refused from 192\.168\.1\.40/);
  });

  it('treats a request through a tunnel as not from the shop computer, even though it arrives from 127.0.0.1', async () => {
    const { from, db } = await fresh();
    for (const headers of [{ 'CF-Connecting-IP': '203.0.113.9' }, { 'X-Forwarded-For': '203.0.113.9' }, { 'CF-Ray': 'abc' }, { Forwarded: 'for=203.0.113.9' }] as Record<string, string>[]) {
      expect((await from('127.0.0.1', 'POST', '/api/auth/setup', body, headers)).status).toBe(403);
    }
    expect((await (await from('127.0.0.1', 'GET', '/api/auth/state', undefined, { 'CF-Connecting-IP': '203.0.113.9' })).json()).setupCodeRequired).toBe(true);
    expect(await db.k.selectFrom('users').select('id').executeTakeFirst()).toBeUndefined();
  });

  it('is allowed from another device with the one-time code printed in the console, and only that code', async () => {
    const { from, db } = await fresh();
    const code = setupCode();
    expect((await from('192.168.1.40', 'POST', '/api/auth/setup', { ...body, setupCode: 'WRNG-CODE' })).status).toBe(403);
    expect((await from('192.168.1.40', 'POST', '/api/auth/setup', { ...body, setupCode: formatCode(code).toLowerCase() })).status).toBe(200);
    expect((await db.k.selectFrom('users').select('email').executeTakeFirstOrThrow()).email).toBe('admin@test.in');
  });

  it('is closed for good once there is a user, from anywhere, with or without the code', async () => {
    const { from } = await fresh();
    const code = setupCode();
    expect((await from('127.0.0.1', 'POST', '/api/auth/setup', body)).status).toBe(200);
    for (const [ip, extra] of [['127.0.0.1', {}], ['192.168.1.40', { setupCode: code }], ['203.0.113.9', {}]] as const) {
      expect((await from(ip, 'POST', '/api/auth/setup', { ...body, email: 'second@test.in', ...extra })).status).toBe(409);
    }
    expect((await (await from('127.0.0.1', 'GET', '/api/auth/state')).json()).setupNeeded).toBe(false);
  });

  it('lets only one of two set-ups at once through', async () => {
    const { from, db } = await fresh();
    const results = await Promise.all([from('127.0.0.1', 'POST', '/api/auth/setup', body), from('127.0.0.1', 'POST', '/api/auth/setup', { ...body, email: 'other@test.in' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.k.selectFrom('users').select('id').execute()).length).toBe(1);
  });

  it('is slowed down after repeated refused tries from one address', async () => {
    const { from } = await fresh();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await from('203.0.113.77', 'POST', '/api/auth/setup', body)).status);
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429, 429]);
  });
});
