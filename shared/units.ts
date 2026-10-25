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
 * Items sold only as whole packs (a jute sack, a bag, a can of oil, a pouch of ghee).
 * Stock is counted in those packs, not in kg or litres: the kg or litre size is only a label.
 * The shop can add more types when it needs them (stored in settings.pack_types).
 */
export interface PackKindDef {
  value: string; // what is stored on the product: 'bori'
  label: string; // what the dropdown shows
  name: string; // how it starts a unit name: 'Bori 50 kg'
  one: string; // '1 bori'
  many: string; // '3 bori'
}

export const PACK_KINDS: readonly PackKindDef[] = [
  { value: 'bori', label: 'Bori (jute sack)', name: 'Bori', one: 'bori', many: 'bori' },
  { value: 'bag', label: 'Bag', name: 'Bag', one: 'bag', many: 'bags' },
  { value: 'can', label: 'Can', name: 'Can', one: 'can', many: 'cans' },
  { value: 'tin', label: 'Tin', name: 'Tin', one: 'tin', many: 'tins' },
  { value: 'jar', label: 'Jar', name: 'Jar', one: 'jar', many: 'jars' },
  { value: 'pouch', label: 'Pouch', name: 'Pouch', one: 'pouch', many: 'pouches' },
  { value: 'bottle', label: 'Bottle', name: 'Bottle', one: 'bottle', many: 'bottles' },
  { value: 'packet', label: 'Packet', name: 'Packet', one: 'packet', many: 'packets' },
  { value: 'box', label: 'Box', name: 'Box', one: 'box', many: 'boxes' },
  { value: 'pack', label: 'Pack', name: 'Pack', one: 'pack', many: 'packs' },
];
/** Not a pack type of its own: the word used in the products sheet for things sold by the kg or litre. */
export const LOOSE_WORD = 'Loose';
export type PackKind = string; // '' for items that are not whole-pack

const titleCase = (s: string) => s.trim().toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, a: string, c: string) => a + c.toUpperCase());
const plural = (w: string) => (/(s|x|z|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);

/** The definition for a stored pack kind: a built-in one, or one the shop added. */
export function packOf(kind: string | null | undefined): PackKindDef | undefined {
  if (!kind) return undefined;
  return PACK_KINDS.find((k) => k.value === kind) ?? { value: kind, label: titleCase(kind), name: titleCase(kind), one: kind, many: plural(kind) };
}

/** Built-in types plus the ones this shop added, for dropdowns. */
export function allPackKinds(custom: string[]): PackKindDef[] {
  const extra = custom.filter((c) => !PACK_KINDS.some((k) => k.value === c)).map((c) => packOf(c)!);
  return [...PACK_KINDS, ...extra];
}

/** Match what someone typed ("Bag", "bags", "BORI") to a stored kind; undefined if it is not in the list. */
export function findPackKind(word: string, custom: string[]): PackKindDef | undefined {
  const w = word.trim().toLowerCase();
  if (!w) return undefined;
  return allPackKinds(custom).find((k) => [k.value, k.name, k.label, k.one, k.many].some((x) => x.toLowerCase() === w));
}

/** A new pack type's stored form: lower case words, no odd characters. Returns null if it is not usable. */
export function cleanPackKindName(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return /^[a-z][a-z ]{1,19}$/.test(v) && v !== LOOSE_WORD.toLowerCase() ? v : null;
}

const SIZE_UNITS: Record<string, 'kg' | 'g' | 'L' | 'ml' | 'pc'> = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  l: 'L', lt: 'L', ltr: 'L', ltrs: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L',
  ml: 'ml', pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', no: 'pc', nos: 'pc',
};

/** "25kg", "25 KG", "1 ltr", "500ML", "12 pcs" → a clean label ("25 kg", "1 L", "500 ml", "12 pc"), or null. */
export function parsePackSize(s: string): { label: string; qty: number; unit: 'kg' | 'g' | 'L' | 'ml' | 'pc' } | null {
  const m = s.trim().match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/);
  if (!m) return null;
  const unit = SIZE_UNITS[m[2].toLowerCase()];
  const qty = parseFloat(m[1].replace(',', '.'));
  if (!unit || !(qty > 0)) return null;
  return { label: `${qty} ${unit}`, qty, unit };
}

/** The name an item gets when nobody types one: "Sooji — Annapurna 25 kg Bag". The form and the sheet both use it. */
export function derivePackName(p: { family: string; brand: string; packSize: string; packKind: string }): string {
  const kind = packOf(p.packKind)?.name ?? '';
  return [p.family.trim(), p.brand.trim() && `— ${p.brand.trim()}`, p.packSize.trim(), kind].filter(Boolean).join(' ').replace(/^— /, '');
}

/** The base unit's name for a whole-pack item: "Bori 50 kg", "Can 15 L". */
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
