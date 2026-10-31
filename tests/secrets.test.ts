import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db/index';
import { Secrets, SecretKeyError, loadSecrets, newKeyHex, protectTotpSecrets, readTotpSecret, sealTotpSecret } from '../server/lib/secrets';
import { parseKey } from '../server/lib/config';
import { hashPassword } from '../server/lib/crypto';
import { nowIso } from '../server/db/index';

const key = () => Buffer.from(newKeyHex(), 'hex');
const PLAIN = 'JBSWY3DPEHPK3PXP';

describe('sealing short values', () => {
  it('locks and opens, tied to its context', () => {
    const s = new Secrets(key());
    const sealed = s.seal(PLAIN, 'totp:7');
    expect(sealed).toMatch(/^enc:v1:[0-9a-f]{8}:/);
    expect(sealed).not.toContain(PLAIN);
    expect(s.open(sealed, 'totp:7')).toBe(PLAIN);
    expect(() => s.open(sealed, 'totp:8')).toThrow(SecretKeyError); // moved to another user's row
    expect(s.seal(PLAIN, 'totp:7')).not.toBe(sealed); // a fresh nonce every time
  });

  it('refuses a changed value and a different key', () => {
    const s = new Secrets(key());
    const sealed = s.seal(PLAIN, 'c');
    const parts = sealed.split(':');
    parts[5] = Buffer.from('tampered').toString('base64url');
    expect(() => s.open(parts.join(':'), 'c')).toThrow(SecretKeyError);
    expect(() => new Secrets(key()).open(sealed, 'c')).toThrow(/not available/);
  });

  it('reads what an older key locked, when told that key', () => {
    const old = key();
    const sealed = new Secrets(old).seal(PLAIN, 'c');
    const now = new Secrets(key(), [old]);
    expect(now.open(sealed, 'c')).toBe(PLAIN);
    expect(now.isCurrent(sealed)).toBe(false);
    expect(now.isCurrent(now.seal(PLAIN, 'c'))).toBe(true);
  });
});

describe('the key', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-key-'));
  afterEach(() => delete process.env.COMMERCIA_SECRET_KEY);

  it('is made on first run in a file only this user can read, then reused', () => {
    const d = dir();
    const first = loadSecrets({ dbFile: path.join(d, 'commercia.db') });
    const file = path.join(d, 'commercia.key');
    expect(parseKey(fs.readFileSync(file, 'utf8'))).not.toBeNull();
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(loadSecrets({ dbFile: path.join(d, 'commercia.db') }).keyId).toBe(first.keyId);
  });

  it('comes from COMMERCIA_SECRET_KEY when given, and a missing key is never quietly replaced when locked data exists', () => {
    const k = newKeyHex();
    process.env.COMMERCIA_SECRET_KEY = k;
    const d = dir();
    expect(loadSecrets({ dbFile: path.join(d, 'x.db') }).keyId).toBe(new Secrets(Buffer.from(k, 'hex')).keyId);
    expect(fs.existsSync(path.join(d, 'commercia.key'))).toBe(false);
    delete process.env.COMMERCIA_SECRET_KEY;
    expect(() => loadSecrets({ dbFile: path.join(d, 'x.db'), mayMakeKey: false })).toThrow(/key is missing/);
    expect(fs.existsSync(path.join(d, 'commercia.key'))).toBe(false);
  });

  it('must come from the environment on Postgres', () => {
    expect(() => loadSecrets({ postgres: true })).toThrow(/COMMERCIA_SECRET_KEY/);
  });
});

describe('authenticator secrets in the database', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-db-')), 'commercia.db');
  const addUser = (db: Awaited<ReturnType<typeof openDb>>, totp: string | null) =>
    db.k.insertInto('users').values({ name: 'A', email: `a${Math.random()}@x.in`, role: 'owner', password_hash: hashPassword('password123'), active: 1, lang: 'en', totp_enabled: totp ? 1 : 0, totp_secret: totp, session_epoch: 0, created_at: nowIso() }).returning('id').executeTakeFirstOrThrow();
  const raw = (file: string) => [file, `${file}-wal`].filter(fs.existsSync).map((f) => fs.readFileSync(f).toString('latin1')).join('');
  afterEach(() => {
    delete process.env.COMMERCIA_SECRET_KEY;
    delete process.env.COMMERCIA_SECRET_KEY_PREVIOUS;
  });

  it('upgrades an older database in place: plain secrets are locked on the next start, and still work', async () => {
    const file = tmp();
    const a = await openDb({ file });
    const { id } = await addUser(a, PLAIN); // as an older version stored it
    a.sqlite!.pragma('wal_checkpoint(TRUNCATE)');
    expect(raw(file)).toContain(PLAIN);
    await a.k.destroy();

    const b = await openDb({ file });
    const row = await b.k.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.totp_secret).toMatch(/^enc:v1:/);
    expect(readTotpSecret(b.secrets, row)).toBe(PLAIN);
    b.sqlite!.pragma('wal_checkpoint(TRUNCATE)');
    expect(raw(file)).not.toContain(PLAIN); // unreadable in the database file
    await b.k.destroy();
  });

  it('is idempotent: another start changes nothing', async () => {
    const file = tmp();
    const a = await openDb({ file });
    const { id } = await addUser(a, PLAIN);
    await a.k.destroy();
    const b = await openDb({ file });
    const first = (await b.k.selectFrom('users').select('totp_secret').where('id', '=', id).executeTakeFirstOrThrow()).totp_secret;
    expect(await protectTotpSecrets(b.k as never, b.secrets)).toEqual({ changed: 0, discarded: 0 });
    await b.k.destroy();
    const c = await openDb({ file });
    expect((await c.k.selectFrom('users').select('totp_secret').where('id', '=', id).executeTakeFirstOrThrow()).totp_secret).toBe(first);
    await c.k.destroy();
  });

  it('rotates: a new key with the old one as previous re-locks everything; then the old one is not needed', async () => {
    const file = tmp();
    const oldKey = newKeyHex();
    process.env.COMMERCIA_SECRET_KEY = oldKey;
    const a = await openDb({ file });
    const { id } = await addUser(a, PLAIN);
    await a.k.destroy();
    const before = await (await openDb({ file })).k.selectFrom('users').select('totp_secret').where('id', '=', id).executeTakeFirstOrThrow();

    const newKey = newKeyHex();
    process.env.COMMERCIA_SECRET_KEY = newKey;
    process.env.COMMERCIA_SECRET_KEY_PREVIOUS = oldKey;
    const b = await openDb({ file });
    const after = await b.k.selectFrom('users').select(['id', 'totp_secret']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(after.totp_secret).not.toBe(before.totp_secret);
    expect(b.secrets.isCurrent(after.totp_secret!)).toBe(true);
    expect(readTotpSecret(b.secrets, after)).toBe(PLAIN);
    await b.k.destroy();

    delete process.env.COMMERCIA_SECRET_KEY_PREVIOUS;
    const c = await openDb({ file });
    expect(readTotpSecret(c.secrets, (await c.k.selectFrom('users').select(['id', 'totp_secret']).where('id', '=', id).executeTakeFirstOrThrow()))).toBe(PLAIN);
    await c.k.destroy();
  });

  it('refuses to start with a key that cannot read the locked secrets, and can discard them on purpose', async () => {
    const file = tmp();
    process.env.COMMERCIA_SECRET_KEY = newKeyHex();
    const a = await openDb({ file });
    const { id } = await addUser(a, PLAIN);
    await a.k.destroy();
    await (await openDb({ file })).k.destroy(); // locked now

    process.env.COMMERCIA_SECRET_KEY = newKeyHex(); // the key was lost
    await expect(openDb({ file })).rejects.toThrow(/cannot be opened with the key/);
    const d = await openDb({ file, skipSecretCheck: true });
    expect(await protectTotpSecrets(d.k as never, d.secrets, { discardUnreadable: true })).toEqual({ changed: 0, discarded: 1 });
    expect(await d.k.selectFrom('users').select(['totp_secret', 'totp_enabled']).where('id', '=', id).executeTakeFirstOrThrow()).toEqual({ totp_secret: null, totp_enabled: 0 });
    await d.k.destroy();
    await (await openDb({ file })).k.destroy(); // starts again
  });

  it('seals what the app stores, bound to the user', () => {
    const s = new Secrets(key());
    expect(readTotpSecret(s, { id: 3, totp_secret: sealTotpSecret(s, 3, PLAIN) })).toBe(PLAIN);
    expect(() => readTotpSecret(s, { id: 4, totp_secret: sealTotpSecret(s, 3, PLAIN) })).toThrow(SecretKeyError);
    expect(readTotpSecret(s, { id: 1, totp_secret: null })).toBeNull();
  });
});
