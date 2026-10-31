import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
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

/** The API. Kept free of Node-only serving so it can also run on Cloudflare Workers later. */
export function createApp(db: Db) {
  const app = new Hono<AppEnv>();

  // No framing (clickjacking), no guessing of file types, no referrer leaks, and HSTS once the site is served over https.
  app.use('*', secureHeaders({ xFrameOptions: 'DENY', referrerPolicy: 'no-referrer', crossOriginEmbedderPolicy: false }));

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

  return app;
}
