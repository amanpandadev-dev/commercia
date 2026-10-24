import { z } from 'zod';
import type { Tx } from './core';
import { HttpError, bad, logActivity, nextCounter, notFound, saveVersion } from './core';
import { nowIso } from '../db/index';
import { gstOn, priceOn, type PriceList } from './catalog';
import { changeRate } from './rates';
import { getSettings, schemeOn } from './settings';
import { computeBill, financialYear } from '../../shared/gst';
import { toBase } from '../../shared/units';
import { formatRupees } from '../../shared/money';
import { isIsoDate } from '../../shared/dates';
import { can } from '../../shared/perms';
import type { PayMode, User } from '../db/schema';

export const PAY_MODES = ['cash', 'upi', 'card', 'bank', 'cheque'] as const;

export const partSchema = z.object({
  mode: z.enum(PAY_MODES),
  amountPaise: z.number().int().positive(),
  reference: z.string().default(''),
});

export const billSchema = z.object({
  kind: z.enum(['receipt', 'tax_invoice', 'kaccha']),
  estimate: z.boolean().default(false),
  customerId: z.number().nullable().optional(),
  customerName: z.string().trim().default(''),
  customerGstin: z.string().trim().default(''),
  billDate: z.string(),
  paperRef: z.string().trim().default(''),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.number().int().nonnegative() }).nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: z.number(),
        unitId: z.number(),
        qtyMilli: z.number().int().positive(),
        ratePaise: z.number().int().nonnegative().optional(),
        /** True: ratePaise is for this bill only. The item's own price is left alone and no approval is asked. */
        oneOff: z.boolean().optional(),
      }),
    )
    .min(1, 'Add at least one item'),
  payments: z.array(partSchema).default([]),
});

export type BillInput = z.infer<typeof billSchema>;

async function addStock(tx: Tx, user: User, productId: number, qty: number, kind: 'sale' | 'sale_cancel', billId: number, date: string, unitId: number, unitQty: number) {
  await tx
    .insertInto('stock_movements')
    .values({
      product_id: productId,
      qty_milli: qty,
      kind,
      ref_type: 'bill',
      ref_id: billId,
      unit_id: unitId,
      unit_qty_milli: unitQty,
      rate_paise: null,
      note: '',
      date,
      import_id: null,
      created_by: user.id,
      created_at: nowIso(),
    })
    .execute();
}

export async function insertPayment(
  tx: Tx,
  user: User,
  p: { customerId: number | null; billId: number | null; date: string; parts: { mode: PayMode; amountPaise: number; reference: string }[]; note: string; reversalOf?: number | null; atBilling?: boolean },
): Promise<number> {
  const total = p.parts.reduce((a, x) => a + x.amountPaise, 0);
  const pay = await tx
    .insertInto('payments')
    .values({
      customer_id: p.customerId,
      bill_id: p.billId,
      date: p.date,
      total_paise: total,
      note: p.note,
      reversal_of: p.reversalOf ?? null,
      reversed: 0,
      at_billing: p.atBilling ? 1 : 0,
      created_by: user.id,
      created_at: nowIso(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const part of p.parts) {
    await tx
      .insertInto('payment_parts')
      .values({ payment_id: pay.id, mode: part.mode, amount_paise: part.amountPaise, reference: part.reference })
      .execute();
  }
  return pay.id;
}

export async function ledgerEntry(
  tx: Tx,
  user: User,
  e: { customerId: number; date: string; kind: 'opening' | 'bill' | 'payment' | 'reversal' | 'cancel' | 'correction'; refType: string | null; refId: number | null; debit: number; credit: number; note: string; importId?: number | null },
) {
  await tx
    .insertInto('ledger')
    .values({
      customer_id: e.customerId,
      date: e.date,
      kind: e.kind,
      ref_type: e.refType,
      ref_id: e.refId,
      debit_paise: e.debit,
      credit_paise: e.credit,
      note: e.note,
      import_id: e.importId ?? null,
      created_by: user.id,
      created_at: nowIso(),
    })
    .execute();
}

const modeLabel: Record<PayMode, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank transfer', cheque: 'Cheque' };
export const describeParts = (parts: { mode: PayMode; amountPaise: number }[]) =>
  parts.map((p) => `${modeLabel[p.mode]} ${formatRupees(p.amountPaise)}`).join(' + ');

/**
 * Saves a bill in one step: lines with their own copy of rate, unit, GST and name (RATE-1),
 * stock out, payment parts, the credit part on the customer's ledger, a sequential number,
 * and any rate change — applied at once for Owners, sent for approval otherwise.
 */
export async function createBill(tx: Tx, user: User, input: BillInput, opts: { fromEstimateId?: number } = {}) {
  if (!isIsoDate(input.billDate)) throw bad('Bad bill date');
  const settings = await getSettings(tx);
  const scheme = schemeOn(settings, input.billDate);

  let customer = null;
  if (input.customerId) {
    customer = await tx.selectFrom('customers').selectAll().where('id', '=', input.customerId).executeTakeFirst();
    if (!customer) throw notFound('Customer');
  }
  const customerName = customer?.name ?? input.customerName;
  if (input.kind === 'tax_invoice' && !customerName) throw bad('A tax invoice needs a customer name');
  const list: PriceList = customer?.price_list === 'wholesale' ? 'wholesale' : 'retail';

  // Resolve lines.
  const resolved = [];
  for (const l of input.lines) {
    const unit = await tx.selectFrom('product_units').selectAll().where('id', '=', l.unitId).executeTakeFirst();
    const product = await tx.selectFrom('products').selectAll().where('id', '=', l.productId).executeTakeFirst();
    if (!unit || !product || unit.product_id !== product.id) throw bad('An item on this bill no longer exists');
    const official = (await priceOn(tx, unit.id, list, input.billDate)) ?? 0;
    const rate = l.ratePaise ?? official;
    const gstBp = await gstOn(tx, product.id, input.billDate);
    resolved.push({ l, unit, product, official, rate, gstBp, oneOff: l.oneOff === true && rate !== official });
  }
  const oneOffCount = resolved.filter((r) => r.oneOff).length;

  const inclusive = settings.prices_include_gst === '1';
  const totals = computeBill(
    resolved.map((r) => ({ qtyMilli: r.l.qtyMilli, ratePaise: r.rate, gstBp: r.gstBp })),
    { scheme, kind: input.kind, discount: input.discount ?? null, inclusive },
  );

  const paid = input.estimate ? 0 : input.payments.reduce((a, p) => a + p.amountPaise, 0);
  if (paid > totals.total) throw bad(`Payments (${formatRupees(paid)}) are more than the bill total (${formatRupees(totals.total)})`);
  const credit = input.estimate ? 0 : totals.total - paid;
  if (credit > 0 && !customer) throw bad('Choose a customer to put the balance on credit');

  // Number: separate series for receipts, tax invoices and estimates, restarting each April (BILL-5, Q8).
  const fy = financialYear(input.billDate);
  const prefix = input.estimate ? settings.prefix_estimate : input.kind === 'tax_invoice' ? settings.prefix_invoice : settings.prefix_receipt;
  const series = input.estimate ? 'estimate' : input.kind === 'tax_invoice' ? 'invoice' : 'receipt';
  const seq = await nextCounter(tx, `${series}:${fy}`);
  const number = `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;

  const bill = await tx
    .insertInto('bills')
    .values({
      number,
      series,
      fy,
      seq,
      kind: input.kind,
      print_as: totals.printAs,
      status: input.estimate ? 'estimate' : 'active',
      customer_id: customer?.id ?? null,
      customer_name: customerName,
      customer_gstin: input.customerGstin || customer?.gstin || '',
      bill_date: input.billDate,
      subtotal_paise: totals.subtotal,
      discount_paise: totals.discount,
      taxable_paise: totals.taxable,
      cgst_paise: totals.cgst,
      sgst_paise: totals.sgst,
      round_off_paise: totals.roundOff,
      total_paise: totals.total,
      gst_inclusive: inclusive ? 1 : 0,
      paid_paise: paid,
      credit_paise: credit,
      rate_pending: 0,
      // A price typed by the Entry person is something the Owner should see (REP-4).
      needs_review: oneOffCount > 0 && !input.estimate && !can(user.role, 'price.set') ? 1 : 0,
      paper_ref: input.paperRef,
      converted_to: null,
      cancel_reason: '',
      cancelled_by: null,
      cancelled_at: null,
      created_by: user.id,
      created_at: nowIso(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  let ratePending = false;
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    const t = totals.lines[i];
    const baseMilli = toBase(r.l.qtyMilli, r.unit.factor_milli);
    await tx
      .insertInto('bill_lines')
      .values({
        bill_id: bill.id,
        product_id: r.product.id,
        unit_id: r.unit.id,
        name_en: r.product.name_en,
        name_hi: r.product.name_hi,
        unit_name: r.unit.name,
        factor_milli: r.unit.factor_milli,
        hsn: r.product.hsn,
        qty_milli: r.l.qtyMilli,
        rate_paise: r.rate,
        official_rate_paise: r.official,
        gst_bp: t.gstBp,
        amount_paise: t.amount,
        discount_paise: t.discount,
        taxable_paise: t.taxable,
        cgst_paise: t.cgst,
        sgst_paise: t.sgst,
        base_milli: baseMilli,
        price_override: r.oneOff ? 1 : 0,
      })
      .execute();
    if (input.estimate) continue;
    await addStock(tx, user, r.product.id, -baseMilli, 'sale', bill.id, input.billDate, r.unit.id, r.l.qtyMilli);
    if (r.rate !== r.official && !r.oneOff) {
      const res = await changeRate(tx, user, r.unit.id, list, r.rate, input.billDate, 'bill', bill.id);
      if (res === 'requested') ratePending = true;
    }
  }
  if (ratePending) await tx.updateTable('bills').set({ rate_pending: 1 }).where('id', '=', bill.id).execute();

  if (!input.estimate) {
    if (paid > 0) {
      await insertPayment(tx, user, {
        customerId: customer?.id ?? null,
        billId: bill.id,
        date: input.billDate,
        parts: input.payments,
        note: `Paid on ${number}`,
        atBilling: true,
      });
    }
    if (customer) {
      await ledgerEntry(tx, user, { customerId: customer.id, date: input.billDate, kind: 'bill', refType: 'bill', refId: bill.id, debit: totals.total, credit: 0, note: number });
      if (paid > 0) {
        await ledgerEntry(tx, user, {
          customerId: customer.id,
          date: input.billDate,
          kind: 'payment',
          refType: 'bill',
          refId: bill.id,
          debit: 0,
          credit: paid,
          note: `Paid on ${number} · ${describeParts(input.payments)}`,
        });
      }
    }
  }

  await saveVersion(tx, 'bill', bill.id, { ...input, number, total: totals.total }, opts.fromEstimateId ? 'Converted from estimate' : 'Created', user.id);
  await logActivity(
    tx,
    user.id,
    'create',
    input.estimate ? 'estimate' : 'bill',
    bill.id,
    `${input.estimate ? 'Estimate' : 'Bill'} ${number} · ${customerName || 'Walk-in'} · ${formatRupees(totals.total)}${credit > 0 ? ` (${formatRupees(credit)} on credit)` : ''}${ratePending ? ' · rate awaiting approval' : ''}${oneOffCount ? ` · own price on ${oneOffCount} item${oneOffCount > 1 ? 's' : ''}` : ''}`,
  );
  return { id: bill.id, number, total: totals.total, credit, ratePending };
}

/** Cancel with a reason (BILL-6): stock comes back, ledger and payments are reversed; the number stays. */
export async function cancelBill(tx: Tx, user: User, billId: number, reason: string, date: string) {
  if (!reason.trim()) throw bad('Give a reason for cancelling');
  const bill = await tx.selectFrom('bills').selectAll().where('id', '=', billId).executeTakeFirst();
  if (!bill) throw notFound('Bill');
  if (bill.status === 'cancelled') throw new HttpError(409, 'This bill is already cancelled', 'conflict');
  if (bill.status !== 'active') throw bad('Only saved bills can be cancelled');
  const lines = await tx.selectFrom('bill_lines').selectAll().where('bill_id', '=', billId).execute();
  for (const l of lines) await addStock(tx, user, l.product_id, l.base_milli, 'sale_cancel', billId, date, l.unit_id, l.qty_milli);

  const payments = await tx.selectFrom('payments').selectAll().where('bill_id', '=', billId).where('reversed', '=', 0).where('reversal_of', 'is', null).execute();
  for (const p of payments) await reversePaymentRows(tx, user, p.id, `Bill ${bill.number} cancelled`, date);

  if (bill.customer_id) {
    await ledgerEntry(tx, user, {
      customerId: bill.customer_id,
      date,
      kind: 'cancel',
      refType: 'bill',
      refId: billId,
      debit: 0,
      credit: bill.total_paise,
      note: `Cancelled ${bill.number}: ${reason}`,
    });
  }
  await tx
    .updateTable('bills')
    .set({ status: 'cancelled', cancel_reason: reason, cancelled_by: user.id, cancelled_at: nowIso() })
    .where('id', '=', billId)
    .execute();
  await tx.updateTable('rate_requests').set({ status: 'rejected', decided_by: user.id, decided_at: nowIso() }).where('bill_id', '=', billId).where('status', '=', 'pending').execute();
  await saveVersion(tx, 'bill', billId, { status: 'cancelled', reason }, `Cancelled: ${reason}`, user.id);
  await logActivity(tx, user.id, 'cancel', 'bill', billId, `Cancelled ${bill.number} (${formatRupees(bill.total_paise)}): ${reason}`);
}

async function reversePaymentRows(tx: Tx, user: User, paymentId: number, reason: string, date: string) {
  const p = await tx.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
  if (!p) throw notFound('Payment');
  if (p.reversed || p.reversal_of) throw new HttpError(409, 'This payment is already reversed', 'conflict');
  const parts = await tx.selectFrom('payment_parts').selectAll().where('payment_id', '=', paymentId).execute();
  const revId = await insertPayment(tx, user, {
    customerId: p.customer_id,
    billId: p.bill_id,
    date,
    parts: parts.map((x) => ({ mode: x.mode, amountPaise: -x.amount_paise, reference: x.reference })),
    note: `Reversal: ${reason}`,
    reversalOf: p.id,
  });
  await tx.updateTable('payments').set({ reversed: 1 }).where('id', '=', p.id).execute();
  if (p.customer_id) {
    await ledgerEntry(tx, user, {
      customerId: p.customer_id,
      date,
      kind: 'reversal',
      refType: 'payment',
      refId: p.id,
      debit: p.total_paise,
      credit: 0,
      note: `Payment reversed: ${reason}`,
    });
  }
  return revId;
}

/** Corrections only by reversal (LED-4). */
export async function reversePayment(tx: Tx, user: User, paymentId: number, reason: string, date: string) {
  if (!reason.trim()) throw bad('Give a reason');
  await reversePaymentRows(tx, user, paymentId, reason, date);
  await logActivity(tx, user.id, 'reverse', 'payment', paymentId, `Reversed payment #${paymentId}: ${reason}`);
}

/**
 * After an Owner rejects a rate and sets their own (RATE-6, Q6), the bill is corrected:
 * the lines take the Owner's rate, totals are worked out again, and any difference goes
 * on the customer's ledger as a correction entry. The old version stays in history.
 */
export async function correctBillRate(tx: Tx, user: User, billId: number, unitId: number, newRate: number, reason: string) {
  const bill = await tx.selectFrom('bills').selectAll().where('id', '=', billId).executeTakeFirst();
  if (!bill || bill.status !== 'active') return;
  const lines = await tx.selectFrom('bill_lines').selectAll().where('bill_id', '=', billId).orderBy('id').execute();
  if (!lines.some((l) => l.unit_id === unitId && !l.price_override)) return;
  const settings = await getSettings(tx);
  const scheme = schemeOn(settings, bill.bill_date);
  const nextLines = lines.map((l) => (l.unit_id === unitId && !l.price_override ? { ...l, rate_paise: newRate } : l));
  const discount = bill.discount_paise > 0 ? { type: 'amount' as const, value: bill.discount_paise } : null;
  const totals = computeBill(
    nextLines.map((l) => ({ qtyMilli: l.qty_milli, ratePaise: l.rate_paise, gstBp: l.gst_bp })),
    { scheme, kind: bill.kind, discount, inclusive: bill.gst_inclusive === 1 },
  );
  await saveVersion(tx, 'bill', billId, { lines, total: bill.total_paise }, `Before correction: ${reason}`, user.id);
  for (let i = 0; i < nextLines.length; i++) {
    const t = totals.lines[i];
    await tx
      .updateTable('bill_lines')
      .set({ rate_paise: nextLines[i].rate_paise, amount_paise: t.amount, discount_paise: t.discount, taxable_paise: t.taxable, cgst_paise: t.cgst, sgst_paise: t.sgst, gst_bp: t.gstBp })
      .where('id', '=', nextLines[i].id)
      .execute();
  }
  const delta = totals.total - bill.total_paise;
  await tx
    .updateTable('bills')
    .set({
      subtotal_paise: totals.subtotal,
      discount_paise: totals.discount,
      taxable_paise: totals.taxable,
      cgst_paise: totals.cgst,
      sgst_paise: totals.sgst,
      round_off_paise: totals.roundOff,
      total_paise: totals.total,
      credit_paise: bill.customer_id ? bill.credit_paise + delta : bill.credit_paise,
      needs_review: bill.customer_id ? bill.needs_review : 1,
    })
    .where('id', '=', billId)
    .execute();
  if (bill.customer_id && delta !== 0) {
    await ledgerEntry(tx, user, {
      customerId: bill.customer_id,
      date: bill.bill_date,
      kind: 'correction',
      refType: 'bill',
      refId: billId,
      debit: delta > 0 ? delta : 0,
      credit: delta < 0 ? -delta : 0,
      note: `Rate correction on ${bill.number}`,
    });
  }
  await logActivity(tx, user.id, 'correct', 'bill', billId, `Corrected ${bill.number}: ${formatRupees(bill.total_paise)} → ${formatRupees(totals.total)} (${reason})`);
}
