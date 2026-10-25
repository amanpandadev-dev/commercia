// Suppliers and the purchase ledger: what the shop owes each supplier, and what it has paid.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../lib/core';
import { HttpError, bad, logActivity, need, notFound } from '../lib/core';
import { nowIso } from '../db/index';
import { itemsBoughtFromSupplier } from '../lib/itemSummary';
import { paySupplier, reverseSupplierPayment, supplierAgeing, supplierBalances, supplierEntry } from '../lib/suppliers';
import { formatDate, istDate, isIsoDate } from '../../shared/dates';
import { formatRupees } from '../../shared/money';

export const suppliers = new Hono<AppEnv>();

const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Name is needed'),
  phone: z.string().trim().default(''),
  area: z.string().trim().default(''),
});

const partSchema = z.object({
  mode: z.enum(['cash', 'upi', 'card', 'bank', 'cheque']),
  amountPaise: z.number().int().positive(),
  reference: z.string().default(''),
});

async function nameTaken(c: { get(k: 'db'): { k: import('kysely').Kysely<import('../db/schema').DB> } }, name: string, exceptId?: number) {
  let q = c.get('db').k.selectFrom('suppliers').select('id').where((eb) => eb(eb.fn('lower', ['name']), '=', name.trim().toLowerCase()));
  if (exceptId) q = q.where('id', '!=', exceptId);
  return !!(await q.executeTakeFirst());
}

/** The Purchase tab's list: balance we owe, last delivery, ageing; filters for name, dues and how overdue. */
suppliers.get('/supplier-ledger', async (c) => {
  await need(c, 'supplier.view');
  const { k } = c.get('db');
  const today = istDate();
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const onlyDue = c.req.query('due') === '1';
  const overdue = Number(c.req.query('overdue') ?? 0);
  const includeInactive = c.req.query('inactive') === '1';

  let sq = k.selectFrom('suppliers').selectAll();
  if (!includeInactive) sq = sq.where('active', '=', 1);
  const all = await sq.orderBy('name').execute();
  const balances = await supplierBalances(k);
  const last = await k
    .selectFrom('supplier_ledger')
    .select(['supplier_id', (eb) => eb.fn.max('date').as('last')])
    .where('kind', '=', 'purchase')
    .groupBy('supplier_id')
    .execute();
  const lastMap = new Map(last.map((l) => [l.supplier_id, String(l.last)]));
  const ageing = await supplierAgeing(k, all.filter((s) => (balances.get(s.id) ?? 0) > 0).map((s) => s.id), today);

  let rows = all.map((s) => ({ ...s, balance: balances.get(s.id) ?? 0, lastPurchase: lastMap.get(s.id) ?? null, ageing: ageing.get(s.id) ?? null }));
  if (q) rows = rows.filter((s) => s.name.toLowerCase().includes(q) || s.phone.includes(q) || s.area.toLowerCase().includes(q));
  if (onlyDue) rows = rows.filter((s) => s.balance > 0);
  if (overdue > 0) {
    const cutoff = new Date(Date.parse(today) - overdue * 86400000).toISOString().slice(0, 10);
    rows = rows.filter((s) => s.balance > 0 && s.ageing?.oldest && s.ageing.oldest <= cutoff);
  }
  rows.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  return c.json(rows);
});

/**
 * One supplier's statement. Filters: date range, purchases or payments only, and payment mode.
 * Running balances always cover the whole history, so a filtered view still shows true balances.
 */
suppliers.get('/supplier-ledger/:id', async (c) => {
  await need(c, 'supplier.view');
  const id = Number(c.req.param('id'));
  const { k } = c.get('db');
  const supplier = await k.selectFrom('suppliers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!supplier) throw notFound('Supplier');
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  const type = c.req.query('type') ?? '';
  const mode = c.req.query('mode') ?? '';

  const rows = await k
    .selectFrom('supplier_ledger as l')
    .leftJoin('users as u', 'u.id', 'l.created_by')
    .leftJoin('cash_outs as co', (j) => j.onRef('co.id', '=', 'l.ref_id').on('l.ref_type', '=', 'cash_out'))
    .leftJoin('stock_ins as si', (j) => j.onRef('si.id', '=', 'l.ref_id').on('l.ref_type', '=', 'stock_in'))
    .select([
      'l.id', 'l.date', 'l.kind', 'l.ref_type', 'l.ref_id', 'l.owed_paise', 'l.paid_paise', 'l.note', 'l.created_at',
      'u.name as by', 'co.mode as mode', 'co.reversed as reversed', 'si.invoice_no as invoiceNo',
    ])
    .where('l.supplier_id', '=', id)
    .orderBy('l.date')
    .orderBy('l.id')
    .execute();

  let running = 0;
  let opening = 0;
  const all = rows.map((r) => {
    running += r.owed_paise - r.paid_paise;
    if (from && r.date < from) opening = running;
    return { ...r, balance: running };
  });
  const isPurchase = (r: (typeof all)[number]) => r.kind === 'opening' || r.kind === 'purchase' || (r.kind === 'correction' && r.owed_paise > 0);
  const entries = all.filter((r) => {
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    if (type === 'purchases' && !isPurchase(r)) return false;
    if (type === 'payments' && isPurchase(r)) return false;
    if (mode && !((r.kind === 'payment' || r.kind === 'reversal') && r.mode === mode)) return false;
    return true;
  });
  const balance = running;
  const ageing = balance > 0 ? ((await supplierAgeing(k, [id], istDate())).get(id) ?? null) : null;
  return c.json({
    supplier,
    balance,
    opening,
    closing: entries.length ? entries[entries.length - 1].balance : opening,
    entries,
    // The list under the statement: what was bought in this date range, per item.
    items: await itemsBoughtFromSupplier(k, id, from || undefined, to || undefined),
    totals: {
      purchased: entries.filter((r) => r.kind !== 'reversal').reduce((a, r) => a + r.owed_paise, 0),
      paid: entries.reduce((a, r) => a + r.paid_paise, 0),
    },
    ageing,
  });
});

suppliers.post('/suppliers', async (c) => {
  const user = await need(c, 'supplier.edit');
  const body = supplierSchema.extend({ openingPaise: z.number().int().nonnegative().default(0), asOf: z.string().optional() }).parse(await c.req.json());
  if (await nameTaken(c, body.name)) throw new HttpError(409, `${body.name} is already a supplier`, 'conflict');
  const asOf = body.asOf && isIsoDate(body.asOf) ? body.asOf : istDate();
  const { k } = c.get('db');
  const id = await k.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto('suppliers')
      .values({ name: body.name, phone: body.phone, area: body.area, active: 1, created_at: nowIso() })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (body.openingPaise > 0) {
      await supplierEntry(tx, user, { supplierId: row.id, date: asOf, kind: 'opening', owed: body.openingPaise, note: `Opening balance as on ${formatDate(asOf)}` });
    }
    await logActivity(tx, user.id, 'create', 'supplier', row.id, `Added supplier ${body.name}${body.openingPaise ? ` owing ${formatRupees(body.openingPaise)}` : ''}`);
    return row.id;
  });
  return c.json({ id });
});

suppliers.patch('/suppliers/:id', async (c) => {
  const user = await need(c, 'supplier.edit');
  const id = Number(c.req.param('id'));
  const body = supplierSchema.extend({ active: z.boolean().optional() }).parse(await c.req.json());
  const { k } = c.get('db');
  const s = await k.selectFrom('suppliers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!s) throw notFound('Supplier');
  if (await nameTaken(c, body.name, id)) throw new HttpError(409, `${body.name} is already a supplier`, 'conflict');
  await k
    .updateTable('suppliers')
    .set({ name: body.name, phone: body.phone, area: body.area, ...(body.active === undefined ? {} : { active: body.active ? 1 : 0 }) })
    .where('id', '=', id)
    .execute();
  await logActivity(k, user.id, 'update', 'supplier', id, `Edited supplier ${body.name}`);
  return c.json({ id });
});

suppliers.post('/suppliers/:id/payments', async (c) => {
  const user = await need(c, 'supplier.pay');
  const id = Number(c.req.param('id'));
  const body = z.object({ date: z.string(), parts: z.array(partSchema).min(1, 'Enter an amount'), note: z.string().default('') }).parse(await c.req.json());
  if (!isIsoDate(body.date)) throw bad('Bad date');
  if (body.date > istDate()) throw bad('A payment cannot be dated in the future');
  const total = await c.get('db').k.transaction().execute((tx) => paySupplier(tx, user, { supplierId: id, date: body.date, parts: body.parts, note: body.note }));
  return c.json({ total });
});

/** A wrong invoice amount is fixed with a visible correction, never by editing a row. */
suppliers.post('/suppliers/:id/corrections', async (c) => {
  const user = await need(c, 'supplier.pay');
  const id = Number(c.req.param('id'));
  const body = z
    .object({ date: z.string(), direction: z.enum(['owed', 'paid']), amountPaise: z.number().int().positive(), reason: z.string().trim().min(1, 'Give a reason') })
    .parse(await c.req.json());
  if (!isIsoDate(body.date)) throw bad('Bad date');
  const { k } = c.get('db');
  const s = await k.selectFrom('suppliers').select('name').where('id', '=', id).executeTakeFirst();
  if (!s) throw notFound('Supplier');
  await k.transaction().execute(async (tx) => {
    await supplierEntry(tx, user, {
      supplierId: id, date: body.date, kind: 'correction',
      owed: body.direction === 'owed' ? body.amountPaise : 0, paid: body.direction === 'paid' ? body.amountPaise : 0,
      note: `Correction: ${body.reason}`,
    });
    await logActivity(tx, user.id, 'correct', 'supplier', id, `${s.name}: ${body.direction === 'owed' ? 'added' : 'took off'} ${formatRupees(body.amountPaise)} (${body.reason})`);
  });
  return c.json({ ok: true });
});

suppliers.post('/supplier-ledger/entries/:id/reverse', async (c) => {
  const user = await need(c, 'supplier.pay');
  const id = Number(c.req.param('id'));
  const { reason } = z.object({ reason: z.string() }).parse(await c.req.json());
  await c.get('db').k.transaction().execute((tx) => reverseSupplierPayment(tx, user, id, reason, istDate()));
  return c.json({ ok: true });
});
