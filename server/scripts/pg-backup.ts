// An encrypted backup of the hosted (Postgres) database: pg_dump, locked with the secret key, written to a folder you choose
// (point it at the place your off-site storage syncs from; give that storage a token that can only ADD files).
//
//   npm run pg-backup -- [--out backups]
//
// Needs pg_dump on this computer (the same major version as the server, or newer) and DATABASE_URL + COMMERCIA_SECRET_KEY.
// The database password goes to pg_dump in its environment, never on a command line where other programs could see it.
import '../lib/boot';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../lib/config';
import { loadSecrets } from '../lib/secrets';
import { lockFile } from '../lib/backupCrypto';

export async function pgBackup(url: string, outDir: string): Promise<string> {
  const u = new URL(url);
  const secrets = loadSecrets({ postgres: true });
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const plain = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-pgdump-')), 'dump');
  const dest = path.join(outDir, `commercia-pg-${stamp}.dump.enc`);
  try {
    const r = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', plain], {
      env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGSSLMODE: u.searchParams.get('sslmode') ?? 'prefer' },
      encoding: 'utf8',
    });
    if (r.error) throw new Error(`Could not run pg_dump: ${r.error.message}. Is PostgreSQL's client installed?`);
    if (r.status !== 0) throw new Error(`pg_dump failed: ${String(r.stderr).replace(/password[^\n]*/gi, '').trim()}`);
    await lockFile(plain, dest, secrets);
  } finally {
    fs.rmSync(path.dirname(plain), { recursive: true, force: true }); // the plain dump exists only for a moment
  }
  return dest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = config().databaseUrl;
  if (!url) {
    console.error('Set DATABASE_URL to the Postgres address.');
    process.exit(1);
  }
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'backups';
  try {
    const file = await pgBackup(url, path.resolve(out));
    console.log(`\n  Backup written: ${file}\n  It is locked with COMMERCIA_SECRET_KEY. Without that key it cannot be opened: keep a copy of the key apart from the backups.\n`);
  } catch (e) {
    console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
