import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../server/db/index';
import { runBackup, listBackups } from '../server/lib/backup';
import { isLockedBackup, reencryptBackups, restoreBackup } from '../server/lib/backupCrypto';
import { setSetting } from '../server/lib/settings';
import { newKeyHex, Secrets } from '../server/lib/secrets';
import { setup, type Client } from './helpers';

const MARKER = 'Zzyzx Marker Customer';

describe('backups are locked, and restore works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-bk-'));
  const key = newKeyHex();
  afterEach(() => {
    delete process.env.COMMERCIA_SECRET_KEY;
    delete process.env.COMMERCIA_SECRET_KEY_PREVIOUS;
  });

  async function shop(name: string): Promise<{ db: Db; file: string; backups: string }> {
    process.env.COMMERCIA_SECRET_KEY = key;
    const file = path.join(dir, name, 'commercia.db');
    const db = await openDb({ file });
    const backups = path.join(dir, name, 'backups');
    await setSetting(db.k, 'backup_dir', backups);
    await db.k.insertInto('customers').values({ name: MARKER, nickname: '', phone: '', area: '', gstin: '', price_list: 'retail', active: 1, created_at: new Date().toISOString() }).execute();
    return { db, file, backups };
  }
  const readable = (f: string) => fs.readFileSync(f).toString('latin1');

  it('makes a locked file: no SQLite header, no readable data, nothing left behind', async () => {
    const { db, file, backups } = await shop('a');
    const res = await runBackup(db);
    expect(res.file.endsWith('.db.enc')).toBe(true);
    expect(isLockedBackup(res.file)).toBe(true);
    expect(readable(res.file)).not.toContain('SQLite format 3');
    expect(readable(res.file)).not.toContain(MARKER);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('.backup-'))).toEqual([]); // the plain copy is gone
    expect(fs.readdirSync(backups)).toEqual([path.basename(res.file)]);
    expect(listBackups(backups).map((b) => b.name)).toEqual([path.basename(res.file)]);
    if (process.platform !== 'win32') expect(fs.statSync(res.file).mode & 0o077).toBe(0);
    await db.k.destroy();
  });

  it('restores it as a working database, with the data in it', async () => {
    const { db, backups } = await shop('b');
    const { file: backup } = await runBackup(db);
    await db.k.destroy();
    const target = path.join(dir, 'b-restored', 'commercia.db');
    process.env.COMMERCIA_SECRET_KEY = key;
    await restoreBackup(backup, target, new Secrets(Buffer.from(key, 'hex')));
    const back = await openDb({ file: target });
    expect((await back.k.selectFrom('customers').select('name').executeTakeFirstOrThrow()).name).toBe(MARKER);
    await back.k.destroy();
    expect(fs.existsSync(backups)).toBe(true);
  });

  it('refuses a wrong key or a changed file, and leaves nothing in place', async () => {
    const { db } = await shop('c');
    const { file: backup } = await runBackup(db);
    await db.k.destroy();
    const target = path.join(dir, 'c-restored', 'commercia.db');
    await expect(restoreBackup(backup, target, new Secrets(Buffer.from(newKeyHex(), 'hex')))).rejects.toThrow(/not available|could not be opened/);
    const bytes = fs.readFileSync(backup);
    bytes[bytes.length - 40] ^= 0xff;
    const changed = path.join(dir, 'changed.db.enc');
    fs.writeFileSync(changed, bytes);
    await expect(restoreBackup(changed, target, new Secrets(Buffer.from(key, 'hex')))).rejects.toThrow(/could not be opened|not a healthy/);
    await expect(restoreBackup(backup, target, null)).rejects.toThrow(/secret key is not available/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.restoring`) || fs.existsSync(`${target}.partial`)).toBe(false);
  });

  it('will not overwrite a database unless told to, and then keeps the old one', async () => {
    const { db, file } = await shop('d');
    const { file: backup } = await runBackup(db);
    await db.k.destroy();
    const secrets = new Secrets(Buffer.from(key, 'hex'));
    await expect(restoreBackup(backup, file, secrets)).rejects.toThrow(/already exists/);
    const { keptOld } = await restoreBackup(backup, file, secrets, { force: true });
    expect(keptOld && fs.existsSync(keptOld)).toBe(true);
    process.env.COMMERCIA_SECRET_KEY = key;
    const back = await openDb({ file });
    expect((await back.k.selectFrom('customers').select('name').executeTakeFirstOrThrow()).name).toBe(MARKER);
    await back.k.destroy();
  });

  it('still restores a plain backup from before backups were locked, and locks it when asked', async () => {
    const { db, backups } = await shop('e');
    fs.mkdirSync(backups, { recursive: true });
    const legacy = path.join(backups, 'commercia-2026-01-01-21-00-00.db');
    await db.sqlite!.backup(legacy);
    expect(readable(legacy)).toContain('SQLite format 3');
    const secrets = new Secrets(Buffer.from(key, 'hex'));
    const target = path.join(dir, 'e-restored', 'commercia.db');
    await restoreBackup(legacy, target, null); // no key needed for a plain one
    expect(fs.existsSync(target)).toBe(true);

    expect(await reencryptBackups(backups, secrets, { onlyPlain: true })).toEqual({ rewritten: 1, alreadyCurrent: 0, failed: 0 });
    expect(fs.readdirSync(backups)).toEqual(['commercia-2026-01-01-21-00-00.db.enc']);
    expect(readable(path.join(backups, 'commercia-2026-01-01-21-00-00.db.enc'))).not.toContain(MARKER);
    await restoreBackup(path.join(backups, 'commercia-2026-01-01-21-00-00.db.enc'), path.join(dir, 'e-restored2', 'commercia.db'), secrets);
    await db.k.destroy();
  });

  it('moves backups to a new key, keeping them restorable', async () => {
    const { db, backups } = await shop('f');
    await runBackup(db);
    const oldSecrets = new Secrets(Buffer.from(key, 'hex'));
    const newer = new Secrets(Buffer.from(newKeyHex(), 'hex'), [Buffer.from(key, 'hex')]);
    expect(await reencryptBackups(backups, newer)).toEqual({ rewritten: 1, alreadyCurrent: 0, failed: 0 });
    expect(await reencryptBackups(backups, newer)).toEqual({ rewritten: 0, alreadyCurrent: 1, failed: 0 });
    const file = path.join(backups, fs.readdirSync(backups)[0]);
    await expect(restoreBackup(file, path.join(dir, 'f-old', 'commercia.db'), oldSecrets)).rejects.toThrow(); // the old key no longer opens it
    await restoreBackup(file, path.join(dir, 'f-new', 'commercia.db'), newer);
    // Without the old key a file made with it cannot be moved: it is counted, not lost.
    const stranger = new Secrets(Buffer.from(newKeyHex(), 'hex'));
    expect((await reencryptBackups(backups, stranger)).failed).toBe(1);
    expect(fs.readdirSync(backups)).toEqual([path.basename(file)]);
    await db.k.destroy();
  });
});

describe('exports and downloads through the app', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  const bk = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-bk-api-'));

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    await owner.patch('/api/settings', { backup_dir: bk });
  });

  it('leaves password hashes and authenticator secrets out of export.json, and logs who exported', async () => {
    await ctx.db.k.updateTable('users').set({ totp_enabled: 1, totp_secret: 'enc:v1:abcd1234:iv:tag:ct' }).where('email', '=', 'amit@shop.in').execute();
    const res = await ctx.app.request('/api/admin/export.json', { headers: { Cookie: await cookie() } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.tables.users).toHaveLength(3);
    for (const u of data.tables.users) {
      expect(u).not.toHaveProperty('password_hash');
      expect(u).not.toHaveProperty('totp_secret');
      expect(u).toHaveProperty('totp_enabled');
    }
    expect(text).not.toMatch(/scrypt\$/);
    expect(text).not.toContain('enc:v1:abcd1234');
    const log = (await owner.get('/api/activity')).find((a: any) => a.action === 'export');
    expect(log.summary).toMatch(/Sunil Sharma exported all data \(\d+ rows in \d+ tables/);
  });

  it('downloads a locked backup, and logs it', async () => {
    const res = await ctx.app.request('/api/backup/download', { headers: { Cookie: await cookie() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/\.db\.enc"/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('CMBK');
    expect(bytes.toString('latin1')).not.toContain('SQLite format 3');
    expect((await owner.get('/api/activity')).some((a: any) => a.action === 'backup_download' && /Sunil Sharma downloaded a backup/.test(a.summary))).toBe(true);
  });

  async function cookie() {
    const login = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sunil@shop.in', password: 'password123' }) });
    return (login.headers.get('set-cookie') ?? '').split(';')[0];
  }
});
