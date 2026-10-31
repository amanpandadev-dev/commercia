import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Tx } from '../lib/core';
import { HttpError, bad, int, logActivity, need, notFound, saveVersion } from '../lib/core';
import { nowIso } from '../db/index';
import { lastPurchasePerBase } from '../lib/catalog';
import { istDate, isIsoDate } from '../../shared/dates';
import { formatQty, formatRupees, roundHalfUp } from '../../shared/money';
import { toBase } from '../../shared/units';
import { findOrCreateSupplier, paySupplier, supplierEntry, type PayPart } from '../lib/suppliers';
import type { User } from '../db/schema';

export const stock = new Hono<AppEnv>();

const lineSchema = z.object({
  productId: z.number(),
  unitId: z.number(),
  qtyMilli: z.number().int().positive(),
  ratePaise: z.number().int().nonnegative().nullable().optional(),
});

async function unitOf(tx: Tx, productId: number, unitId: number) {
  const u = await tx
    .selectFrom('product_units as u')
    .innerJoin('products as p', 'p.id', 'u.product_id')
    .select(['u.id', 'u.name', 'u.factor_milli', 'p.id as product_id', 'p.name_en', 'p.base_unit'])
    .where('u.id', '=', unitId)
    .executeTakeFirst();
  if (!u || u.product_id !== productId) throw bad('An item on this entry no longer exists');
  return u;
}

const payPartSchema = z.object({
  mode: z.enum(['cash', 'upi', 'card', 'bank', 'cheque']),
  amountPaise: z.number().int().positive(),
  reference: z.string().default(''),
});

interface StockInBody {
  supplier: string;
  date: string;
  note: string;
  /** The supplier's own invoice number. */
  invoiceNo?: string;
  /** What the invoice comes to (prices include GST). Defaults to the lines' rates × quantities. */
  amountPaise?: number | null;
  /** Paid at the counter with the delivery; the rest of the invoice goes on credit. */
  payments?: PayPart[];
  lines: z.infer<typeof lineSchema>[];
}

/**
 * Record a delivery (STK-1): all lines raise stock together, or nothing is saved. A named supplier
 * gets an account: the invoice amount goes on what we owe them, and anything paid now comes off it.
 */
export async function saveStockIn(tx: Tx, user: User, body: StockInBody, importId: number | null = null) {
  if (!isIsoDate(body.date)) throw bad('Bad date');
  let total = 0;
  const resolved = [];
  for (const l of body.lines) {
    const u = await unitOf(tx, l.productId, l.unitId);
    total += l.ratePaise ? roundHalfUp((l.qtyMilli * l.ratePaise) / 1000) : 0;
    resolved.push({ l, u });
  }
  const amount = body.amountPaise ?? total;
  const payments = body.payments ?? [];
  const paid = payments.reduce((a, p) => a + p.amountPaise, 0);
  if (paid > 0 && !body.supplier.trim()) throw bad('Name the supplier to record a payment');
  if (paid > amount) throw bad('The amount paid is more than the invoice amount');
  // Opening-stock rows are not a purchase from anyone.
  const supplierId = body.supplier.trim() && !(importId && body.supplier === 'Opening stock') ? await findOrCreateSupplier(tx, body.supplier) : null;
  const si = await tx
    .insertInto('stock_ins')
    .values({
      supplier: body.supplier, supplier_id: supplierId, invoice_no: body.invoiceNo?.trim() ?? '', amount_paise: amount, paid_paise: paid,
      date: body.date, note: body.note, total_paise: total, import_id: importId, created_by: user.id, created_at: nowIso(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Every delivery from a named supplier goes on their purchase ledger, imported ones too (a stock file's rows total up per supplier and date).
  if (supplierId && amount > 0) {
    await supplierEntry(tx, user, {
      supplierId, date: body.date, kind: 'purchase', refType: 'stock_in', refId: si.id, owed: amount,
      note: ['Stock in', body.invoiceNo?.trim() && `invoice ${body.invoiceNo.trim()}`].filter(Boolean).join(' · '),
    });
    if (paid > 0) await paySupplier(tx, user, { supplierId, date: body.date, parts: payments, note: 'Paid with delivery', stockInId: si.id });
  }
  for (const { l, u } of resolved) {
    await tx
      .insertInto('stock_movements')
      .values({
        product_id: l.productId,
        qty_milli: toBase(l.qtyMilli, u.factor_milli),
        kind: importId ? 'import' : 'stock_in',
        ref_type: 'stock_in',
        ref_id: si.id,
        unit_id: u.id,
        unit_qty_milli: l.qtyMilli,
        rate_paise: l.ratePaise ?? null,
        note: '',
        date: body.date,
        import_id: importId,
        created_by: user.id,
        created_at: nowIso(),
      })
      .execute();
  }
  await logActivity(
    tx,
    user.id,
    'create',
    'stock_in',
    si.id,
    `Stock in${body.supplier ? ` from ${body.supplier}` : ''}: ${resolved.map(({ l, u }) => `${formatQty(l.qtyMilli)} ${u.name} ${u.name_en}`).join(', ')}${amount ? ` · ${formatRupees(amount)}${paid ? `, ${formatRupees(paid)} paid` : ''}` : ''}`,
  );
  return { id: si.id, total };
}

stock.post('/stock-ins', async (c) => {
  const user = await need(c, 'stock.in');
  const body = z
    .object({
      supplier: z.string().trim().default(''),
      date: z.string(),
      note: z.string().default(''),
      invoiceNo: z.string().trim().default(''),
      amountPaise: z.number().int().nonnegative().nullable().optional(),
      payments: z.array(payPartSchema).default([]),
      lines: z.array(lineSchema).min(1, 'Add at least one item'),
    })
    .parse(await c.req.json());
  // Putting money out is for Owners; an Entry person records the delivery and the invoice amount.
  if (body.payments.length) await need(c, 'supplier.pay');
  const res = await c.get('db').k.transaction().execute((tx) => saveStockIn(tx, user, body));
  return c.json(res);
});

stock.get('/stock-ins', async (c) => {
  const { k } = c.get('db');
  const rows = await k
    .selectFrom('stock_ins as s')
    .leftJoin('users as u', 'u.id', 's.created_by')
    .select(['s.id', 's.supplier', 's.supplier_id', 's.invoice_no', 's.date', 's.total_paise', 's.amount_paise', 's.paid_paise', 's.note', 's.created_at', 'u.name as by'])
    .orderBy('s.id', 'desc')
    .limit(100)
    .execute();
  return c.json(rows);
});

/** Supplier names for the Stock in screen's suggestions. */
stock.get('/suppliers', async (c) => {
  const rows = await c.get('db').k.selectFrom('suppliers').select('name').where('active', '=', 1).orderBy('name').execute();
  return c.json(rows.map((r) => r.name));
});

/** A supplier's last delivery as a starting point (STK-5). */
stock.get('/stock-ins/last', async (c) => {
  const supplier = c.req.query('supplier') ?? '';
  const { k } = c.get('db');
  const last = await k.selectFrom('stock_ins').select('id').where('supplier', '=', supplier).orderBy('id', 'desc').executeTakeFirst();
  if (!last) return c.json({ lines: [] });
  const lines = await k
    .selectFrom('stock_movements')
    .select(['product_id as productId', 'unit_id as unitId', 'unit_qty_milli as qtyMilli', 'rate_paise as ratePaise'])
    .where('ref_type', '=', 'stock_in')
    .where('ref_id', '=', last.id)
    .execute();
  return c.json({ lines });
});

/** Owners correct stock with a reason (STK-4). */
stock.post('/stock/adjust', async (c) => {
  const user = await need(c, 'stock.adjust');
  const body = z
    .object({ productId: z.number(), unitId: z.number(), qtyMilli: z.number().int(), reason: z.string().trim().min(1, 'Give a reason'), date: z.string().optional() })
    .parse(await c.req.json());
  if (body.qtyMilli === 0) throw bad('Quantity is zero');
  const date = body.date && isIsoDate(body.date) ? body.date : istDate();
  const { k } = c.get('db');
  await k.transaction().execute(async (tx) => {
    const u = await unitOf(tx, body.productId, body.unitId);
    const m = await tx
      .insertInto('stock_movements')
      .values({
        product_id: body.productId,
        qty_milli: toBase(body.qtyMilli, u.factor_milli),
        kind: 'adjustment',
        ref_type: null,
        ref_id: null,
        unit_id: u.id,
        unit_qty_milli: body.qtyMilli,
        rate_paise: null,
        note: body.reason,
        date,
        import_id: null,
        created_by: user.id,
        created_at: nowIso(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await logActivity(tx, user.id, 'adjust', 'stock', m.id, `Adjusted ${u.name_en} by ${body.qtyMilli > 0 ? '+' : ''}${formatQty(body.qtyMilli)} ${u.name}: ${body.reason}`);
  });
  return c.json({ ok: true });
});

// ---------- Losses and theft (LOSS-1..3) ----------
const lossSchema = z.object({
  reason: z.enum(['theft', 'missing', 'damaged', 'expired', 'other']),
  date: z.string(),
  notes: z.string().default(''),
  lines: z.array(z.object({ productId: z.number(), unitId: z.number(), qtyMilli: z.number().int().positive() })).min(1),
});

async function applyLoss(tx: Tx, user: User, lossId: number, sign: 1 | -1, kind: 'loss' | 'loss_reversal', date: string) {
  const lines = await tx.selectFrom('loss_lines').selectAll().where('loss_id', '=', lossId).execute();
  for (const l of lines) {
    await tx
      .insertInto('stock_movements')
      .values({
        product_id: l.product_id,
        qty_milli: sign * -l.base_milli,
        kind,
        ref_type: 'loss',
        ref_id: lossId,
        unit_id: l.unit_id,
        unit_qty_milli: l.qty_milli,
        rate_paise: null,
        note: '',
        date,
        import_id: null,
        created_by: user.id,
        created_at: nowIso(),
      })
      .execute();
  }
}

stock.post('/losses', async (c) => {
  const user = await need(c, 'loss.report');
  const body = lossSchema.parse(await c.req.json());
  if (!isIsoDate(body.date)) throw bad('Bad date');
  const owner = user.role !== 'entry';
  const { k } = c.get('db');
  const id = await k.transaction().execute(async (tx) => {
    const perBase = await lastPurchasePerBase(tx);
    const loss = await tx
      .insertInto('losses')
      .values({
        reason: body.reason,
        date: body.date,
        notes: body.notes,
        status: owner ? 'confirmed' : 'reported',
        value_paise: 0,
        reverses_id: null,
        reported_by: user.id,
        confirmed_by: owner ? user.id : null,
        created_at: nowIso(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    let value = 0;
    const names: string[] = [];
    for (const l of body.lines) {
      const u = await unitOf(tx, l.productId, l.unitId);
      const base = toBase(l.qtyMilli, u.factor_milli);
      const v = roundHalfUp(((perBase.get(l.productId) ?? 0) * base) / 1000);
      value += v;
      names.push(`${formatQty(l.qtyMilli)} ${u.name} ${u.name_en}`);
      await tx.insertInto('loss_lines').values({ loss_id: loss.id, product_id: l.productId, unit_id: l.unitId, qty_milli: l.qtyMilli, base_milli: base, value_paise: v }).execute();
    }
    await tx.updateTable('losses').set({ value_paise: value }).where('id', '=', loss.id).execute();
    // Only an Owner's loss changes stock; the Entry person's report waits for confirmation (LOSS-2).
    if (owner) await applyLoss(tx, user, loss.id, 1, 'loss', body.date);
    await saveVersion(tx, 'loss', loss.id, body, owner ? 'Recorded' : 'Reported', user.id);
    await logActivity(tx, user.id, owner ? 'create' : 'report', 'loss', loss.id, `${owner ? 'Loss recorded' : 'Shortage reported'} (${body.reason}): ${names.join(', ')}${value ? ` · ${formatRupees(value)}` : ''}`);
    return loss.id;
  });
  return c.json({ id });
});

stock.get('/losses', async (c) => {
  const { k } = c.get('db');
  const losses = await k
    .selectFrom('losses as l')
    .leftJoin('users as r', 'r.id', 'l.reported_by')
    .leftJoin('users as o', 'o.id', 'l.confirmed_by')
    .select(['l.id', 'l.reason', 'l.date', 'l.notes', 'l.status', 'l.value_paise', 'l.reverses_id', 'l.created_at', 'r.name as reportedBy', 'o.name as confirmedBy'])
    .orderBy('l.id', 'desc')
    .limit(300)
    .execute();
  const lines = losses.length
    ? await k
        .selectFrom('loss_lines as ll')
        .innerJoin('products as p', 'p.id', 'll.product_id')
        .innerJoin('product_units as u', 'u.id', 'll.unit_id')
        .select(['ll.loss_id', 'll.product_id', 'll.unit_id', 'll.qty_milli', 'll.base_milli', 'll.value_paise', 'p.name_en', 'p.name_hi', 'u.name as unit'])
        .where('ll.loss_id', 'in', losses.map((l) => l.id))
        .execute()
    : [];
  return c.json(losses.map((l) => ({ ...l, lines: lines.filter((x) => x.loss_id === l.id) })));
});

stock.post('/losses/:id/confirm', async (c) => {
  const user = await need(c, 'loss.record');
  const id = int(c.req.param('id'));
  const { confirm } = z.object({ confirm: z.boolean() }).parse(await c.req.json());
  const { k } = c.get('db');
  await k.transaction().execute(async (tx) => {
    const loss = await tx.selectFrom('losses').selectAll().where('id', '=', id).executeTakeFirst();
    if (!loss) throw notFound('Loss');
    if (loss.status !== 'reported') throw new HttpError(409, 'Already decided', 'conflict');
    await tx.updateTable('losses').set({ status: confirm ? 'confirmed' : 'dismissed', confirmed_by: user.id }).where('id', '=', id).execute();
    if (confirm) await applyLoss(tx, user, id, 1, 'loss', loss.date);
    await saveVersion(tx, 'loss', id, { status: confirm ? 'confirmed' : 'dismissed' }, confirm ? 'Confirmed' : 'Dismissed', user.id);
    await logActivity(tx, user.id, confirm ? 'confirm' : 'dismiss', 'loss', id, `${confirm ? 'Confirmed' : 'Dismissed'} shortage report #${id}`);
  });
  return c.json({ ok: true });
});

/** Losses are never deleted; goods found later are a reversal with a reason (LOSS-3). */
stock.post('/losses/:id/reverse', async (c) => {
  const user = await need(c, 'loss.record');
  const id = int(c.req.param('id'));
  const body = z
    .object({ reason: z.string().trim().min(1, 'Give a reason'), date: z.string().optional(), lines: z.array(z.object({ productId: z.number(), unitId: z.number(), qtyMilli: z.number().int().positive() })).min(1) })
    .parse(await c.req.json());
  const date = body.date && isIsoDate(body.date) ? body.date : istDate();
  const { k } = c.get('db');
  const newId = await k.transaction().execute(async (tx) => {
    const loss = await tx.selectFrom('losses').selectAll().where('id', '=', id).executeTakeFirst();
    if (!loss || loss.status !== 'confirmed' || loss.reverses_id) throw bad('Only a confirmed loss can be reversed');
    const perBase = await lastPurchasePerBase(tx);
    const rev = await tx
      .insertInto('losses')
      .values({ reason: loss.reason, date, notes: body.reason, status: 'confirmed', value_paise: 0, reverses_id: id, reported_by: user.id, confirmed_by: user.id, created_at: nowIso() })
      .returning('id')
      .executeTakeFirstOrThrow();
    let value = 0;
    for (const l of body.lines) {
      const u = await unitOf(tx, l.productId, l.unitId);
      const base = toBase(l.qtyMilli, u.factor_milli);
      const v = roundHalfUp(((perBase.get(l.productId) ?? 0) * base) / 1000);
      value += v;
      await tx.insertInto('loss_lines').values({ loss_id: rev.id, product_id: l.productId, unit_id: l.unitId, qty_milli: l.qtyMilli, base_milli: base, value_paise: v }).execute();
    }
    await tx.updateTable('losses').set({ value_paise: -value }).where('id', '=', rev.id).execute();
    await applyLoss(tx, user, rev.id, -1, 'loss_reversal', date);
    await logActivity(tx, user.id, 'reverse', 'loss', rev.id, `Goods found against loss #${id}: ${body.reason}`);
    return rev.id;
  });
  return c.json({ id: newId });
});
