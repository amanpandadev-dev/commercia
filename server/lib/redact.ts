// Nothing secret in a log. Every line the server prints, and every error it reports, goes through redact():
// the configured secrets (SMTP and database passwords, the key), passwords inside URLs, and values next to
// words like password, token, code or cookie.
import util from 'node:util';
import { secretValues } from './config';

const MASK = '[hidden]';

export function redact(text: string): string {
  let out = text;
  for (const s of secretValues()) out = out.split(s).join(MASK);
  return out
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`) // user:password@host
    .replace(/((?:commercia_session|__Host-commercia_session|set-cookie|cookie)["']?\s*[:=]\s*(?:__Host-)?(?:commercia_session=)?)[A-Za-z0-9_\-%.]{16,}/gi, `$1${MASK}`)
    .replace(/(\b(?:authorization)["']?\s*[:=]\s*(?:bearer|basic)\s+)[^\s"',]+/gi, `$1${MASK}`)
    .replace(/(["']?\b(?:password|passwd|current|next|secret|token|code|totp|recovery|key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}"']+)/gi, `$1${MASK}`);
}

let installed = false;
/** Makes console.log/info/warn/error/debug redact what they print, whoever calls them (our code or a library). */
export function installConsoleRedaction() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(redact(util.format(...args)));
  }
}
