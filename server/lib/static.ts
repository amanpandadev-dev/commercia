// Serving the built web app. Anything that is not a file of the build gets index.html (the app handles its own pages), and
// nothing outside the build folder can be reached: not through "..", encoded dots or slashes, or a hidden file.
import fs from 'node:fs';
import path from 'node:path';
import type { Hono, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppEnv } from './core';

/** Refuses paths that try to leave the folder, hidden files, and source maps (a build has none, and none should be handed out). */
export const guardPaths: MiddlewareHandler = async (c, next) => {
  const raw = new URL(c.req.url).pathname;
  let decoded = raw;
  try {
    // Twice, so %252e%252e is seen for what it is.
    decoded = decodeURIComponent(decodeURIComponent(raw));
  } catch {
    return c.text('Not found', 404);
  }
  const parts = decoded.split(/[\\/]+/);
  if (parts.some((p) => p === '..' || (p.startsWith('.') && p.length > 0)) || decoded.includes('\0') || /\.map$/i.test(decoded)) return c.text('Not found', 404);
  await next();
};

export function mountStatic(app: Hono<AppEnv>, dist: string): boolean {
  if (!fs.existsSync(dist)) return false;
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  app.use('/*', guardPaths);
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }));
  // Single-page app: unknown paths get index.html.
  app.get('*', (c) => c.html(index));
  return true;
}
