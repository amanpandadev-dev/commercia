import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup } from './helpers';
import { installConsoleRedaction } from '../server/lib/redact';
import { setMailer } from '../server/lib/mailer';

// Whatever the server prints, no secret, password, reset code or session token may be in it.
describe('log output', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  const seen: string[] = [];
  const real = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const SMTP_PASSWORD = 'Smtp-Pw-7f3a9';
  let savedSmtp: string | undefined;

  beforeAll(async () => {
    savedSmtp = process.env.SMTP_URL;
    process.env.SMTP_URL = `smtps://mailer:${SMTP_PASSWORD}@smtp.example.com:465`;
    // Catch what each console method is finally given, then put the redaction in front of it, as the server does.
    for (const level of Object.keys(real) as (keyof typeof real)[]) console[level] = (...args: unknown[]) => void seen.push(args.map(String).join(' '));
    installConsoleRedaction();
    ctx = await setup();
  });
  afterAll(() => {
    Object.assign(console, real);
    setMailer(null);
    if (savedSmtp === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = savedSmtp;
  });

  const post = (url: string, body: unknown, cookie = '') =>
    ctx.app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });

  it('never holds a password, reset code, session token or SMTP password, across login, reset, mail and import', async () => {
    const mails: { to: string; text: string }[] = [];
    // A mail server that fails and puts its own login in the error, as some do.
    setMailer({ sendMail: async (m) => { mails.push(m); throw new Error(`Invalid login for smtps://mailer:${SMTP_PASSWORD}@smtp.example.com:465`); } });

    const login = await post('/api/auth/login', { email: 'sunil@shop.in', password: 'password123' });
    const token = (login.headers.get('set-cookie') ?? '').split(';')[0].split('=')[1];
    await post('/api/auth/login', { email: 'sunil@shop.in', password: 'Wrong-Password-XYZ' });
    await post('/api/auth/forgot', { email: 'amit@shop.in' }); // the mail fails; the failure is logged
    const code = mails[0]?.text.match(/is ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] ?? '';
    await post('/api/auth/reset', { email: 'amit@shop.in', code: 'WRNG-CODE', password: 'New-Password-9876' });
    await post(
      '/api/import/commit',
      { kind: 'customers', rows: [{ name: 'Log Test', amount: '10' }], fileName: 'x.csv' },
      `commercia_session=${token}`,
    );
    console.error(new Error(`server failed: password: hunter2 ${SMTP_PASSWORD}`)); // an unexpected error carrying secrets

    const out = seen.join('');
    expect(out).toContain('Could not send the password reset email'); // the failure itself is still reported
    for (const secret of [SMTP_PASSWORD, 'hunter2', 'Wrong-Password-XYZ', 'New-Password-9876', 'password123', token]) expect(out).not.toContain(secret);
    expect(code).not.toBe('');
    expect(out).not.toContain(code);
    expect(out).not.toContain(code.replace('-', ''));
  });
});

describe('npm run init-env', () => {
  it('makes a .env with a fresh key that only this user can read, and leaves an existing one alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-init-'));
    const run = () => execFileSync(process.execPath, ['--import', path.resolve('node_modules/tsx/dist/esm/index.mjs'), path.resolve('server/scripts/init-env.ts')], { cwd: dir, encoding: 'utf8' });
    expect(run()).toMatch(/Created \.env/);
    const file = path.join(dir, '.env');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/^COMMERCIA_SECRET_KEY=[0-9a-f]{64}$/m);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(run()).toMatch(/already exists/);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});
