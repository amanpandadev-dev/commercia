import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv } from './lib/core';
import { HttpError } from './lib/core';
import type { Db } from './db/index';
import { auth, account, requireAuth, users } from './routes/auth';
import { catalog } from './routes/catalog';
import { sales } from './routes/sales';
import { stock } from './routes/stock';
import { suppliers } from './routes/suppliers';
import { reports } from './routes/reports';
import { admin } from './routes/admin';
import { security } from './routes/security';
import { DEFAULT_LIMITS, ipAllowList, limitBodies, rateLimits, requestTimeout, sameOriginOnly, securityHeaders, timeoutFor, type RateLimits } from './lib/edge';

/** The API. Kept free of Node-only serving so it can also run on Cloudflare Workers later. */
export function createApp(db: Db, opts: { limits?: RateLimits } = {}) {
  const app = new Hono<AppEnv>();

  // The edge: who may connect, how often, what headers go out, same origin only, how big a body, how long a request may take.
  app.use('*', securityHeaders); // first, so every answer has them, a refusal too
  app.use('*', ipAllowList);
  app.use('*', rateLimits(opts.limits ?? DEFAULT_LIMITS));
  app.use('/api/*', sameOriginOnly);
  app.use('/api/*', limitBodies);
  app.use('/api/*', requestTimeout(timeoutFor));

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err.retryAfter) c.header('Retry-After', String(err.retryAfter));
      return c.json({ error: err.message, code: err.code, details: err.details }, err.status);
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return c.json({ error: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', code: 'invalid', details: err.issues }, 400);
    }
    console.error(err);
    return c.json({ error: 'Something went wrong. Nothing was saved.', code: 'server_error' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', auth);

  const api = new Hono<AppEnv>();
  api.use('*', requireAuth);
  api.route('/account', account);
  api.route('/users', users);
  api.route('/', catalog);
  api.route('/', sales);
  api.route('/', stock);
  api.route('/', suppliers);
  api.route('/', reports);
  api.route('/', admin);
  api.route('/', security);
  app.route('/api', api);
  // An unknown address under /api is an error in JSON, not the web page the browser would otherwise be given.
  app.all('/api/*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

  return app;
}
