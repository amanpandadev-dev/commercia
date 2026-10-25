import { describe, expect, it, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { setup, type Client } from './helpers';
import { EXAMPLES, FIELDS, mapHeaders } from '../server/lib/importer';
import { parseCsv, readSheet } from '../server/lib/sheets';

const simple = (kind: 'products' | 'stock' | 'customers') => FIELDS[kind].filter((f) => !f.advanced);

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
  const column = (ws: ExcelJS.Worksheet, n: number) => ws.getColumn(n).values.slice(2).map((v) => (v == null ? '' : String(v)));

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    const login = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sunil@shop.in', password: 'password123' }) });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  });

  it('has exactly these eight columns, in this order, and nothing else', async () => {
    const { wb } = await sheetOf('products');
    const ws = wb.worksheets[0];
    const headings = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v).replace(/ \*$/, ''));
    expect(headings).toEqual(['Category', 'Brand', 'Pack type', 'Pack size', 'Pack price', 'Stock', 'Reorder at', 'Aliases (Hindi names)']);
    expect(ws.columnCount).toBe(8);
    expect(ws.actualRowCount).toBe(1 + EXAMPLES.products.length); // the empty rows below only carry the dropdowns
  });

  it('reads only the filled rows when the file is uploaded, not the empty rows that carry the dropdowns', async () => {
    const { buf } = await sheetOf('products');
    const read = await readSheet('products.xlsx', buf as ArrayBuffer);
    expect(read.rows).toHaveLength(EXAMPLES.products.length);
  });

  it('reads back with every heading recognised, for all three templates', async () => {
    for (const kind of ['products', 'stock', 'customers'] as const) {
      const { wb, buf } = await sheetOf(kind);
      const headings = (wb.worksheets[0].getRow(1).values as unknown[]).slice(1).map((v) => String(v).replace(/ \*$/, ''));
      expect(headings).toEqual(simple(kind).map((f) => f.header));
      const read = await readSheet(`${kind}.xlsx`, buf as ArrayBuffer);
      const { map, missing } = mapHeaders(kind, read.headers);
      expect(missing).toEqual([]);
      expect(map.every(Boolean)).toBe(true);
    }
  });

  it('puts each example under its own heading', async () => {
    const { wb } = await sheetOf('products');
    const ws = wb.worksheets[0];
    const bag = ws.getRow(4).values as unknown[];
    expect(bag.slice(1).map(String)).toEqual(['Sooji', 'Annapurna', 'Bag', '25 kg', '1150', '8', '3', 'सूजी, suji, rava']);
    const loose = ws.getRow(8).values as unknown[];
    expect(String(loose[3])).toBe('Loose');
    expect(String(loose[4])).toBe('1 kg');
  });

  it('gives Pack type and Pack size a dropdown, and numbers a number check, down 500 rows', async () => {
    const { wb } = await sheetOf('products');
    const ws = wb.worksheets[0];
    const type = ws.getCell('C2').dataValidation;
    expect(type).toMatchObject({ type: 'list', allowBlank: true, errorStyle: 'stop' });
    expect(type.formulae[0]).toMatch(/^Lists!\$A\$2:\$A\$\d+$/);
    expect(ws.getCell('C500').dataValidation.type).toBe('list');
    const size = ws.getCell('D2').dataValidation;
    expect(size).toMatchObject({ type: 'list', errorStyle: 'warning' }); // other sizes may be typed
    expect(size.formulae[0]).toMatch(/^Lists!\$B\$2:\$B\$\d+$/);
    for (const c of ['E2', 'F2', 'G2']) expect(ws.getCell(c).dataValidation.type).toBe('decimal');
    expect(ws.getCell('A2').dataValidation).toBeUndefined(); // Category is free text
  });

  it('writes each dropdown as one range, and no two ranges overlap (overlaps make Excel repair the file)', async () => {
    const { buf } = await sheetOf('products');
    const zip = await JSZip.loadAsync(buf as ArrayBuffer);
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const refs = [...xml.matchAll(/<dataValidation [^>]*sqref="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.sort()).toEqual(['C2:C500', 'D2:D500', 'E2:E500', 'F2:F500', 'G2:G500']);
    const cells = new Set<string>();
    for (const r of refs) {
      const [from, to] = r.split(':');
      const col = from.replace(/\d+/g, '');
      for (let row = Number(from.replace(/\D/g, '')); row <= Number(to.replace(/\D/g, '')); row++) {
        expect(cells.has(`${col}${row}`)).toBe(false);
        cells.add(`${col}${row}`);
      }
    }
  });

  it("keeps every dropdown message inside Excel's limits (a longer one makes Excel call the file corrupt)", async () => {
    const { wb } = await sheetOf('products');
    const ws = wb.worksheets[0];
    for (const c of ['C2', 'D2', 'E2']) {
      const v = ws.getCell(c).dataValidation;
      for (const t of [v.errorTitle, v.promptTitle]) expect((t ?? '').length).toBeLessThanOrEqual(32);
      for (const m of [v.error, v.prompt]) expect((m ?? '').length).toBeLessThanOrEqual(255);
    }
  });

  it('fills the dropdowns from a hidden Lists sheet: built-in types plus Loose, and common sizes in order', async () => {
    const { wb } = await sheetOf('products');
    const lists = wb.getWorksheet('Lists')!;
    expect(lists.state).toBe('hidden');
    const types = column(lists, 1).filter(Boolean);
    expect(types).toEqual(expect.arrayContaining(['Bori', 'Bag', 'Can', 'Tin', 'Pouch', 'Packet', 'Loose']));
    const sizes = column(lists, 2).filter(Boolean);
    expect(sizes).toEqual(expect.arrayContaining(['50 kg', '25 kg', '1 L', '500 ml', '250 g', '12 pc']));
    expect(sizes.indexOf('250 g')).toBeLessThan(sizes.indexOf('1 kg')); // grams, then kg, then ml, L, pc
    expect(sizes.indexOf('1 kg')).toBeLessThan(sizes.indexOf('500 ml'));
    expect(sizes.indexOf('500 ml')).toBeLessThan(sizes.indexOf('1 L'));
    expect(sizes.indexOf('1 L')).toBeLessThan(sizes.indexOf('12 pc'));
  });

  it('keeps the instructions short', async () => {
    const { wb } = await sheetOf('products');
    const help = wb.getWorksheet('Instructions')!;
    expect(help.rowCount).toBeLessThan(18);
    expect(help.getSheetValues().flat().join(' ')).toContain('Delete them before you upload');
  });

  it('gives the CSV template the same headings and rows', async () => {
    const csv = parseCsv(await (await download('products.csv')).text());
    expect(csv.headers).toEqual(simple('products').map((f) => f.header));
    expect(csv.rows).toHaveLength(EXAMPLES.products.length);
    expect(csv.rows.every((r) => r.length === 8)).toBe(true);
  });

  it('imports every example row cleanly, so a template can never go out with examples that fail', async () => {
    const products = EXAMPLES.products.map((e) => e.row);
    const prev = await owner.post('/api/import/validate', { kind: 'products', rows: products });
    expect(prev.rows.map((r: any) => r.errors)).toEqual(products.map(() => []));
    expect(prev.counts).toMatchObject({ new: products.length, error: 0 });
    expect(prev.rows[0].notes).toContain('Will be added as "Sugar — Dhampur 50 kg Bori"');
    await owner.post('/api/import/commit', { kind: 'products', rows: products, fileName: 'template-examples.xlsx' });
    const cat = (await owner.get('/api/catalog')).products;
    expect(cat.map((p: any) => p.nameEn).sort()).toEqual([
      'Mustard Oil — Fortune 15 L Can', 'Refined Oil — Fortune 1 L Pouch', 'Sooji — Annapurna 25 kg Bag', 'Sugar — Balrampur 50 kg Bori',
      'Sugar — Dhampur 50 kg Bori', 'Tea — Tata 250 g Packet', 'Toor Dal (loose)',
    ]);
    const bori = cat.find((p: any) => p.nameEn === 'Sugar — Dhampur 50 kg Bori');
    expect(bori).toMatchObject({ packKind: 'bori', packSize: '50 kg', family: 'Sugar', brand: 'Dhampur', nameHi: 'चीनी', aliases: 'चीनी, chini', baseUnit: 'pc', loose: false, stockMilli: 6000, reorderMilli: 2000, gstBp: 500 });
    expect(bori.units).toHaveLength(1);
    expect(bori.units[0]).toMatchObject({ name: 'Bori 50 kg', retail: 215000 });
    const dal = cat.find((p: any) => p.nameEn === 'Toor Dal (loose)');
    expect(dal).toMatchObject({ packKind: '', family: 'Toor Dal', brand: '', baseUnit: 'kg', loose: true, stockMilli: 25000, nameHi: 'अरहर दाल' });
    expect(dal.units[0]).toMatchObject({ name: 'kg', retail: 14000 });
    expect(cat.find((p: any) => p.nameEn === 'Tea — Tata 250 g Packet').units[0].name).toBe('Packet 250 g');
  });

  it('imports every stock example too, and lets a pack item be named just "bori" or "pouch"', async () => {
    const rows = EXAMPLES.stock.map((e) => e.row);
    const prev = await owner.post('/api/import/validate', { kind: 'stock', rows });
    expect(prev.rows.map((r: any) => r.errors)).toEqual(rows.map(() => []));
    await owner.post('/api/import/commit', { kind: 'stock', rows, fileName: 'stock-examples.xlsx' });
    const cat = (await owner.get('/api/catalog')).products;
    expect(cat.find((p: any) => p.nameEn === 'Sugar — Dhampur 50 kg Bori').stockMilli).toBe(12000); // 6 + 6
    expect(cat.find((p: any) => p.nameEn === 'Refined Oil — Fortune 1 L Pouch').stockMilli).toBe(64000); // 40 + 24
    expect(cat.find((p: any) => p.nameEn === 'Toor Dal (loose)').stockMilli).toBe(50000); // 25 + 25 kg
    // A pack word means one whole pack, but only for the item's own kind.
    const bad = await owner.post('/api/import/validate', { kind: 'stock', rows: [{ ...rows[0], unit: 'bag' }, { ...rows[2], unit: 'bori' }, { ...rows[0], unit: 'pcs' }] });
    expect(bad.rows.map((r: any) => r.errors.length)).toEqual([1, 1, 0]);
  });

  it('imports the customer examples', async () => {
    const rows = EXAMPLES.customers.map((e) => e.row);
    const prev = await owner.post('/api/import/validate', { kind: 'customers', rows });
    expect(prev.rows.map((r: any) => r.errors)).toEqual(rows.map(() => []));
  });
});
