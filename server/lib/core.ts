import type { Context } from 'hono';
import type { Kysely, Transaction } from 'kysely';
import type { DB, User } from '../db/schema';
import type { Db } from '../db/index';
import { nowIso } from '../db/index';
import { can, type Permission } from '../../shared/perms';

export type Tx = Kysely<DB> | Transaction<DB>;

export interface AppEnv {
  Variables: {
    db: Db;
    user: User;
    sessionId: string;
  };
}

export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
    message: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const bad = (msg: string, details?: unknown) => new HttpError(400, msg, 'bad_request', details);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`, 'not_found');

/** Refuses — and logs — anything the user's role may not do (AUTH-3). */
export async function need(c: Ctx, perm: Permission): Promise<User> {
  const user = c.get('user');
  if (!can(user.role, perm)) {
    await logActivity(c.get('db').k, user.id, 'refused', 'permission', null, `Refused ${perm} for ${user.name} (${user.role})`);
    throw new HttpError(403, `Your role can't do this (${perm})`, 'forbidden');
  }
  return user;
}

export async function logActivity(
  tx: Tx,
  userId: number | null,
  action: string,
  entity: string,
  entityId: number | null,
  summary: string,
): Promise<void> {
  await tx
    .insertInto('activity')
    .values({ user_id: userId, action, entity, entity_id: entityId, summary, created_at: nowIso() })
    .execute();
}

/** Saves a new version of a record; nothing is ever overwritten in history (HIST-1). */
export async function saveVersion(
  tx: Tx,
  entity: string,
  entityId: number,
  data: unknown,
  reason: string,
  userId: number | null,
): Promise<void> {
  const last = await tx
    .selectFrom('versions')
    .select(({ fn }) => fn.max('version').as('v'))
    .where('entity', '=', entity)
    .where('entity_id', '=', entityId)
    .executeTakeFirst();
  await tx
    .insertInto('versions')
    .values({
      entity,
      entity_id: entityId,
      version: Number(last?.v ?? 0) + 1,
      data: JSON.stringify(data),
      reason,
      changed_by: userId,
      created_at: nowIso(),
    })
    .execute();
}

/** Next number in a series. One atomic UPDATE … RETURNING, so two people saving at once get consecutive numbers (BILL-5). */
export async function nextCounter(tx: Tx, name: string): Promise<number> {
  await tx.insertInto('counters').values({ name, value: 0 }).onConflict((oc) => oc.column('name').doNothing()).execute();
  const row = await tx
    .updateTable('counters')
    .set((eb) => ({ value: eb('value', '+', 1) }))
    .where('name', '=', name)
    .returning('value')
    .executeTakeFirstOrThrow();
  return Number(row.value);
}

export const toNum = (v: unknown): number => (v == null ? 0 : Number(v));
