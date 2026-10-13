import type { Tx } from './core';
import { nowIso } from '../db/index';
import { priceOn, type PriceList } from './catalog';
import { can } from '../../shared/perms';
import type { User } from '../db/schema';

export async function setPrice(tx: Tx, user: User, unitId: number, list: PriceList, price: number, from: string, source: string) {
  const current = await priceOn(tx, unitId, list, from);
  if (current === price) return false;
  // A unit's first price applies to all earlier dates too, so back-dated paper bills get a rate.
  const any = await tx.selectFrom('unit_prices').select('id').where('unit_id', '=', unitId).where('list', '=', list).executeTakeFirst();
  if (!any) from = '2000-01-01';
  await tx
    .insertInto('unit_prices')
    .values({
      unit_id: unitId,
      list,
      price_paise: price,
      from_date: from,
      set_by: user.id,
      approved_by: user.id,
      source,
      created_at: nowIso(),
    })
    .execute();
  return true;
}

/** Owners' rate changes apply at once; the Entry person's wait for approval (RATE-5). */
export async function changeRate(
  tx: Tx,
  user: User,
  unitId: number,
  list: PriceList,
  newPaise: number,
  date: string,
  source: string,
  billId: number | null = null,
): Promise<'applied' | 'requested' | 'same'> {
  const old = (await priceOn(tx, unitId, list, date)) ?? 0;
  if (old === newPaise) return 'same';
  if (can(user.role, 'price.set')) {
    await setPrice(tx, user, unitId, list, newPaise, date, source);
    return 'applied';
  }
  await tx
    .insertInto('rate_requests')
    .values({
      unit_id: unitId,
      list,
      for_date: date,
      old_paise: old,
      new_paise: newPaise,
      bill_id: billId,
      status: 'pending',
      final_paise: null,
      requested_by: user.id,
      decided_by: null,
      decided_at: null,
      created_at: nowIso(),
    })
    .execute();
  return 'requested';
}

export async function markChecked(tx: Tx, user: User, unitId: number, list: string, date: string) {
  const exists = await tx
    .selectFrom('rate_checks')
    .select('unit_id')
    .where('unit_id', '=', unitId)
    .where('list', '=', list)
    .where('date', '=', date)
    .executeTakeFirst();
  if (!exists) await tx.insertInto('rate_checks').values({ unit_id: unitId, list, date, checked_by: user.id, created_at: nowIso() }).execute();
}
