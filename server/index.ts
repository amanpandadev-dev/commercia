import './lib/boot';
import { serve } from '@hono/node-server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db/index';
import { createApp } from './app';
import { scheduleBackups } from './lib/backup';
import { config } from './lib/config';
import { printSetupHelp } from './lib/setup';
import { mountStatic } from './lib/static';

const { port, host } = config();
// HOST defaults to 0.0.0.0 so phones on the shop Wi-Fi can reach the laptop (PILOT-2); set HOST=127.0.0.1 to keep it to this computer.

const db = await openDb();
const needsSetup = !(await db.k.selectFrom('users').select('id').executeTakeFirst());
const app = createApp(db);

const dist = path.resolve('dist');
const served = mountStatic(app, dist);

scheduleBackups(db);

const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`\n  Commercia is running`);
  console.log(`  On this computer:  http://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && host === '0.0.0.0') console.log(`  On the shop Wi-Fi: http://${a.address}:${port}`);
  }
  console.log(`  Database: ${db.file ?? 'Postgres'}\n`);
  if (needsSetup) printSetupHelp(port);
  if (!served) console.log('  (No web build found — run "npm run dev" for development or "npm start" to build and serve.)\n');
});

// Slow or stalled connections (a script holding sockets open) must not tie the server up.
const http = server as unknown as import('node:http').Server;
http.headersTimeout = 15_000; // the request line and headers must arrive within 15 s
http.requestTimeout = 180_000; // the whole request, a 10 MB spreadsheet on a poor connection included
http.keepAliveTimeout = 5_000;
http.maxHeadersCount = 100;
