import { formatQty, formatRupees } from '../../shared/money';
import { stockLabel } from '../../shared/units';
import type { CProduct, CUnit } from './state';

export const rs = (p: number | null | undefined, decimals = true) => (p == null ? '—' : formatRupees(p, { decimals }));
/** Whole rupees, compact: ₹14.2k */
export const rsShort = (p: number) => {
  const r = p / 100;
  if (Math.abs(r) >= 100000) return `₹${(r / 100000).toFixed(1)}L`;
  if (Math.abs(r) >= 1000) return `₹${(r / 1000).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
};
export const qty = formatQty;

export const productStock = (p: CProduct) => stockLabel(p.stockMilli, p.baseUnit, p.units);
export const baseUnitOf = (p: CProduct) => p.units.find((u) => u.isBase) ?? p.units[0];
export const unitById = (p: CProduct, id: number | null | undefined) => p.units.find((u) => u.id === id);

/** "10 kg" style reorder label in the unit it was set in. */
export function reorderLabel(p: CProduct): string {
  if (p.reorderMilli == null) return '—';
  const u = unitById(p, p.reorderUnitId) ?? baseUnitOf(p);
  return `${formatQty(Math.round((p.reorderMilli * 1000) / u.factorMilli))} ${u.isBase ? shortBase(p.baseUnit) : u.name}`;
}
export const shortBase = (b: string) => (b === 'pc' ? 'pcs' : b);
export const priceFor = (u: CUnit, list: 'retail' | 'wholesale') => (list === 'wholesale' ? (u.wholesale ?? u.retail) : u.retail);
export const unitShort = (u: CUnit, p: CProduct) => (u.isBase ? shortBase(p.baseUnit).replace('pcs', 'pc') : u.name);

const COLORS = ['#0e7a6e', '#f08a24', '#7b5bd6', '#3466c2', '#d14d72', '#2f9e5c', '#b8721d', '#1f8fa6', '#6a7a2b'];
export function avatarColor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

export const MODES = ['cash', 'upi', 'card', 'bank', 'cheque'] as const;
export type Mode = (typeof MODES)[number];
export const MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', cheque: 'Cheque', credit: 'Credit' };

export const PRINT_AS_LABEL: Record<string, string> = {
  tax_invoice: 'Tax Invoice',
  receipt: 'Receipt',
  kaccha: 'Kaccha slip',
  bill_of_supply: 'Bill of Supply',
  cash_memo: 'Cash memo',
};

export function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}
export function dateTimeOf(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}
