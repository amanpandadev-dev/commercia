// "What was bought": the items on a ledger's bills or deliveries, added up per item for a date range.
// The ledger itself stays one row per entry, by date; this is the list under it.
import type { Tx } from './core';
import { roundHalfUp } from '../../shared/money';

export interface ItemTotal {
  productId: number;
  name: string;
  nameHi: string;
  /** Quantities are added up per unit: 6 Bori and 20 kg of one item are two rows, not 26 of something. */
  unit: string;
  qtyMilli: number;
  amountPaise: number;
  /** On how many bills or deliveries it appeared. */
  times: number;
  lastDate: string;
}

interface Line {
  productId: number;
  name: string;
  nameHi: string;
  unit: string;
  qtyMilli: number;
  amountPaise: number;
  doc: number;
  date: string;
}

function total(lines: Line[]): ItemTotal[] {
  const by = new Map<string, ItemTotal & { docs: Set<number> }>();
  for (const l of lines) {
    const key = `${l.productId}|${l.unit}`;
    const t = by.get(key) ?? { productId: l.productId, name: l.name, nameHi: l.nameHi, unit: l.unit, qtyMilli: 0, amountPaise: 0, times: 0, lastDate: '', docs: new Set<number>() };
    t.qtyMilli += l.qtyMilli;
    t.amountPaise += l.amountPaise;
    t.docs.add(l.doc);
    if (l.date >= t.lastDate) {
      t.lastDate = l.date;
      t.name = l.name; // the name it had on the latest bill
      t.nameHi = l.nameHi;
    }
    by.set(key, t);
  }
  return [...by.values()]
    .map(({ docs, ...t }) => ({ ...t, times: docs.size }))
    .sort((a, b) => b.amountPaise - a.amountPaise || a.name.localeCompare(b.name));
}

/** What a customer bought: the lines of their live bills (cancelled bills and estimates don't count), at the price on the bill after any discount. */
export async function itemsBoughtByCustomer(tx: Tx, customerId: number, from?: string, to?: string): Promise<ItemTotal[]> {
  let q = tx
    .selectFrom('bill_lines as l')
    .innerJoin('bills as b', 'b.id', 'l.bill_id')
    .select(['l.product_id', 'l.name_en', 'l.name_hi', 'l.unit_name', 'l.qty_milli', 'l.amount_paise', 'l.discount_paise', 'b.id as bill', 'b.bill_date'])
    .where('b.customer_id', '=', customerId)
    .where('b.status', '=', 'active');
  if (from) q = q.where('b.bill_date', '>=', from);
  if (to) q = q.where('b.bill_date', '<=', to);
  const rows = await q.execute();
  return total(rows.map((r) => ({ productId: r.product_id, name: r.name_en, nameHi: r.name_hi, unit: r.unit_name, qtyMilli: r.qty_milli, amountPaise: r.amount_paise - r.discount_paise, doc: r.bill, date: r.bill_date })));
}

/** What was bought from a supplier: the lines of their deliveries, quantity × the rate paid (a line with no rate counts as 0). */
export async function itemsBoughtFromSupplier(tx: Tx, supplierId: number, from?: string, to?: string): Promise<ItemTotal[]> {
  let q = tx
    .selectFrom('stock_movements as m')
    .innerJoin('stock_ins as s', 's.id', 'm.ref_id')
    .innerJoin('products as p', 'p.id', 'm.product_id')
    .leftJoin('product_units as u', 'u.id', 'm.unit_id')
    .select(['m.product_id', 'p.name_en', 'p.name_hi', 'u.name as unit', 'm.unit_qty_milli', 'm.rate_paise', 'm.qty_milli', 's.id as delivery', 's.date'])
    .where('m.ref_type', '=', 'stock_in')
    .where('s.supplier_id', '=', supplierId);
  if (from) q = q.where('s.date', '>=', from);
  if (to) q = q.where('s.date', '<=', to);
  const rows = await q.execute();
  return total(
    rows.map((r) => {
      const qty = r.unit_qty_milli ?? r.qty_milli;
      return { productId: r.product_id, name: r.name_en, nameHi: r.name_hi, unit: r.unit ?? '', qtyMilli: qty, amountPaise: r.rate_paise ? roundHalfUp((qty * r.rate_paise) / 1000) : 0, doc: r.delivery, date: r.date };
    }),
  );
}
