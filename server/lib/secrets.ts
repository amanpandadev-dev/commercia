// The secret key, and what it protects: authenticator secrets in the database, and backup files.
//
// One master key (32 random bytes). It comes from COMMERCIA_SECRET_KEY (or .env) if given; otherwise, on the
// pilot laptop, it is made on first run and kept in a file next to the database with owner-only permissions.
// Purpose keys are derived from it, so one key can be rotated without anyone typing it into more than one place.
//
// What this does and does not do: a copy of the database or of a backup file taken without the key is useless
// for the authenticator secrets and for the backups. It does NOT protect a laptop that is stolen with the key
// file on it (use BitLocker for that), and it is not a reason to skip a backup of the key itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, parseKey } from './config';

export class SecretKeyError extends Error {}

const PREFIX = 'enc:v1:';
const b64 = (b: Buffer) => b.toString('base64url');

const keyIdOf = (master: Buffer) => crypto.createHmac('sha256', master).update('commercia key id').digest('hex').slice(0, 8);
const derive = (master: Buffer, purpose: string) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('commercia'), purpose, 32));

export class Secrets {
  readonly keyId: string;
  private masters = new Map<string, Buffer>();

  constructor(current: Buffer, previous: Buffer[] = []) {
    this.keyId = keyIdOf(current);
    this.masters.set(this.keyId, current);
    for (const p of previous) this.masters.set(keyIdOf(p), p);
  }

  /** The key for a purpose, from the current master key or (to read old data) a previous one. */
  purposeKey(purpose: string, keyId = this.keyId): Buffer {
    const master = this.masters.get(keyId);
    if (!master) throw new SecretKeyError(`This data was locked with a key (${keyId}) that is not available. Put it back as COMMERCIA_SECRET_KEY or COMMERCIA_SECRET_KEY_PREVIOUS.`);
    return derive(master, purpose);
  }

  isSealed = (v: string | null | undefined): v is string => !!v && v.startsWith(PREFIX);
  /** Sealed with the key in use now (as opposed to an older one). */
  isCurrent = (v: string) => v.startsWith(`${PREFIX}${this.keyId}:`);

  /** Locks a short value. `context` ties it to where it belongs (for example the user), so it cannot be moved to another row. */
  seal(plain: string, context: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.purposeKey('field'), iv);
    c.setAAD(Buffer.from(context));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${PREFIX}${this.keyId}:${b64(iv)}:${b64(c.getAuthTag())}:${b64(ct)}`;
  }

  open(sealed: string, context: string): string {
    const [keyId, iv, tag, ct] = sealed.slice(PREFIX.length).split(':');
    if (!keyId || !iv || !tag || !ct) throw new SecretKeyError('A locked value is damaged.');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.purposeKey('field', keyId), Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch (e) {
      if (e instanceof SecretKeyError) throw e;
      throw new SecretKeyError('A locked value could not be opened: wrong key, or it was changed.');
    }
  }
}

const restrictFile = (file: string) => {
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore' });
    } catch {
      /* best effort: the README says to check the file's Security tab */
    }
  } else fs.chmodSync(file, 0o600);
};

export const newKeyHex = () => crypto.randomBytes(32).toString('hex');

export interface LoadOptions {
  /** A throw-away database (tests): a random key that is never saved. */
  memory?: boolean;
  postgres?: boolean;
  /** Where a key file would be. */
  dbFile?: string;
  /** False when the database already holds locked data: a missing key must not be quietly replaced by a new one. */
  mayMakeKey?: boolean;
}

export function loadSecrets(o: LoadOptions): Secrets {
  const cfg = config();
  const previous = cfg.previousKeys.map((k) => parseKey(k)!);
  if (o.memory) return new Secrets(crypto.randomBytes(32), previous);
  if (cfg.secretKey) return new Secrets(parseKey(cfg.secretKey)!, previous);
  if (o.postgres) throw new SecretKeyError('Set COMMERCIA_SECRET_KEY (64 hex characters) in the host\'s secret store: with Postgres there is no key file to keep it in.');

  const file = cfg.keyFile ?? path.join(path.dirname(o.dbFile ?? path.resolve('data', 'commercia.db')), 'commercia.key');
  if (fs.existsSync(file)) {
    const key = parseKey(fs.readFileSync(file, 'utf8'));
    if (!key) throw new SecretKeyError(`The key file ${file} is not a valid key (64 hex characters).`);
    return new Secrets(key, previous);
  }
  if (o.mayMakeKey === false) {
    throw new SecretKeyError(
      `The secret key is missing (${file}), but this database holds authenticator secrets locked with it.\n` +
        '  Put the key back (as that file, or as COMMERCIA_SECRET_KEY in .env), or if it is lost for good run:\n' +
        '    npm run rotate-key -- --discard-unreadable\n' +
        '  which makes a new key and makes each affected person set up their authenticator again.',
    );
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  restrictFile(file);
  console.log(`\n  A secret key was made for this computer: ${file}\n  Keep a copy somewhere safe (not in the backup folder): without it, backups cannot be opened.\n`);
  return new Secrets(key, previous);
}

// ---- Authenticator secrets ----
// Stored locked ("enc:v1:…"); a plain value (a database from before this existed) is still read, and locked on the next start.
export const totpContext = (userId: number) => `totp:${userId}`;

export function readTotpSecret(secrets: Secrets, user: { id: number; totp_secret: string | null }): string | null {
  if (!user.totp_secret) return null;
  return secrets.isSealed(user.totp_secret) ? secrets.open(user.totp_secret, totpContext(user.id)) : user.totp_secret;
}

export const sealTotpSecret = (secrets: Secrets, userId: number, plain: string) => secrets.seal(plain, totpContext(userId));

interface TotpRows {
  selectFrom: (t: 'users') => any;
  updateTable: (t: 'users') => any;
}

/**
 * Locks every plain authenticator secret, and re-locks any made with an older key. Safe to run on every start.
 * Returns how many rows it changed. Throws SecretKeyError if some cannot be opened with any key we have.
 */
export async function protectTotpSecrets(k: TotpRows, secrets: Secrets, opts: { discardUnreadable?: boolean } = {}): Promise<{ changed: number; discarded: number }> {
  const rows: { id: number; totp_secret: string }[] = await k.selectFrom('users').select(['id', 'totp_secret']).where('totp_secret', 'is not', null).execute();
  let changed = 0;
  let discarded = 0;
  let unreadable = 0;
  for (const r of rows) {
    let plain: string;
    if (!secrets.isSealed(r.totp_secret)) plain = r.totp_secret;
    else if (secrets.isCurrent(r.totp_secret)) {
      try {
        secrets.open(r.totp_secret, totpContext(r.id));
        continue;
      } catch {
        unreadable++;
        continue;
      }
    } else {
      try {
        plain = secrets.open(r.totp_secret, totpContext(r.id));
      } catch {
        unreadable++;
        continue;
      }
    }
    await k.updateTable('users').set({ totp_secret: sealTotpSecret(secrets, r.id, plain) }).where('id', '=', r.id).execute();
    changed++;
  }
  if (unreadable && opts.discardUnreadable) {
    for (const r of rows) {
      if (!secrets.isSealed(r.totp_secret)) continue;
      try {
        secrets.open(r.totp_secret, totpContext(r.id));
      } catch {
        await k.updateTable('users').set({ totp_secret: null, totp_enabled: 0 }).where('id', '=', r.id).execute();
        discarded++;
      }
    }
  } else if (unreadable) {
    throw new SecretKeyError(
      `${unreadable} authenticator secret(s) cannot be opened with the key(s) available.\n` +
        '  If the key was changed on purpose, put the old one in COMMERCIA_SECRET_KEY_PREVIOUS. If it is lost for good, run:\n' +
        '    npm run rotate-key -- --discard-unreadable',
    );
  }
  return { changed, discarded };
}
