import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Tx } from '../lib/core';
import { HttpError, bad, logActivity, need, notFound } from '../lib/core';
import { nowIso } from '../db/index';
import { categoryPaths, gstOn, loadCatalog, priceOn, versionProduct, type PriceList } from '../lib/catalog';
import { changeRate, markChecked, setPrice } from '../lib/rates';
import { correctBillRate } from '../lib/billing';
import { istDate, isIsoDate } from '../../shared/dates';
import { formatRupees } from '../../shared/money';
import type { User } from '../db/schema';

export const catalog = new Hono<AppEnv>();

const dateParam = (s: string | undefined) => (s && isIsoDate(s) ? s : istDate());

catalog.get('/catalog', async (c) => {
  const { k } = c.get('db');
  const date = dateParam(c.req.query('date'));
  const [products, categories] = await Promise.all([
    loadCatalog(k, date, { includeInactive: c.req.query('all') === '1' }),
    k.selectFrom('categories').selectAll().orderBy('sort').orderBy('name_en').execute(),
  ]);
  return c.json({ date, products, categories });
});

// ---------- Categories (CAT-1, CAT-6) ----------
const catSchema = z.object({
  nameEn: z.string().trim().min(1),
  nameHi: z.string().trim().default(''),
  parentId: z.number().nullable().optional(),
});

catalog.post('/categories', async (c) => {
  const user = await need(c, 'catalog.add'); // adding a product may need a new category; renaming and moving stay with Owners
  const body = catSchema.parse(await c.req.json());
  const { k } = c.get('db');
  const row = await k
    .insertInto('categories')
    .values({ name_en: body.nameEn, name_hi: body.nameHi, parent_id: body.parentId ?? null, sort: 0 })
    .returningAll()
    .executeTakeFirstOrThrow();
  await logActivity(k, user.id, 'create', 'category', row.id, `Added category ${body.nameEn}`);
  return c.json(row);
});

catalog.patch('/categories/:id', async (c) => {
  const user = await need(c, 'catalog.edit');
  const id = Number(c.req.param('id'));
  const body = catSchema.partial().parse(await c.req.json());
  const { k } = c.get('db');
  const cat = await k.selectFrom('categories').selectAll().where('id', '=', id).executeTakeFirst();
  if (!cat) throw notFound('Category');
  if (body.parentId !== undefined && body.parentId !== null) {
    const paths = await categoryPaths(k);
    if (body.parentId === id || paths.get(body.parentId)?.ids.includes(id)) throw bad("A category can't move inside itself");
  }
  await k
    .updateTable('categories')
    .set({
      ...(body.nameEn !== undefined && { name_en: body.nameEn }),
      ...(body.nameHi !== undefined && { name_hi: body.nameHi }),
      ...(body.parentId !== undefined && { parent_id: body.parentId }),
    })
    .where('id', '=', id)
    .execute();
  await logActivity(k, user.id, 'update', 'category', id, `Changed category ${cat.name_en}`);
  return c.json({ ok: true });
});

catalog.delete('/categories/:id', async (c) => {
  const user = await need(c, 'catalog.edit');
  const id = Number(c.req.param('id'));
  const { k } = c.get('db');
  const child = await k.selectFrom('categories').select('id').where('parent_id', '=', id).executeTakeFirst();
  const prod = await k.selectFrom('products').select('id').where('category_id', '=', id).executeTakeFirst();
  if (child || prod) throw new HttpError(409, 'Move its products and sub-categories first', 'conflict');
  const cat = await k.deleteFrom('categories').where('id', '=', id).returningAll().executeTakeFirst();
  await logActivity(k, user.id, 'delete', 'category', id, `Deleted category ${cat?.name_en ?? id}`);
  return c.json({ ok: true });
});

// ---------- Products, units, prices (CAT-2..5, UNIT-1..6) ----------
const unitSchema = z.object({
  id: z.number().optional(),
  name: z.string().trim().min(1),
  factorMilli: z.number().int().positive(),
  isBase: z.boolean().default(false),
  retail: z.number().int().nonnegative().nullable().optional(),
  wholesale: z.number().int().nonnegative().nullable().optional(),
});

const productSchema = z.object({
  code: z.string().trim().nullable().optional(),
  categoryId: z.number().nullable().optional(),
  nameEn: z.string().trim().min(1),
  nameHi: z.string().trim().default(''),
  brand: z.string().trim().default(''),
  type: z.string().trim().default(''),
  family: z.string().trim().default(''),
  packSize: z.string().trim().default(''),
  packKind: z.enum(['', 'bori', 'bag', 'tin', 'jar', 'pouch', 'bottle', 'pack']).default(''),
  hsn: z.string().trim().default(''),
  gstBp: z.number().int().min(0).max(4000),
  gstFrom: z.string().optional(),
  baseUnit: z.enum(['kg', 'L', 'pc']),
  loose: z.boolean().default(false),
  stepMilli: z.number().int().positive().default(1000),
  reorderQtyMilli: z.number().int().nonnegative().nullable().optional(),
  reorderUnitName: z.string().nullable().optional(),
  aliases: z.string().default(''),
  buyUnitName: z.string().nullable().optional(),
  sellUnitName: z.string().nullable().optional(),
  units: z.array(unitSchema).min(1),
  priceFrom: z.string().optional(),
  reason: z.string().default(''),
});

type ProductInput = z.infer<typeof productSchema>;


async function writeProduct(tx: Tx, user: User, body: ProductInput, existingId?: number): Promise<number> {
  // A whole-pack item is counted in packs: one base unit, never sold loose.
  if (body.packKind && (body.baseUnit !== 'pc' || body.loose)) throw bad('A bori, bag or tin item is counted in packs: base unit pc, not sold loose');
  const bases = body.units.filter((u) => u.isBase);
  if (bases.length !== 1 || bases[0].factorMilli !== 1000) throw bad('Exactly one base unit with size 1 is needed');
  const names = body.units.map((u) => u.name.toLowerCase());
  if (new Set(names).size !== names.length) throw bad('Two units have the same name');
  if (body.code) {
    let q = tx.selectFrom('products').select('id').where('code', '=', body.code);
    if (existingId) q = q.where('id', '!=', existingId);
    if (await q.executeTakeFirst()) throw new HttpError(409, `Code ${body.code} is already used`, 'conflict');
  }
  const now = nowIso();
  const today = istDate();
  const fields = {
    code: body.code || null,
    category_id: body.categoryId ?? null,
    name_en: body.nameEn,
    name_hi: body.nameHi,
    brand: body.brand,
    type: body.type,
    family: body.family,
    pack_size: body.packSize,
    pack_kind: body.packKind,
    hsn: body.hsn,
    base_unit: body.baseUnit,
    loose: body.loose ? 1 : 0,
    step_milli: body.stepMilli,
    aliases: body.aliases,
    updated_at: now,
  };
  let id = existingId;
  if (!id) {
    const row = await tx
      .insertInto('products')
      .values({ ...fields, active: 1, created_at: now, reorder_milli: null, reorder_unit_id: null, buy_unit_id: null, sell_unit_id: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = row.id;
  } else {
    await tx.updateTable('products').set(fields).where('id', '=', id).execute();
  }

  // Units: update, add, retire.
  const existing = await tx.selectFrom('product_units').selectAll().where('product_id', '=', id).execute();
  const keep = new Set<number>();
  const nameToId = new Map<string, number>();
  const priceFrom = body.priceFrom && isIsoDate(body.priceFrom) ? body.priceFrom : today;
  for (const u of body.units) {
    let unitId = u.id && existing.find((e) => e.id === u.id)?.id;
    if (unitId) {
      await tx
        .updateTable('product_units')
        .set({ name: u.name, factor_milli: u.factorMilli, is_base: u.isBase ? 1 : 0, active: 1 })
        .where('id', '=', unitId)
        .execute();
    } else {
      const row = await tx
        .insertInto('product_units')
        .values({ product_id: id, name: u.name, factor_milli: u.factorMilli, is_base: u.isBase ? 1 : 0, active: 1 })
        .returning('id')
        .executeTakeFirstOrThrow();
      unitId = row.id;
    }
    keep.add(unitId);
    nameToId.set(u.name.toLowerCase(), unitId);
    if (u.retail != null) await setPrice(tx, user, unitId, 'retail', u.retail, priceFrom, existingId ? 'manual' : 'new');
    if (u.wholesale != null) await setPrice(tx, user, unitId, 'wholesale', u.wholesale, priceFrom, existingId ? 'manual' : 'new');
  }
  for (const e of existing) if (!keep.has(e.id)) await tx.updateTable('product_units').set({ active: 0 }).where('id', '=', e.id).execute();

  // GST rate, dated (GST-2).
  const gstFrom = body.gstFrom && isIsoDate(body.gstFrom) ? body.gstFrom : existingId ? today : '2000-01-01';
  const currentGst = existingId ? await gstOn(tx, id, gstFrom) : null;
  if (currentGst !== body.gstBp) {
    await tx
      .insertInto('product_gst')
      .values({ product_id: id, gst_bp: body.gstBp, from_date: gstFrom, set_by: user.id, created_at: now })
      .execute();
  }

  // Reorder level in whichever unit suits the item (STK-3).
  const reorderUnitId = body.reorderUnitName ? nameToId.get(body.reorderUnitName.toLowerCase()) ?? null : null;
  const reorderFactor = reorderUnitId ? body.units.find((u) => u.name.toLowerCase() === body.reorderUnitName!.toLowerCase())!.factorMilli : 1000;
  await tx
    .updateTable('products')
    .set({
      reorder_milli: body.reorderQtyMilli == null ? null : Math.round((body.reorderQtyMilli * reorderFactor) / 1000),
      reorder_unit_id: reorderUnitId,
      buy_unit_id: body.buyUnitName ? nameToId.get(body.buyUnitName.toLowerCase()) ?? null : null,
      sell_unit_id: body.sellUnitName ? nameToId.get(body.sellUnitName.toLowerCase()) ?? null : null,
    })
    .where('id', '=', id)
    .execute();
  return id;
}

catalog.post('/products', async (c) => {
  const user = await need(c, 'catalog.add');
  const body = productSchema.parse(await c.req.json());
  const { k } = c.get('db');
  // Anyone adding items can add the same one twice; the importer matches by name too, so a name is used once.
  const same = await k.selectFrom('products').select('name_en').where((eb) => eb(eb.fn('lower', ['name_en']), '=', body.nameEn.toLowerCase())).executeTakeFirst();
  if (same) throw new HttpError(409, `"${same.name_en}" is already in the list. Search for it, or give this one a different name.`, 'conflict');
  const id = await k.transaction().execute(async (tx) => {
    const id = await writeProduct(tx, user, body);
    await versionProduct(tx, id, istDate(), 'Created', user.id);
    await logActivity(tx, user.id, 'create', 'product', id, `Added product ${body.nameEn}`);
    return id;
  });
  return c.json({ id });
});

catalog.patch('/products/:id', async (c) => {
  const user = await need(c, 'catalog.edit');
  const id = Number(c.req.param('id'));
  const body = productSchema.parse(await c.req.json());
  const { k } = c.get('db');
  const p = await k.selectFrom('products').select('id').where('id', '=', id).executeTakeFirst();
  if (!p) throw notFound('Product');
  await k.transaction().execute(async (tx) => {
    await writeProduct(tx, user, body, id);
    await versionProduct(tx, id, istDate(), body.reason || 'Edited', user.id);
    await logActivity(tx, user.id, 'update', 'product', id, `Edited product ${body.nameEn}`);
  });
  return c.json({ id });
});

catalog.post('/products/:id/active', async (c) => {
  const user = await need(c, 'catalog.edit');
  const id = Number(c.req.param('id'));
  const { active } = z.object({ active: z.boolean() }).parse(await c.req.json());
  const { k } = c.get('db');
  await k.transaction().execute(async (tx) => {
    const p = await tx.updateTable('products').set({ active: active ? 1 : 0, updated_at: nowIso() }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!p) throw notFound('Product');
    await versionProduct(tx, id, istDate(), active ? 'Reactivated' : 'Hidden', user.id);
    await logActivity(tx, user.id, 'update', 'product', id, `${active ? 'Reactivated' : 'Hid'} product ${p.name_en}`);
  });
  return c.json({ ok: true });
});

/** History tab for a product (HIST-2, HIST-5): versions, price changes, GST changes and stock movements. */
catalog.get('/products/:id/history', async (c) => {
  const id = Number(c.req.param('id'));
  const { k } = c.get('db');
  const product = await k.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
  if (!product) throw notFound('Product');
  const versions = await k
    .selectFrom('versions as v')
    .leftJoin('users as u', 'u.id', 'v.changed_by')
    .select(['v.id', 'v.version', 'v.data', 'v.reason', 'v.created_at', 'u.name as by'])
    .where('v.entity', '=', 'product')
    .where('v.entity_id', '=', id)
    .orderBy('v.version', 'desc')
    .execute();
  const prices = await k
    .selectFrom('unit_prices as p')
    .innerJoin('product_units as un', 'un.id', 'p.unit_id')
    .leftJoin('users as u', 'u.id', 'p.set_by')
    .leftJoin('users as a', 'a.id', 'p.approved_by')
    .select(['p.id', 'un.name as unit', 'p.list', 'p.price_paise', 'p.from_date', 'p.source', 'p.created_at', 'u.name as by', 'a.name as approvedBy'])
    .where('un.product_id', '=', id)
    .orderBy('p.from_date', 'desc')
    .orderBy('p.id', 'desc')
    .execute();
  const gst = await k
    .selectFrom('product_gst as g')
    .leftJoin('users as u', 'u.id', 'g.set_by')
    .select(['g.id', 'g.gst_bp', 'g.from_date', 'g.created_at', 'u.name as by'])
    .where('g.product_id', '=', id)
    .orderBy('g.from_date', 'desc')
    .execute();
  const movements = await k
    .selectFrom('stock_movements as m')
    .leftJoin('users as u', 'u.id', 'm.created_by')
    .leftJoin('product_units as un', 'un.id', 'm.unit_id')
    .select(['m.id', 'm.qty_milli', 'm.kind', 'm.ref_type', 'm.ref_id', 'm.note', 'm.date', 'm.created_at', 'm.unit_qty_milli', 'm.rate_paise', 'un.name as unit', 'u.name as by'])
    .where('m.product_id', '=', id)
    .orderBy('m.date')
    .orderBy('m.id')
    .execute();
  // Attach bill numbers / suppliers so each movement reads as "Sale R/26-27/0231".
  const billIds = movements.filter((m) => m.ref_type === 'bill' && m.ref_id).map((m) => m.ref_id!);
  const bills = billIds.length ? await k.selectFrom('bills').select(['id', 'number']).where('id', 'in', billIds).execute() : [];
  const inIds = movements.filter((m) => m.ref_type === 'stock_in' && m.ref_id).map((m) => m.ref_id!);
  const ins = inIds.length ? await k.selectFrom('stock_ins').select(['id', 'supplier']).where('id', 'in', inIds).execute() : [];
  let running = 0;
  const moves = movements.map((m) => {
    running += m.qty_milli;
    const ref =
      m.ref_type === 'bill'
        ? bills.find((b) => b.id === m.ref_id)?.number
        : m.ref_type === 'stock_in'
          ? ins.find((s) => s.id === m.ref_id)?.supplier
          : undefined;
    return { ...m, ref: ref ?? '', balance: running };
  });
  return c.json({ versions: versions.map((v) => ({ ...v, data: JSON.parse(v.data) })), prices, gst, movements: moves.reverse() });
});

// ---------- Daily rates and approvals (RATE-1..7) ----------



catalog.get('/rates/checks', async (c) => {
  const date = dateParam(c.req.query('date'));
  const rows = await c.get('db').k.selectFrom('rate_checks').select(['unit_id', 'list']).where('date', '=', date).execute();
  return c.json(rows.map((r) => `${r.unit_id}:${r.list}`));
});

/** "Rate for Sugar (Bag 50 kg) on 13 Oct still ₹X?" — Same / Changed (RATE-3). */
catalog.post('/rates/check', async (c) => {
  const user = await need(c, 'bill.create');
  const body = z
    .object({ unitId: z.number(), list: z.enum(['retail', 'wholesale']), date: z.string(), pricePaise: z.number().int().nonnegative().optional() })
    .parse(await c.req.json());
  if (!isIsoDate(body.date)) throw bad('Bad date');
  const { k } = c.get('db');
  const result = await k.transaction().execute(async (tx) => {
    let r: string = 'same';
    if (body.pricePaise != null) r = await changeRate(tx, user, body.unitId, body.list, body.pricePaise, body.date, 'rate-check');
    await markChecked(tx, user, body.unitId, body.list, body.date);
    if (r !== 'same') await logActivity(tx, user.id, r === 'applied' ? 'rate' : 'rate_request', 'unit', body.unitId, `Rate ${r === 'applied' ? 'changed' : 'change asked'} to ${formatRupees(body.pricePaise!)} from ${body.date}`);
    return r;
  });
  return c.json({ result });
});

/** Update-rates screen (RATE-4): all units with today's rate, most-sold first. */
catalog.post('/rates/bulk', async (c) => {
  const user = await need(c, 'bill.create');
  const body = z
    .object({
      date: z.string(),
      changes: z.array(z.object({ unitId: z.number(), list: z.enum(['retail', 'wholesale']), pricePaise: z.number().int().nonnegative() })),
      confirmUnitIds: z.array(z.object({ unitId: z.number(), list: z.enum(['retail', 'wholesale']) })).default([]),
    })
    .parse(await c.req.json());
  if (!isIsoDate(body.date)) throw bad('Bad date');
  const { k } = c.get('db');
  const counts = await k.transaction().execute(async (tx) => {
    let applied = 0;
    let requested = 0;
    for (const ch of body.changes) {
      const r = await changeRate(tx, user, ch.unitId, ch.list, ch.pricePaise, body.date, 'rates-screen');
      if (r === 'applied') applied++;
      if (r === 'requested') requested++;
      await markChecked(tx, user, ch.unitId, ch.list, body.date);
    }
    for (const u of body.confirmUnitIds) await markChecked(tx, user, u.unitId, u.list, body.date);
    await logActivity(tx, user.id, 'rate', 'unit', null, `Rates for ${body.date}: ${applied} changed, ${requested} sent for approval, ${body.confirmUnitIds.length} unchanged`);
    return { applied, requested };
  });
  return c.json(counts);
});

catalog.get('/rates/requests', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const { k } = c.get('db');
  const rows = await k
    .selectFrom('rate_requests as r')
    .innerJoin('product_units as un', 'un.id', 'r.unit_id')
    .innerJoin('products as p', 'p.id', 'un.product_id')
    .leftJoin('users as u', 'u.id', 'r.requested_by')
    .leftJoin('users as d', 'd.id', 'r.decided_by')
    .leftJoin('bills as b', 'b.id', 'r.bill_id')
    .select([
      'r.id', 'r.unit_id', 'r.list', 'r.for_date', 'r.old_paise', 'r.new_paise', 'r.final_paise', 'r.status', 'r.created_at', 'r.decided_at', 'r.bill_id',
      'un.name as unit', 'p.name_en', 'p.name_hi', 'u.name as requestedBy', 'd.name as decidedBy', 'b.number as billNumber',
    ])
    .$if(status !== 'all', (q) => q.where('r.status', '=', status as 'pending' | 'approved' | 'rejected'))
    .orderBy('r.id', 'desc')
    .limit(500)
    .execute();
  return c.json(rows);
});

/**
 * Approve or reject an Entry person's rate (RATE-5, RATE-6, Q6). Approval makes it the
 * official rate from that date. Rejection takes the Owner's rate instead: that becomes
 * official, and bills saved with the asked-for rate are corrected to it.
 */
catalog.post('/rates/requests/decide', async (c) => {
  const user = await need(c, 'rates.approve');
  const body = z
    .object({
      decisions: z.array(z.object({ id: z.number(), approve: z.boolean(), finalPaise: z.number().int().nonnegative().optional() })),
    })
    .parse(await c.req.json());
  const { k } = c.get('db');
  await k.transaction().execute(async (tx) => {
    for (const d of body.decisions) {
      const r = await tx.selectFrom('rate_requests').selectAll().where('id', '=', d.id).executeTakeFirst();
      if (!r || r.status !== 'pending') continue;
      const final = d.approve ? r.new_paise : (d.finalPaise ?? r.old_paise);
      await tx
        .updateTable('rate_requests')
        .set({ status: d.approve ? 'approved' : 'rejected', final_paise: final, decided_by: user.id, decided_at: nowIso() })
        .where('id', '=', r.id)
        .execute();
      const list = r.list as PriceList;
      const current = await priceOn(tx, r.unit_id, list, r.for_date);
      if (current !== final) {
        await tx
          .insertInto('unit_prices')
          .values({ unit_id: r.unit_id, list, price_paise: final, from_date: r.for_date, set_by: r.requested_by, approved_by: user.id, source: 'approval', created_at: nowIso() })
          .execute();
      }
      if (r.bill_id) {
        if (!d.approve && final !== r.new_paise) await correctBillRate(tx, user, r.bill_id, r.unit_id, final, `Rate rejected; owner's rate ${formatRupees(final)}`);
        const stillPending = await tx
          .selectFrom('rate_requests')
          .select('id')
          .where('bill_id', '=', r.bill_id)
          .where('status', '=', 'pending')
          .executeTakeFirst();
        if (!stillPending) await tx.updateTable('bills').set({ rate_pending: 0 }).where('id', '=', r.bill_id).execute();
      }
      await logActivity(
        tx,
        user.id,
        d.approve ? 'rate_approve' : 'rate_reject',
        'rate_request',
        r.id,
        `${d.approve ? 'Approved' : 'Rejected'} rate ${formatRupees(r.old_paise)} → ${formatRupees(r.new_paise)}${d.approve ? '' : `, set ${formatRupees(final)}`}`,
      );
    }
  });
  return c.json({ ok: true });
});
