// Brute-force brakes. Wrong passwords, wrong authenticator codes and wrong reset codes are counted per account and per
// address. Enough of them inside a window lock that account (or address) for a while; each lock is longer than the last
// (5 minutes, 15, 45, then an hour at most), and a quiet day forgets the history.
//
// The counts live in the database, so a lock survives a restart, and `npm run reset-password -- <email> --unlock`
// (run on the shop computer) can lift it. A lock is never longer than an hour, so nobody, the Admin included, is locked
// out for good. While locked, even the right password is refused, or a lock would stop nothing.
import type { Tx } from './core';
import { HttpError } from './core';

export interface Policy {
  /** Wrong tries inside `windowMs` that cause a lock. */
  max: number;
  windowMs: number;
  /** The first lock; later ones are three times longer each, up to `capMs`. */
  baseLockMs: number;
  capMs?: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const CAP = HOUR;
const FORGET_AFTER = 24 * HOUR;

export const POLICY = {
  /** A password on one account. */
  account: { max: 5, windowMs: 15 * MIN, baseLockMs: 5 * MIN },
  /** Anything wrong from one address, across all accounts: spraying names or passwords. */
  address: { max: 30, windowMs: 15 * MIN, baseLockMs: 15 * MIN },
  /** Authenticator, recovery and enrolment codes. */
  code: { max: 5, windowMs: 10 * MIN, baseLockMs: 5 * MIN },
  /** Every "forgot password" or reset try (they can't "fail", so each one counts). */
  reset: { max: 8, windowMs: HOUR, baseLockMs: 15 * MIN },
  /** First-time setup tokens. */
  setup: { max: 5, windowMs: 15 * MIN, baseLockMs: 15 * MIN },
} as const satisfies Record<string, Policy>;

const iso = (ms: number) => new Date(ms).toISOString();

/** Refuses (429, with Retry-After) while the key is locked. */
export async function checkThrottle(k: Tx, key: string, now = Date.now()): Promise<void> {
  const row = await k.selectFrom('auth_throttle').select('locked_until').where('key', '=', key).executeTakeFirst();
  if (row?.locked_until && Date.parse(row.locked_until) > now) {
    const secs = Math.ceil((Date.parse(row.locked_until) - now) / 1000);
    const mins = Math.ceil(secs / 60);
    throw new HttpError(429, `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'rate_limited', undefined, secs);
  }
}

export interface Failure {
  /** This failure caused a lock. */
  locked: boolean;
  until?: string;
  strikes: number;
}

/** Counts one wrong try. */
export async function recordFailure(k: Tx, key: string, policy: Policy, now = Date.now()): Promise<Failure> {
  const row = await k.selectFrom('auth_throttle').selectAll().where('key', '=', key).executeTakeFirst();
  const quiet = row && now - Date.parse(row.last_fail) > FORGET_AFTER;
  const inWindow = row && !quiet && now - Date.parse(row.window_start) <= policy.windowMs;
  let fails = inWindow ? row.fails + 1 : 1;
  let windowStart = inWindow ? row.window_start : iso(now);
  let strikes = quiet ? 0 : (row?.strikes ?? 0);
  let lockedUntil: string | null = row?.locked_until && Date.parse(row.locked_until) > now ? row.locked_until : null;
  let locked = false;
  if (fails >= policy.max) {
    strikes += 1;
    const ms = Math.min(policy.capMs ?? CAP, policy.baseLockMs * 3 ** (strikes - 1));
    lockedUntil = iso(now + ms);
    fails = 0; // the next window starts after the lock
    windowStart = iso(now);
    locked = true;
  }
  const values = { key, fails, window_start: windowStart, locked_until: lockedUntil, strikes, last_fail: iso(now) };
  if (row) await k.updateTable('auth_throttle').set(values).where('key', '=', key).execute();
  else await k.insertInto('auth_throttle').values(values).execute();
  return { locked, until: locked ? lockedUntil! : undefined, strikes };
}

/** A good login: forget the wrong tries (and any history) for this key. */
export async function clearThrottle(k: Tx, key: string): Promise<void> {
  await k.deleteFrom('auth_throttle').where('key', '=', key).execute();
}

/** Lifts every lock on one person: their password, codes and reset tries. */
export async function unlockUser(k: Tx, userId: number): Promise<number> {
  const keys = [`login:u${userId}`, `code:u${userId}`, `reset:u${userId}`];
  const r = await k.deleteFrom('auth_throttle').where('key', 'in', keys).executeTakeFirst();
  return Number(r.numDeletedRows);
}

/** Lifts every lock there is (Admin, on the shop computer). */
export async function unlockEverything(k: Tx): Promise<number> {
  const r = await k.deleteFrom('auth_throttle').executeTakeFirst();
  return Number(r.numDeletedRows);
}

/** Who is locked right now (for the security view). */
export async function activeLocks(k: Tx, now = Date.now()) {
  const rows = await k.selectFrom('auth_throttle').select(['key', 'locked_until', 'strikes']).where('locked_until', '>', iso(now)).orderBy('locked_until', 'desc').execute();
  return rows.map((r) => ({ key: r.key, until: r.locked_until!, strikes: r.strikes }));
}

export const accountKey = (user: { id: number } | undefined, email?: string) => `login:${user ? `u${user.id}` : `e${(email ?? '').trim().toLowerCase().slice(0, 120)}`}`;
export const addressKey = (ip: string) => `ip:${ip}`;
