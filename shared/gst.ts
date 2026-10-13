import { roundHalfUp, type Paise } from './money';

export type GstScheme = 'regular' | 'composition' | 'unregistered';
export type BillKind = 'receipt' | 'tax_invoice' | 'kaccha';

export interface LineInput {
  /** Quantity in the chosen unit, in thousandths (2 bags = 2000). */
  qtyMilli: number;
  /** Rate per chosen unit, before tax, in paise. */
  ratePaise: Paise;
  /** GST rate in basis points (5% = 500). */
  gstBp: number;
}

export interface LineResult {
  amount: Paise; // qty × rate, before discount
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  gstBp: number; // effective rate actually charged (0 when the scheme charges none)
  /** Tax-inclusive rate per unit, for kaccha slips. */
  inclusiveRate: Paise;
}

export interface BillTotals {
  lines: LineResult[];
  subtotal: Paise; // sum of amounts before discount
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  roundOff: Paise;
  total: Paise;
  /** How the bill prints: tax invoice / receipt / kaccha slip / bill of supply / cash memo. */
  printAs: 'tax_invoice' | 'receipt' | 'kaccha' | 'bill_of_supply' | 'cash_memo';
}

export interface Discount {
  type: 'amount' | 'percent';
  /** Paise when type is amount; basis points when percent (10% = 1000). */
  value: number;
}

/**
 * Prices are before tax. GST is worked out per line at the product's rate and split
 * equally into CGST and SGST; the bill total is rounded to the nearest rupee and the
 * round-off is shown. A bill-level discount is applied before tax, spread across
 * lines in proportion to their amounts (BILL-3, BILL-10).
 */
export function computeBill(
  lines: LineInput[],
  opts: { scheme?: GstScheme; kind?: BillKind; discount?: Discount | null } = {},
): BillTotals {
  const scheme = opts.scheme ?? 'regular';
  const kind = opts.kind ?? 'receipt';
  const chargesGst = scheme === 'regular';

  const amounts = lines.map((l) => roundHalfUp((l.qtyMilli * l.ratePaise) / 1000));
  const subtotal = amounts.reduce((a, b) => a + b, 0);

  let discount = 0;
  if (opts.discount && opts.discount.value > 0) {
    discount =
      opts.discount.type === 'amount'
        ? opts.discount.value
        : roundHalfUp((subtotal * opts.discount.value) / 10000);
    discount = Math.min(Math.max(discount, 0), subtotal);
  }

  // Spread the discount across lines; the last non-zero line takes the remainder.
  const lineDiscounts = amounts.map(() => 0);
  if (discount > 0 && subtotal > 0) {
    let left = discount;
    let lastIdx = -1;
    amounts.forEach((a, i) => {
      if (a > 0) lastIdx = i;
    });
    amounts.forEach((a, i) => {
      if (i === lastIdx) return;
      const d = Math.floor((discount * a) / subtotal);
      lineDiscounts[i] = d;
      left -= d;
    });
    if (lastIdx >= 0) lineDiscounts[lastIdx] = left;
  }

  const results: LineResult[] = lines.map((l, i) => {
    const taxable = amounts[i] - lineDiscounts[i];
    const gstBp = chargesGst ? l.gstBp : 0;
    const half = roundHalfUp((taxable * gstBp) / 20000);
    const inclusiveRate = roundHalfUp((l.ratePaise * (10000 + gstBp)) / 10000);
    return { amount: amounts[i], discount: lineDiscounts[i], taxable, cgst: half, sgst: half, gstBp, inclusiveRate };
  });

  const taxable = results.reduce((a, r) => a + r.taxable, 0);
  const cgst = results.reduce((a, r) => a + r.cgst, 0);
  const sgst = results.reduce((a, r) => a + r.sgst, 0);
  const exact = taxable + cgst + sgst;
  const total = Math.round(exact / 100) * 100;

  let printAs: BillTotals['printAs'];
  if (scheme === 'unregistered') printAs = 'cash_memo';
  else if (scheme === 'composition') printAs = 'bill_of_supply';
  else if (kind === 'kaccha') printAs = 'kaccha';
  else if (lines.length > 0 && results.every((r) => r.gstBp === 0)) printAs = 'bill_of_supply';
  else printAs = kind;

  return { lines: results, subtotal, discount, taxable, cgst, sgst, roundOff: total - exact, total, printAs };
}

/** Indian financial year label for a date: 2026-10-12 -> "26-27". */
export function financialYear(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}
