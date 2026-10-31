// Recovery codes: ten one-use codes, made when an authenticator is set up, for the day the phone is lost or broken.
// Each logs in once in place of an authenticator code. Only hashes are stored, so they cannot be read back: they are
// shown once, to be written down and kept somewhere safe.
import crypto from 'node:crypto';
import type { Tx } from './core';
import { sha256 } from './crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, O, L, 0, 1
const LENGTH = 10; // about 50 bits each
export const RECOVERY_COUNT = 10;
const hash = (userId: number, code: string) => sha256(`recovery:${userId}:${code}`);

export const normalizeRecovery = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatRecovery = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`;

/** Replaces any codes the person has with ten new ones, and returns them (this is the only time they can be seen). */
export async function makeRecoveryCodes(tx: Tx, userId: number): Promise<string[]> {
  await tx.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
  const codes = Array.from({ length: RECOVERY_COUNT }, () => Array.from({ length: LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join(''));
  const now = new Date().toISOString();
  await tx.insertInto('recovery_codes').values(codes.map((c) => ({ user_id: userId, code_hash: hash(userId, c), used_at: null, created_at: now }))).execute();
  return codes.map(formatRecovery);
}

export async function recoveryLeft(tx: Tx, userId: number): Promise<number> {
  const r = await tx.selectFrom('recovery_codes').select(({ fn }) => fn.countAll().as('n')).where('user_id', '=', userId).where('used_at', 'is', null).executeTakeFirst();
  return Number(r?.n ?? 0);
}

/** Uses a code up. False for a wrong or already-used one. */
export async function useRecoveryCode(tx: Tx, userId: number, raw: string): Promise<boolean> {
  const code = normalizeRecovery(raw);
  if (code.length !== LENGTH) return false;
  // The "is null" in the update makes two tries with the same code at once succeed only once.
  const r = await tx.updateTable('recovery_codes').set({ used_at: new Date().toISOString() }).where('user_id', '=', userId).where('code_hash', '=', hash(userId, code)).where('used_at', 'is', null).executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

export async function voidRecoveryCodes(tx: Tx, userId: number): Promise<void> {
  await tx.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
}
