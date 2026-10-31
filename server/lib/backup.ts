import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index';
import { nowIso } from '../db/index';
import { getSettings, setSetting } from './settings';
import { logActivity } from './core';
import { istDate } from '../../shared/dates';
import { BACKUP_EXT, lockFile, reencryptBackups } from './backupCrypto';

const KEEP = 30;

const dirFor = (configured: string) => (configured.trim() ? path.resolve(configured.trim()) : path.resolve('backups'));

export function listBackups(configured: string): { name: string; size: number; at: string }[] {
  const dir = dirFor(configured);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^commercia-.*\.db(\.enc)?$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Copies the SQLite file safely while the app runs (PILOT-5). Point the backup folder at a
 * USB drive or a Google Drive / OneDrive synced folder. Keeps the last 30 copies.
 */
export async function runBackup(db: Db, tag = ''): Promise<{ file: string; size: number }> {
  if (db.dialect !== 'sqlite' || !db.sqlite) throw new Error('File backups are for the SQLite pilot; Supabase uses nightly R2 backups');
  const s = await getSettings(db.k);
  const dir = dirFor(s.backup_dir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, `commercia-${stamp}${tag ? `-${tag}` : ''}${BACKUP_EXT}`);
  // The plain copy exists only for a moment, next to the database (never in the backup folder, which may be synced), and is deleted at once.
  const plain = path.join(path.dirname(db.file ?? dir), `.backup-${process.pid}-${Date.now()}.tmp`);
  try {
    await db.sqlite.backup(plain);
    await lockFile(plain, file, db.secrets);
  } finally {
    fs.rmSync(plain, { force: true });
  }
  await setSetting(db.k, 'last_backup_at', nowIso());
  const old = listBackups(s.backup_dir).filter((b) => !b.name.includes('before-'));
  for (const b of old.slice(KEEP)) fs.rmSync(path.join(dir, b.name), { force: true });
  return { file, size: fs.statSync(file).size };
}

/** Nightly backup: once a day after 9 pm India time, or at start-up if the last one is over a day old. */
export function scheduleBackups(db: Db): NodeJS.Timeout | null {
  if (db.dialect !== 'sqlite' || db.file === ':memory:') return null;
  const tick = async () => {
    try {
      const s = await getSettings(db.k);
      const last = s.last_backup_at ? Date.parse(s.last_backup_at) : 0;
      const istHour = new Date(Date.now() + 330 * 60000).getUTCHours();
      const doneToday = last && istDate(new Date(last)) === istDate();
      if ((!doneToday && istHour >= 21) || Date.now() - last > 26 * 3600_000) {
        const res = await runBackup(db);
        await logActivity(db.k, null, 'backup', 'database', null, `Nightly backup saved to ${res.file}`);
      }
    } catch (e) {
      console.error('[backup] failed:', e);
      await logActivity(db.k, null, 'backup_failed', 'database', null, `Nightly backup failed: ${e instanceof Error ? e.message : e}`).catch(() => {});
    }
  };
  // Backups made before they were locked get locked now.
  setTimeout(() => {
    getSettings(db.k).then((s) => reencryptBackups(s.backup_dir, db.secrets, { onlyPlain: true })).catch(() => {});
  }, 5_000);
  setTimeout(tick, 15_000);
  return setInterval(tick, 10 * 60_000);
}
