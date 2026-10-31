// First-time setup creates the Admin, so it must not be open to whoever reaches the address first. It is allowed
// from a browser on the shop computer itself, or from another device with a one-time setup code that is printed in the
// server's console (which only someone at the computer can read). Once there is a user it is closed for good.
import crypto from 'node:crypto';
import type { Context } from 'hono';
import { isShopPc } from './proxy';
import { formatCode, newCode, normalizeCode } from './passwordReset';

let token: string | null = null;

/** The code for this run of the server. Made on first use, never stored. */
export function setupCode(): string {
  return (token ??= newCode());
}

export function printSetupHelp(port: number) {
  // Straight to the console, not through log redaction: this is the one place the code is meant to be seen.
  process.stdout.write(`\n  First-time setup: open http://localhost:${port} on this computer.\n  From another device (a phone, a tunnel) the setup code is  ${formatCode(setupCode())}\n\n`);
}

export function clearSetupCode() {
  token = null;
}

export type SetupAccess = 'shop-pc' | 'code' | 'refused';

export function setupAccess(c: Context, given?: string): SetupAccess {
  if (isShopPc(c)) return 'shop-pc';
  if (given && token) {
    const a = Buffer.from(normalizeCode(given));
    const b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'code';
  }
  return 'refused';
}
