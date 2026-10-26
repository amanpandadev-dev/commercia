// Running behind Cloudflare Tunnel (or any proxy): the app itself only sees plain http from the proxy on this
// computer, so it has to be told to believe the proxy's headers. Off by default: anyone on the Wi-Fi could send them.
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export const trustProxy = () => process.env.TRUST_PROXY === '1';

/** Was the browser's connection https? Behind a trusted proxy, ask the proxy. */
export function isHttps(c: Context): boolean {
  if (c.req.url.startsWith('https:')) return true;
  if (!trustProxy()) return false;
  if (c.req.header('x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  return /"scheme"\s*:\s*"https"/.test(c.req.header('cf-visitor') ?? '');
}

/** Who is calling: Cloudflare's header behind a trusted proxy, otherwise the connection itself. */
export function clientIp(c: Context): string {
  if (trustProxy()) {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim();
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? 'local';
  } catch {
    return 'local'; // no real connection (tests)
  }
}
