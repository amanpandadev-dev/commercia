// Who is really calling, and was it https? Behind a tunnel or reverse proxy (Cloudflare Tunnel, Tailscale Serve) the
// server only sees the proxy on this very computer; the visitor's address and "https" arrive in headers. Those headers
// are believed ONLY when the connection itself comes from a configured proxy address (TRUST_PROXY=1 means this
// computer, or TRUSTED_PROXIES). From anyone else, on the Wi-Fi for example, they are ignored, since anyone can send them.
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from './config';
import { LOOPBACK, ipSet, normalizeIp } from './net';

/** The address of the connection itself. null when there is no real connection (a call made inside the program, as tests do). */
export function peerAddress(c: Context): string | null {
  try {
    const a = getConnInfo(c).remote.address;
    return a ? normalizeIp(a) : null;
  } catch {
    return null;
  }
}

/** The connection comes from a proxy we trust. A call with no real connection counts as coming from this computer. */
export function fromTrustedProxy(c: Context): boolean {
  const trusted = config().trustedProxies;
  if (!trusted.length) return false;
  const peer = peerAddress(c) ?? '127.0.0.1';
  return ipSet(trusted).has(peer);
}

export function isHttps(c: Context): boolean {
  if (c.req.url.startsWith('https:')) return true;
  if (!fromTrustedProxy(c)) return false;
  if (c.req.header('x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  return /"scheme"\s*:\s*"https"/.test(c.req.header('cf-visitor') ?? '');
}

/** The visitor's address: the proxy's header behind a trusted proxy, otherwise the connection itself. */
export function clientIp(c: Context): string {
  if (fromTrustedProxy(c)) {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim();
    if (ip) return normalizeIp(ip);
  }
  return peerAddress(c) ?? 'local';
}

/** Headers a proxy or tunnel adds. A request that has any of them did not come straight from a person at this computer. */
const FORWARDING = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry'];

/** The request has been passed on by a proxy or tunnel. */
export const wasForwarded = (c: Context): boolean => FORWARDING.some((h) => c.req.header(h) !== undefined);

/** The request is from a browser on this computer itself (the shop PC), not from the Wi-Fi, a phone, or a tunnel. */
export function isShopPc(c: Context): boolean {
  const peer = peerAddress(c);
  if (peer !== null && !ipSet(LOOPBACK).has(peer)) return false;
  return !wasForwarded(c);
}
