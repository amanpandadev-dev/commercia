import { Hono } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppEnv, Tx } from '../lib/core';
import { bad, logActivity, need, notFound, saveVersion, toNum } from '../lib/core';
import { nowIso } from '../db/index';
import { billSchema, cancelBill, createBill, describeParts, insertPayment, ledgerEntry, partSchema, reversePayment } from '../lib/billing';
import { customerBalances } from '../lib/catalog';
import { getSettings } from '../lib/settings';
import { istDate, isIsoDate } from '../../shared/dates';
import { formatRupees } from '../../shared/money';

export const sales = new Hono<AppEnv>();

// ---------- Bills ----------
sales.post('/bills', async (c) => {
  const user = await need(c, 'bill.create');
  const input = billSchema.parse(await c.req.json());
  const { k } = c.get('db');
  const result = await k.transaction().execute((tx) => createBill(tx, user, input));
  return c.json(result);
});

/** Duplicate warning (BILL-9): same customer, date and total. */
sales.post('/bills/duplicate-check', async (c) => {
  const body = z.object({ customerId: z.number().nullable(), billDate: z.string(), total: z.number() }).parse(await c.req.json());
  if (!body.customerId) return c.json({ duplicate: null });
  const row = await c
    .get('db')
    .k.selectFrom('bills')
    .select(['id', 'number'])
    .where('customer_id', '=', body.customerId)
    .where('bill_date', '=', body.billDate)
    .where('total_paise', '=', body.total)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return c.json({ duplicate: row ?? null });
});

sales.get('/bills', async (c) => {
  const { k } = c.get('db');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const q = c.req.query('q')?.trim();
  let query = k
    .selectFrom('bills as b')
    .leftJoin('users as u', 'u.id', 'b.created_by')
    .select([
      'b.id', 'b.number', 'b.kind', 'b.print_as', 'b.status', 'b.customer_id', 'b.customer_name', 'b.bill_date', 'b.total_paise',
      'b.paid_paise', 'b.credit_paise', 'b.rate_pending', 'b.needs_review', 'b.paper_ref', 'b.created_at', 'b.created_by', 'u.name as by',
    ])
    .orderBy('b.id', 'desc')
    .limit(Math.min(Number(c.req.query('limit') ?? 200), 1000));
  if (from && isIsoDate(from)) query = query.where('b.bill_date', '>=', from);
  if (to && isIsoDate(to)) query = query.where('b.bill_date', '<=', to);
  if (c.req.query('customerId')) query = query.where('b.customer_id', '=', Number(c.req.query('customerId')));
  if (c.req.query('userId')) query = query.where('b.created_by', '=', Number(c.req.query('userId')));
  const status = c.req.query('status');
  if (status) query = query.where('b.status', '=', status as 'active');
  else query = query.where('b.status', '!=', 'estimate');
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    query = query.where((eb) => eb.or([eb(eb.fn('lower', ['b.number']), 'like', like), eb(eb.fn('lower', ['b.paper_ref']), 'like', like), eb(eb.fn('lower', ['b.customer_name']), 'like', like)]));
  }
  const rows = await query.execute();
  // Mode summary per bill, for the "Payment" column.
  const ids = rows.map((r) => r.id);
  const parts = ids.length
    ? await k
        .selectFrom('payment_parts as pp')
        .innerJoin('payments as p', 'p.id', 'pp.payment_id')
        .select(['p.bill_id', 'pp.mode'])
        .where('p.bill_id', 'in', ids)
        .where('p.reversal_of', 'is', null)
        .execute()
    : [];
  const modes = new Map<number, Set<string>>();
  for (const p of parts) {
    if (!p.bill_id) continue;
    const s = modes.get(p.bill_id) ?? new Set();
    s.add(p.mode);
    modes.set(p.bill_id, s);
  }
  return c.json(rows.map((r) => ({ ...r, modes: [...(modes.get(r.id) ?? [])] })));
});

sales.get('/bills/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const { k } = c.get('db');
  const bill = await k
    .selectFrom('bills as b')
    .leftJoin('users as u', 'u.id', 'b.created_by')
    .leftJoin('users as cu', 'cu.id', 'b.cancelled_by')
    .selectAll('b')
    .select(['u.name as by', 'cu.name as cancelledByName'])
    .where('b.id', '=', id)
    .executeTakeFirst();
  if (!bill) throw notFound('Bill');
  const lines = await k.selectFrom('bill_lines').selectAll().where('bill_id', '=', id).orderBy('id').execute();
  const payments = await k.selectFrom('payments').selectAll().where('bill_id', '=', id).orderBy('id').execute();
  const parts = payments.length
    ? await k.selectFrom('payment_parts').selectAll().where('payment_id', 'in', payments.map((p) => p.id)).execute()
    : [];
  const customer = bill.customer_id ? await k.selectFrom('customers').selectAll().where('id', '=', bill.customer_id).executeTakeFirst() : null;
  const balance = bill.customer_id ? ((await customerBalances(k, [bill.customer_id])).get(bill.customer_id) ?? 0) : null;
  const converted = bill.converted_to ? await k.selectFrom('bills').select(['id', 'number']).where('id', '=', bill.converted_to).executeTakeFirst() : null;
  const history = await k
    .selectFrom('versions as v')
    .leftJoin('users as u', 'u.id', 'v.changed_by')
    .select(['v.version', 'v.reason', 'v.created_at', 'v.data', 'u.name as by'])
    .where('v.entity', '=', 'bill')
    .where('v.entity_id', '=', id)
    .orderBy('v.version', 'desc')
    .execute();
  return c.json({
    bill,
    lines,
    payments: payments.map((p) => ({ ...p, parts: parts.filter((x) => x.payment_id === p.id) })),
    customer,
    balance,
    converted,
    history: history.map((h) => ({ ...h, data: JSON.parse(h.data) })),
    shop: await getSettings(k),
  });
});

sales.post('/bills/:id/cancel', async (c) => {
  const user = await need(c, 'bill.cancel');
  const id = Number(c.req.param('id'));
  const { reason } = z.object({ reason: z.string() }).parse(await c.req.json());
  await c.get('db').k.transaction().execute((tx) => cancelBill(tx, user, id, reason, istDate()));
  return c.json({ ok: true });
});

sales.post('/bills/:id/reviewed', async (c) => {
  const user = await need(c, 'review.view');
  const id = Number(c.req.param('id'));
  const { k } = c.get('db');
  await k.updateTable('bills').set({ needs_review: 0 }).where('id', '=', id).execute();
  await logActivity(k, user.id, 'review', 'bill', id, `Marked bill #${id} as checked`);
  return c.json({ ok: true });
});

/** Estimate → real bill in one tap (BILL-12). */
sales.post('/bills/:id/convert', async (c) => {
  const user = await need(c, 'bill.create');
  const id = Number(c.req.param('id'));
  const body = z.object({ payments: z.array(partSchema).default([]), kind: z.enum(['receipt', 'tax_invoice', 'kaccha']).optional(), billDate: z.string().optional() }).parse(await c.req.json());
  const { k } = c.get('db');
  const result = await k.transaction().execute(async (tx) => {
    const est = await tx.selectFrom('bills').selectAll().where('id', '=', id).executeTakeFirst();
    if (!est || est.status !== 'estimate') throw bad('Only an open estimate can be converted');
    const lines = await tx.selectFrom('bill_lines').selectAll().where('bill_id', '=', id).orderBy('id').execute();
    const res = await createBill(
      tx,
      user,
      {
        kind: body.kind ?? est.kind,
        estimate: false,
        customerId: est.customer_id,
        customerName: est.customer_name,
        customerGstin: est.customer_gstin,
        billDate: body.billDate && isIsoDate(body.billDate) ? body.billDate : istDate(),
        paperRef: est.paper_ref,
        discount: est.discount_paise ? { type: 'amount', value: est.discount_paise } : null,
        lines: lines.map((l) => ({ productId: l.product_id, unitId: l.unit_id, qtyMilli: l.qty_milli, ratePaise: l.rate_paise })),
        payments: body.payments,
      },
      { fromEstimateId: id },
    );
    await tx.updateTable('bills').set({ status: 'converted', converted_to: res.id }).where('id', '=', id).execute();
    await logActivity(tx, user.id, 'convert', 'estimate', id, `Estimate ${est.number} converted to ${res.number}`);
    return res;
  });
  return c.json(result);
});

// ---------- Customers (LED-1, MIG-3) ----------
const customerSchema = z.object({
  name: z.string().trim().min(1),
  nickname: z.string().trim().default(''),
  phone: z.string().trim().default(''),
  area: z.string().trim().default(''),
  gstin: z.string().trim().toUpperCase().default(''),
  priceList: z.enum(['retail', 'wholesale']).default('retail'),
});

async function dueAgeing(tx: Tx, customerIds: number[], today: string) {
  // First-in-first-out: payments settle the oldest debits first (LED-7).
  const rows = customerIds.length
    ? await tx.selectFrom('ledger').select(['customer_id', 'date', 'debit_paise', 'credit_paise', 'id']).where('customer_id', 'in', customerIds).orderBy('date').orderBy('id').execute()
    : [];
  const by = new Map<number, typeof rows>();
  for (const r of rows) by.set(r.customer_id, [...(by.get(r.customer_id) ?? []), r]);
  const out = new Map<number, { b0: number; b30: number; b60: number; b90: number; oldest: string | null }>();
  for (const [cid, list] of by) {
    const debits: { date: string; left: number }[] = [];
    let credit = 0;
    for (const r of list) {
      if (r.debit_paise) debits.push({ date: r.date, left: r.debit_paise });
      credit += r.credit_paise;
    }
    for (const d of debits) {
      const use = Math.min(d.left, credit);
      d.left -= use;
      credit -= use;
    }
    const a = { b0: 0, b30: 0, b60: 0, b90: 0, oldest: null as string | null };
    for (const d of debits) {
      if (d.left <= 0) continue;
      a.oldest ??= d.date;
      const age = (Date.parse(today) - Date.parse(d.date)) / 86400000;
      if (age <= 30) a.b0 += d.left;
      else if (age <= 60) a.b30 += d.left;
      else if (age <= 90) a.b60 += d.left;
      else a.b90 += d.left;
    }
    // Advance left over reduces the newest bucket.
    if (credit > 0) a.b0 -= credit;
    out.set(cid, a);
  }
  return out;
}

sales.get('/customers', async (c) => {
  const { k } = c.get('db');
  const customers = await k.selectFrom('customers').selectAll().where('active', '=', 1).orderBy('name').execute();
  const balances = await customerBalances(k);
  const last = await k
    .selectFrom('ledger')
    .select(['customer_id', (eb) => eb.fn.max('date').as('last')])
    .groupBy('customer_id')
    .execute();
  const lastMap = new Map(last.map((l) => [l.customer_id, String(l.last)]));
  const ageing = await dueAgeing(k, customers.filter((x) => (balances.get(x.id) ?? 0) > 0).map((x) => x.id), istDate());
  return c.json(
    customers.map((x) => ({
      ...x,
      balance: balances.get(x.id) ?? 0,
      lastActivity: lastMap.get(x.id) ?? null,
      ageing: ageing.get(x.id) ?? null,
    })),
  );
});

sales.post('/customers', async (c) => {
  const user = await need(c, 'customer.edit');
  const body = customerSchema.parse(await c.req.json());
  const { k } = c.get('db');
  const row = await k.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto('customers')
      .values({ name: body.name, nickname: body.nickname, phone: body.phone, area: body.area, gstin: body.gstin, price_list: body.priceList, active: 1, created_at: nowIso() })
      .returningAll()
      .executeTakeFirstOrThrow();
    await saveVersion(tx, 'customer', row.id, body, 'Created', user.id);
    await logActivity(tx, user.id, 'create', 'customer', row.id, `Added customer ${body.name}`);
    return row;
  });
  return c.json(row);
});

sales.patch('/customers/:id', async (c) => {
  const user = await need(c, 'customer.edit');
  const id = Number(c.req.param('id'));
  const body = customerSchema.extend({ reason: z.string().default('') }).parse(await c.req.json());
  const { k } = c.get('db');
  await k.transaction().execute(async (tx) => {
    const cur = await tx.selectFrom('customers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cur) throw notFound('Customer');
    await tx
      .updateTable('customers')
      .set({ name: body.name, nickname: body.nickname, phone: body.phone, area: body.area, gstin: body.gstin, price_list: body.priceList })
      .where('id', '=', id)
      .execute();
    const { reason, ...data } = body;
    await saveVersion(tx, 'customer', id, data, reason || 'Edited', user.id);
    await logActivity(tx, user.id, 'update', 'customer', id, `Edited customer ${body.name}`);
  });
  return c.json({ ok: true });
});

/** Statement for a date range with opening balance and running balance (LED-2, LED-6). */
sales.get('/customers/:id/ledger', async (c) => {
  const id = Number(c.req.param('id'));
  const { k } = c.get('db');
  const customer = await k.selectFrom('customers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!customer) throw notFound('Customer');
  const from = c.req.query('from');
  const to = c.req.query('to');
  let opening = 0;
  if (from && isIsoDate(from)) {
    const r = await k
      .selectFrom('ledger')
      .select([sql<number>`coalesce(sum(debit_paise),0) - coalesce(sum(credit_paise),0)`.as('bal')])
      .where('customer_id', '=', id)
      .where('date', '<', from)
      .executeTakeFirst();
    opening = toNum(r?.bal);
  }
  let q = k
    .selectFrom('ledger as l')
    .leftJoin('users as u', 'u.id', 'l.created_by')
    .select(['l.id', 'l.date', 'l.kind', 'l.ref_type', 'l.ref_id', 'l.debit_paise', 'l.credit_paise', 'l.note', 'l.created_at', 'u.name as by'])
    .where('l.customer_id', '=', id)
    .orderBy('l.date')
    .orderBy('l.id');
  if (from && isIsoDate(from)) q = q.where('l.date', '>=', from);
  if (to && isIsoDate(to)) q = q.where('l.date', '<=', to);
  const rows = await q.execute();
  let bal = opening;
  const entries = rows.map((r) => {
    bal += r.debit_paise - r.credit_paise;
    return { ...r, balance: bal };
  });
  const balance = (await customerBalances(k, [id])).get(id) ?? 0;

  // Payment history with mode mix (PAY-3).
  const payments = await k
    .selectFrom('payments as p')
    .leftJoin('bills as b', 'b.id', 'p.bill_id')
    .leftJoin('users as u', 'u.id', 'p.created_by')
    .select(['p.id', 'p.date', 'p.total_paise', 'p.note', 'p.reversed', 'p.reversal_of', 'b.number as billNumber', 'u.name as by'])
    .where('p.customer_id', '=', id)
    .orderBy('p.date', 'desc')
    .orderBy('p.id', 'desc')
    .execute();
  const parts = payments.length ? await k.selectFrom('payment_parts').selectAll().where('payment_id', 'in', payments.map((p) => p.id)).execute() : [];
  const history = await k
    .selectFrom('versions as v')
    .leftJoin('users as u', 'u.id', 'v.changed_by')
    .select(['v.version', 'v.reason', 'v.created_at', 'v.data', 'u.name as by'])
    .where('v.entity', '=', 'customer')
    .where('v.entity_id', '=', id)
    .orderBy('v.version', 'desc')
    .execute();
  return c.json({
    customer,
    opening,
    entries,
    closing: bal,
    balance,
    payments: payments.map((p) => ({ ...p, parts: parts.filter((x) => x.payment_id === p.id) })),
    history: history.map((h) => ({ ...h, data: JSON.parse(h.data) })),
  });
});

// ---------- Payments (LED-3, LED-4, PAY-1, PAY-2) ----------
sales.post('/payments', async (c) => {
  const user = await need(c, 'payment.receive');
  const body = z
    .object({ customerId: z.number(), billId: z.number().nullable().optional(), date: z.string(), parts: z.array(partSchema).min(1), note: z.string().default('') })
    .parse(await c.req.json());
  if (!isIsoDate(body.date)) throw bad('Bad date');
  const { k } = c.get('db');
  const id = await k.transaction().execute(async (tx) => {
    const cust = await tx.selectFrom('customers').selectAll().where('id', '=', body.customerId).executeTakeFirst();
    if (!cust) throw notFound('Customer');
    let billNo = '';
    if (body.billId) {
      const b = await tx.selectFrom('bills').select(['number', 'customer_id']).where('id', '=', body.billId).executeTakeFirst();
      if (!b || b.customer_id !== cust.id) throw bad("That bill isn't this customer's");
      billNo = b.number;
    }
    const id = await insertPayment(tx, user, { customerId: cust.id, billId: body.billId ?? null, date: body.date, parts: body.parts, note: body.note });
    const total = body.parts.reduce((a, p) => a + p.amountPaise, 0);
    await ledgerEntry(tx, user, {
      customerId: cust.id,
      date: body.date,
      kind: 'payment',
      refType: 'payment',
      refId: id,
      debit: 0,
      credit: total,
      note: `Payment received · ${describeParts(body.parts)}${billNo ? ` · for ${billNo}` : ''}${body.note ? ` · ${body.note}` : ''}`,
    });
    await logActivity(tx, user.id, 'create', 'payment', id, `Received ${formatRupees(total)} from ${cust.name} (${describeParts(body.parts)})`);
    return id;
  });
  return c.json({ id });
});

sales.post('/payments/:id/reverse', async (c) => {
  const user = await need(c, 'payment.reverse');
  const id = Number(c.req.param('id'));
  const { reason } = z.object({ reason: z.string() }).parse(await c.req.json());
  await c.get('db').k.transaction().execute((tx) => reversePayment(tx, user, id, reason, istDate()));
  return c.json({ ok: true });
});

// ---------- Cash out (DAY-3) ----------
sales.post('/cash-outs', async (c) => {
  const user = await need(c, 'cashout.create');
  const body = z
    .object({
      date: z.string(),
      category: z.enum(['supplier', 'rent', 'wages', 'transport', 'electricity', 'other']),
      payee: z.string().default(''),
      mode: z.enum(['cash', 'upi', 'card', 'bank', 'cheque']),
      amountPaise: z.number().int().positive(),
      note: z.string().default(''),
    })
    .parse(await c.req.json());
  if (!isIsoDate(body.date)) throw bad('Bad date');
  const { k } = c.get('db');
  const row = await k
    .insertInto('cash_outs')
    .values({ date: body.date, category: body.category, payee: body.payee, mode: body.mode, amount_paise: body.amountPaise, note: body.note, created_by: user.id, created_at: nowIso() })
    .returning('id')
    .executeTakeFirstOrThrow();
  await logActivity(k, user.id, 'create', 'cash_out', row.id, `Paid out ${formatRupees(body.amountPaise)} (${body.category}${body.payee ? `: ${body.payee}` : ''})`);
  return c.json({ id: row.id });
});

export { dueAgeing };
