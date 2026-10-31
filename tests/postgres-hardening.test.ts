import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, type Db } from '../server/db/index';
import { createApp } from '../server/app';
import { hashPassword } from '../server/lib/crypto';
import { nowIso } from '../server/db/index';
import { pgBackup } from '../server/scripts/pg-backup';
import { pgRestore } from '../server/scripts/pg-restore';
import { newKeyHex } from '../server/lib/secrets';

const BASE = process.env.TEST_DATABASE_URL;
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;
const sql = (name: string) => fs.readFileSync(path.join('server/db/sql', name), 'utf8');

/** Least privilege, for real: these run only against a Postgres you can create roles on (npm run test:pg). */
describe.skipIf(!BASE)('hosted Postgres: least-privilege logins', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dbName = `commercia_h_${suffix}`;
  const migrateRole = `commercia_migrate_${suffix}`;
  const appRole = `commercia_app_${suffix}`;
  const urlFor = (user: string, password: string, db: string) => {
    const u = new URL(BASE!);
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };
  let pg: typeof import('pg').default;
  let appDb: Db;
  const saved = { url: process.env.DATABASE_URL, migrate: process.env.DATABASE_URL_MIGRATE, key: process.env.COMMERCIA_SECRET_KEY };

  const admin = async (db: string, query: string) => {
    const c = new pg.Client({ connectionString: urlFor(new URL(BASE!).username, decodeURIComponent(new URL(BASE!).password), db) });
    await c.connect();
    try {
      return await c.query(query);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    pg = (await import('pg')).default;
    process.env.COMMERCIA_SECRET_KEY ??= newKeyHex();
    await admin(new URL(BASE!).pathname.slice(1), `CREATE DATABASE ${dbName}`);
    const script = sql('postgres-roles.sql')
      .replaceAll('commercia_migrate', migrateRole)
      .replaceAll('commercia_app', appRole)
      .replace('{{MIGRATE_PASSWORD}}', 'migrate-pass-1')
      .replace('{{APP_PASSWORD}}', 'app-pass-1')
      .replaceAll('{{DATABASE}}', dbName);
    await admin(dbName, script);
    process.env.DATABASE_URL = urlFor(appRole, 'app-pass-1', dbName);
    process.env.DATABASE_URL_MIGRATE = urlFor(migrateRole, 'migrate-pass-1', dbName);
    appDb = await openDb(); // migrates as the migrate login, then runs as the app login
  });
  afterAll(async () => {
    await appDb?.k.destroy();
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('DATABASE_URL', saved.url);
    restore('DATABASE_URL_MIGRATE', saved.migrate);
    restore('COMMERCIA_SECRET_KEY', saved.key);
    await admin(new URL(BASE!).pathname.slice(1), `DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    for (const r of [appRole, migrateRole]) await admin(new URL(BASE!).pathname.slice(1), `DROP ROLE IF EXISTS ${r}`).catch(() => {});
  });

  const app = async (query: string) => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      return await c.query(query);
    } finally {
      await c.end();
    }
  };

  it('runs the app as a login that only reads and writes rows, with the tables made by the migrate login', async () => {
    expect((await app('select current_user as u')).rows[0].u).toBe(appRole);
    const owner = (await admin(dbName, `select tableowner from pg_tables where tablename = 'customers'`)).rows[0].tableowner;
    expect(owner).toBe(migrateRole);
    await app(`insert into customers (name, nickname, phone, area, gstin, price_list, active, created_at) values ('Row Test','','','','','retail',1, now()::text)`);
    expect((await app(`select count(*)::int as n from customers`)).rows[0].n).toBe(1);
    await app(`update customers set area = 'Naka' where name = 'Row Test'`);
    await app(`delete from customers where name = 'Row Test'`);
  });

  it('cannot create, alter, drop or truncate a table, or make a role', async () => {
    for (const q of ['create table sneaky (id int)', 'alter table customers add column sneaky text', 'drop table customers', 'truncate table customers', `create role sneaky login password 'x'`, 'create schema sneaky', 'drop table ledger']) {
      await expect(app(q), q).rejects.toThrow(/permission denied|must be owner/);
    }
  });

  it('cannot change the append-only tables (the triggers refuse), and after the go-live script not even the privilege exists', async () => {
    await app(`insert into activity (user_id, action, entity, summary, created_at) values (null, 'x', 'y', 'z', now()::text)`);
    await expect(app(`update activity set summary = 'changed'`)).rejects.toThrow(/append-only/);
    await expect(app(`delete from activity`)).rejects.toThrow(/append-only/);
    await admin(dbName, sql('postgres-lock-ledgers.sql').replaceAll('commercia_app', appRole));
    await expect(app(`update activity set summary = 'changed'`)).rejects.toThrow(/permission denied/);
    await expect(app(`delete from ledger`)).rejects.toThrow(/permission denied/);
    expect((await app(`select count(*)::int as n from activity`)).rows[0].n).toBeGreaterThanOrEqual(1); // reading and adding still work
    await app(`insert into activity (user_id, action, entity, summary, created_at) values (null, 'x', 'y', 'again', now()::text)`);
  });

  it('runs the whole app on that login: set-up, login, and a stored authenticator secret', async () => {
    await appDb.k.insertInto('users').values({ name: 'Hosted Owner', email: 'owner@shop.in', role: 'owner', password_hash: hashPassword('Granite-Willow-Pencil-2025'), active: 1, lang: 'en', totp_enabled: 0, totp_secret: null, session_epoch: 0, created_at: nowIso() }).execute();
    await appDb.k.insertInto('settings').values({ key: 'require_2fa', value: '0' }).onConflict((oc) => oc.column('key').doUpdateSet({ value: '0' })).execute();
    const web = createApp(appDb);
    const login = await web.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@shop.in', password: 'Granite-Willow-Pencil-2025' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    expect((await web.request('/api/account/me', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await web.request('/api/security', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it.skipIf(!hasPgDump)('backs up to an encrypted file, and the restore drill brings it back into a fresh database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-pgbk-'));
    const file = await pgBackup(process.env.DATABASE_URL_MIGRATE!, dir); // (a login that can read everything)
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 4).toString()).toBe('CMBK');
    expect(bytes.toString('latin1')).not.toContain('PGDMP');
    expect(bytes.toString('latin1')).not.toContain('owner@shop.in');
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('commercia-pgdump-')).length).toBe(0); // no plain dump left behind

    const fresh = `${dbName}_restore`;
    await admin(new URL(BASE!).pathname.slice(1), `CREATE DATABASE ${fresh}`);
    try {
      const target = urlFor(new URL(BASE!).username, decodeURIComponent(new URL(BASE!).password), fresh);
      await pgRestore(file, target);
      const c = new pg.Client({ connectionString: target });
      await c.connect();
      expect((await c.query(`select email from users`)).rows.map((r: any) => r.email)).toEqual(['owner@shop.in']);
      await c.end();
      // A different key opens nothing, and touches nothing.
      const other = `${fresh}2`;
      await admin(new URL(BASE!).pathname.slice(1), `CREATE DATABASE ${other}`);
      const key = process.env.COMMERCIA_SECRET_KEY;
      process.env.COMMERCIA_SECRET_KEY = newKeyHex();
      await expect(pgRestore(file, urlFor(new URL(BASE!).username, decodeURIComponent(new URL(BASE!).password), other))).rejects.toThrow(/not available|could not be opened/);
      process.env.COMMERCIA_SECRET_KEY = key;
      const c2 = new pg.Client({ connectionString: urlFor(new URL(BASE!).username, decodeURIComponent(new URL(BASE!).password), other) });
      await c2.connect();
      expect((await c2.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`)).rows[0].n).toBe(0);
      await c2.end();
      await admin(new URL(BASE!).pathname.slice(1), `DROP DATABASE ${other}`);
    } finally {
      await admin(new URL(BASE!).pathname.slice(1), `DROP DATABASE IF EXISTS ${fresh}`);
    }
  });
});
