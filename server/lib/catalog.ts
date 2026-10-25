import { sql } from 'kysely';
import type { Tx } from './core';
import { toNum, saveVersion } from './core';
import { addDays } from '../../shared/dates';

export type PriceList = 'retail' | 'wholesale';

/** The rate in force for a unit on a date (RATE-2). Wholesale falls back to retail when not set. */
export async function priceOn(tx: Tx, unitId: number, list: PriceList, date: string): Promise<number | null> {
  const lists: PriceList[] = list === 'wholesale' ? ['wholesale', 'retail'] : ['retail'];
  for (const l of lists) {
    const row = await tx
      .selectFrom('unit_prices')
      .select('price_paise')
      .where('unit_id', '=', unitId)
      .where('list', '=', l)
      .where('from_date', '<=', date)
      .orderBy('from_date', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (row) return row.price_paise;
  }
  return null;
}

/** GST rate in force for a product on a date (GST-2). */
export async function gstOn(tx: Tx, productId: number, date: string): Promise<number> {
  const row = await tx
    .selectFrom('product_gst')
    .select('gst_bp')
    .where('product_id', '=', productId)
    .where('from_date', '<=', date)
    .orderBy('from_date', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (row) return row.gst_bp;
  // A rate that starts later than the date is still better than nothing for old dates.
  const first = await tx
    .selectFrom('product_gst')
    .select('gst_bp')
    .where('product_id', '=', productId)
    .orderBy('from_date', 'asc')
    .executeTakeFirst();
  return first?.gst_bp ?? 0;
}

/** Stock is the sum of movements, never typed in (STK-2). */
export async function stockMap(tx: Tx, productIds?: number[], asOf?: string): Promise<Map<number, number>> {
  let q = tx
    .selectFrom('stock_movements')
    .select(['product_id', (eb) => eb.fn.sum<number>('qty_milli').as('qty')])
    .groupBy('product_id');
  if (asOf) q = q.where('date', '<=', asOf);
  if (productIds) {
    if (productIds.length === 0) return new Map();
    q = q.where('product_id', 'in', productIds);
  }
  const rows = await q.execute();
  return new Map(rows.map((r) => [r.product_id, toNum(r.qty)]));
}

/** Latest purchase rate per base unit, in paise per 1 base unit (for loss values, stock value). */
export async function lastPurchasePerBase(tx: Tx): Promise<Map<number, number>> {
  const rows = await tx
    .selectFrom('stock_movements as m')
    .innerJoin('product_units as u', 'u.id', 'm.unit_id')
    .select(['m.product_id', 'm.rate_paise', 'u.factor_milli', 'm.date', 'm.id'])
    .where('m.kind', 'in', ['stock_in', 'import', 'opening'])
    .where('m.rate_paise', 'is not', null)
    .orderBy('m.date')
    .orderBy('m.id')
    .execute();
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.rate_paise == null || r.factor_milli <= 0) continue;
    out.set(r.product_id, (r.rate_paise * 1000) / r.factor_milli);
  }
  return out;
}

export interface CatalogUnit {
  id: number;
  name: string;
  factorMilli: number;
  isBase: boolean;
  retail: number | null;
  wholesale: number | null;
}

export interface CatalogProduct {
  id: number;
  code: string | null;
  categoryId: number | null;
  categoryPath: string[];
  nameEn: string;
  nameHi: string;
  brand: string;
  type: string;
  family: string;
  packSize: string;
  packKind: string;
  hsn: string;
  gstBp: number;
  baseUnit: 'kg' | 'L' | 'pc';
  loose: boolean;
  stepMilli: number;
  reorderMilli: number | null;
  reorderUnitId: number | null;
  aliases: string;
  buyUnitId: number | null;
  sellUnitId: number | null;
  stockMilli: number;
  low: boolean;
  freq: number;
  units: CatalogUnit[];
}

export async function categoryPaths(tx: Tx): Promise<Map<number, { en: string[]; ids: number[] }>> {
  const cats = await tx.selectFrom('categories').selectAll().execute();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out = new Map<number, { en: string[]; ids: number[] }>();
  for (const c of cats) {
    const en: string[] = [];
    const ids: number[] = [];
    let cur: typeof c | undefined = c;
    let guard = 0;
    while (cur && guard++ < 20) {
      en.unshift(cur.name_en);
      ids.unshift(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.set(c.id, { en, ids });
  }
  return out;
}

/** Everything the screens need for fast in-browser search: products, units, prices, stock. */
export async function loadCatalog(tx: Tx, date: string, opts: { includeInactive?: boolean } = {}): Promise<CatalogProduct[]> {
  let pq = tx.selectFrom('products').selectAll();
  if (!opts.includeInactive) pq = pq.where('active', '=', 1);
  const products = await pq.orderBy('name_en').execute();
  const units = await tx.selectFrom('product_units').selectAll().where('active', '=', 1).execute();
  const prices = await tx
    .selectFrom('unit_prices')
    .select(['unit_id', 'list', 'price_paise', 'from_date', 'id'])
    .where('from_date', '<=', date)
    .orderBy('from_date')
    .orderBy('id')
    .execute();
  const gst = await tx.selectFrom('product_gst').select(['product_id', 'gst_bp', 'from_date', 'id']).orderBy('from_date').orderBy('id').execute();
  const stock = await stockMap(tx);
  const paths = await categoryPaths(tx);
  const since = addDays(date, -90);
  const freqRows = await tx
    .selectFrom('bill_lines as l')
    .innerJoin('bills as b', 'b.id', 'l.bill_id')
    .select(['l.product_id', (eb) => eb.fn.countAll<number>().as('n')])
    .where('b.bill_date', '>=', since)
    .groupBy('l.product_id')
    .execute();
  const freq = new Map(freqRows.map((r) => [r.product_id, toNum(r.n)]));

  const priceMap = new Map<string, number>();
  for (const p of prices) priceMap.set(`${p.unit_id}:${p.list}`, p.price_paise); // later rows win
  const gstMap = new Map<number, number>();
  for (const g of gst) if (g.from_date <= date || !gstMap.has(g.product_id)) gstMap.set(g.product_id, g.gst_bp);
  const unitsBy = new Map<number, CatalogUnit[]>();
  for (const u of units) {
    const list = unitsBy.get(u.product_id) ?? [];
    list.push({
      id: u.id,
      name: u.name,
      factorMilli: u.factor_milli,
      isBase: u.is_base === 1,
      retail: priceMap.get(`${u.id}:retail`) ?? null,
      wholesale: priceMap.get(`${u.id}:wholesale`) ?? null,
    });
    unitsBy.set(u.product_id, list);
  }

  return products.map((p) => {
    const stockMilli = stock.get(p.id) ?? 0;
    return {
      id: p.id,
      code: p.code,
      categoryId: p.category_id,
      categoryPath: p.category_id ? (paths.get(p.category_id)?.en ?? []) : [],
      nameEn: p.name_en,
      nameHi: p.name_hi,
      brand: p.brand,
      type: p.type,
      family: p.family,
      packSize: p.pack_size,
      packKind: p.pack_kind,
      hsn: p.hsn,
      gstBp: gstMap.get(p.id) ?? 0,
      baseUnit: p.base_unit,
      loose: p.loose === 1,
      stepMilli: p.step_milli,
      reorderMilli: p.reorder_milli,
      reorderUnitId: p.reorder_unit_id,
      aliases: p.aliases,
      buyUnitId: p.buy_unit_id,
      sellUnitId: p.sell_unit_id,
      stockMilli,
      low: p.reorder_milli != null && stockMilli < p.reorder_milli,
      freq: freq.get(p.id) ?? 0,
      units: (unitsBy.get(p.id) ?? []).sort((a, b) => a.factorMilli - b.factorMilli),
    };
  });
}

/** Snapshot of a product with its units and current prices, for revision history. */
export async function snapshotProduct(tx: Tx, productId: number, date: string) {
  const p = await tx.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirstOrThrow();
  const units = await tx.selectFrom('product_units').selectAll().where('product_id', '=', productId).execute();
  const unitsOut = [];
  for (const u of units) {
    unitsOut.push({
      id: u.id,
      name: u.name,
      factor: u.factor_milli / 1000,
      active: u.active === 1,
      retail: await priceOn(tx, u.id, 'retail', date),
      wholesale: await priceOn(tx, u.id, 'wholesale', date),
    });
  }
  return {
    code: p.code,
    name_en: p.name_en,
    name_hi: p.name_hi,
    category_id: p.category_id,
    brand: p.brand,
    type: p.type,
    hsn: p.hsn,
    gst_bp: await gstOn(tx, productId, date),
    base_unit: p.base_unit,
    loose: p.loose === 1,
    reorder: p.reorder_milli == null ? null : p.reorder_milli / 1000,
    aliases: p.aliases,
    active: p.active === 1,
    units: unitsOut,
  };
}

export async function versionProduct(tx: Tx, productId: number, date: string, reason: string, userId: number) {
  await saveVersion(tx, 'product', productId, await snapshotProduct(tx, productId, date), reason, userId);
}

export async function customerBalances(tx: Tx, customerIds?: number[]): Promise<Map<number, number>> {
  let q = tx
    .selectFrom('ledger')
    .select(['customer_id', sql<number>`sum(debit_paise) - sum(credit_paise)`.as('bal')])
    .groupBy('customer_id');
  if (customerIds) {
    if (!customerIds.length) return new Map();
    q = q.where('customer_id', 'in', customerIds);
  }
  const rows = await q.execute();
  return new Map(rows.map((r) => [r.customer_id, toNum(r.bal)]));
}
