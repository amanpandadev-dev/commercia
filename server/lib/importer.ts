// Spreadsheet import (IMP-1..9, MIG-1..5): read → preview (New / Update / Error) → confirm in one step → undo.
import type { Tx } from './core';
import { HttpError, logActivity, saveVersion } from './core';
import { nowIso } from '../db/index';
import { categoryPaths, customerBalances, gstOn, priceOn, snapshotProduct, stockMap } from './catalog';
import { ledgerEntry } from './billing';
import { saveStockIn } from '../routes/stock';
import { parseRupees, parseQty, formatRupees } from '../../shared/money';
import { PACK_KINDS, packUnitName, parseExtraUnits, type PackKind, type UnitDef } from '../../shared/units';
import { formatDate, isIsoDate, istDate } from '../../shared/dates';
import type { User } from '../db/schema';

export type ImportKind = 'products' | 'stock' | 'customers';

interface FieldDef {
  key: string;
  header: string;
  required?: boolean;
  aliases: string[];
  help: string;
  /** Columns that only matter for whole-pack items (bori, bag, tin…): shaded in the template. */
  wholePack?: boolean;
}

export const FIELDS: Record<ImportKind, FieldDef[]> = {
  products: [
    { key: 'category', header: 'Category path', required: true, aliases: ['category path', 'category', 'group'], help: 'Where it sits in the shop. Levels are separated by ">", e.g. Sugar > Loose, Oil > Fortune, Bori. Categories that do not exist yet are created.' },
    { key: 'name', header: 'Product name', required: true, aliases: ['product name', 'product', 'item', 'item name', 'name'], help: 'The name staff will search for, in English. For packed items include the company and size: "Sooji — Annapurna 25 kg", "Tea 250g".' },
    { key: 'nameHi', header: 'Hindi name', aliases: ['hindi name', 'hindi', 'naam'], help: 'Optional. Type it in Hindi (Unicode). Text typed in an old Kruti Dev font will not show correctly.' },
    { key: 'brand', header: 'Brand', aliases: ['brand', 'company'], help: 'The company. For bori / bag / tin / pouch items, fill it in: each company gets its own row in the Stock summary.' },
    { key: 'packKind', header: 'Pack type', wholePack: true, aliases: ['pack type', 'packing', 'pack kind'], help: 'ONLY for items sold whole, never loose: Bori, Bag, Tin, Jar, Pouch, Bottle or Pack. Leave empty for loose items and ordinary packets.' },
    { key: 'packSize', header: 'Pack size', wholePack: true, aliases: ['pack size', 'size', 'weight'], help: 'ONLY for whole-pack items: the size as a label, e.g. 50 kg, 25 kg, 1 L, 500 ml. It does not change how stock is counted.' },
    { key: 'family', header: 'Item group', wholePack: true, aliases: ['item group', 'item family', 'item (family)', 'family'], help: 'ONLY for whole-pack items: the plain item the pack belongs to, e.g. Sooji, Sugar, Ghee, Refined Oil. Packs of one item line up under one heading in the Stock summary.' },
    { key: 'baseUnit', header: 'Base unit', aliases: ['base unit', 'unit', 'uom'], help: 'kg or L for loose items, pc for packets. Leave EMPTY when Pack type is filled in (those are counted in packs).' },
    { key: 'units', header: 'Extra units', aliases: ['extra units', 'bags', 'pack sizes'], help: 'Optional bigger units, written "Name = how many base units" and separated by ";". Examples: Bag 50 kg = 50 (kg items), Box of 12 = 12 (packets), Carton (12 × 1 L) = 12 (pouches).' },
    { key: 'price', header: 'Selling price per unit', required: true, aliases: ['selling price per unit', 'selling price', 'price', 'rate', 'mrp', 'sale price'], help: 'The shelf price of ONE base unit: one kg, one packet, or one bori / bag / pouch. GST is included unless you turned that off in Settings.' },
    { key: 'unitPrices', header: 'Extra unit prices', aliases: ['extra unit prices', 'bag prices', 'unit prices'], help: 'Optional. Own price for each extra unit, written like Extra units: Bag 50 kg = 2150; Box of 12 = 1500.' },
    { key: 'wholesale', header: 'Wholesale price per unit', aliases: ['wholesale price per unit', 'wholesale price', 'wholesale'], help: 'Optional. Price of one base unit for wholesale customers.' },
    { key: 'gst', header: 'GST %', required: true, aliases: ['gst %', 'gst', 'gst rate', 'tax', 'tax %'], help: '0, 5, 12, 18 or 28 (whatever your accountant says).' },
    { key: 'hsn', header: 'HSN code', aliases: ['hsn code', 'hsn'], help: 'Optional, shown on bills and the GST summary.' },
    { key: 'reorder', header: 'Reorder level', aliases: ['reorder level', 'reorder', 'min stock', 'minimum'], help: 'Optional. Quantity and unit, e.g. "20 Bag 50 kg"; or just "10" for the base unit (packs, for bori / bag items).' },
    { key: 'opening', header: 'Opening stock', aliases: ['opening stock', 'stock', 'qty', 'quantity', 'current stock'], help: 'Optional, new items only. Quantity and unit, e.g. "12 Bag 50 kg"; or just "607" for the base unit. For bori / bag items just the number of packs, e.g. "6".' },
    { key: 'cost', header: 'Purchase rate per base unit', aliases: ['purchase rate per base unit', 'purchase rate', 'cost', 'cost price', 'purchase price'], help: 'Optional. What one base unit costs you. Used to value opening stock and losses.' },
    { key: 'type', header: 'Type', aliases: ['type', 'variety'], help: 'Optional, e.g. mustard, sunflower.' },
    { key: 'code', header: 'Code', aliases: ['code', 'item code', 'sku', 'barcode'], help: 'Optional. Your own item code; used to match items when you upload again.' },
    { key: 'aliases', header: 'Aliases', aliases: ['aliases', 'other names', 'search names'], help: 'Optional. Other spellings people type, separated by commas: chini, cheeni.' },
  ],
  stock: [
    { key: 'date', header: 'Date', required: true, aliases: ['date', 'bill date'], help: 'YYYY-MM-DD or DD-MM-YYYY.' },
    { key: 'supplier', header: 'Supplier', aliases: ['supplier', 'vendor', 'party'], help: 'Optional. A new name creates a supplier. Old deliveries are treated as paid, so nothing is added to what you owe.' },
    { key: 'product', header: 'Code or Product name', required: true, aliases: ['code or product name', 'product', 'item', 'item name', 'code', 'name'], help: 'Must match an item already in Commercia.' },
    { key: 'qty', header: 'Quantity', required: true, aliases: ['quantity', 'qty'], help: 'How many of the unit below.' },
    { key: 'unit', header: 'Unit', required: true, aliases: ['unit', 'uom'], help: 'kg / L / pc, one of the item\'s extra units (Bag 50 kg, Carton (12 × 1 L)), or for a bori / bag / tin / pouch item just "bori", "bag"… ' },
    { key: 'rate', header: 'Purchase rate per unit', required: true, aliases: ['purchase rate per unit', 'purchase rate', 'rate', 'cost', 'price'], help: 'Price paid for ONE of that unit.' },
  ],
  customers: [
    { key: 'name', header: 'Name', required: true, aliases: ['name', 'customer', 'customer name', 'party'], help: 'Customer name.' },
    { key: 'amount', header: 'Amount owed', required: true, aliases: ['amount owed', 'amount', 'due', 'balance', 'udhaar', 'baaki'], help: 'What they owe today. Negative = they paid in advance.' },
    { key: 'nickname', header: 'Nickname', aliases: ['nickname', 'nick'], help: 'Optional. Tells two people with the same name apart.' },
    { key: 'phone', header: 'Phone', aliases: ['phone', 'mobile', 'phone number'], help: 'Optional.' },
    { key: 'area', header: 'Area', aliases: ['area', 'locality', 'address'], help: 'Optional.' },
    { key: 'gstin', header: 'GSTIN', aliases: ['gstin', 'gst no', 'gst number'], help: 'Optional, for business buyers.' },
    { key: 'priceList', header: 'Price list', aliases: ['price list', 'customer type'], help: 'Optional: retail or wholesale.' },
  ],
};

/**
 * The rows shown in the downloadable templates. They are real: the tests import them, so a
 * template can never go out with examples that do not work. Keyed by field, so adding a column
 * cannot shift them.
 */
export const EXAMPLES: Record<ImportKind, { what: string; row: Record<string, string> }[]> = {
  products: [
    { what: 'Loose item sold by weight, also in bags', row: { category: 'Sugar > Loose', name: 'Sugar', nameHi: 'चीनी', baseUnit: 'kg', units: 'Bag 50 kg = 50; Bag 25 kg = 25', price: '45', unitPrices: 'Bag 50 kg = 2150; Bag 25 kg = 1090', wholesale: '43', gst: '5', hsn: '1701', reorder: '10', opening: '6 Bag 50 kg', cost: '40', aliases: 'chini, cheeni' } },
    { what: 'Packet sold singly and by the box', row: { category: 'Tea', name: 'Tea 250g', nameHi: 'चाय', brand: 'Tata', baseUnit: 'pc', units: 'Box of 12 = 12', price: '130', unitPrices: 'Box of 12 = 1500', gst: '5', hsn: '0902', reorder: '8', opening: '4 Box of 12', cost: '112', aliases: 'chai' } },
    { what: 'Bori: sold whole, one product per company and size', row: { category: 'Bori', name: 'Sugar — Dhampur 50 kg', brand: 'Dhampur', packKind: 'Bori', packSize: '50 kg', family: 'Sugar', price: '2150', gst: '5', opening: '6', cost: '2000' } },
    { what: 'Bag: sold whole, a different company', row: { category: 'Bag', name: 'Sooji — Annapurna 25 kg', brand: 'Annapurna', packKind: 'Bag', packSize: '25 kg', family: 'Sooji', price: '1150', gst: '5', opening: '8', cost: '1050' } },
    { what: 'Pouch sold singly and by the carton', row: { category: 'Refined Oil', name: 'Refined Oil — Fortune 1 L', brand: 'Fortune', packKind: 'Pouch', packSize: '1 L', family: 'Refined Oil', units: 'Carton (12 × 1 L) = 12', price: '150', unitPrices: 'Carton (12 × 1 L) = 1740', gst: '5', hsn: '1514', opening: '40', cost: '140' } },
    { what: 'Tin: sold whole', row: { category: 'Ghee', name: 'Ghee — Amul 15 L', brand: 'Amul', packKind: 'Tin', packSize: '15 L', family: 'Ghee', price: '9100', gst: '5', opening: '2', cost: '8600' } },
  ],
  // These refer to the product examples above, so import those first.
  stock: [
    { what: 'Loose item, bought by the bag', row: { date: istDate(), supplier: 'Gupta Traders', product: 'Sugar', qty: '10', unit: 'Bag 50 kg', rate: '2000' } },
    { what: 'Packet, bought by the box', row: { date: istDate(), supplier: 'Gupta Traders', product: 'Tea 250g', qty: '4', unit: 'Box of 12', rate: '1344' } },
    { what: 'Bori: just say bori', row: { date: istDate(), supplier: 'Dhampur Sugar', product: 'Sugar — Dhampur 50 kg', qty: '6', unit: 'Bori', rate: '2000' } },
    { what: 'Pouches, bought by the carton', row: { date: istDate(), supplier: 'Fortune Dealer', product: 'Refined Oil — Fortune 1 L', qty: '5', unit: 'Carton (12 × 1 L)', rate: '1680' } },
  ],
  customers: [
    { what: 'A customer who owes money', row: { name: 'Sunita Devi', amount: '1250', phone: '9800004521', area: 'Naka' } },
    { what: 'Two people with the same name: tell them apart', row: { name: 'Ramesh', amount: '300', nickname: 'Dudhwala', area: 'Chowk' } },
    { what: 'Paid in advance: negative amount', row: { name: 'Pooja Gupta', amount: '-500', phone: '9721055566' } },
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

/** Match the file's own headers to the template's fields (IMP-8, by known names). */
export function mapHeaders(kind: ImportKind, headers: string[]): { map: (string | null)[]; missing: string[] } {
  const fields = FIELDS[kind];
  const used = new Set<string>();
  const map = headers.map((h) => {
    const n = norm(h);
    const f = fields.find((f) => !used.has(f.key) && (norm(f.header) === n || f.aliases.includes(n)));
    if (f) used.add(f.key);
    return f?.key ?? null;
  });
  return { map, missing: fields.filter((f) => f.required && !used.has(f.key)).map((f) => f.header) };
}

export type RowData = Record<string, string>;
export interface PreviewRow {
  rowNo: number;
  data: RowData;
  status: 'new' | 'update' | 'same' | 'error';
  errors: string[];
  notes: string[];
}

function parseDate(s: string): string | null {
  const t = s.trim();
  if (isIsoDate(t)) return t;
  const m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  }
  return null;
}

/** "12 Bag 50 kg" / "607" / "2.5 kg" → qty in that unit. */
function parseQtyUnit(s: string): { qtyMilli: number; unit: string | null } | null {
  const m = s.trim().match(/^(-?[\d.,]+)\s*(.*)$/);
  if (!m) return null;
  const q = parseQty(m[1]);
  if (Number.isNaN(q)) return null;
  return { qtyMilli: q, unit: m[2].trim() || null };
}

const BASE_ALIASES: Record<string, 'kg' | 'L' | 'pc'> = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilogram: 'kg', l: 'L', ltr: 'L', litre: 'L', liter: 'L', lt: 'L', pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', nos: 'pc', no: 'pc', unit: 'pc',
};

interface ParsedProduct {
  code: string | null;
  path: string[];
  name: string;
  nameHi: string;
  brand: string;
  type: string;
  family: string;
  packKind: PackKind;
  packSize: string;
  baseUnit: 'kg' | 'L' | 'pc';
  units: (UnitDef & { price: number | null })[];
  price: number;
  wholesale: number | null;
  gstBp: number;
  hsn: string;
  reorder: { qtyMilli: number; unit: string } | null;
  opening: { qtyMilli: number; unit: string } | null;
  cost: number | null;
  aliases: string;
}

function parseProductRow(d: RowData, errors: string[]): ParsedProduct | null {
  const name = (d.name ?? '').trim();
  if (!name) errors.push('Missing product name');
  const path = (d.category ?? '').split(/>|»|\//).map((s) => s.trim()).filter(Boolean);
  if (!path.length) errors.push('Missing category path');
  const kindWord = (d.packKind ?? '').trim().toLowerCase();
  const packKind = (PACK_KINDS.find((k) => k.value === kindWord || k.one === kindWord || k.many === kindWord)?.value ?? '') as PackKind;
  if (kindWord && !packKind) errors.push(`Pack type must be one of ${PACK_KINDS.map((k) => k.name).join(', ')} (got "${d.packKind}")`);
  // Whole-pack items are counted in packs, so their base unit is always pc.
  const baseUnit = packKind ? 'pc' : BASE_ALIASES[(d.baseUnit ?? '').trim().toLowerCase()];
  if (!baseUnit) errors.push(`Base unit must be kg, L or pc (got "${d.baseUnit ?? ''}")`);
  const price = parseRupees(d.price ?? '');
  if (!d.price?.trim()) errors.push('Missing price');
  else if (Number.isNaN(price) || price < 0) errors.push(`Bad number in price: "${d.price}"`);
  const wholesale = d.wholesale?.trim() ? parseRupees(d.wholesale) : null;
  if (wholesale != null && Number.isNaN(wholesale)) errors.push(`Bad number in wholesale price: "${d.wholesale}"`);
  const gstRaw = (d.gst ?? '').replace('%', '').trim();
  const gstPct = Number(gstRaw);
  if (!gstRaw) errors.push('Missing GST %');
  else if (Number.isNaN(gstPct) || ![0, 0.25, 3, 5, 12, 18, 28, 40].includes(gstPct)) errors.push(`Unknown GST rate "${d.gst}"`);
  const extra = parseExtraUnits(d.units ?? '');
  if (extra.error) errors.push(extra.error);
  const unitPrices = parseExtraUnits(d.unitPrices ?? '');
  if (unitPrices.error) errors.push(unitPrices.error.replace('Bad size', 'Bad price'));
  const units: ParsedProduct['units'] = extra.units.map((u) => {
    const p = unitPrices.units.find((x) => x.name.toLowerCase() === u.name.toLowerCase());
    return { ...u, price: p ? p.factorMilli / 10 : null }; // factorMilli of "= 2150" is 2150000 → paise 215000
  });
  for (const p of unitPrices.units) if (!units.some((u) => u.name.toLowerCase() === p.name.toLowerCase())) errors.push(`Price given for unknown unit "${p.name}"`);
  const unitNames = new Set([baseUnit?.toLowerCase(), ...units.map((u) => u.name.toLowerCase())]);
  let reorder: ParsedProduct['reorder'] = null;
  if (d.reorder?.trim()) {
    const r = parseQtyUnit(d.reorder);
    if (!r) errors.push(`Bad reorder level "${d.reorder}"`);
    else if (r.unit && !unitNames.has(r.unit.toLowerCase())) errors.push(`Reorder unit "${r.unit}" isn't one of this item's units`);
    else reorder = { qtyMilli: r.qtyMilli, unit: r.unit ?? baseUnit };
  }
  let opening: ParsedProduct['opening'] = null;
  if (d.opening?.trim()) {
    const r = parseQtyUnit(d.opening);
    if (!r || r.qtyMilli < 0) errors.push(`Bad opening stock "${d.opening}"`);
    else if (r.unit && !unitNames.has(r.unit.toLowerCase())) errors.push(`Opening stock unit "${r.unit}" isn't one of this item's units`);
    else opening = { qtyMilli: r.qtyMilli, unit: r.unit ?? baseUnit };
  }
  const cost = d.cost?.trim() ? parseRupees(d.cost) : null;
  if (cost != null && Number.isNaN(cost)) errors.push(`Bad number in purchase rate: "${d.cost}"`);
  if (errors.length) return null;
  return {
    code: d.code?.trim() || null,
    path,
    name,
    nameHi: d.nameHi?.trim() ?? '',
    brand: d.brand?.trim() ?? '',
    type: d.type?.trim() ?? '',
    family: d.family?.trim() ?? '',
    packKind,
    packSize: d.packSize?.trim() ?? '',
    baseUnit,
    units,
    price,
    wholesale,
    gstBp: Math.round(gstPct * 100),
    hsn: d.hsn?.trim() ?? '',
    reorder,
    opening,
    cost,
    aliases: d.aliases?.trim() ?? '',
  };
}

interface UnitRef {
  id: number;
  product_id: number;
  name: string;
  is_base: number;
}

/**
 * The unit a stock row means: its exact name, kg / L / pc, or — for a bori, bag, tin or pouch item —
 * just the word ("bori", "bags"), which stands for one whole pack.
 */
function findUnit(units: UnitRef[], product: { id: number; base_unit: string; pack_kind: string }, word: string): UnitRef | undefined {
  const w = word.trim().toLowerCase();
  const own = units.filter((u) => u.product_id === product.id);
  const exact = own.find((u) => u.name.toLowerCase() === w || BASE_ALIASES[w] === u.name);
  if (exact) return exact;
  const kind = PACK_KINDS.find((k) => k.value === product.pack_kind);
  if (kind && (w === kind.value || w === kind.one || w === kind.many || BASE_ALIASES[w] === 'pc')) return own.find((u) => u.is_base === 1);
  return undefined;
}

async function findCategory(tx: Tx, path: string[]): Promise<number | null> {
  const paths = await categoryPaths(tx);
  const want = path.map((p) => p.toLowerCase()).join('>');
  for (const [id, p] of paths) if (p.en.map((x) => x.toLowerCase()).join('>') === want) return id;
  return null;
}

async function productState(tx: Tx, productId: number, date: string) {
  return snapshotProduct(tx, productId, date);
}

/** Validate every row against the current data; nothing is written. */
export async function previewImport(tx: Tx, kind: ImportKind, rows: RowData[], opts: { newOnly?: boolean } = {}) {
  const out: PreviewRow[] = [];
  const newCategories = new Set<string>();
  const today = istDate();
  const paths = await categoryPaths(tx);
  const pathKeys = new Set([...paths.values()].map((p) => p.en.map((x) => x.toLowerCase()).join('>')));

  if (kind === 'products') {
    const products = await tx.selectFrom('products').select(['id', 'code', 'name_en']).execute();
    const seen = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const errors: string[] = [];
      const notes: string[] = [];
      const p = parseProductRow(rows[i], errors);
      let status: PreviewRow['status'] = 'error';
      if (p) {
        const key = p.code ? `code:${p.code.toLowerCase()}` : `name:${p.name.toLowerCase()}`;
        if (seen.has(key)) errors.push(`Duplicate of row ${seen.get(key)}`);
        seen.set(key, i + 2);
        // Missing category levels are created on confirm (IMP-4).
        for (let d = 1; d <= p.path.length; d++) {
          const k2 = p.path.slice(0, d).map((x) => x.toLowerCase()).join('>');
          if (!pathKeys.has(k2)) newCategories.add(p.path.slice(0, d).join(' > '));
        }
        const match = (p.code && products.find((x) => x.code && x.code.toLowerCase() === p.code!.toLowerCase())) || products.find((x) => x.name_en.toLowerCase() === p.name.toLowerCase());
        if (!errors.length) {
          if (!match) status = 'new';
          else {
            const changes = await productChanges(tx, match.id, p, today);
            status = changes.length ? 'update' : 'same';
            notes.push(...changes);
            // Someone who may add items but not change them (the Entry person) cannot slip a price or GST change in through a file.
            if (opts.newOnly && changes.length) errors.push('Already in the list. Only an Owner can change it: remove this row.');
            if (p.opening) notes.push('Opening stock is ignored for existing items — use Stock in');
          }
        }
      }
      out.push({ rowNo: i + 2, data: rows[i], status: errors.length ? 'error' : status, errors, notes });
    }
  } else if (kind === 'stock') {
    const products = await tx.selectFrom('products').select(['id', 'code', 'name_en', 'base_unit', 'pack_kind']).where('active', '=', 1).execute();
    const units = await tx.selectFrom('product_units').select(['id', 'product_id', 'name', 'is_base']).where('active', '=', 1).execute();
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i];
      const errors: string[] = [];
      if (!parseDate(d.date ?? '')) errors.push(`Bad date "${d.date ?? ''}"`);
      const ref = (d.product ?? '').trim().toLowerCase();
      const prod = products.find((p) => p.code?.toLowerCase() === ref) ?? products.find((p) => p.name_en.toLowerCase() === ref);
      if (!ref) errors.push('Missing product');
      else if (!prod) errors.push(`No item called "${d.product}" — add it first`);
      const qty = parseQty(d.qty ?? '');
      if (Number.isNaN(qty) || qty <= 0) errors.push(`Bad quantity "${d.qty ?? ''}"`);
      const rate = parseRupees(d.rate ?? '');
      if (Number.isNaN(rate) || rate < 0) errors.push(`Bad purchase rate "${d.rate ?? ''}"`);
      if (prod) {
        const unit = findUnit(units, prod, d.unit ?? '');
        if (!unit) errors.push(`"${d.unit ?? ''}" isn't a unit of ${prod.name_en}`);
      }
      out.push({ rowNo: i + 2, data: d, status: errors.length ? 'error' : 'new', errors, notes: [] });
    }
  } else {
    const existing = await tx.selectFrom('customers').select(['id', 'name', 'nickname', 'area', 'phone']).where('active', '=', 1).execute();
    const balances = await customerBalances(tx);
    const key = (d: { name: string; nickname?: string; area?: string }) => `${d.name.trim().toLowerCase()}|${(d.nickname ?? '').trim().toLowerCase()}|${(d.area ?? '').trim().toLowerCase()}`;
    const counts = new Map<string, number[]>();
    rows.forEach((d, i) => {
      const k2 = key({ name: d.name ?? '', nickname: d.nickname, area: d.area });
      counts.set(k2, [...(counts.get(k2) ?? []), i + 2]);
    });
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i];
      const errors: string[] = [];
      const notes: string[] = [];
      if (!d.name?.trim()) errors.push('Missing name');
      const amt = parseRupees(d.amount ?? '');
      if (!(d.amount ?? '').trim()) errors.push('Missing amount owed');
      else if (Number.isNaN(amt)) errors.push(`Bad number in amount: "${d.amount}"`);
      if (d.priceList && !['retail', 'wholesale', ''].includes(d.priceList.trim().toLowerCase())) errors.push('Price list must be retail or wholesale');
      const dupRows = counts.get(key({ name: d.name ?? '', nickname: d.nickname, area: d.area })) ?? [];
      // Two "Ramesh" rows can't be saved until they're told apart or merged (MIG-4).
      if (d.name?.trim() && dupRows.length > 1) errors.push(`Same name as row ${dupRows.filter((r) => r !== i + 2).join(', ')} — add a nickname or area, or merge`);
      const match = existing.find((e) => key(e) === key({ name: d.name ?? '', nickname: d.nickname, area: d.area }));
      let status: PreviewRow['status'] = 'new';
      if (match) {
        const hasOpening = await tx.selectFrom('ledger').select('id').where('customer_id', '=', match.id).where('kind', '=', 'opening').executeTakeFirst();
        status = 'update';
        if (hasOpening || (balances.get(match.id) ?? 0) !== 0) notes.push('Already has a balance — only details will be updated');
      } else if (!Number.isNaN(amt) && amt < 0) notes.push(`Advance ${formatRupees(-amt)}`);
      out.push({ rowNo: i + 2, data: d, status: errors.length ? 'error' : status, errors, notes });
    }
  }

  const counts = { new: 0, update: 0, same: 0, error: 0 };
  for (const r of out) counts[r.status]++;
  return { rows: out, counts, newCategories: [...newCategories] };
}

async function productChanges(tx: Tx, productId: number, p: ParsedProduct, date: string): Promise<string[]> {
  const cur = await productState(tx, productId, date);
  const changes: string[] = [];
  const catId = await findCategory(tx, p.path);
  if (catId !== cur.category_id) changes.push('category');
  if (p.nameHi !== cur.name_hi) changes.push('Hindi name');
  if (p.brand !== cur.brand) changes.push('brand');
  if (p.type !== cur.type) changes.push('type');
  if (p.hsn !== cur.hsn) changes.push('HSN');
  if (p.aliases !== cur.aliases) changes.push('aliases');
  if (p.baseUnit !== cur.base_unit) changes.push('base unit (not changed on import)');
  if (p.gstBp !== cur.gst_bp) changes.push(`GST ${cur.gst_bp / 100}% → ${p.gstBp / 100}%`);
  const base = cur.units.find((u) => u.factor === 1 && u.active);
  if (base?.retail !== p.price) changes.push(`price ${formatRupees(base?.retail ?? 0)} → ${formatRupees(p.price)}`);
  if (p.wholesale != null && base?.wholesale !== p.wholesale) changes.push('wholesale price');
  for (const u of p.units) {
    const cu = cur.units.find((x) => x.active && x.name.toLowerCase() === u.name.toLowerCase());
    if (!cu) changes.push(`new unit ${u.name}`);
    else {
      if (Math.round(cu.factor * 1000) !== u.factorMilli) changes.push(`${u.name} size`);
      if (u.price != null && cu.retail !== u.price) changes.push(`${u.name} price`);
    }
  }
  const reorderNow = cur.reorder == null ? null : Math.round(cur.reorder * 1000);
  const reorderNew = p.reorder ? Math.round((p.reorder.qtyMilli * unitFactor(p, p.reorder.unit)) / 1000) : null;
  if (p.reorder && reorderNow !== reorderNew) changes.push('reorder level');
  return changes;
}

function unitFactor(p: ParsedProduct, unit: string): number {
  if (unit.toLowerCase() === p.baseUnit.toLowerCase()) return 1000;
  return p.units.find((u) => u.name.toLowerCase() === unit.toLowerCase())?.factorMilli ?? 1000;
}

interface UndoData {
  createdProducts: number[];
  updatedProducts: { id: number; product: Record<string, unknown> }[];
  addedUnits: number[];
  priceIds: number[];
  gstIds: number[];
  categories: number[];
  createdCustomers: number[];
  updatedCustomers: { id: number; data: Record<string, unknown> }[];
}

/** Saves all rows together, or none if anything fails (IMP-6). */
export async function commitImport(tx: Tx, user: User, kind: ImportKind, rows: RowData[], fileName: string, opts: { asOf?: string; newOnly?: boolean } = {}) {
  const preview = await previewImport(tx, kind, rows, { newOnly: opts.newOnly });
  if (preview.counts.error) throw new HttpError(422, `${preview.counts.error} row(s) still have errors — fix or skip them`, 'import_errors', preview);
  const imp = await tx
    .insertInto('imports')
    .values({ kind, file_name: fileName, summary: '', undone: 0, created_by: user.id, created_at: nowIso() })
    .returning('id')
    .executeTakeFirstOrThrow();
  const undo: UndoData = { createdProducts: [], updatedProducts: [], addedUnits: [], priceIds: [], gstIds: [], categories: [], createdCustomers: [], updatedCustomers: [] };
  const today = istDate();
  const now = nowIso();
  let summary = '';

  if (kind === 'products') {
    const openingLines: { productId: number; unitId: number; qtyMilli: number; ratePaise: number | null }[] = [];
    for (const r of preview.rows) {
      if (r.status === 'same') continue;
      const p = parseProductRow(r.data, [])!;
      // Categories, created on confirm.
      let parent: number | null = null;
      for (let d = 1; d <= p.path.length; d++) {
        let id = await findCategory(tx, p.path.slice(0, d));
        if (!id) {
          const row = await tx.insertInto('categories').values({ parent_id: parent, name_en: p.path[d - 1], name_hi: '', sort: 0 }).returning('id').executeTakeFirstOrThrow();
          id = row.id;
          undo.categories.push(id);
        }
        parent = id;
      }
      const products = await tx.selectFrom('products').selectAll().execute();
      const match = (p.code && products.find((x) => x.code && x.code.toLowerCase() === p.code!.toLowerCase())) || products.find((x) => x.name_en.toLowerCase() === p.name.toLowerCase());
      let productId: number;
      if (!match) {
        const row = await tx
          .insertInto('products')
          .values({
            code: p.code, category_id: parent, name_en: p.name, name_hi: p.nameHi, brand: p.brand, type: p.type, family: p.family, pack_size: p.packSize, pack_kind: p.packKind, hsn: p.hsn, base_unit: p.baseUnit,
            loose: p.baseUnit === 'pc' ? 0 : 1, step_milli: p.baseUnit === 'pc' ? 1000 : 250, reorder_milli: null, reorder_unit_id: null, aliases: p.aliases,
            buy_unit_id: null, sell_unit_id: null, active: 1, created_at: now, updated_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        productId = row.id;
        undo.createdProducts.push(productId);
      } else {
        productId = match.id;
        undo.updatedProducts.push({ id: match.id, product: { ...match } });
        await tx
          .updateTable('products')
          .set({ code: p.code ?? match.code, category_id: parent, name_hi: p.nameHi, brand: p.brand, type: p.type, family: p.family, pack_size: p.packSize, pack_kind: p.packKind, hsn: p.hsn, aliases: p.aliases, updated_at: now, active: 1 })
          .where('id', '=', productId)
          .execute();
      }
      // Units and prices.
      const units = await tx.selectFrom('product_units').selectAll().where('product_id', '=', productId).where('active', '=', 1).execute();
      const unitIds = new Map<string, number>();
      let base = units.find((u) => u.is_base === 1);
      if (!base) {
        const baseName = p.packKind ? packUnitName(p.packKind, p.packSize) : p.baseUnit;
        const id = (await tx.insertInto('product_units').values({ product_id: productId, name: baseName, factor_milli: 1000, is_base: 1, active: 1 }).returning('id').executeTakeFirstOrThrow()).id;
        undo.addedUnits.push(id);
        base = { id, product_id: productId, name: baseName, factor_milli: 1000, is_base: 1, active: 1 };
      }
      unitIds.set(base.name.toLowerCase(), base.id);
      unitIds.set(p.baseUnit.toLowerCase(), base.id);
      const wants: { unitId: number; price: number | null; wholesale: number | null }[] = [{ unitId: base.id, price: p.price, wholesale: p.wholesale }];
      for (const u of p.units) {
        let ex = units.find((x) => x.name.toLowerCase() === u.name.toLowerCase());
        if (!ex) {
          const id = (await tx.insertInto('product_units').values({ product_id: productId, name: u.name, factor_milli: u.factorMilli, is_base: 0, active: 1 }).returning('id').executeTakeFirstOrThrow()).id;
          undo.addedUnits.push(id);
          ex = { id, product_id: productId, name: u.name, factor_milli: u.factorMilli, is_base: 0, active: 1 };
        } else if (ex.factor_milli !== u.factorMilli) {
          await tx.updateTable('product_units').set({ factor_milli: u.factorMilli }).where('id', '=', ex.id).execute();
        }
        unitIds.set(u.name.toLowerCase(), ex.id);
        wants.push({ unitId: ex.id, price: u.price, wholesale: null });
      }
      const priceFrom = match ? today : '2000-01-01';
      for (const w of wants) {
        for (const [list, val] of [['retail', w.price], ['wholesale', w.wholesale]] as const) {
          if (val == null) continue;
          if ((await priceOn(tx, w.unitId, list, today)) === val && list === 'retail') continue;
          if (list === 'wholesale') {
            const cur = await tx.selectFrom('unit_prices').select('price_paise').where('unit_id', '=', w.unitId).where('list', '=', 'wholesale').where('from_date', '<=', today).orderBy('from_date', 'desc').orderBy('id', 'desc').executeTakeFirst();
            if (cur?.price_paise === val) continue;
          }
          const row = await tx
            .insertInto('unit_prices')
            .values({ unit_id: w.unitId, list, price_paise: val, from_date: priceFrom, set_by: user.id, approved_by: user.id, source: 'import', created_at: now })
            .returning('id')
            .executeTakeFirstOrThrow();
          undo.priceIds.push(row.id);
        }
      }
      if (!match || (await gstOn(tx, productId, today)) !== p.gstBp) {
        const row = await tx
          .insertInto('product_gst')
          .values({ product_id: productId, gst_bp: p.gstBp, from_date: match ? today : '2000-01-01', set_by: user.id, created_at: now })
          .returning('id')
          .executeTakeFirstOrThrow();
        undo.gstIds.push(row.id);
      }
      if (p.reorder) {
        const uid = unitIds.get(p.reorder.unit.toLowerCase()) ?? base.id;
        await tx.updateTable('products').set({ reorder_milli: Math.round((p.reorder.qtyMilli * unitFactor(p, p.reorder.unit)) / 1000), reorder_unit_id: uid }).where('id', '=', productId).execute();
      }
      if (!match && p.opening && p.opening.qtyMilli > 0) {
        const uid = unitIds.get(p.opening.unit.toLowerCase()) ?? base.id;
        const factor = unitFactor(p, p.opening.unit);
        openingLines.push({ productId, unitId: uid, qtyMilli: p.opening.qtyMilli, ratePaise: p.cost != null ? Math.round((p.cost * factor) / 1000) : null });
      }
      await saveVersion(tx, 'product', productId, await snapshotProduct(tx, productId, today), match ? `Updated by import #${imp.id}` : `Created by import #${imp.id}`, user.id);
    }
    if (openingLines.length) await saveStockIn(tx, user, { supplier: 'Opening stock', date: today, note: `Import #${imp.id}`, lines: openingLines }, imp.id);
    summary = `${preview.counts.new} new, ${preview.counts.update} updated, ${preview.counts.same} unchanged`;
  } else if (kind === 'stock') {
    const products = await tx.selectFrom('products').select(['id', 'code', 'name_en', 'base_unit', 'pack_kind']).where('active', '=', 1).execute();
    const units = await tx.selectFrom('product_units').select(['id', 'product_id', 'name', 'is_base']).where('active', '=', 1).execute();
    const groups = new Map<string, { supplier: string; date: string; lines: { productId: number; unitId: number; qtyMilli: number; ratePaise: number }[] }>();
    for (const r of preview.rows) {
      const d = r.data;
      const date = parseDate(d.date)!;
      const ref = d.product.trim().toLowerCase();
      const prod = products.find((p) => p.code?.toLowerCase() === ref) ?? products.find((p) => p.name_en.toLowerCase() === ref)!;
      const unit = findUnit(units, prod, d.unit)!;
      const key = `${date}|${(d.supplier ?? '').trim()}`;
      const g = groups.get(key) ?? { supplier: (d.supplier ?? '').trim(), date, lines: [] };
      g.lines.push({ productId: prod.id, unitId: unit.id, qtyMilli: parseQty(d.qty), ratePaise: parseRupees(d.rate) });
      groups.set(key, g);
    }
    for (const g of groups.values()) await saveStockIn(tx, user, { supplier: g.supplier, date: g.date, note: `Import #${imp.id}`, lines: g.lines }, imp.id);
    summary = `${preview.rows.length} lines in ${groups.size} deliveries`;
  } else {
    const asOf = opts.asOf && isIsoDate(opts.asOf) ? opts.asOf : today;
    const existing = await tx.selectFrom('customers').selectAll().where('active', '=', 1).execute();
    let total = 0;
    for (const r of preview.rows) {
      const d = r.data;
      const amt = parseRupees(d.amount);
      const fields = {
        name: d.name.trim(),
        nickname: (d.nickname ?? '').trim(),
        phone: (d.phone ?? '').trim(),
        area: (d.area ?? '').trim(),
        gstin: (d.gstin ?? '').trim().toUpperCase(),
        price_list: ((d.priceList ?? '').trim().toLowerCase() === 'wholesale' ? 'wholesale' : 'retail') as 'retail' | 'wholesale',
      };
      const match = existing.find((e) => e.name.toLowerCase() === fields.name.toLowerCase() && e.nickname.toLowerCase() === fields.nickname.toLowerCase() && e.area.toLowerCase() === fields.area.toLowerCase());
      let cid: number;
      if (match) {
        cid = match.id;
        undo.updatedCustomers.push({ id: match.id, data: { ...match } });
        await tx
          .updateTable('customers')
          .set({ phone: fields.phone || match.phone, gstin: fields.gstin || match.gstin, price_list: d.priceList ? fields.price_list : match.price_list })
          .where('id', '=', cid)
          .execute();
      } else {
        cid = (await tx.insertInto('customers').values({ ...fields, active: 1, created_at: now }).returning('id').executeTakeFirstOrThrow()).id;
        undo.createdCustomers.push(cid);
        // Each amount becomes one ledger entry with no bill behind it (MIG-2); negative = advance (MIG-5).
        if (amt !== 0) {
          await ledgerEntry(tx, user, {
            customerId: cid, date: asOf, kind: 'opening', refType: 'import', refId: imp.id,
            debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0, note: `Opening balance as on ${formatDate(asOf)}`, importId: imp.id,
          });
          total += amt;
        }
      }
      await saveVersion(tx, 'customer', cid, fields, match ? `Updated by import #${imp.id}` : `Created by import #${imp.id}`, user.id);
    }
    summary = `${undo.createdCustomers.length} new, ${undo.updatedCustomers.length} updated · opening dues ${formatRupees(total)}`;
  }

  await tx.updateTable('imports').set({ summary: JSON.stringify({ text: summary, undo }) }).where('id', '=', imp.id).execute();
  await logActivity(tx, user.id, 'import', kind, imp.id, `Imported ${kind} from ${fileName || 'sheet'}: ${summary}`);
  return { id: imp.id, summary, counts: preview.counts };
}

/** Undo the last import (IMP-7). Sales made since stay recorded; stock is the sum of what's left. */
export async function undoImport(tx: Tx, user: User, importId: number) {
  const imp = await tx.selectFrom('imports').selectAll().where('id', '=', importId).executeTakeFirst();
  if (!imp) throw new HttpError(404, 'Import not found', 'not_found');
  const latest = await tx.selectFrom('imports').select('id').orderBy('id', 'desc').executeTakeFirst();
  if (imp.undone || latest?.id !== imp.id) throw new HttpError(409, 'Only the most recent import can be undone', 'conflict');
  const { undo } = JSON.parse(imp.summary || '{}') as { undo: UndoData };
  const today = istDate();

  // Stock movements and deliveries from the import.
  await tx.deleteFrom('stock_movements').where('import_id', '=', importId).execute();
  await tx.deleteFrom('stock_ins').where('import_id', '=', importId).execute();
  if (undo.priceIds.length) await tx.deleteFrom('unit_prices').where('id', 'in', undo.priceIds).execute();
  if (undo.gstIds.length) await tx.deleteFrom('product_gst').where('id', 'in', undo.gstIds).execute();

  for (const u of undo.updatedProducts) {
    const { id, ...rest } = u.product as { id: number } & Record<string, never>;
    await tx.updateTable('products').set(rest).where('id', '=', id).execute();
  }
  if (undo.addedUnits.length) await tx.updateTable('product_units').set({ active: 0 }).where('id', 'in', undo.addedUnits).execute();
  for (const pid of undo.createdProducts) {
    const sold = await tx.selectFrom('bill_lines').select('id').where('product_id', '=', pid).executeTakeFirst();
    const moved = (await stockMap(tx, [pid])).get(pid);
    if (sold || moved) {
      // Sold since the import: keep it for the bills, but hide it.
      await tx.updateTable('products').set({ active: 0 }).where('id', '=', pid).execute();
    } else {
      const unitIds = (await tx.selectFrom('product_units').select('id').where('product_id', '=', pid).execute()).map((u) => u.id);
      if (unitIds.length) await tx.deleteFrom('unit_prices').where('unit_id', 'in', unitIds).execute();
      await tx.deleteFrom('product_units').where('product_id', '=', pid).execute();
      await tx.deleteFrom('product_gst').where('product_id', '=', pid).execute();
      await tx.deleteFrom('products').where('id', '=', pid).execute();
    }
  }
  for (const cid of [...undo.categories].reverse()) {
    const used = (await tx.selectFrom('products').select('id').where('category_id', '=', cid).executeTakeFirst()) || (await tx.selectFrom('categories').select('id').where('parent_id', '=', cid).executeTakeFirst());
    if (!used) await tx.deleteFrom('categories').where('id', '=', cid).execute();
  }

  // Ledger rows are never deleted: opening balances are reversed instead.
  const openings = await tx.selectFrom('ledger').selectAll().where('import_id', '=', importId).execute();
  for (const o of openings) {
    await ledgerEntry(tx, user, {
      customerId: o.customer_id, date: today, kind: 'reversal', refType: 'import', refId: importId,
      debit: o.credit_paise, credit: o.debit_paise, note: `Undo import #${importId}: opening balance reversed`,
    });
  }
  for (const cid of undo.createdCustomers) {
    const other = await tx.selectFrom('ledger').select('id').where('customer_id', '=', cid).where('ref_type', '!=', 'import').executeTakeFirst();
    if (!other) await tx.updateTable('customers').set({ active: 0 }).where('id', '=', cid).execute();
  }
  for (const u of undo.updatedCustomers) {
    const { id, ...rest } = u.data as { id: number } & Record<string, never>;
    await tx.updateTable('customers').set(rest).where('id', '=', id).execute();
  }

  await tx.updateTable('imports').set({ undone: 1 }).where('id', '=', importId).execute();
  await logActivity(tx, user.id, 'undo', 'import', importId, `Undid import #${importId} (${imp.kind}, ${imp.file_name})`);
}
