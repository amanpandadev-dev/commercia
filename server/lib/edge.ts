// The edge of the app: what happens to a request before any route sees it. None of this needs a new service.
//   1. Who may connect at all (the address of the connection; default: this computer, the shop network and Tailscale).
//   2. Rate limits: per visitor, tighter for login, password reset, imports and exports. 429 with Retry-After.
//   3. Security headers: a strict Content-Security-Policy and the rest, no caching of anything under /api.
//   4. Same origin only: no CORS, and a change (POST, PUT, PATCH, DELETE) must come from this site's own pages.
//   5. A limit on how big a request body may be.
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './core';
import { config } from './config';
import { ipSet } from './net';
import { clientIp, fromTrustedProxy, isHttps, peerAddress } from './proxy';

// ---- 1. Who may connect ----
export const ipAllowList: MiddlewareHandler<AppEnv> = async (c, next) => {
  const peer = peerAddress(c);
  // A call made inside the program (tests) has no connection to check.
  if (peer !== null && !ipSet(config().allowedIps).has(peer)) return c.text('This address is not allowed to use Commercia.', 403);
  await next();
};

// ---- 2. Rate limits ----
/** Counts calls per key in fixed windows. In memory: a brake on one running server, not a record. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(readonly limit: number, readonly windowMs: number) {}

  /** ok: false means the limit is used up; retryAfter is in seconds. */
  hit(key: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    if (this.buckets.size > 10_000) for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) this.buckets.set(key, (b = { count: 0, resetAt: now + this.windowMs }));
    b.count++;
    return { ok: b.count <= this.limit, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
}

export interface RateLimits {
  /** Every request, per visitor. */
  global: number;
  /** /api/auth/*: login, second step, setup, forgot and reset. */
  auth: number;
  /** "Forgot password" and reset, which also send email. */
  reset: number;
  /** Spreadsheet imports. */
  imports: number;
  /** Exports and backup downloads, which read everything. */
  exports: number;
}
/** Per minute, per visitor. Generous for a shop (a busy counter makes a few calls a second); hard on a script. */
export const DEFAULT_LIMITS: RateLimits = { global: 600, auth: 30, reset: 10, imports: 20, exports: 10 };

export function rateLimits(limits: RateLimits): MiddlewareHandler<AppEnv> {
  const rules: { match: (path: string) => boolean; name: string; limiter: RateLimiter }[] = [
    { name: 'reset', match: (p) => p === '/api/auth/forgot' || p === '/api/auth/reset', limiter: new RateLimiter(limits.reset, 60_000) },
    { name: 'auth', match: (p) => p.startsWith('/api/auth/') && p !== '/api/auth/state', limiter: new RateLimiter(limits.auth, 60_000) },
    { name: 'import', match: (p) => p.startsWith('/api/import/'), limiter: new RateLimiter(limits.imports, 60_000) },
    { name: 'export', match: (p) => p === '/api/export' || p === '/api/admin/export.json' || p.startsWith('/api/backup/'), limiter: new RateLimiter(limits.exports, 60_000) },
    { name: 'all', match: () => true, limiter: new RateLimiter(limits.global, 60_000) },
  ];
  return async (c, next) => {
    const ip = clientIp(c);
    const path = new URL(c.req.url).pathname;
    for (const r of rules) {
      if (!r.match(path)) continue;
      const res = r.limiter.hit(`${r.name}:${ip}`);
      if (!res.ok) {
        c.header('Retry-After', String(res.retryAfter));
        return c.json({ error: 'Too many requests. Wait a moment and try again.', code: 'rate_limited' }, 429);
      }
    }
    await next();
  };
}

// ---- 3. Headers ----
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:", // data: for the authenticator QR code
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  // HSTS only when the visitor really is on https (it would be ignored, or worse, over plain http on the Wi-Fi).
  const https = isHttps(c);
  const hsts = https ? 'max-age=31536000; includeSubDomains' : false;
  return secureHeaders({
    contentSecurityPolicy: undefined,
    strictTransportSecurity: hsts,
    // Browsers ignore these two over plain http (and print an error for it on every page), so they are sent only over https.
    crossOriginOpenerPolicy: https ? 'same-origin' : false,
    originAgentCluster: https ? '?1' : false,
    xFrameOptions: 'DENY',
    referrerPolicy: 'no-referrer',
    crossOriginEmbedderPolicy: false,
    permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [], serial: [] },
  })(c, async () => {
    c.header('Content-Security-Policy', CSP);
    await next();
    if (new URL(c.req.url).pathname.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });
};

// ---- 4. Same origin only ----
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A browser sends Origin with every change it makes. It must be this site (the Host the request was made to, or an address
 * listed in ALLOWED_ORIGINS). No CORS headers are ever sent, so no other site can read an answer either.
 * Without an Origin there is no browser involved (curl, a script), and nobody's logged-in browser can be used against them.
 */
export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE.has(c.req.method)) return next();
  const refuse = () => c.json({ error: 'This request did not come from the Commercia page.', code: 'cross_origin' }, 403);
  const origin = c.req.header('origin');
  if (origin !== undefined) {
    let host: string;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      return refuse(); // "null" and other things that are not an address
    }
    const own = (fromTrustedProxy(c) ? c.req.header('x-forwarded-host')?.split(',')[0].trim() : undefined) ?? c.req.header('host') ?? new URL(c.req.url).host;
    if (host !== own.toLowerCase() && !config().allowedOrigins.includes(origin.toLowerCase())) return refuse();
  } else {
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return refuse();
  }
  await next();
};

// ---- 5. Body size ----
const MB = 1024 * 1024;
/** How big a body may be for a path. A spreadsheet is the biggest thing anyone sends. */
export function maxBody(path: string): number {
  if (path === '/api/import/preview') return 12 * MB;
  if (path === '/api/import/validate' || path === '/api/import/commit' || path === '/api/export') return 6 * MB;
  return 256 * 1024;
}

export const limitBodies: MiddlewareHandler<AppEnv> = (c, next) =>
  bodyLimit({
    maxSize: maxBody(new URL(c.req.url).pathname),
    onError: (ctx) => ctx.json({ error: 'That is too large to send. Nothing was saved.', code: 'too_large' }, 413),
  })(c, next);

// ---- A guard against a handler that hangs ----
/** After this long the caller gets a 504. (The work, if it already started, may still finish: check before doing it again.) */
export function requestTimeout(ms: (path: string) => number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms(new URL(c.req.url).pathname));
    });
    try {
      const r = await Promise.race([next().then(() => 'done' as const), timedOut]);
      if (r === 'timeout') return c.json({ error: 'That took too long. Check whether it was saved before you do it again.', code: 'timeout' }, 504);
    } finally {
      clearTimeout(timer);
    }
  };
}
export const timeoutFor = (path: string) => (path.startsWith('/api/import/') || path === '/api/export' || path.startsWith('/api/backup') || path.startsWith('/api/admin/') ? 180_000 : 60_000);
