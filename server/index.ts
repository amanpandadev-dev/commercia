import './lib/boot';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db/index';
import { createApp } from './app';
import { scheduleBackups } from './lib/backup';
import { config } from './lib/config';

const { port, host } = config();
// HOST defaults to 0.0.0.0 so phones on the shop Wi-Fi can reach the laptop (PILOT-2); set HOST=127.0.0.1 to keep it to this computer.

const db = await openDb();
const app = createApp(db);

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }));
  // Single-page app: unknown paths get index.html.
  app.get('*', (c) => c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')));
}

scheduleBackups(db);

serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`\n  Commercia is running`);
  console.log(`  On this computer:  http://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && host === '0.0.0.0') console.log(`  On the shop Wi-Fi: http://${a.address}:${port}`);
  }
  console.log(`  Database: ${db.file ?? 'Postgres'}\n`);
  if (!fs.existsSync(dist)) console.log('  (No web build found — run "npm run dev" for development or "npm start" to build and serve.)\n');
});
