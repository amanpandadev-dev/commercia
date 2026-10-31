import crypto from 'node:crypto';
import { config } from './config';

// Passwords: scrypt with a random salt. The cost is written into the hash itself ("scrypt$N$r$p$salt$hash"), so it can be
// raised later without breaking anyone: the next successful login quietly re-hashes with the current cost. Hashes from before
// ("scrypt$salt$hash") were N=16384, r=8, p=1 and are still read.
const R = 8;
const P = 1;
const LEGACY_N = 16384;
const KEY_LEN = 32;
const maxmem = (n: number, r: number) => 129 * n * r + 4 * 1024 * 1024;

const costN = () => 2 ** config().scryptLog2;

interface Parsed {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}
function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3 && parts[1] && parts[2]) return { n: LEGACY_N, r: R, p: P, salt: Buffer.from(parts[1], 'base64'), hash: Buffer.from(parts[2], 'base64') };
  if (parts.length === 6) {
    const [n, r, p] = parts.slice(1, 4).map(Number);
    if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 2 ** 22 || r > 32 || p > 8) return null; // a stored value cannot make us use a huge amount of memory
    return { n, r, p, salt: Buffer.from(parts[4], 'base64'), hash: Buffer.from(parts[5], 'base64') };
  }
  return null;
}
const format = (n: number, salt: Buffer, hash: Buffer) => `scrypt$${n}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
const derive = (pw: string, salt: Buffer, n: number, r: number, p: number) => crypto.scryptSync(pw, salt, KEY_LEN, { N: n, r, p, maxmem: maxmem(n, r) });
const deriveAsync = (pw: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => crypto.scrypt(pw, salt, KEY_LEN, { N: n, r, p, maxmem: maxmem(n, r) }, (e, k) => (e ? reject(e) : resolve(k))));

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const n = costN();
  return format(n, salt, derive(password, salt, n, R, P));
}
/** The same, without holding up the server while it works (it takes a few tenths of a second at the current cost). */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const n = costN();
  return format(n, salt, await deriveAsync(password, salt, n, R, P));
}

export function verifyPassword(password: string, stored: string): boolean {
  const x = parse(stored);
  if (!x || x.hash.length !== KEY_LEN) return false;
  return crypto.timingSafeEqual(x.hash, derive(password, x.salt, x.n, x.r, x.p));
}
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const x = parse(stored);
  if (!x || x.hash.length !== KEY_LEN) return false;
  return crypto.timingSafeEqual(x.hash, await deriveAsync(password, x.salt, x.n, x.r, x.p));
}

/** The hash was made with a lower cost (or the old format) than the one in force now. */
export function passwordNeedsRehash(stored: string): boolean {
  const x = parse(stored);
  return !!x && (x.n < costN() || x.r !== R || x.p !== P || stored.split('$').length === 3);
}

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// TOTP (RFC 6238) for authenticator apps — 6 digits, 30 s steps, SHA-1.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpCode(secret: string, time = Date.now(), step = 30): string {
  const counter = Math.floor(time / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * Accepts the current code and one step either side, for clock drift. Returns the time step the code belongs to
 * (so the caller can refuse to take the same step twice), or null if it is wrong.
 */
export function verifyTotpStep(secret: string, code: string, time = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  let found: number | null = null;
  for (const d of [-1, 0, 1]) {
    const t = time + d * 30000;
    const expected = Buffer.from(totpCode(secret, t));
    // Always compare all three, and in constant time.
    if (crypto.timingSafeEqual(expected, Buffer.from(c)) && found === null) found = Math.floor(t / 1000 / 30);
  }
  return found;
}

export const verifyTotp = (secret: string, code: string, time = Date.now()): boolean => verifyTotpStep(secret, code, time) !== null;
