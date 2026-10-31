// Forgotten passwords, in a way that works with and without email.
//
//   With email set up (SMTP_URL): "Forgot password?" emails a one-time code to the address on the account.
//   Without it (the offline pilot): the request shows up for an Owner, who makes a one-time code and
//   reads it out to the person (the Admin's own account is reset on the shop computer, see scripts/reset-password.ts).
//
// Either way the person then types the code with a new password. A code works once, expires, allows
// five wrong tries, and only a hash of it is stored. Setting the password signs them out everywhere
// and leaves their authenticator as it was.
import crypto from 'node:crypto';
import type { Tx } from './core';
import { logActivity } from './core';
import { hashPasswordAsync, sha256 } from './crypto';
import { mailConfigured, sendMail } from './mailer';
import type { User } from '../db/schema';

// No I, O, L, 0 or 1: easy to read out over the phone and to type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const EMAIL_CODE_MINUTES = 30;
export const OWNER_CODE_MINUTES = 60;
const MAX_TRIES = 5;
const MAX_REQUESTS_PER_HOUR = 3;
const REQUESTS_SHOWN_HOURS = 24;

export const newCode = () => Array.from({ length: CODE_LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (userId: number, code: string) => sha256(`${userId}:${code}`);
const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/**
 * Someone tapped "Forgot password?". The answer never depends on whether the account exists, so the
 * button can't be used to find out who has one. Returns how the person will get their code.
 */
export async function askForReset(tx: Tx, user: User | undefined, shopName: string): Promise<'email' | 'owner'> {
  const via = mailConfigured() ? 'email' : 'owner';
  if (!user) return via;
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await tx.selectFrom('password_resets').select('id').where('user_id', '=', user.id).where('requested_at', '>=', hourAgo).execute();
  if (recent.length >= MAX_REQUESTS_PER_HOUR) return via;

  if (via === 'email') {
    const code = newCode();
    // One live code per person: asking again replaces the earlier one.
    await tx.updateTable('password_resets').set({ dismissed: 1 }).where('user_id', '=', user.id).where('used_at', 'is', null).execute();
    const row = await tx
      .insertInto('password_resets')
      .values({ user_id: user.id, kind: 'email', code_hash: hashCode(user.id, code), requested_at: now, issued_at: now, issued_by: null, expires_at: minutesFromNow(EMAIL_CODE_MINUTES), attempts: 0, used_at: null, dismissed: 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      await sendMail({
        to: user.email,
        subject: `${shopName}: your Commercia password reset code`,
        text: `Hello ${user.name},\n\nYour code to choose a new Commercia password is ${formatCode(code)}\n\nIt works once and expires in ${EMAIL_CODE_MINUTES} minutes. If you did not ask for it, ignore this email: your password has not changed.\n`,
      });
    } catch (e) {
      // Email failed: turn it into a request an Owner can see and help with.
      console.error('Could not send the password reset email:', e instanceof Error ? e.message : e);
      await tx.updateTable('password_resets').set({ kind: 'owner', code_hash: null, issued_at: null, expires_at: null }).where('id', '=', row.id).execute();
    }
    return via;
  }
  const waiting = await tx.selectFrom('password_resets').select('id').where('user_id', '=', user.id).where('kind', '=', 'owner').where('code_hash', 'is', null).where('dismissed', '=', 0).where('used_at', 'is', null).executeTakeFirst();
  if (!waiting) {
    await tx.insertInto('password_resets').values({ user_id: user.id, kind: 'owner', code_hash: null, requested_at: now, issued_at: null, issued_by: null, expires_at: null, attempts: 0, used_at: null, dismissed: 0 }).execute();
  }
  return via;
}

/** Requests waiting for an Owner or the Admin. An Owner never sees the Admin's, as they cannot manage that account. */
export async function pendingRequests(tx: Tx, actor: User) {
  const since = new Date(Date.now() - REQUESTS_SHOWN_HOURS * 3600_000).toISOString();
  const rows = await tx
    .selectFrom('password_resets as r')
    .innerJoin('users as u', 'u.id', 'r.user_id')
    .select(['r.id', 'r.requested_at', 'u.id as userId', 'u.name', 'u.email', 'u.role'])
    .where('r.kind', '=', 'owner')
    .where('r.code_hash', 'is', null)
    .where('r.dismissed', '=', 0)
    .where('r.used_at', 'is', null)
    .where('r.requested_at', '>=', since)
    .where('u.active', '=', 1)
    .orderBy('r.id')
    .execute();
  return rows.filter((r) => actor.role === 'admin' || r.role !== 'admin');
}

/** An Owner (or the Admin) makes a one-time code for someone, to read out to them. Shown once. */
export async function issueCode(tx: Tx, actor: User, target: User): Promise<{ code: string; expiresAt: string }> {
  const code = newCode();
  const now = new Date().toISOString();
  const expiresAt = minutesFromNow(OWNER_CODE_MINUTES);
  const waiting = await tx.selectFrom('password_resets').select('id').where('user_id', '=', target.id).where('kind', '=', 'owner').where('code_hash', 'is', null).where('dismissed', '=', 0).where('used_at', 'is', null).orderBy('id', 'desc').executeTakeFirst();
  // Any earlier live code stops working.
  let q = tx.updateTable('password_resets').set({ dismissed: 1 }).where('user_id', '=', target.id).where('used_at', 'is', null);
  if (waiting) q = q.where('id', '!=', waiting.id);
  await q.execute();
  const issue = { code_hash: hashCode(target.id, code), issued_at: now, issued_by: actor.id, expires_at: expiresAt, attempts: 0, dismissed: 0 };
  if (waiting) await tx.updateTable('password_resets').set(issue).where('id', '=', waiting.id).execute();
  else await tx.insertInto('password_resets').values({ user_id: target.id, kind: 'owner', requested_at: now, used_at: null, ...issue }).execute();
  await logActivity(tx, actor.id, 'issue', 'password_reset', target.id, `${actor.name} made a password reset code for ${target.name}`);
  return { code: formatCode(code), expiresAt };
}

/** Check the code and set the new password. Any failure looks the same to the caller. */
export async function redeem(tx: Tx, user: User, rawCode: string, newPassword: string): Promise<boolean> {
  const code = normalizeCode(rawCode);
  const now = new Date().toISOString();
  const row = await tx
    .selectFrom('password_resets')
    .selectAll()
    .where('user_id', '=', user.id)
    .where('used_at', 'is', null)
    .where('dismissed', '=', 0)
    .where('code_hash', 'is not', null)
    .where('expires_at', '>', now)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!row || row.attempts >= MAX_TRIES) return false;
  if (code.length !== CODE_LENGTH || !sameHash(row.code_hash!, hashCode(user.id, code))) {
    const attempts = row.attempts + 1;
    await tx.updateTable('password_resets').set({ attempts, dismissed: attempts >= MAX_TRIES ? 1 : 0 }).where('id', '=', row.id).execute();
    await logActivity(tx, user.id, 'login_failed', 'password_reset', user.id, `Wrong password reset code for ${user.name}`);
    return false;
  }
  await tx.updateTable('users').set({ password_hash: await hashPasswordAsync(newPassword), session_epoch: user.session_epoch + 1 }).where('id', '=', user.id).execute();
  await tx.updateTable('password_resets').set({ used_at: now }).where('id', '=', row.id).execute();
  await tx.updateTable('password_resets').set({ dismissed: 1 }).where('user_id', '=', user.id).where('used_at', 'is', null).execute();
  await logActivity(tx, user.id, 'update', 'user', user.id, `${user.name} chose a new password with a reset code`);
  return true;
}

/** Tell the person, when email is set up, that their password was changed. Best effort. */
export async function tellPasswordChanged(user: User, shopName: string) {
  if (!mailConfigured()) return;
  try {
    await sendMail({ to: user.email, subject: `${shopName}: your Commercia password was changed`, text: `Hello ${user.name},\n\nYour Commercia password was just changed with a reset code. If this was not you, tell the shop Owner now.\n` });
  } catch {
    /* the password is changed either way */
  }
}
