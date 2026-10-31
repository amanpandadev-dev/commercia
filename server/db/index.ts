import { Kysely, SqliteDialect, PostgresDialect } from 'kysely';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './schema';
import { migrate } from './migrate';
import { config } from '../lib/config';
import { Secrets, loadSecrets, protectTotpSecrets } from '../lib/secrets';

export type Dialect = 'sqlite' | 'postgres';

export interface Db {
  k: Kysely<DB>;
  dialect: Dialect;
  /** SQLite file path (pilot) — used for backups. */
  file?: string;
  /** Raw SQLite handle, for file backups. */
  sqlite?: Database.Database;
  /** The secret key: locks authenticator secrets and backup files. */
  secrets: Secrets;
}

/** Opens the secret key for this database, and locks the authenticator secrets in it (also upgrades an older database in place). */
async function withSecrets(k: Kysely<DB>, where: { memory?: boolean; postgres?: boolean; dbFile?: string }, skip?: boolean): Promise<Secrets> {
  const held = await k.selectFrom('users').select('id').where('totp_secret', 'like', 'enc:v1:%').executeTakeFirst();
  const secrets = loadSecrets({ ...where, mayMakeKey: !held });
  if (!skip) await protectTotpSecrets(k as never, secrets);
  return secrets;
}

/**
 * Opens the database. During the pilot this is one SQLite file on the shop laptop;
 * at go-live, set DATABASE_URL=postgres://… (Supabase) and the same queries run there.
 */
export async function openDb(opts: { file?: string; url?: string; /** For the rotate-key tool only. */ skipSecretCheck?: boolean } = {}): Promise<Db> {
  // An explicit file always means SQLite, even when DATABASE_URL is set.
  const url = opts.url ?? (opts.file ? undefined : config().databaseUrl);
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    // `pg` is only needed after go-live: npm i pg
    const pg = (await import(/* @vite-ignore */ 'pg' as string)) as { default: { Pool: new (o: object) => unknown } };
    const connect = (connectionString: string, max: number) =>
      new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.default.Pool({ connectionString, max }) as never }) });
    // With DATABASE_URL_MIGRATE set, tables are made and changed by that login, and the app runs as one that can only read and write rows.
    const migrateUrl = opts.url ? undefined : config().databaseUrlMigrate;
    if (migrateUrl) {
      const m = connect(migrateUrl, 1);
      await migrate(m, 'postgres');
      await m.destroy();
    }
    const k = connect(url, 5);
    if (!migrateUrl) await migrate(k, 'postgres');
    return { k, dialect: 'postgres', secrets: await withSecrets(k, { postgres: true }, opts.skipSecretCheck) };
  }

  const file = opts.file ?? config().dbFile ?? path.resolve('data', 'commercia.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const k = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
  await migrate(k, 'sqlite');
  return { k, dialect: 'sqlite', file, sqlite, secrets: await withSecrets(k, { memory: file === ':memory:', dbFile: file }, opts.skipSecretCheck) };
}

export const nowIso = () => new Date().toISOString();
