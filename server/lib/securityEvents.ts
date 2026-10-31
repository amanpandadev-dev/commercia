// What the Security screen and the Dashboard banner read: the security entries of the activity log, and who is locked now.
import type { Tx } from './core';
import { SECURITY_ACTIONS } from './alerts';
import { activeLocks } from './throttle';

const DAY = 24 * 3600_000;

/** Counts for the last 24 hours, and how many locks are in force now. */
export async function securitySummary(k: Tx, now = Date.now()) {
  const since = new Date(now - DAY).toISOString();
  const rows = await k.selectFrom('activity').select(['action']).where('action', 'in', [...SECURITY_ACTIONS]).where('created_at', '>=', since).execute();
  const n = (...actions: string[]) => rows.filter((r) => actions.includes(r.action)).length;
  const locks = await activeLocks(k, now);
  return {
    failedLogins: n('login_failed', 'reauth_failed'),
    lockouts: n('lockout'),
    refused: n('refused'),
    resets: n('password_forgot', 'password_reset', 'totp_reset', 'enrolment_code'),
    exports: n('export', 'backup_download'),
    newDevices: n('login_new_device'),
    locksNow: locks.length,
  };
}

/** A person-readable name for a lock key such as "login:u7" or "ip:203.0.113.9". */
async function lockLabel(k: Tx, key: string): Promise<string> {
  const [kind, rest = ''] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (rest.startsWith('u')) {
    const u = await k.selectFrom('users').select('name').where('id', '=', Number(rest.slice(1))).executeTakeFirst();
    const what = { login: 'password', code: 'authenticator codes', reset: 'password reset codes' }[kind] ?? kind;
    return `${u?.name ?? `user ${rest.slice(1)}`}: ${what}`;
  }
  if (kind === 'ip') return `Address ${rest}`;
  if (rest.startsWith('e')) return `Name that is not a user: ${rest.slice(1)}`;
  return key;
}

export async function securityEvents(k: Tx, opts: { days?: number; type?: string; limit?: number } = {}) {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const actions = opts.type && (SECURITY_ACTIONS as readonly string[]).includes(opts.type) ? [opts.type] : [...SECURITY_ACTIONS];
  const events = await k
    .selectFrom('activity as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .select(['a.id', 'a.action', 'a.summary', 'a.created_at', 'u.name as by'])
    .where('a.action', 'in', actions)
    .where('a.created_at', '>=', new Date(Date.now() - days * DAY).toISOString())
    .orderBy('a.id', 'desc')
    .limit(Math.min(opts.limit ?? 300, 1000))
    .execute();
  const locks = await Promise.all((await activeLocks(k)).map(async (l) => ({ label: await lockLabel(k, l.key), until: l.until, strikes: l.strikes })));
  return { events, locks, summary: await securitySummary(k) };
}
