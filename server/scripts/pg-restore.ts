// The restore drill for a hosted backup: opens an encrypted backup (from npm run pg-backup) and loads it into a database you
// name, then checks it. Do this into a FRESH, EMPTY database, on a schedule, so you know a backup works before you need it.
//
//   npm run pg-restore -- backups/commercia-pg-2026-10-30-21-00-00.dump.enc --to postgres://user:pass@host/freshdb?sslmode=require
import '../lib/boot';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSecrets } from '../lib/secrets';
import { unlockFile } from '../lib/backupCrypto';

export async function pgRestore(backup: string, to: string): Promise<void> {
  const u = new URL(to);
  const secrets = loadSecrets({ postgres: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-pgrestore-'));
  const plain = path.join(dir, 'dump');
  try {
    await unlockFile(backup, plain, secrets); // wrong key or a changed file stops here, before anything is touched
    const r = spawnSync('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', u.pathname.slice(1), plain], {
      env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: u.searchParams.get('sslmode') ?? 'prefer' },
      encoding: 'utf8',
    });
    if (r.error) throw new Error(`Could not run pg_restore: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`pg_restore failed: ${String(r.stderr).replace(/password[^\n]*/gi, '').trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [backup] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--to');
  const to = process.argv.includes('--to') ? process.argv[process.argv.indexOf('--to') + 1] : '';
  if (!backup || !to) {
    console.error('Usage: npm run pg-restore -- <backup file> --to <address of a fresh, empty database>');
    process.exit(1);
  }
  try {
    await pgRestore(path.resolve(backup), to);
    console.log('\n  Restored. Check it: start Commercia with DATABASE_URL set to that database, and compare the Dashboard and Reports > Day book.\n');
  } catch (e) {
    console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
