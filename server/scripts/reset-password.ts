// Last resort for a forgotten password, run on the shop computer (it needs the database file).
// This is how the Admin gets back in when email is not set up, because no one above the Admin can reset it.
//
//   npm run reset-password -- ramesh@shop.in                  makes a new random password and prints it
//   npm run reset-password -- ramesh@shop.in "my new pass"    sets the one you give
//   add --reset-2fa to also switch off the authenticator (lost phone); the person sets it up again at next login
import '../lib/boot';
import crypto from 'node:crypto';
import { openDb, nowIso } from '../db/index';
import { hashPassword } from '../lib/crypto';
import { logActivity } from '../lib/core';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const reset2fa = process.argv.includes('--reset-2fa');
const [email, given] = args;
if (!email) {
  console.error('Usage: npm run reset-password -- <email> [new password] [--reset-2fa]');
  process.exit(1);
}
if (given && given.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}

const db = await openDb();
const user = await db.k.selectFrom('users').selectAll().where('email', '=', email.trim().toLowerCase()).executeTakeFirst();
if (!user) {
  console.error(`No user with the email ${email}. Check ${db.file ?? 'the database'} is the right one.`);
  process.exit(1);
}
const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const password = given ?? Array.from({ length: 12 }, () => letters[crypto.randomInt(letters.length)]).join('');
await db.k
  .updateTable('users')
  .set({
    password_hash: hashPassword(password),
    active: 1,
    session_epoch: user.session_epoch + 1, // signs them out everywhere
    ...(reset2fa ? { totp_enabled: 0, totp_secret: null } : {}),
  })
  .where('id', '=', user.id)
  .execute();
await logActivity(db.k, null, 'update', 'user', user.id, `Password for ${user.name} reset from the shop computer${reset2fa ? ' (authenticator reset too)' : ''} at ${nowIso()}`);

console.log(`\n  Password for ${user.name} (${user.email}) is now:  ${password}`);
console.log('  They are signed out everywhere. Log in, then change it under your account.');
if (reset2fa) console.log('  The authenticator was switched off; it is set up again at the next login.');
console.log('');
process.exit(0);
