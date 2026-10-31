// Puts a backup back as the database. Run it on the shop computer with Commercia stopped.
//
//   npm run restore-backup -- backups/commercia-2026-10-30-21-00-00.db.enc
//   npm run restore-backup -- <file> --to data/commercia.db --force     replace the current database (it is kept next to it)
//
// A locked backup (.db.enc) needs the secret key it was made with (COMMERCIA_SECRET_KEY, .env or data/commercia.key).
// An older plain .db backup restores without a key.
import '../lib/boot';
import path from 'node:path';
import { config } from '../lib/config';
import { loadSecrets } from '../lib/secrets';
import { restoreBackup } from '../lib/backupCrypto';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--to');
const [backup] = positional;
if (!backup) {
  console.error('Usage: npm run restore-backup -- <backup file> [--to data/commercia.db] [--force]');
  process.exit(1);
}
const target = path.resolve(value('--to') ?? config().dbFile ?? path.join('data', 'commercia.db'));
try {
  let secrets = null;
  try {
    secrets = loadSecrets({ dbFile: target, mayMakeKey: false });
  } catch {
    /* only needed for a locked backup; restoreBackup says so if it is */
  }
  const { keptOld } = await restoreBackup(path.resolve(backup), target, secrets, { force: flag('--force') });
  console.log(`\n  Restored ${backup} as ${target}.`);
  if (keptOld) console.log(`  The database that was there is kept as ${keptOld}.`);
  console.log('  Start Commercia and check the Dashboard and Reports > Day book against what you expect.\n');
} catch (e) {
  console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
}
