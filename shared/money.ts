// Amounts are whole paise (integers). Quantities are thousandths of a unit ("milli"):
// 2.5 kg = 2500, 3 pieces = 3000. GST rates are basis points: 5% = 500.

export type Paise = number;

/** ₹1,00,000.00 — Indian digit grouping. */
export function formatRupees(paise: Paise, opts: { decimals?: boolean; sign?: boolean } = {}): string {
  const decimals = opts.decimals ?? true;
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const s = rupees.toString();
  let grouped = s;
  if (s.length > 3) {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  const body = decimals ? `${grouped}.${p.toString().padStart(2, '0')}` : grouped;
  const sign = neg ? '−' : opts.sign && paise > 0 ? '+' : '';
  return `${sign}₹${body}`;
}

/** Parse "1,250.50" / "1250" / "₹45" into paise. Returns NaN on garbage. */
export function parseRupees(input: string | number): Paise {
  if (typeof input === 'number') return Math.round(input * 100);
  const cleaned = input.replace(/[₹,\s]/g, '').replace('−', '-');
  if (!/^-?\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === '' || cleaned === '-') return NaN;
  return Math.round(parseFloat(cleaned) * 100);
}

/** Parse "2.5" into milli units (2500). */
export function parseQty(input: string | number): number {
  if (typeof input === 'number') return Math.round(input * 1000);
  const cleaned = input.replace(/[,\s]/g, '');
  if (!/^-?\d*(\.\d{0,3})?$/.test(cleaned) || cleaned === '' || cleaned === '-') return NaN;
  return Math.round(parseFloat(cleaned) * 1000);
}

/** 2500 -> "2.5", 3000 -> "3". */
export function formatQty(milli: number): string {
  const v = milli / 1000;
  return Number.isInteger(v) ? v.toString() : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Basis points to a percent label: 500 -> "5%", 250 -> "2.5%". */
export function formatRate(bp: number): string {
  return `${formatQty(bp * 10)}%`;
}

/** Round half away from zero, the way people round money by hand. */
export function roundHalfUp(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}
