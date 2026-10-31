import { Hono } from 'hono';
import type { AppEnv } from '../lib/core';
import { int, need } from '../lib/core';
import { securityEvents } from '../lib/securityEvents';

/** The Security screen: failed logins, lockouts, refused actions, resets, exports, new devices. Owners and the Admin. */
export const security = new Hono<AppEnv>();

security.get('/security', async (c) => {
  await need(c, 'security.view');
  return c.json(await securityEvents(c.get('db').k, { days: int(c.req.query('days') ?? 30), type: c.req.query('type') || undefined }));
});
