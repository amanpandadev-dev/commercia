// The secret key: make a new one, move everything to it, or recover when it is lost.
//
//   npm run rotate-key -- --generate            prints a fresh random key (64 hex characters). Changes nothing.
//   npm run rotate-key                          locks everything with the key in use now, using COMMERCIA_SECRET_KEY_PREVIOUS
//                                               to read what the old key locked (authenticator secrets and backup files)
//   npm run rotate-key -- --discard-unreadable  the key is lost for good: forget the authenticator secrets nobody can read,
//                                               so those people set up their authenticator again (see SECURITY.md)
//
// To change the key: 1. --generate. 2. In .env put the new one as COMMERCIA_SECRET_KEY and the old one as
// COMMERCIA_SECRET_KEY_PREVIOUS. 3. Run this (or just start the app: it does the authenticator secrets by itself).
// 4. Remove COMMERCIA_SECRET_KEY_PREVIOUS once it says everything is done, and keep a copy of the new key.
import '../lib/boot';
import { openDb } from '../db/index';
import { logActivity } from '../lib/core';
import { newKeyHex, protectTotpSecrets } from '../lib/secrets';
import { reencryptBackups } from '../lib/backupCrypto';
import { getSettings } from '../lib/settings';

if (process.argv.includes('--generate')) {
  console.log(newKeyHex());
  process.exit(0);
}
const discard = process.argv.includes('--discard-unreadable');
const db = await openDb({ skipSecretCheck: discard });
if (discard) {
  const r = await protectTotpSecrets(db.k as never, db.secrets, { discardUnreadable: true });
  await logActivity(db.k, null, 'update', 'secrets', null, `Secret key replaced: ${r.discarded} authenticator secret(s) that could not be read were discarded`);
  console.log(`\n  ${r.discarded} authenticator secret(s) were unreadable and have been discarded. Those people set up their authenticator again:`);
  console.log('  run  npm run reset-password -- <email> --reset-2fa  to get each of them a one-time enrolment code.\n');
  process.exit(0);
}
const { backup_dir } = await getSettings(db.k);
const b = await reencryptBackups(backup_dir, db.secrets);
await logActivity(db.k, null, 'update', 'secrets', null, `Secret key rotation: ${b.rewritten} backup file(s) locked with the current key, ${b.failed} could not be read`);
console.log(`\n  Authenticator secrets: locked with the current key.\n  Backup files: ${b.rewritten} re-locked, ${b.alreadyCurrent} already current${b.failed ? `, ${b.failed} COULD NOT BE READ (missing an old key?)` : ''}.`);
if (!b.failed) console.log('  You can now remove COMMERCIA_SECRET_KEY_PREVIOUS. Keep a copy of the current key somewhere safe.\n');
process.exit(b.failed ? 1 : 0);
