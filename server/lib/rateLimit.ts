// Stops guessing: too many wrong passwords or codes lock that account (and that address) for a while.
// Kept in memory on purpose: it is a short-lived brake, and a restart of the server is not something an attacker controls.
import { HttpError } from './core';

export class AttemptLimiter {
  private entries = new Map<string, { fails: number[]; lockedUntil: number }>();

  /** `max` wrong tries inside `windowMs` lock the key for `lockMs`. */
  constructor(private max: number, private windowMs: number, private lockMs: number) {}

  /** Refuses while locked, even for a right password: otherwise a lock would not stop anything. */
  check(key: string, now = Date.now()) {
    const e = this.entries.get(key);
    if (e && e.lockedUntil > now) {
      const mins = Math.ceil((e.lockedUntil - now) / 60000);
      throw new HttpError(429, `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'rate_limited');
    }
  }

  fail(key: string, now = Date.now()) {
    if (this.entries.size > 5000) this.prune(now);
    const e = this.entries.get(key) ?? { fails: [], lockedUntil: 0 };
    e.fails = [...e.fails.filter((t) => t > now - this.windowMs), now];
    if (e.fails.length >= this.max) {
      e.lockedUntil = now + this.lockMs;
      e.fails = [];
    }
    this.entries.set(key, e);
  }

  clear(key: string) {
    this.entries.delete(key);
  }

  private prune(now: number) {
    for (const [k, e] of this.entries) if (e.lockedUntil <= now && e.fails.every((t) => t <= now - this.windowMs)) this.entries.delete(k);
  }
}
