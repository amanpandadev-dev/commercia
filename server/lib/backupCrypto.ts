// Backup files are locked (AES-256-GCM) with a key derived from the secret key, so a backup copied to a USB
// stick or a synced Drive folder is unreadable without it. A backup made before this existed is a plain SQLite
// file: it is still restorable, and gets locked the next time `reencryptBackups` runs.
//
// File layout:  "CMBK" | version 1 | key id (8 ascii) | nonce (12) | ciphertext … | tag (16)
// The header is authenticated too, so a changed key id or nonce is caught.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SecretKeyError, type Secrets } from './secrets';

const MAGIC = Buffer.from('CMBK');
const VERSION = 1;
const HEADER = MAGIC.length + 1 + 8 + 12;
const TAG = 16;
export const BACKUP_EXT = '.db.enc';

export function isLockedBackup(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(4);
    return fs.readSync(fd, b, 0, 4, 0) === 4 && b.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

export function isPlainSqlite(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    return b.toString('latin1') === 'SQLite format 3\0';
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes `dest` (owner-only) as the locked form of `src`. */
export async function lockFile(src: string, dest: string, secrets: Secrets): Promise<void> {
  const iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), Buffer.from(secrets.keyId, 'ascii'), iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', secrets.purposeKey('backup'), iv);
  cipher.setAAD(header);
  const out = fs.openSync(dest, 'w', 0o600);
  try {
    fs.writeSync(out, header);
    for await (const chunk of fs.createReadStream(src)) fs.writeSync(out, cipher.update(chunk as Buffer));
    fs.writeSync(out, cipher.final());
    fs.writeSync(out, cipher.getAuthTag());
  } finally {
    fs.closeSync(out);
  }
}

/** Writes the opened form of a locked file to `dest`. Throws SecretKeyError (and leaves nothing at `dest`) if the key is wrong or the file was changed. */
export async function unlockFile(src: string, dest: string, secrets: Secrets): Promise<void> {
  const size = fs.statSync(src).size;
  if (size < HEADER + TAG) throw new SecretKeyError('This backup file is damaged (too short).');
  const fd = fs.openSync(src, 'r');
  const header = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    fs.readSync(fd, header, 0, HEADER, 0);
    fs.readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, 4).equals(MAGIC) || header[4] !== VERSION) throw new SecretKeyError('This is not a Commercia backup file.');
  const keyId = header.subarray(5, 13).toString('ascii');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secrets.purposeKey('backup', keyId), header.subarray(13, HEADER));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const tmp = `${dest}.partial`;
  const out = fs.openSync(tmp, 'w', 0o600);
  try {
    for await (const chunk of fs.createReadStream(src, { start: HEADER, end: size - TAG - 1 })) fs.writeSync(out, decipher.update(chunk as Buffer));
    fs.writeSync(out, decipher.final());
    fs.closeSync(out);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.closeSync(out);
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { force: true });
    if (e instanceof SecretKeyError) throw e;
    throw new SecretKeyError('This backup could not be opened: wrong key, or the file was changed.');
  }
}

const backupFiles = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^commercia-.*\.db(\.enc)?$/.test(f)) : []);

/**
 * Locks every plain backup in the folder, and re-locks any made with an older key (the previous keys must be
 * known). `onlyPlain` leaves the already-locked ones alone. Each file is replaced only after its new form is complete.
 */
export function reencryptBackups(dirSetting: string, secrets: Secrets, opts: { onlyPlain?: boolean } = {}): Promise<{ rewritten: number; alreadyCurrent: number; failed: number }> {
  const dir = dirSetting.trim() ? path.resolve(dirSetting.trim()) : path.resolve('backups');
  return (async () => {
    const r = { rewritten: 0, alreadyCurrent: 0, failed: 0 };
    for (const name of backupFiles(dir)) {
      const file = path.join(dir, name);
      try {
        if (isLockedBackup(file)) {
          if (opts.onlyPlain) continue;
          const keyId = fs.readFileSync(file).subarray(5, 13).toString('ascii');
          if (keyId === secrets.keyId) {
            r.alreadyCurrent++;
            continue;
          }
          const plain = `${file}.plain`;
          await unlockFile(file, plain, secrets);
          await lockFile(plain, `${file}.new`, secrets);
          fs.rmSync(plain, { force: true });
          fs.renameSync(`${file}.new`, file);
        } else if (isPlainSqlite(file)) {
          const dest = file.replace(/\.db$/, BACKUP_EXT);
          await lockFile(file, `${dest}.new`, secrets);
          fs.renameSync(`${dest}.new`, dest);
          fs.rmSync(file, { force: true });
        } else continue;
        r.rewritten++;
      } catch {
        r.failed++;
        for (const x of ['.plain', '.new']) fs.rmSync(file + x, { force: true });
      }
    }
    return r;
  })();
}

/**
 * Puts a backup (locked or plain) in place as the database file. Refuses to overwrite a database unless `force`,
 * in which case the old files are kept next to it. Checks the result is a Commercia database before it replaces anything.
 */
export async function restoreBackup(backup: string, target: string, secrets: Secrets | null, opts: { force?: boolean } = {}): Promise<{ keptOld?: string }> {
  if (!fs.existsSync(backup)) throw new Error(`No such backup file: ${backup}`);
  if (fs.existsSync(target) && !opts.force) throw new Error(`${target} already exists. Add --force to replace it (the old one is kept next to it).`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.restoring`;
  fs.rmSync(staged, { force: true });
  if (isLockedBackup(backup)) {
    if (!secrets) throw new SecretKeyError('This backup is locked and the secret key is not available.');
    await unlockFile(backup, staged, secrets);
  } else if (isPlainSqlite(backup)) fs.copyFileSync(backup, staged);
  else throw new Error('This is not a Commercia backup file.');
  try {
    const db = new Database(staged, { readonly: true });
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('integrity check failed');
      db.prepare('select count(*) from users').get();
    } finally {
      db.close();
    }
  } catch (e) {
    fs.rmSync(staged, { force: true });
    throw new Error(`That file is not a healthy Commercia database (${e instanceof Error ? e.message : e}). Nothing was changed.`);
  }
  let keptOld: string | undefined;
  if (fs.existsSync(target)) {
    keptOld = `${target}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(target, keptOld);
  }
  for (const ext of ['-wal', '-shm']) {
    // A leftover write-ahead log belongs to the old file and would corrupt the restored one.
    if (fs.existsSync(target + ext)) fs.renameSync(target + ext, `${keptOld ?? target}${ext}`);
  }
  fs.renameSync(staged, target);
  return { keptOld };
}
