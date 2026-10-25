// The purchase side of the books: what the shop owes each supplier (the "Purchase" ledger).
// Every stock in raises what we owe; every payment to a supplier lowers it. Rows are never
// edited: a wrong payment is reversed, a wrong invoice amount is fixed with a correction.
import type { Tx } from './core';
import { bad, HttpError, logActivity, notFound, toNum } from './core';
import { nowIso } from '../db/index';
import { formatRupees } from '../../shared/money';
import type { PayMode, User } from '../db/schema';

const MODE_LABEL: Record<PayMode, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank transfer', cheque: 'Cheque' };

export interface PayPart {
  mode: PayMode;
  amountPaise: number;
  reference?: string;
}

/** The supplier with this name (any capitalisation), made on the spot if the shop has not dealt with them before. */
export async function findOrCreateSupplier(tx: Tx, name: string): Promise<number> {
  const clean = name.trim();
  if (!clean) throw bad('Supplier name is empty');
  const existing = await tx.selectFrom('suppliers').select('id').where((eb) => eb(eb.fn('lower', ['name']), '=', clean.toLowerCase())).executeTakeFirst();
  if (existing) return existing.id;
  const row = await tx
    .insertInto('suppliers')
    .values({ name: clean, phone: '', area: '', active: 1, created_at: nowIso() })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function supplierEntry(
  tx: Tx,
  user: User,
  e: { supplierId: number; date: string; kind: 'opening' | 'purchase' | 'payment' | 'reversal' | 'correction'; refType?: string | null; refId?: number | null; owed?: number; paid?: number; note: string },
) {
  await tx
    .insertInto('supplier_ledger')
    .values({
      supplier_id: e.supplierId,
      date: e.date,
      kind: e.kind,
      ref_type: e.refType ?? null,
      ref_id: e.refId ?? null,
      owed_paise: e.owed ?? 0,
      paid_paise: e.paid ?? 0,
      note: e.note,
      created_by: user.id,
      created_at: nowIso(),
    })
    .execute();
}

/** What we owe each supplier (positive) or what they hold in advance (negative). */
export async function supplierBalances(tx: Tx, supplierIds?: number[]): Promise<Map<number, number>> {
  let q = tx
    .selectFrom('supplier_ledger')
    .select(['supplier_id', (eb) => eb.fn.sum<number>('owed_paise').as('owed'), (eb) => eb.fn.sum<number>('paid_paise').as('paid')])
    .groupBy('supplier_id');
  if (supplierIds) {
    if (supplierIds.length === 0) return new Map();
    q = q.where('supplier_id', 'in', supplierIds);
  }
  const rows = await q.execute();
  return new Map(rows.map((r) => [r.supplier_id, toNum(r.owed) - toNum(r.paid)]));
}

/** How old the unpaid part of each supplier's purchases is. Payments settle the oldest purchases first, as for customers (LED-7). */
export async function supplierAgeing(tx: Tx, supplierIds: number[], today: string) {
  const rows = supplierIds.length
    ? await tx.selectFrom('supplier_ledger').select(['supplier_id', 'date', 'owed_paise', 'paid_paise']).where('supplier_id', 'in', supplierIds).orderBy('date').orderBy('id').execute()
    : [];
  const by = new Map<number, typeof rows>();
  for (const r of rows) by.set(r.supplier_id, [...(by.get(r.supplier_id) ?? []), r]);
  const out = new Map<number, { b0: number; b30: number; b60: number; b90: number; oldest: string | null }>();
  for (const [id, list] of by) {
    const owed: { date: string; left: number }[] = [];
    let paid = 0;
    for (const r of list) {
      if (r.owed_paise) owed.push({ date: r.date, left: r.owed_paise });
      paid += r.paid_paise;
    }
    for (const d of owed) {
      const use = Math.min(d.left, paid);
      d.left -= use;
      paid -= use;
    }
    const a = { b0: 0, b30: 0, b60: 0, b90: 0, oldest: null as string | null };
    for (const d of owed) {
      if (d.left <= 0) continue;
      a.oldest ??= d.date;
      const age = (Date.parse(today) - Date.parse(d.date)) / 86400000;
      if (age <= 30) a.b0 += d.left;
      else if (age <= 60) a.b30 += d.left;
      else if (age <= 90) a.b60 += d.left;
      else a.b90 += d.left;
    }
    if (paid > 0) a.b0 -= paid; // an advance reduces the newest bucket
    out.set(id, a);
  }
  return out;
}

/**
 * Pay a supplier in any mix of modes. Each part is also a cash-out in the day book (category
 * supplier), so cash flow and the day book stay right, and a row on the supplier's ledger.
 */
export async function paySupplier(
  tx: Tx,
  user: User,
  e: { supplierId: number; date: string; parts: PayPart[]; note?: string; stockInId?: number | null },
): Promise<number> {
  const supplier = await tx.selectFrom('suppliers').selectAll().where('id', '=', e.supplierId).executeTakeFirst();
  if (!supplier) throw notFound('Supplier');
  let total = 0;
  for (const p of e.parts) {
    if (!(p.amountPaise > 0)) throw bad('A payment amount must be more than zero');
    const ref = (p.reference ?? '').trim();
    const note = [ref, e.note?.trim()].filter(Boolean).join(' · ');
    const co = await tx
      .insertInto('cash_outs')
      .values({
        date: e.date,
        category: 'supplier',
        payee: supplier.name,
        mode: p.mode,
        amount_paise: p.amountPaise,
        note,
        supplier_id: supplier.id,
        stock_in_id: e.stockInId ?? null,
        created_by: user.id,
        created_at: nowIso(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await supplierEntry(tx, user, {
      supplierId: supplier.id,
      date: e.date,
      kind: 'payment',
      refType: 'cash_out',
      refId: co.id,
      paid: p.amountPaise,
      note: [`${MODE_LABEL[p.mode]} payment`, note].filter(Boolean).join(' · '),
    });
    total += p.amountPaise;
  }
  await logActivity(tx, user.id, 'create', 'supplier_payment', supplier.id, `Paid ${supplier.name} ${formatRupees(total)} (${e.parts.map((p) => MODE_LABEL[p.mode]).join(' + ')})`);
  return total;
}

/**
 * Undo a payment to a supplier. The original stays, marked reversed; a second, negative cash-out
 * takes the money back out of the day book, and the ledger gets a reversal row (LED-4).
 */
export async function reverseSupplierPayment(tx: Tx, user: User, ledgerId: number, reason: string, today: string) {
  if (!reason.trim()) throw bad('Give a reason');
  const row = await tx.selectFrom('supplier_ledger').selectAll().where('id', '=', ledgerId).executeTakeFirst();
  if (!row || row.kind !== 'payment' || row.ref_type !== 'cash_out' || row.ref_id == null) throw bad('Only a payment can be reversed');
  const orig = await tx.selectFrom('cash_outs').selectAll().where('id', '=', row.ref_id).executeTakeFirst();
  if (!orig) throw notFound('Payment');
  if (orig.reversed === 1) throw new HttpError(409, 'This payment is already reversed', 'conflict');
  const rev = await tx
    .insertInto('cash_outs')
    .values({
      date: today,
      category: 'supplier',
      payee: orig.payee,
      mode: orig.mode,
      amount_paise: -orig.amount_paise,
      note: `Reversal: ${reason.trim()}`,
      supplier_id: orig.supplier_id,
      stock_in_id: orig.stock_in_id,
      reversal_of: orig.id,
      created_by: user.id,
      created_at: nowIso(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx.updateTable('cash_outs').set({ reversed: 1 }).where('id', '=', orig.id).execute();
  await supplierEntry(tx, user, {
    supplierId: row.supplier_id,
    date: today,
    kind: 'reversal',
    refType: 'cash_out',
    refId: rev.id,
    owed: row.paid_paise,
    note: `Reversal of payment on ${row.date}: ${reason.trim()}`,
  });
  await logActivity(tx, user.id, 'reverse', 'supplier_payment', row.supplier_id, `Reversed a ${formatRupees(row.paid_paise)} payment to ${orig.payee}: ${reason.trim()}`);
}
