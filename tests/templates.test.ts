import { describe, expect, it, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { setup, type Client } from './helpers';
import { EXAMPLES, FIELDS, mapHeaders } from '../server/lib/importer';
import { parseCsv, readSheet } from '../server/lib/sheets';

describe('import templates', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let cookie = '';

  const download = async (file: string) => {
    const res = await ctx.app.request(`/api/import/template/${file}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return res;
  };
  const sheetOf = async (kind: 'products' | 'stock' | 'customers') => {
    const buf = await (await download(`${kind}.xlsx`)).arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return { wb, buf };
  };

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    const login = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sunil@shop.in', password: 'password123' }) });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  });

  it('has every column the importer reads, in the headings of the first sheet, with the example under the right heading', async () => {
    for (const kind of ['products', 'stock', 'customers'] as const) {
      const { wb, buf } = await sheetOf(kind);
      const ws = wb.worksheets[0];
      const headings = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v).replace(/ \*$/, ''));
      expect(headings).toEqual(FIELDS[kind].map((f) => f.header));
      expect(ws.rowCount).toBe(1 + EXAMPLES[kind].length);
      // The file reads back with every heading recognised.
      const read = await readSheet(`${kind}.xlsx`, buf as ArrayBuffer);
      const { map, missing } = mapHeaders(kind, read.headers);
      expect(missing).toEqual([]);
      expect(map.every(Boolean)).toBe(true);
    }
    // The bori example: pack columns filled, base unit empty, each in its own column.
    const { wb } = await sheetOf('products');
    const ws = wb.worksheets[0];
    const col = (key: string) => FIELDS.products.findIndex((f) => f.key === key) + 1;
    const bori = ws.getRow(4);
    expect(String(bori.getCell(col('name')).value)).toBe('Sugar — Dhampur 50 kg');
    expect(String(bori.getCell(col('packKind')).value)).toBe('Bori');
    expect(String(bori.getCell(col('packSize')).value)).toBe('50 kg');
    expect(String(bori.getCell(col('family')).value)).toBe('Sugar');
    expect(bori.getCell(col('baseUnit')).value ?? '').toBe('');
    // Hovering a heading explains the column; the sheet also has instructions.
    expect(String((ws.getRow(1).getCell(col('packKind')).note as { texts?: { text: string }[] } | string) && JSON.stringify(ws.getRow(1).getCell(col('packKind')).note))).toContain('sold whole');
    const help = wb.getWorksheet('Instructions')!;
    expect(help.getSheetValues().flat().join(' ')).toContain('Which columns do I fill?');
  });

  it('gives the CSV template the same headings and rows', async () => {
    const csv = parseCsv(await (await download('products.csv')).text());
    expect(csv.headers).toEqual(FIELDS.products.map((f) => f.header));
    expect(csv.rows).toHaveLength(EXAMPLES.products.length);
    expect(csv.rows.every((r) => r.length === FIELDS.products.length)).toBe(true);
  });

  it('imports every example row cleanly, so a template can never go out with examples that fail', async () => {
    const products = EXAMPLES.products.map((e) => e.row);
    const prev = await owner.post('/api/import/validate', { kind: 'products', rows: products });
    expect(prev.rows.map((r: any) => r.errors)).toEqual(products.map(() => []));
    expect(prev.counts).toMatchObject({ new: products.length, error: 0 });
    await owner.post('/api/import/commit', { kind: 'products', rows: products, fileName: 'template-examples.xlsx' });
    const cat = (await owner.get('/api/catalog')).products;
    const bori = cat.find((p: any) => p.nameEn === 'Sugar — Dhampur 50 kg');
    expect(bori).toMatchObject({ packKind: 'bori', packSize: '50 kg', family: 'Sugar', brand: 'Dhampur', baseUnit: 'pc', loose: false, stockMilli: 6000 });
    expect(bori.units[0]).toMatchObject({ name: 'Bori 50 kg', retail: 215000 });
    const pouch = cat.find((p: any) => p.nameEn === 'Refined Oil — Fortune 1 L');
    expect(pouch.units.map((u: any) => u.name)).toEqual(['Pouch 1 L', 'Carton (12 × 1 L)']);
    expect(pouch.units[1].retail).toBe(174000);
    expect(cat.find((p: any) => p.nameEn === 'Sugar').stockMilli).toBe(300000); // 6 bags of 50 kg
  });

  it('imports every stock example too, and lets a bori item be named just "bori"', async () => {
    const rows = EXAMPLES.stock.map((e) => e.row);
    const prev = await owner.post('/api/import/validate', { kind: 'stock', rows });
    expect(prev.rows.map((r: any) => r.errors)).toEqual(rows.map(() => []));
    await owner.post('/api/import/commit', { kind: 'stock', rows, fileName: 'stock-examples.xlsx' });
    const cat = (await owner.get('/api/catalog')).products;
    expect(cat.find((p: any) => p.nameEn === 'Sugar — Dhampur 50 kg').stockMilli).toBe(12000); // 6 opening + 6 bori
    expect(cat.find((p: any) => p.nameEn === 'Refined Oil — Fortune 1 L').stockMilli).toBe(100000); // 40 + 5 cartons × 12
    // The pack words are accepted for whole-pack items only.
    const bad = await owner.post('/api/import/validate', { kind: 'stock', rows: [{ ...rows[2], unit: 'bag' }, { ...rows[0], unit: 'bori' }, { ...rows[2], unit: 'pcs' }] });
    // "bag" is not a bori item's word; "bori" means nothing for loose sugar; "pcs" is one whole pack of anything counted in packs.
    expect(bad.rows.map((r: any) => r.errors.length)).toEqual([1, 1, 0]);
  });

  it('imports the customer examples', async () => {
    const rows = EXAMPLES.customers.map((e) => e.row);
    const prev = await owner.post('/api/import/validate', { kind: 'customers', rows });
    expect(prev.rows.map((r: any) => r.errors)).toEqual(rows.map(() => []));
  });
});
