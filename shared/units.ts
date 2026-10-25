import { formatQty } from './money';

export type BaseUnit = 'kg' | 'L' | 'pc';

export interface UnitDef {
  id?: number;
  name: string;
  /** How many thousandths of the base unit one of this unit holds (Bag 50 kg = 50000). */
  factorMilli: number;
}

/** Convert a quantity in some unit to base-unit milli. 2 bags of 50 kg (2000) -> 100000 (100 kg). */
export function toBase(qtyMilli: number, factorMilli: number): number {
  return Math.round((qtyMilli * factorMilli) / 1000);
}

/**
 * Items sold only as whole packs (a jute sack, a bag, a tin of ghee, a pouch of oil).
 * Stock is counted in those packs, not in kg or litres: the kg or litre size is only a label.
 */
export const PACK_KINDS = [
  { value: 'bori', label: 'Bori (jute sack)', name: 'Bori', one: 'bori', many: 'bori' },
  { value: 'bag', label: 'Bag', name: 'Bag', one: 'bag', many: 'bags' },
  { value: 'tin', label: 'Tin', name: 'Tin', one: 'tin', many: 'tins' },
  { value: 'jar', label: 'Jar', name: 'Jar', one: 'jar', many: 'jars' },
  { value: 'pouch', label: 'Pouch', name: 'Pouch', one: 'pouch', many: 'pouches' },
  { value: 'bottle', label: 'Bottle', name: 'Bottle', one: 'bottle', many: 'bottles' },
  { value: 'pack', label: 'Pack', name: 'Pack', one: 'pack', many: 'packs' },
] as const;
export type PackKind = '' | (typeof PACK_KINDS)[number]['value'];

const packOf = (kind: string | null | undefined) => PACK_KINDS.find((k) => k.value === kind);

/** The base unit's name for a whole-pack item: "Bori 50 kg", "Tin 15 L". */
export function packUnitName(kind: PackKind, size: string): string {
  const k = packOf(kind);
  return k ? `${k.name}${size.trim() ? ` ${size.trim()}` : ''}` : 'pc';
}

/** A carton is just a bigger unit: "Carton (12 × 1 L)" when the pack size is known, else "Carton of 12". */
export function cartonUnitName(count: number, packSize: string): string {
  return packSize.trim() ? `Carton (${count} × ${packSize.trim()})` : `Carton of ${count}`;
}

export function baseLabel(base: BaseUnit, qtyMilli: number, kind?: PackKind | string | null): string {
  const k = base === 'pc' ? packOf(kind) : undefined;
  if (k) return `${formatQty(qtyMilli)} ${Math.abs(qtyMilli) === 1000 ? k.one : k.many}`;
  if (base === 'pc') return `${formatQty(qtyMilli)} pc${Math.abs(qtyMilli) === 1000 ? '' : 's'}`;
  return `${formatQty(qtyMilli)} ${base}`;
}

/**
 * Show stock in the largest whole unit plus the remainder (UNIT-5):
 * 607 kg with "Bag 50 kg" -> "12 Bag 50 kg + 7 kg".
 */
export function stockLabel(baseMilli: number, base: BaseUnit, units: UnitDef[], kind?: PackKind | string | null): string {
  const bigger = units
    .filter((u) => u.factorMilli > 1000)
    .sort((a, b) => b.factorMilli - a.factorMilli)
    .find((u) => Math.abs(baseMilli) >= u.factorMilli);
  if (!bigger || baseMilli <= 0) return baseLabel(base, baseMilli, kind);
  const count = Math.floor(baseMilli / bigger.factorMilli);
  const rest = baseMilli - count * bigger.factorMilli;
  const head = `${count} × ${bigger.name}`;
  return rest === 0 ? head : `${head} + ${baseLabel(base, rest, kind)}`;
}

/** Parse the template's extra-units cell: "Bag 50 kg = 50; Bag 25 kg = 25". */
export function parseExtraUnits(cell: string): { units: UnitDef[]; error?: string } {
  const units: UnitDef[] = [];
  for (const part of cell.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(.+?)\s*=\s*([\d.]+)$/);
    if (!m) return { units, error: `Can't read unit "${part}" (use "Bag 50 kg = 50")` };
    const factor = Math.round(parseFloat(m[2]) * 1000);
    if (!(factor > 0)) return { units, error: `Bad size in "${part}"` };
    units.push({ name: m[1].trim(), factorMilli: factor });
  }
  return { units };
}
