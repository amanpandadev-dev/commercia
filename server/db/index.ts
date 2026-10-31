import { Kysely, SqliteDialect, PostgresDialect } from 'kysely';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './schema';
import { migrate } from './migrate';
import { config } from '../lib/config';

export type Dialect = 'sqlite' | 'postgres';

export interface Db {
  k: Kysely<DB>;
  dialect: Dialect;
  /** SQLite file path (pilot) — used for backups. */
  file?: string;
  /** Raw SQLite handle, for file backups. */
  sqlite?: Database.Database;
}

/**
 * Opens the database. During the pilot this is one SQLite file on the shop laptop;
 * at go-live, set DATABASE_URL=postgres://… (Supabase) and the same queries run there.
 */
export async function openDb(opts: { file?: string; url?: string } = {}): Promise<Db> {
  // An explicit file always means SQLite, even when DATABASE_URL is set.
  const url = opts.url ?? (opts.file ? undefined : config().databaseUrl);
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    // `pg` is only needed after go-live: npm i pg
    const pg = (await import(/* @vite-ignore */ 'pg' as string)) as { default: { Pool: new (o: object) => unknown } };
    const k = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new pg.default.Pool({ connectionString: url, max: 5 }) as never }),
    });
    await migrate(k, 'postgres');
    return { k, dialect: 'postgres' };
  }

  const file = opts.file ?? config().dbFile ?? path.resolve('data', 'commercia.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const k = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
  await migrate(k, 'sqlite');
  return { k, dialect: 'sqlite', file, sqlite };
}

export const nowIso = () => new Date().toISOString();
