import { describe, expect, it } from 'vitest';
import { openDb } from '../server/db/index';
import { migrate } from '../server/db/migrate';

describe('migrations', () => {
  it('add the one-off price column to a database made before it existed', async () => {
    const db = await openDb({ file: ':memory:' });
    await db.k.schema.alterTable('bill_lines').dropColumn('price_override').execute();
    const has = async () => (await db.k.introspection.getTables()).find((t) => t.name === 'bill_lines')!.columns.some((c) => c.name === 'price_override');
    expect(await has()).toBe(false);
    await migrate(db.k, 'sqlite');
    expect(await has()).toBe(true);
    await migrate(db.k, 'sqlite'); // running again is harmless
    expect(await has()).toBe(true);
  });
});

describe('supplier accounts for old deliveries', () => {
  it('gives each typed supplier name an account, once, with no dues', async () => {
    const db = await openDb({ file: ':memory:' });
    const row = (supplier: string, date: string) => ({ supplier, date, note: '', total_paise: 1000, import_id: null, created_by: 1, created_at: new Date().toISOString() });
    // Deliveries as an older version saved them: a name, no supplier account.
    await db.k.schema.alterTable('stock_ins').dropColumn('supplier_id').execute();
    await db.k.insertInto('stock_ins').values([row('Gupta Traders', '2026-09-01'), row('gupta traders', '2026-09-05'), row('Opening stock', '2026-09-06'), row('', '2026-09-07')] as never).execute();
    await migrate(db.k, 'sqlite');
    await migrate(db.k, 'sqlite'); // running again changes nothing
    const suppliers = await db.k.selectFrom('suppliers').selectAll().execute();
    expect(suppliers.map((s) => s.name)).toEqual(['Gupta Traders']);
    const linked = await db.k.selectFrom('stock_ins').select(['supplier', 'supplier_id']).orderBy('id').execute();
    expect(linked.map((r) => r.supplier_id)).toEqual([suppliers[0].id, suppliers[0].id, null, null]);
    expect((await db.k.selectFrom('supplier_ledger').select('id').execute()).length).toBe(0);
  });
});

describe('security upgrades', () => {
  it('bring a database from before them up to date in place, keeping people and their passwords and sessions', async () => {
    const db = await openDb({ file: ':memory:' });
    const { hashPassword } = await import('../server/lib/crypto');
    const u = await db.k.insertInto('users').values({ name: 'Old Admin', email: 'old@shop.in', role: 'admin', password_hash: hashPassword('an-old-password'), active: 1, lang: 'en', totp_enabled: 1, totp_secret: 'JBSWY3DPEHPK3PXP', session_epoch: 0, created_at: new Date().toISOString() }).returning('id').executeTakeFirstOrThrow();
    await db.k.insertInto('sessions').values({ id: 'abc', user_id: u.id, epoch: 0, totp_ok: 1, created_at: new Date().toISOString(), last_seen: new Date().toISOString(), expires_at: new Date(Date.now() + 1e9).toISOString() }).execute();
    // Take away what a version from before these changes did not have.
    for (const t of ['auth_throttle', 'recovery_codes', 'enrolment_codes']) await db.k.schema.dropTable(t).execute();
    for (const c of ['totp_pending', 'totp_last_step']) await db.k.schema.alterTable('users').dropColumn(c).execute();
    for (const c of ['enrol_ok', 'reauth_until', 'ip', 'device', 'ua_hash']) await db.k.schema.alterTable('sessions').dropColumn(c).execute();

    await migrate(db.k, 'sqlite');
    await migrate(db.k, 'sqlite'); // again: harmless
    const tables = (await db.k.introspection.getTables()).reduce((m, t) => m.set(t.name, t.columns.map((c) => c.name)), new Map<string, string[]>());
    expect(tables.get('auth_throttle')).toEqual(expect.arrayContaining(['key', 'fails', 'locked_until', 'strikes']));
    expect(tables.get('recovery_codes')).toEqual(expect.arrayContaining(['user_id', 'code_hash', 'used_at']));
    expect(tables.get('enrolment_codes')).toEqual(expect.arrayContaining(['user_id', 'code_hash', 'expires_at', 'attempts']));
    expect(tables.get('users')).toEqual(expect.arrayContaining(['totp_pending', 'totp_last_step']));
    expect(tables.get('sessions')).toEqual(expect.arrayContaining(['enrol_ok', 'reauth_until', 'ip', 'device', 'ua_hash']));
    // Everyone is still there, with what they had.
    const user = await db.k.selectFrom('users').selectAll().where('id', '=', u.id).executeTakeFirstOrThrow();
    expect(user).toMatchObject({ email: 'old@shop.in', totp_enabled: 1, totp_secret: 'JBSWY3DPEHPK3PXP', totp_pending: null, totp_last_step: null });
    expect(await db.k.selectFrom('sessions').select(['id', 'enrol_ok', 'ip']).executeTakeFirstOrThrow()).toEqual({ id: 'abc', enrol_ok: 0, ip: '' });
  });
});
