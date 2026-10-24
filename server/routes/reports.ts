import { Hono } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import type { AppEnv, Tx } from '../lib/core';
import { bad, need, toNum } from '../lib/core';
import { categoryPaths, customerBalances, lastPurchasePerBase, loadCatalog } from '../lib/catalog';
import { addDays, istDate, isIsoDate } from '../../shared/dates';
import { roundHalfUp } from '../../shared/money';

export const reports = new Hono<AppEnv>();

const MODES = ['cash', 'upi', 'card', 'bank', 'cheque'] as const;
type Mode = (typeof MODES)[number];
const emptyModes = () => Object.fromEntries(MODES.map((m) => [m, 0])) as Record<Mode, number>;

function range(c: { req: { query: (k: string) => string | undefined } }) {
  const today = istDate();
  const from = c.req.query('from') ?? today;
  const to = c.req.query('to') ?? from;
  if (!isIsoDate(from) || !isIsoDate(to)) throw bad('Bad date');
  return { from, to };
}

/** IST calendar date of a UTC timestamp. */
const istOf = (iso: string) => istDate(new Date(iso));

async function collections(tx: Tx, from: string, to: string) {
  const rows = await tx
    .selectFrom('payment_parts as pp')
    .innerJoin('payments as p', 'p.id', 'pp.payment_id')
    .select(['pp.mode', (eb) => eb.fn.sum<number>('pp.amount_paise').as('amt')])
    .where('p.date', '>=', from)
    .where('p.date', '<=', to)
    .groupBy('pp.mode')
    .execute();
  const out = emptyModes();
  for (const r of rows) out[r.mode as Mode] = toNum(r.amt);
  return out;
}

async function salesTotal(tx: Tx, from: string, to: string) {
  const r = await tx
    .selectFrom('bills')
    .select([(eb) => eb.fn.sum<number>('total_paise').as('total'), (eb) => eb.fn.countAll<number>().as('n')])
    .where('status', '=', 'active')
    .where('bill_date', '>=', from)
    .where('bill_date', '<=', to)
    .executeTakeFirst();
  return { total: toNum(r?.total), count: toNum(r?.n) };
}

/** Dashboard (REP-1, STK-3, RATE-7). */
reports.get('/dashboard', async (c) => {
  const { k } = c.get('db');
  const today = istDate();
  const monthStart = `${today.slice(0, 8)}01`;
  const [todaySales, monthSales, collected] = await Promise.all([salesTotal(k, today, today), salesTotal(k, monthStart, today), collections(k, today, today)]);
  const balances = await customerBalances(k);
  let due = 0;
  let dueCustomers = 0;
  for (const b of balances.values()) if (b > 0) {
    due += b;
    dueCustomers++;
  }
  const catalog = await loadCatalog(k, today);
  const low = catalog
    .filter((p) => p.low)
    .map((p) => ({ id: p.id, nameEn: p.nameEn, nameHi: p.nameHi, stockMilli: p.stockMilli, reorderMilli: p.reorderMilli, baseUnit: p.baseUnit, units: p.units, reorderUnitId: p.reorderUnitId }));
  const week = await k
    .selectFrom('bills')
    .select(['bill_date', (eb) => eb.fn.sum<number>('total_paise').as('total')])
    .where('status', '=', 'active')
    .where('bill_date', '>=', addDays(today, -6))
    .where('bill_date', '<=', today)
    .groupBy('bill_date')
    .execute();
  const weekMap = new Map(week.map((w) => [w.bill_date, toNum(w.total)]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)).map((d) => ({ date: d, total: weekMap.get(d) ?? 0 }));
  const recent = await k
    .selectFrom('bills as b')
    .leftJoin('users as u', 'u.id', 'b.created_by')
    .select(['b.id', 'b.number', 'b.customer_name', 'b.total_paise', 'b.credit_paise', 'b.paid_paise', 'b.status', 'b.bill_date', 'b.created_at', 'u.name as by'])
    .where('b.status', 'in', ['active', 'cancelled'])
    .orderBy('b.id', 'desc')
    .limit(6)
    .execute();
  const recentParts = recent.length
    ? await k
        .selectFrom('payment_parts as pp')
        .innerJoin('payments as p', 'p.id', 'pp.payment_id')
        .select(['p.bill_id', 'pp.mode'])
        .where('p.bill_id', 'in', recent.map((r) => r.id))
        .where('p.reversal_of', 'is', null)
        .execute()
    : [];
  const pendingRates = await k.selectFrom('rate_requests').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'pending').executeTakeFirst();
  const review = await k
    .selectFrom('bills')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where((eb) => eb.or([eb('rate_pending', '=', 1), eb('needs_review', '=', 1)]))
    .where('status', '=', 'active')
    .executeTakeFirst();
  const reportedLosses = await k.selectFrom('losses').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'reported').executeTakeFirst();
  const monthLoss = await k
    .selectFrom('losses')
    .select((eb) => eb.fn.sum<number>('value_paise').as('v'))
    .where('status', '=', 'confirmed')
    .where('date', '>=', monthStart)
    .executeTakeFirst();
  return c.json({
    today,
    todaySales,
    monthSales,
    collected,
    due,
    dueCustomers,
    low,
    days,
    recent: recent.map((r) => ({ ...r, modes: [...new Set(recentParts.filter((p) => p.bill_id === r.id).map((p) => p.mode))] })),
    pendingRates: toNum(pendingRates?.n),
    reviewCount: toNum(review?.n) + toNum(reportedLosses?.n),
    monthLoss: toNum(monthLoss?.v),
  });
});

/** Sales by day, month, category or brand (REP-2). A category includes everything under it. */
reports.get('/reports/sales', async (c) => {
  await need(c, 'reports.view');
  const { from, to } = range(c);
  const groupBy = (c.req.query('groupBy') ?? 'day') as 'day' | 'month' | 'category' | 'brand' | 'product';
  const categoryId = c.req.query('categoryId') ? Number(c.req.query('categoryId')) : null;
  const { k } = c.get('db');
  const lines = await k
    .selectFrom('bill_lines as l')
    .innerJoin('bills as b', 'b.id', 'l.bill_id')
    .innerJoin('products as p', 'p.id', 'l.product_id')
    .select(['b.bill_date', 'l.product_id', 'l.name_en', 'p.brand', 'p.category_id', 'l.taxable_paise', 'l.cgst_paise', 'l.sgst_paise', 'l.base_milli', 'p.base_unit'])
    .where('b.status', '=', 'active')
    .where('b.bill_date', '>=', from)
    .where('b.bill_date', '<=', to)
    .execute();
  const paths = await categoryPaths(k);
  const groups = new Map<string, { key: string; taxable: number; gst: number; total: number; lines: number; qty: number; unit: string }>();
  for (const l of lines) {
    const path = l.category_id ? paths.get(l.category_id) : undefined;
    if (categoryId && !path?.ids.includes(categoryId)) continue;
    let key: string;
    if (groupBy === 'day') key = l.bill_date;
    else if (groupBy === 'month') key = l.bill_date.slice(0, 7);
    else if (groupBy === 'brand') key = l.brand || '—';
    else if (groupBy === 'product') key = l.name_en;
    else {
      // Group by the next level below the chosen category (or top level).
      const ids = path?.ids ?? [];
      const at = categoryId ? ids.indexOf(categoryId) + 1 : 0;
      key = path ? (path.en[at] ?? path.en[path.en.length - 1]) : 'Uncategorised';
    }
    const g = groups.get(key) ?? { key, taxable: 0, gst: 0, total: 0, lines: 0, qty: 0, unit: l.base_unit };
    g.taxable += l.taxable_paise;
    g.gst += l.cgst_paise + l.sgst_paise;
    g.total += l.taxable_paise + l.cgst_paise + l.sgst_paise;
    g.lines += 1;
    g.qty += l.base_milli;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => (groupBy === 'day' || groupBy === 'month' ? a.key.localeCompare(b.key) : b.total - a.total));
  const bills = await salesTotal(k, from, to);
  return c.json({ from, to, groupBy, rows, billTotal: bills.total, billCount: bills.count });
});

/** Monthly GST summary by rate and HSN (REP-3); cancelled bills and estimates excluded. */
reports.get('/reports/gst', async (c) => {
  await need(c, 'reports.view');
  const month = c.req.query('month') ?? istDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('Bad month');
  const { k } = c.get('db');
  const lines = await k
    .selectFrom('bill_lines as l')
    .innerJoin('bills as b', 'b.id', 'l.bill_id')
    .select(['l.hsn', 'l.gst_bp', 'l.taxable_paise', 'l.cgst_paise', 'l.sgst_paise', 'b.print_as'])
    .where('b.status', '=', 'active')
    .where('b.bill_date', '>=', `${month}-01`)
    .where('b.bill_date', '<=', `${month}-31`)
    .execute();
  const byRate = new Map<number, { gstBp: number; taxable: number; cgst: number; sgst: number }>();
  const byHsn = new Map<string, { hsn: string; gstBp: number; taxable: number; cgst: number; sgst: number }>();
  const byType = new Map<string, { type: string; taxable: number; cgst: number; sgst: number }>();
  for (const l of lines) {
    const r = byRate.get(l.gst_bp) ?? { gstBp: l.gst_bp, taxable: 0, cgst: 0, sgst: 0 };
    r.taxable += l.taxable_paise;
    r.cgst += l.cgst_paise;
    r.sgst += l.sgst_paise;
    byRate.set(l.gst_bp, r);
    const hk = `${l.hsn}|${l.gst_bp}`;
    const h = byHsn.get(hk) ?? { hsn: l.hsn || '—', gstBp: l.gst_bp, taxable: 0, cgst: 0, sgst: 0 };
    h.taxable += l.taxable_paise;
    h.cgst += l.cgst_paise;
    h.sgst += l.sgst_paise;
    byHsn.set(hk, h);
    const t = byType.get(l.print_as) ?? { type: l.print_as, taxable: 0, cgst: 0, sgst: 0 };
    t.taxable += l.taxable_paise;
    t.cgst += l.cgst_paise;
    t.sgst += l.sgst_paise;
    byType.set(l.print_as, t);
  }
  const totals = [...byRate.values()].reduce((a, r) => ({ taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst }), { taxable: 0, cgst: 0, sgst: 0 });
  return c.json({
    month,
    byRate: [...byRate.values()].sort((a, b) => a.gstBp - b.gstBp),
    byHsn: [...byHsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.gstBp - b.gstBp),
    byType: [...byType.values()],
    totals,
  });
});

/** Day book: everything on one date in time order, plus the day's totals (DAY-1, DAY-2). */
reports.get('/reports/daybook', async (c) => {
  await need(c, 'daybook.view');
  const { from, to } = range(c);
  const { k } = c.get('db');
  type Entry = { type: string; id: number; date: string; at: string; title: string; party: string; amount: number; method: string; by: string; userId: number | null; link?: string };
  const entries: Entry[] = [];
  const userNames = new Map((await k.selectFrom('users').select(['id', 'name']).execute()).map((u) => [u.id, u.name]));

  const bills = await k.selectFrom('bills').selectAll().where('status', 'in', ['active', 'cancelled']).where('bill_date', '>=', from).where('bill_date', '<=', to).execute();
  const billPays = bills.length
    ? await k
        .selectFrom('payment_parts as pp')
        .innerJoin('payments as p', 'p.id', 'pp.payment_id')
        .select(['p.bill_id', 'pp.mode', 'pp.amount_paise', 'p.at_billing'])
        .where('p.bill_id', 'in', bills.map((b) => b.id))
        .execute()
    : [];
  const salesSplit = { ...emptyModes(), credit: 0 };
  for (const b of bills) {
    const parts = billPays.filter((p) => p.bill_id === b.id && p.at_billing === 1);
    const method = [...parts.map((p) => p.mode.toUpperCase()), ...(b.credit_paise > 0 ? ['CREDIT'] : [])].join(' + ') || '—';
    entries.push({ type: 'bill', id: b.id, date: b.bill_date, at: b.created_at, title: `${b.number}${b.status === 'cancelled' ? ' (cancelled)' : ''}`, party: b.customer_name || 'Walk-in', amount: b.total_paise, method, by: userNames.get(b.created_by) ?? '', userId: b.created_by });
    if (b.status === 'active') {
      for (const p of parts) salesSplit[p.mode as Mode] += p.amount_paise;
      salesSplit.credit += b.credit_paise;
    }
  }
  // Cancellations on these dates (they may cancel older bills).
  const cancels = await k.selectFrom('bills').selectAll().where('status', '=', 'cancelled').where('cancelled_at', 'is not', null).execute();
  for (const b of cancels) {
    const d = istOf(b.cancelled_at!);
    if (d < from || d > to) continue;
    entries.push({ type: 'cancel', id: b.id, date: d, at: b.cancelled_at!, title: `Cancelled ${b.number}`, party: b.cancel_reason, amount: -b.total_paise, method: '', by: userNames.get(b.cancelled_by ?? 0) ?? '', userId: b.cancelled_by });
  }

  // Payments not made on a bill at billing time: dues collected, reversals.
  const pays = await k
    .selectFrom('payments as p')
    .leftJoin('customers as cu', 'cu.id', 'p.customer_id')
    .leftJoin('bills as b', 'b.id', 'p.bill_id')
    .select(['p.id', 'p.date', 'p.created_at', 'p.total_paise', 'p.bill_id', 'p.note', 'p.reversal_of', 'p.at_billing', 'p.created_by', 'cu.name as customer', 'b.number'])
    .where('p.date', '>=', from)
    .where('p.date', '<=', to)
    .execute();
  const payParts = pays.length ? await k.selectFrom('payment_parts').selectAll().where('payment_id', 'in', pays.map((p) => p.id)).execute() : [];
  const received = emptyModes();
  for (const p of pays) {
    const parts = payParts.filter((x) => x.payment_id === p.id);
    if (p.at_billing) continue; // already inside its bill's entry
    for (const x of parts) received[x.mode as Mode] += x.amount_paise;
    entries.push({
      type: p.reversal_of ? 'reversal' : 'payment',
      id: p.id,
      date: p.date,
      at: p.created_at,
      title: p.reversal_of ? `Payment reversed${p.number ? ` · ${p.number}` : ''}` : `Payment received${p.number ? ` · ${p.number}` : ''}`,
      party: p.customer ?? 'Walk-in',
      amount: p.total_paise,
      method: parts.map((x) => x.mode.toUpperCase()).join(' + '),
      by: userNames.get(p.created_by) ?? '',
      userId: p.created_by,
    });
  }

  const outs = await k.selectFrom('cash_outs').selectAll().where('date', '>=', from).where('date', '<=', to).execute();
  const paidOut = emptyModes();
  for (const o of outs) {
    paidOut[o.mode as Mode] += o.amount_paise;
    entries.push({ type: 'cash_out', id: o.id, date: o.date, at: o.created_at, title: `Paid out · ${o.category}`, party: o.payee || o.note, amount: -o.amount_paise, method: o.mode.toUpperCase(), by: userNames.get(o.created_by) ?? '', userId: o.created_by });
  }

  const ins = await k.selectFrom('stock_ins').selectAll().where('date', '>=', from).where('date', '<=', to).execute();
  for (const s of ins) entries.push({ type: 'stock_in', id: s.id, date: s.date, at: s.created_at, title: 'Stock in', party: s.supplier, amount: s.total_paise, method: '', by: userNames.get(s.created_by) ?? '', userId: s.created_by });

  const losses = await k.selectFrom('losses').selectAll().where('date', '>=', from).where('date', '<=', to).where('status', '!=', 'dismissed').execute();
  for (const l of losses) entries.push({ type: 'loss', id: l.id, date: l.date, at: l.created_at, title: `${l.reverses_id ? 'Goods found' : l.status === 'reported' ? 'Shortage reported' : 'Loss'} · ${l.reason}`, party: l.notes, amount: -l.value_paise, method: '', by: userNames.get(l.reported_by) ?? '', userId: l.reported_by });

  const adjs = await k
    .selectFrom('stock_movements as m')
    .innerJoin('products as p', 'p.id', 'm.product_id')
    .select(['m.id', 'm.date', 'm.created_at', 'm.note', 'm.qty_milli', 'm.created_by', 'p.name_en', 'p.base_unit'])
    .where('m.kind', '=', 'adjustment')
    .where('m.date', '>=', from)
    .where('m.date', '<=', to)
    .execute();
  for (const a of adjs) entries.push({ type: 'adjustment', id: a.id, date: a.date, at: a.created_at, title: `Stock adjusted · ${a.name_en} ${a.qty_milli > 0 ? '+' : ''}${a.qty_milli / 1000} ${a.base_unit}`, party: a.note, amount: 0, method: '', by: userNames.get(a.created_by) ?? '', userId: a.created_by });

  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : null;
  const type = c.req.query('type');
  const filtered = entries
    .filter((e) => (userId ? e.userId === userId : true) && (type ? e.type === type : true))
    .sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));

  const salesTotalAmt = bills.filter((b) => b.status === 'active').reduce((a, b) => a + b.total_paise, 0);
  const cashIn = salesSplit.cash + received.cash;
  return c.json({
    from,
    to,
    entries: filtered,
    totals: {
      sales: salesTotalAmt,
      salesSplit,
      received,
      receivedTotal: Object.values(received).reduce((a, b) => a + b, 0),
      paidOut,
      paidOutTotal: Object.values(paidOut).reduce((a, b) => a + b, 0),
      cashIn,
      netCash: cashIn - paidOut.cash,
    },
  });
});

/** Payments register (PAY-4): one row per payment, a column per mode. */
reports.get('/reports/payments', async (c) => {
  await need(c, 'reports.view');
  const { from, to } = range(c);
  const { k } = c.get('db');
  let q = k
    .selectFrom('payments as p')
    .leftJoin('customers as cu', 'cu.id', 'p.customer_id')
    .leftJoin('bills as b', 'b.id', 'p.bill_id')
    .leftJoin('users as u', 'u.id', 'p.created_by')
    .select(['p.id', 'p.date', 'p.total_paise', 'p.note', 'p.reversal_of', 'p.reversed', 'p.customer_id', 'cu.name as customer', 'b.number as billNumber', 'u.name as by'])
    .where('p.date', '>=', from)
    .where('p.date', '<=', to)
    .orderBy('p.date')
    .orderBy('p.id');
  if (c.req.query('customerId')) q = q.where('p.customer_id', '=', Number(c.req.query('customerId')));
  const pays = await q.execute();
  const parts = pays.length ? await k.selectFrom('payment_parts').selectAll().where('payment_id', 'in', pays.map((p) => p.id)).execute() : [];
  const mode = c.req.query('mode') as Mode | undefined;
  const totals = emptyModes();
  const rows = [];
  for (const p of pays) {
    const m = emptyModes();
    const refs: string[] = [];
    for (const x of parts.filter((x) => x.payment_id === p.id)) {
      m[x.mode as Mode] += x.amount_paise;
      if (x.reference) refs.push(x.reference);
    }
    if (mode && !m[mode]) continue;
    for (const k2 of MODES) totals[k2] += m[k2];
    rows.push({ ...p, customer: p.customer ?? 'Walk-in', modes: m, refs: refs.join(', ') });
  }
  return c.json({ from, to, rows, totals, total: Object.values(totals).reduce((a, b) => a + b, 0) });
});

/** Cash flow by mode (PAY-5): money in per mode with who paid, money out, net. */
reports.get('/reports/cashflow', async (c) => {
  await need(c, 'reports.view');
  const { from, to } = range(c);
  const { k } = c.get('db');
  const parts = await k
    .selectFrom('payment_parts as pp')
    .innerJoin('payments as p', 'p.id', 'pp.payment_id')
    .leftJoin('customers as cu', 'cu.id', 'p.customer_id')
    .select(['pp.mode', 'pp.amount_paise', 'p.date', 'cu.name as customer', 'p.customer_id'])
    .where('p.date', '>=', from)
    .where('p.date', '<=', to)
    .execute();
  const outs = await k.selectFrom('cash_outs').selectAll().where('date', '>=', from).where('date', '<=', to).execute();
  const modes = MODES.map((m) => {
    const ins = new Map<string, number>();
    for (const p of parts.filter((x) => x.mode === m)) {
      const name = p.customer ?? 'Walk-in';
      ins.set(name, (ins.get(name) ?? 0) + p.amount_paise);
    }
    const out = outs.filter((o) => o.mode === m);
    const inTotal = [...ins.values()].reduce((a, b) => a + b, 0);
    const outTotal = out.reduce((a, o) => a + o.amount_paise, 0);
    return {
      mode: m,
      in: [...ins.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      out: out.map((o) => ({ name: o.payee || o.category, category: o.category, amount: o.amount_paise, date: o.date })),
      inTotal,
      outTotal,
      net: inTotal - outTotal,
    };
  });
  return c.json({ from, to, modes });
});

/** Mode mix month by month (PAY-8). */
reports.get('/reports/mode-mix', async (c) => {
  await need(c, 'reports.view');
  const { k } = c.get('db');
  const rows = await k
    .selectFrom('payment_parts as pp')
    .innerJoin('payments as p', 'p.id', 'pp.payment_id')
    .select([sql<string>`substr(p.date, 1, 7)`.as('month'), 'pp.mode', (eb) => eb.fn.sum<number>('pp.amount_paise').as('amt')])
    .groupBy([sql`substr(p.date, 1, 7)`, 'pp.mode'])
    .execute();
  const months = new Map<string, Record<Mode, number>>();
  for (const r of rows) {
    const m = months.get(r.month) ?? emptyModes();
    m[r.mode as Mode] = toNum(r.amt);
    months.set(r.month, m);
  }
  return c.json([...months.entries()].sort().map(([month, modes]) => ({ month, modes })));
});

/** Owners' review screen (REP-4): entries by the Entry person, flagged bills, reports waiting. */
reports.get('/reports/review', async (c) => {
  await need(c, 'review.view');
  const { from, to } = range(c);
  const { k } = c.get('db');
  const flagged = await k
    .selectFrom('bills as b')
    .leftJoin('users as u', 'u.id', 'b.created_by')
    .select(['b.id', 'b.number', 'b.customer_name', 'b.bill_date', 'b.total_paise', 'b.rate_pending', 'b.needs_review', 'u.name as by'])
    .select((eb) =>
      eb.selectFrom('bill_lines as bl').select((e) => e.fn.countAll<number>().as('n')).whereRef('bl.bill_id', '=', 'b.id').where('bl.price_override', '=', 1).as('own_prices'),
    )
    .where('b.status', '=', 'active')
    .where((eb) => eb.or([eb('b.rate_pending', '=', 1), eb('b.needs_review', '=', 1)]))
    .orderBy('b.id', 'desc')
    .execute();
  const entryUsers = await k.selectFrom('users').select(['id', 'name']).where('role', '=', 'entry').execute();
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : null;
  const ids = userId ? [userId] : entryUsers.map((u) => u.id);
  const activity = ids.length
    ? await k
        .selectFrom('activity as a')
        .leftJoin('users as u', 'u.id', 'a.user_id')
        .select(['a.id', 'a.action', 'a.entity', 'a.entity_id', 'a.summary', 'a.created_at', 'u.name as by'])
        .where('a.user_id', 'in', ids)
        .where('a.action', 'not in', ['login', 'login_failed'])
        .where('a.created_at', '>=', `${addDays(from, -1)}T18:30:00.000Z`)
        .where('a.created_at', '<', `${to}T18:30:00.000Z`)
        .orderBy('a.id', 'desc')
        .limit(500)
        .execute()
    : [];
  const reported = await k
    .selectFrom('losses as l')
    .leftJoin('users as u', 'u.id', 'l.reported_by')
    .select(['l.id', 'l.reason', 'l.date', 'l.notes', 'l.value_paise', 'u.name as by'])
    .where('l.status', '=', 'reported')
    .execute();
  return c.json({ flagged, activity, reported, entryUsers });
});

/** Activity log (REP-5). Nobody can edit or delete it — the database refuses. */
reports.get('/activity', async (c) => {
  await need(c, 'activity.view');
  const { k } = c.get('db');
  let q = k
    .selectFrom('activity as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .select(['a.id', 'a.action', 'a.entity', 'a.entity_id', 'a.summary', 'a.created_at', 'a.user_id', 'u.name as by'])
    .orderBy('a.id', 'desc')
    .limit(Math.min(Number(c.req.query('limit') ?? 200), 2000));
  if (c.req.query('userId')) q = q.where('a.user_id', '=', Number(c.req.query('userId')));
  if (c.req.query('before')) q = q.where('a.id', '<', Number(c.req.query('before')));
  return c.json(await q.execute());
});

/** Stock value at purchase cost and selling price, by category (REP-6). */
reports.get('/reports/stock-value', async (c) => {
  await need(c, 'reports.view');
  const { k } = c.get('db');
  const today = istDate();
  const catalog = await loadCatalog(k, today);
  const cost = await lastPurchasePerBase(k);
  const groups = new Map<string, { category: string; cost: number; selling: number; missingCost: number }>();
  for (const p of catalog) {
    if (p.stockMilli <= 0) continue;
    const key = p.categoryPath[0] ?? 'Uncategorised';
    const g = groups.get(key) ?? { category: key, cost: 0, selling: 0, missingCost: 0 };
    const base = p.units.find((u) => u.isBase);
    const perBase = cost.get(p.id);
    if (perBase == null) g.missingCost++;
    else g.cost += roundHalfUp((perBase * p.stockMilli) / 1000);
    if (base?.retail != null) g.selling += roundHalfUp((base.retail * p.stockMilli) / 1000);
    groups.set(key, g);
  }
  return c.json([...groups.values()].sort((a, b) => b.selling - a.selling));
});

/** Losses by month and reason (LOSS-5). */
reports.get('/reports/losses', async (c) => {
  await need(c, 'reports.view');
  const { k } = c.get('db');
  const rows = await k.selectFrom('losses').select(['date', 'reason', 'value_paise']).where('status', '=', 'confirmed').execute();
  const m = new Map<string, { month: string; reason: string; value: number; count: number }>();
  for (const r of rows) {
    const key = `${r.date.slice(0, 7)}|${r.reason}`;
    const g = m.get(key) ?? { month: r.date.slice(0, 7), reason: r.reason, value: 0, count: 0 };
    g.value += r.value_paise;
    g.count++;
    m.set(key, g);
  }
  return c.json([...m.values()].sort((a, b) => b.month.localeCompare(a.month)));
});

// ---------- Excel export for any list (REP-7, REP-3) ----------
const exportSchema = z.object({
  fileName: z.string().min(1),
  sheets: z
    .array(
      z.object({
        name: z.string().min(1).max(31),
        columns: z.array(z.object({ header: z.string(), key: z.string(), type: z.enum(['text', 'money', 'number', 'date']).default('text') })),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
    )
    .min(1),
});

reports.post('/export', async (c) => {
  const body = exportSchema.parse(await c.req.json());
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Commercia';
  for (const s of body.sheets) {
    const ws = wb.addWorksheet(s.name.replace(/[\\/?*[\]:]/g, ' '));
    ws.columns = s.columns.map((col) => ({
      header: col.header,
      key: col.key,
      width: Math.max(12, Math.min(40, col.header.length + 4)),
      style: col.type === 'money' ? { numFmt: '"₹"#,##,##0.00' } : {},
    }));
    ws.getRow(1).font = { bold: true };
    for (const r of s.rows) {
      const row: Record<string, unknown> = {};
      for (const col of s.columns) {
        const v = r[col.key];
        row[col.key] = col.type === 'money' ? toNum(v) / 100 : col.type === 'number' ? toNum(v) : (v ?? '');
      }
      ws.addRow(row);
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  const name = body.fileName.replace(/[^\w.\- ]+/g, '_').replace(/\.xlsx$/i, '') + '.xlsx';
  return new Response(buf as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  });
});
