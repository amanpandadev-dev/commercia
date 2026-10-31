// Every setting the server reads from its environment, in one place: checked when the server starts, with a
// clear message (never the values) if something is wrong. Nothing else in the server reads process.env.
//
// Zero configuration is a supported way to run: every setting has a safe default. Settings can come from the
// environment or from a `.env` file next to where the server is started (see .env.example); the environment wins.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LOOPBACK, PRIVATE_RANGES, isValidRange } from './net';

export class ConfigError extends Error {}

/** A 32-byte key written as 64 hex characters, or as base64. */
export function parseKey(s: string): Buffer | null {
  const t = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) {
    const b = Buffer.from(t, 'base64');
    return b.length === 32 ? b : null;
  }
  return null;
}

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const text = () => z.preprocess(blank, z.string().optional());
const flag = z.preprocess((v) => blank(v) ?? '0', z.enum(['0', '1'], { error: 'must be 0 or 1' }).transform((v) => v === '1'));
const list = (what: string, ok: (s: string) => boolean) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
    z.array(z.string()).refine((a) => a.every(ok), { error: `each entry must be ${what}` }),
  );
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** A Postgres address. Anything that is not on this computer must say it wants an encrypted connection (sslmode=require). */
const pgUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, { error: 'must start with postgres:// or postgresql://' })
  .refine(
    (s) => {
      try {
        const u = new URL(s);
        const mode = u.searchParams.get('sslmode');
        return LOCAL_HOSTS.has(u.hostname) || u.hostname === '' || ['require', 'verify-ca', 'verify-full'].includes(mode ?? '');
      } catch {
        return true; // not a URL we can take apart: the regex above already judged it
      }
    },
    { error: 'a database on another computer must use an encrypted connection: add ?sslmode=require to the address' },
  );
const keyField = z.string().refine((s) => parseKey(s) !== null, { error: 'must be 64 hex characters (or 32 bytes in base64)' });

const schema = z.object({
  PORT: z.preprocess((v) => blank(v) ?? '8787', z.coerce.number({ error: 'must be a number' }).int().min(1).max(65535)),
  HOST: z.preprocess((v) => blank(v) ?? '0.0.0.0', z.string().min(1)),
  COMMERCIA_DB: text(),
  DATABASE_URL: z.preprocess(blank, pgUrl.optional()),
  /** A second, more privileged login used only to create and change tables. The app itself then runs as DATABASE_URL, which cannot. */
  DATABASE_URL_MIGRATE: z.preprocess(blank, pgUrl.optional()),
  SMTP_URL: z.preprocess(blank, z.string().regex(/^smtps?:\/\//, { error: 'must start with smtp:// or smtps://' }).optional()),
  MAIL_FROM: text(),
  COMMERCIA_SECRET_KEY: z.preprocess(blank, keyField.optional()),
  COMMERCIA_SECRET_KEY_PREVIOUS: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
    z.array(keyField),
  ),
  COMMERCIA_KEY_FILE: text(),
  TRUST_PROXY: flag,
  TRUSTED_PROXIES: list('an address or range like 10.0.0.5 or 10.0.0.0/24', isValidRange),
  ALLOWED_ORIGINS: list('an origin like https://shop.example.com', (s) => /^https?:\/\/[^/\s]+$/.test(s)),
  ALLOWED_IPS: list('an address or range like 192.168.1.0/24', isValidRange),
  SHOW_USERS_ON_LAN: flag,
  COMMERCIA_SCRYPT_LOG2: z.preprocess((v) => blank(v) ?? '17', z.coerce.number({ error: 'must be a number' }).int().min(10).max(20)),
});

export interface Config {
  port: number;
  host: string;
  dbFile?: string;
  databaseUrl?: string;
  databaseUrlMigrate?: string;
  smtpUrl?: string;
  mailFrom: string;
  /** The master key for backups and authenticator secrets, if given (otherwise one is made and kept in a file). */
  secretKey?: string;
  previousKeys: string[];
  keyFile?: string;
  /** Addresses whose forwarding headers are believed: "TRUST_PROXY=1" means a proxy on this very computer (a tunnel). */
  trustedProxies: string[];
  allowedOrigins: string[];
  /** Who may connect at all (the address of the connection itself). Default: this computer, private networks and Tailscale. */
  allowedIps: string[];
  showUsersOnLan: boolean;
  scryptLog2: number;
}

function parse(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(Object.fromEntries(Object.keys(schema.shape).map((k) => [k, env[k]])));
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Commercia can't start: these settings are wrong (values are never shown).\n${lines.join('\n')}\nFix them in the environment or in the .env file; see .env.example.`);
  }
  const v = r.data;
  return {
    port: v.PORT,
    host: v.HOST,
    dbFile: v.COMMERCIA_DB,
    databaseUrl: v.DATABASE_URL,
    databaseUrlMigrate: v.DATABASE_URL_MIGRATE,
    smtpUrl: v.SMTP_URL,
    mailFrom: v.MAIL_FROM ?? 'Commercia <no-reply@localhost>',
    secretKey: v.COMMERCIA_SECRET_KEY,
    previousKeys: v.COMMERCIA_SECRET_KEY_PREVIOUS,
    keyFile: v.COMMERCIA_KEY_FILE,
    trustedProxies: [...(v.TRUST_PROXY ? LOOPBACK : []), ...v.TRUSTED_PROXIES],
    allowedOrigins: v.ALLOWED_ORIGINS.map((o) => o.toLowerCase()),
    allowedIps: v.ALLOWED_IPS.length ? v.ALLOWED_IPS : PRIVATE_RANGES,
    showUsersOnLan: v.SHOW_USERS_ON_LAN,
    scryptLog2: v.COMMERCIA_SCRYPT_LOG2,
  };
}

let last: { sig: string; cfg: Config } | null = null;
const KEYS = Object.keys(schema.shape);

/** The settings now in force. Read again when the environment changes (tests do that); cheap otherwise. */
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const sig = KEYS.map((k) => env[k] ?? '').join('\u0000');
  if (last?.sig === sig) return last.cfg;
  const cfg = parse(env);
  last = { sig, cfg };
  return cfg;
}

/** Values that must never appear in a log line or an error message. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const add = (s?: string) => s && s.length >= 6 && out.push(s);
  add(env.COMMERCIA_SECRET_KEY);
  (env.COMMERCIA_SECRET_KEY_PREVIOUS ?? '').split(',').forEach((s) => add(s.trim()));
  for (const url of [env.SMTP_URL, env.DATABASE_URL, env.DATABASE_URL_MIGRATE]) {
    if (!url) continue;
    try {
      const u = new URL(url);
      add(decodeURIComponent(u.password));
      add(u.password);
    } catch {
      add(url); // not a URL we can take apart: hide all of it
    }
  }
  return [...new Set(out)];
}

/** Reads a .env file into process.env without overriding what is already set. Returns the names it set. */
export function loadDotEnv(file = path.resolve('.env'), env: NodeJS.ProcessEnv = process.env): string[] {
  if (!fs.existsSync(file)) return [];
  const set: string[] = [];
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const quoted = m[2].trim().match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
    const val = quoted ? quoted[2] : m[2].trim().replace(/\s+#.*$/, '');
    if (env[m[1]] === undefined) {
      env[m[1]] = val;
      set.push(m[1]);
    }
  }
  return set;
}
