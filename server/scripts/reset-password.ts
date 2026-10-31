// Last resort for a forgotten password, run on the shop computer (it needs the database file).
// This is how the Admin gets back in when email is not set up, because no one above the Admin can reset it.
//
//   npm run reset-password -- ramesh@shop.in                  makes a new random password and prints it
//   npm run reset-password -- ramesh@shop.in "my new pass"    sets the one you give
//   add --reset-2fa to also switch off the authenticator (lost phone); the person sets it up again at next login
//   npm run reset-password -- ramesh@shop.in --unlock         lifts the lock after too many wrong tries; changes nothing else
//   npm run reset-password -- --unlock-all                    lifts every lock (every account and address)
//   npm run reset-password -- ramesh@shop.in --enrol-code     a one-time code to set up an authenticator (changes nothing else)
import '../lib/boot';
import crypto from 'node:crypto';
import { openDb, nowIso } from '../db/index';
import { hashPassword } from '../lib/crypto';
import { checkPassword } from '../lib/passwordPolicy';
import { logActivity } from '../lib/core';
import { unlockEverything, unlockUser } from '../lib/throttle';
import { issueEnrolmentCode } from '../lib/enrolment';
import { voidRecoveryCodes } from '../lib/recovery';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const reset2fa = process.argv.includes('--reset-2fa');
const [email, given] = args;
if (process.argv.includes('--unlock-all')) {
  const db = await openDb();
  const n = await unlockEverything(db.k);
  await logActivity(db.k, null, 'update', 'security', null, `All login locks lifted from the shop computer (${n} lock record(s) cleared)`);
  console.log(`\n  Every lock is lifted (${n} cleared).\n`);
  process.exit(0);
}
if (!email) {
  console.error('Usage: npm run reset-password -- <email> [new password] [--reset-2fa]\n       npm run reset-password -- <email> --unlock\n       npm run reset-password -- --unlock-all');
  process.exit(1);
}
if (given) {
  const problem = checkPassword(given);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}

const db = await openDb();
const user = await db.k.selectFrom('users').selectAll().where('email', '=', email.trim().toLowerCase()).executeTakeFirst();
if (!user) {
  console.error(`No user with the email ${email}. Check ${db.file ?? 'the database'} is the right one.`);
  process.exit(1);
}
if (process.argv.includes('--unlock')) {
  const n = await unlockUser(db.k, user.id);
  await logActivity(db.k, null, 'update', 'security', user.id, `Locks on ${user.name} lifted from the shop computer`);
  console.log(`\n  ${user.name} (${user.email}) can try again now (${n} lock record(s) cleared). Their password was not changed.\n`);
  process.exit(0);
}
if (process.argv.includes('--enrol-code')) {
  const { code, expiresAt } = await issueEnrolmentCode(db.k, null, user);
  console.log(`\n  One-time code for ${user.name} to set up an authenticator:  ${code}`);
  console.log(`  It works once and expires ${expiresAt}. They type it at their next login. Nothing else was changed.\n`);
  process.exit(0);
}
const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const password = given ?? Array.from({ length: 12 }, () => letters[crypto.randomInt(letters.length)]).join('');
await db.k
  .updateTable('users')
  .set({
    password_hash: hashPassword(password),
    active: 1,
    session_epoch: user.session_epoch + 1, // signs them out everywhere
    ...(reset2fa ? { totp_enabled: 0, totp_secret: null, totp_pending: null, totp_last_step: null } : {}),
  })
  .where('id', '=', user.id)
  .execute();
let enrolCode = '';
if (reset2fa) {
  await voidRecoveryCodes(db.k, user.id);
  enrolCode = (await issueEnrolmentCode(db.k, null, user)).code;
}
await logActivity(db.k, null, 'update', 'user', user.id, `Password for ${user.name} reset from the shop computer${reset2fa ? ' (authenticator reset too)' : ''} at ${nowIso()}`);

console.log(`\n  Password for ${user.name} (${user.email}) is now:  ${password}`);
console.log('  They are signed out everywhere. Log in, then change it under your account.');
if (reset2fa) console.log(`  The authenticator was switched off and its recovery codes cancelled. To set it up again they need this one-time code at their next login:  ${enrolCode}`);
console.log('');
process.exit(0);
