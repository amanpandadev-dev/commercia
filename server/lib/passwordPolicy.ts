// What counts as an acceptable password: at least ten characters, not a common one (a list bundled with the program,
// also with digits, symbols and look-alike letters stripped), and not the person's own name, email or the shop's name.
// No rules about "one capital and one symbol": length and not being guessable matter far more than those do.
import { COMMON_ROOTS, COMMON_WHOLE } from './commonPasswords';

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 128; // a longer one only costs time to hash

export interface Who {
  name?: string;
  email?: string;
  shopName?: string;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };
const unleet = (s: string) => s.replace(/[0134578@$!]/g, (c) => LEET[c] ?? c);
/** For comparing with someone's name: look-alikes collapse, so "Sun1l", "sunil" and "$unIl" are the same. */
const CANON: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', l: 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
const canon = (s: string) => s.toLowerCase().replace(/[01!|l34578@$]/g, (c) => CANON[c] ?? c).replace(/[^a-z]/g, '');
const trimEnds = (s: string) => s.replace(/^[^a-z]+|[^a-z]+$/g, '');
const pieces = (s: string | undefined, min: number) => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= min);

/** null if the password is acceptable; otherwise what to tell the person. */
export function checkPassword(password: string, who: Who = {}): string | null {
  if (password.length < MIN_LENGTH) return `The password must be at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `The password can be at most ${MAX_LENGTH} characters.`;
  const p = password.toLowerCase();
  const letters = p.replace(/[^a-z]/g, '');
  // Their own details make it easy to guess for anyone who knows them.
  const personal = [...pieces(who.name, 3), ...pieces((who.email ?? '').split('@')[0], 3), ...pieces(who.shopName, 4)];
  const flat = canon(p);
  if (personal.some((w) => p.includes(w) || flat.includes(canon(w)))) return "The password must not contain your name, your email or the shop's name.";
  // "P@ssw0rd2024!": strip what was added at the ends, then undo the look-alike letters.
  const core = trimEnds(p);
  const forms = [p, core, unleet(core), unleet(p), letters];
  if (forms.some((f) => COMMON_WHOLE.has(f) || COMMON_ROOTS.has(f))) return 'That password is too common. Choose something harder to guess, such as a few unrelated words.';
  if (/^(.)\1+$/.test(p) || new Set(p).size <= 3) return 'That password is too simple (the same few characters repeated).';
  if (isRun(p)) return 'That password is a run of keys or numbers in order. Choose something harder to guess.';
  return null;
}

const KEY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
/** Mostly keys that sit next to each other on the keyboard, or follow each other in the alphabet or the digits ("zxcvbnmasdfg", "abcdefghijkl"). */
function isRun(p: string): boolean {
  let steps = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const near = KEY_ROWS.some((row) => Math.abs(row.indexOf(a) - row.indexOf(b)) === 1 && row.includes(a) && row.includes(b));
    if (near || Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) === 1) steps++;
  }
  return steps >= p.length - 2;
}
