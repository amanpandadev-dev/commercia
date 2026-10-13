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

export function baseLabel(base: BaseUnit, qtyMilli: number): string {
  if (base === 'pc') return `${formatQty(qtyMilli)} pc${Math.abs(qtyMilli) === 1000 ? '' : 's'}`;
  return `${formatQty(qtyMilli)} ${base}`;
}

/**
 * Show stock in the largest whole unit plus the remainder (UNIT-5):
 * 607 kg with "Bag 50 kg" -> "12 Bag 50 kg + 7 kg".
 */
export function stockLabel(baseMilli: number, base: BaseUnit, units: UnitDef[]): string {
  const bigger = units
    .filter((u) => u.factorMilli > 1000)
    .sort((a, b) => b.factorMilli - a.factorMilli)
    .find((u) => Math.abs(baseMilli) >= u.factorMilli);
  if (!bigger || baseMilli <= 0) return baseLabel(base, baseMilli);
  const count = Math.floor(baseMilli / bigger.factorMilli);
  const rest = baseMilli - count * bigger.factorMilli;
  const head = `${count} × ${bigger.name}`;
  return rest === 0 ? head : `${head} + ${baseLabel(base, rest)}`;
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
