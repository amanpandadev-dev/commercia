// Setting up an authenticator is allowed only to someone who can show they are the person: a one-time enrolment code that
// was emailed to the address on the account (proof of email control), or issued by an Admin or Owner and handed over in
// person. Without it, anyone who knew or guessed a password could set up their own authenticator first, and the real person
// would be the one locked out. A code works once, expires, allows five wrong tries, and only a hash is stored.
import crypto from 'node:crypto';
import type { Tx } from './core';
import { logActivity } from './core';
import { sha256 } from './crypto';
import { mailConfigured, sendMail } from './mailer';
import { formatCode, newCode, normalizeCode } from './passwordReset';
import type { User } from '../db/schema';

export const EMAIL_CODE_MINUTES = 30;
export const ADMIN_CODE_HOURS = 24;
const MAX_TRIES = 5;
const hashCode = (userId: number, code: string) => sha256(`enrol:${userId}:${code}`);
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function store(tx: Tx, target: User, kind: 'email' | 'admin', issuedBy: number | null, expiresAt: string): Promise<string> {
  const code = newCode();
  const now = new Date().toISOString();
  // One live code per person: a new one replaces the earlier one.
  await tx.updateTable('enrolment_codes').set({ used_at: now }).where('user_id', '=', target.id).where('used_at', 'is', null).execute();
  await tx.insertInto('enrolment_codes').values({ user_id: target.id, kind, code_hash: hashCode(target.id, code), issued_by: issuedBy, expires_at: expiresAt, attempts: 0, used_at: null, created_at: now }).execute();
  return code;
}

/** An Admin or Owner (or the shop computer, actor null) makes a code to hand over. Shown once. */
export async function issueEnrolmentCode(tx: Tx, actor: User | null, target: User): Promise<{ code: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + ADMIN_CODE_HOURS * 3600_000).toISOString();
  const code = await store(tx, target, 'admin', actor?.id ?? null, expiresAt);
  await logActivity(tx, actor?.id ?? null, 'enrolment_code', 'security', target.id, `${actor?.name ?? 'The shop computer'} made an authenticator enrolment code for ${target.name}`);
  return { code: formatCode(code), expiresAt };
}

/** Emails a code to the address on the account. The caller answers the same way whether or not it worked. Returns whether it was sent. */
export async function emailEnrolmentCode(tx: Tx, user: User, shopName: string): Promise<boolean> {
  if (!mailConfigured()) return false;
  const expiresAt = new Date(Date.now() + EMAIL_CODE_MINUTES * 60_000).toISOString();
  const code = await store(tx, user, 'email', null, expiresAt);
  try {
    await sendMail({
      to: user.email,
      subject: `${shopName}: your Commercia authenticator setup code`,
      text: `Hello ${user.name},\n\nYour code to set up the authenticator app for Commercia is ${formatCode(code)}\n\nIt works once and expires in ${EMAIL_CODE_MINUTES} minutes. If you did not ask for it, ignore this email: nothing has changed.\n`,
    });
    return true;
  } catch (e) {
    console.error('Could not send the enrolment email:', e instanceof Error ? e.message : e);
    return false;
  }
}

/** True if the code is right for this person (and uses it up). Every failure looks the same to the caller. */
export async function redeemEnrolmentCode(tx: Tx, user: User, raw: string): Promise<boolean> {
  const code = normalizeCode(raw);
  const row = await tx
    .selectFrom('enrolment_codes')
    .selectAll()
    .where('user_id', '=', user.id)
    .where('used_at', 'is', null)
    .where('expires_at', '>', new Date().toISOString())
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!row || row.attempts >= MAX_TRIES) return false;
  if (code.length !== 8 || !same(row.code_hash, hashCode(user.id, code))) {
    await tx.updateTable('enrolment_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
    return false;
  }
  await tx.updateTable('enrolment_codes').set({ used_at: new Date().toISOString() }).where('id', '=', row.id).execute();
  return true;
}

/** Forgets every live enrolment code of a person (when their authenticator is reset or they are deactivated). */
export async function voidEnrolmentCodes(tx: Tx, userId: number): Promise<void> {
  await tx.updateTable('enrolment_codes').set({ used_at: new Date().toISOString() }).where('user_id', '=', userId).where('used_at', 'is', null).execute();
}
