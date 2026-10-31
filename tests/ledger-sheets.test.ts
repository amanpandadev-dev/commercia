import { describe, expect, it, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { sql } from 'kysely';
import { setup, type Client } from './helpers';
import { EXAMPLES, FIELDS, lineTotalPaise, mapHeaders, parseParty } from '../server/lib/importer';
import { readSheet } from '../server/lib/sheets';
import { istDate, addDays } from '../shared/dates';

const today = istDate();

describe('stock deliveries and dues sheets, and the ledgers they feed', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let cookie = '';

  const download = async (file: string) => {
    const res = await ctx.app.request(`/api/import/template/${file}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return res;
  };
  const sheetOf = async (kind: 'stock' | 'customers') => {
    const buf = await (await download(`${kind}.xlsx`)).arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return { wb, buf };
  };
  const column = (ws: ExcelJS.Worksheet, n: number) => ws.getColumn(n).values.slice(2).map((v) => (v == null ? '' : String(v)));
  const supplier = async (name: string) => (await owner.get('/api/supplier-ledger')).find((s: any) => s.name === name);
  const statement = async (name: string) => owner.get(`/api/supplier-ledger/${(await supplier(name)).id}`);
  const customerBalance = async (name: string) => {
    const c = await ctx.db.k.selectFrom('customers').select('id').where('name', '=', name).executeTakeFirstOrThrow();
    const r = await ctx.db.k.selectFrom('ledger').select([sql<number>`sum(debit_paise)`.as('d'), sql<number>`sum(credit_paise)`.as('c')]).where('customer_id', '=', c.id).executeTakeFirstOrThrow();
    return Number(r.d) - Number(r.c);
  };
  const stock = (qty: string, unit: string, rate: string, over: Record<string, string> = {}) => ({
    date: today, supplier: 'Dhampur Sugar', product: 'Sugar — Dhampur 50 kg Bori', qty, unit, rate, ...over,
  });

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    const login = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sunil@shop.in', password: 'password123' }) });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const products = EXAMPLES.products.map((e) => e.row);
    await owner.post('/api/import/commit', { kind: 'products', rows: products, fileName: 'p.xlsx' });
  });

  describe('the stock deliveries template', () => {
    it('has Supplier required and an Amount column after the rate', async () => {
      const { wb } = await sheetOf('stock');
      const ws = wb.worksheets[0];
      const headings = (ws.getRow(1).values as unknown[]).slice(1).map(String);
      expect(headings).toEqual(['Date *', 'Supplier *', 'Code or Product name *', 'Quantity *', 'Unit *', 'Purchase rate per unit *', 'Amount']);
    });

    it('gives Product, Supplier, Quantity and Unit dropdowns, and the rate a number check', async () => {
      const { wb } = await sheetOf('stock');
      const ws = wb.worksheets[0];
      for (const [cell, style] of [['C2', 'warning'], ['B2', 'warning'], ['D2', 'warning'], ['E2', 'warning']] as const) {
        expect(ws.getCell(cell).dataValidation).toMatchObject({ type: 'list', allowBlank: true, errorStyle: style });
        expect(ws.getCell(cell.replace('2', '500')).dataValidation.type).toBe('list');
      }
      expect(ws.getCell('F2').dataValidation).toMatchObject({ type: 'decimal', errorStyle: 'stop' });
      expect(ws.getCell('G2').dataValidation).toBeUndefined(); // Amount is worked out, not typed
      const lists = wb.getWorksheet('Lists')!;
      expect(lists.state).toBe('hidden');
      expect(column(lists, 1)).toEqual(expect.arrayContaining(['Sugar — Dhampur 50 kg Bori', 'Toor Dal (loose)']));
      expect(column(lists, 3).filter(Boolean)).toEqual(expect.arrayContaining(['1', '10', '24', '100'].map(String)));
      expect(column(lists, 4).filter(Boolean)).toEqual(expect.arrayContaining(['Bori', 'Bag', 'Pouch', 'kg', 'L', 'pc', 'Carton']));
    });

    it('writes each dropdown as one range, with no overlaps and messages inside the limits', async () => {
      const { wb, buf } = await sheetOf('stock');
      const zip = await JSZip.loadAsync(buf as ArrayBuffer);
      const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
      const refs = [...xml.matchAll(/<dataValidation [^>]*sqref="([^"]+)"/g)].map((m) => m[1]);
      expect(refs.sort()).toEqual(['B2:B500', 'C2:C500', 'D2:D500', 'E2:E500', 'F2:F500']);
      const ws = wb.worksheets[0];
      for (const c of ['B2', 'C2', 'D2', 'E2', 'F2']) {
        const v = ws.getCell(c).dataValidation;
        for (const t of [v.errorTitle, v.promptTitle]) expect((t ?? '').length).toBeLessThanOrEqual(32);
        for (const m of [v.error, v.prompt]) expect((m ?? '').length).toBeLessThanOrEqual(255);
      }
    });

    it('works Amount out as Quantity × Rate in every row, with the example totals, and a total on the Instructions sheet', async () => {
      const { wb, buf } = await sheetOf('stock');
      const ws = wb.worksheets[0];
      const g2 = ws.getCell('G2').value as { formula: string; result?: number };
      expect(g2.formula).toBe('IF(AND(ISNUMBER(D2),ISNUMBER(F2)),ROUND(D2*F2,2),"")');
      expect(g2.result).toBe(12000); // 6 bori at 2,000
      expect((ws.getCell('G500').value as { formula: string }).formula).toContain('D500*F500');
      const help = wb.getWorksheet('Instructions')!;
      const total = help.getSheetValues().flat().find((v) => v && typeof v === 'object' && 'formula' in (v as object)) as { formula: string; result: number };
      expect(total.formula).toBe("SUM('Stock deliveries'!G2:G500)");
      expect(total.result).toBe(12000 + 3360 + 3100);
      // Excel works every formula out afresh when it opens the file.
      const book = await (await JSZip.loadAsync(buf as ArrayBuffer)).file('xl/workbook.xml')!.async('string');
      expect(book).toContain('fullCalcOnLoad="1"');
    });

    it('is read back as just the example rows, whatever is in the formula cells', async () => {
      const { buf } = await sheetOf('stock');
      const read = await readSheet('stock.xlsx', buf as ArrayBuffer);
      expect(read.rows).toHaveLength(EXAMPLES.stock.length);
      const { map, missing } = mapHeaders('stock', read.headers);
      expect(missing).toEqual([]);
      expect(map.every(Boolean)).toBe(true);
    });

    it('has examples whose Amount is their quantity × rate, and which import', async () => {
      for (const e of EXAMPLES.stock) expect(lineTotalPaise(e.row.qty, e.row.rate)).toBe(Math.round(Number(e.row.total) * 100));
      expect(lineTotalPaise('10', '1200')).toBe(1200000);
      expect(lineTotalPaise('2.5', '124')).toBe(31000);
      expect(Number.isNaN(lineTotalPaise('x', '1'))).toBe(true);
    });
  });

  describe('importing deliveries', () => {
    it('works the total out itself (10 bori at 1,200 = 12,000), whatever the Amount column says', async () => {
      const prev = await owner.post('/api/import/validate', { kind: 'stock', rows: [stock('10', 'Bori', '1200', { total: '999' })] });
      expect(prev.rows[0].errors).toEqual([]);
      expect(prev.rows[0].data.total).toBe('12000.00');
      expect(prev.rows[0].notes).toContain('New supplier "Dhampur Sugar"');
    });

    it('lodges one purchase on the supplier ledger for each supplier and date, as the total of its rows', async () => {
      const rows = [
        stock('10', 'Bori', '1200'), // 12,000
        stock('2.5', 'Bori', '1000'), // 2,500: same supplier and day, so the same delivery
        stock('24', 'Pouch', '140', { supplier: 'Fortune Dealer', product: 'Refined Oil — Fortune 1 L Pouch' }), // 3,360
        stock('1', 'Bori', '900', { date: addDays(today, -3) }), // another day: its own delivery
      ];
      const res = await owner.post('/api/import/commit', { kind: 'stock', rows, fileName: 'deliveries.xlsx' });
      expect(res.summary).toContain('4 lines in 3 deliveries');
      expect(res.summary).toContain('₹18,760'); // 12,000 + 2,500 + 3,360 + 900
      const dhampur = await statement('Dhampur Sugar');
      expect(dhampur.balance).toBe(1200000 + 250000 + 90000);
      expect(dhampur.entries.map((e: any) => [e.date, e.kind, e.owed_paise])).toEqual([
        [addDays(today, -3), 'purchase', 90000],
        [today, 'purchase', 1450000],
      ]);
      expect((await statement('Fortune Dealer')).balance).toBe(336000);
      // And the stock itself went up: 6 (example) + 10 + 2.5 + 1 bori.
      const bori = (await owner.get('/api/catalog')).products.find((p: any) => p.nameEn === 'Sugar — Dhampur 50 kg Bori');
      expect(bori.stockMilli).toBe(6000 + 13500);
    });

    it('refuses a row with no supplier, since every delivery goes on a ledger', async () => {
      const prev = await owner.post('/api/import/validate', { kind: 'stock', rows: [stock('1', 'Bori', '1000', { supplier: '' })] });
      expect(prev.rows[0].errors.join(' ')).toMatch(/Missing supplier/);
    });

    it('lets a bigger unit be named by its first word', async () => {
      const prod = await ctx.db.k.selectFrom('products').select('id').where('name_en', '=', 'Refined Oil — Fortune 1 L Pouch').executeTakeFirstOrThrow();
      const base = await ctx.db.k.selectFrom('product_units').select('id').where('product_id', '=', prod.id).where('is_base', '=', 1).executeTakeFirstOrThrow();
      await ctx.db.k.insertInto('product_units').values({ product_id: prod.id, name: 'Carton (12 × 1 L)', factor_milli: 12000, is_base: 0, active: 1 } as never).execute();
      const prev = await owner.post('/api/import/validate', { kind: 'stock', rows: [stock('2', 'Carton', '1600', { product: 'Refined Oil — Fortune 1 L Pouch' }), stock('2', 'Cartons', '1', { product: 'Refined Oil — Fortune 1 L Pouch' })] });
      expect(prev.rows.map((r: any) => r.errors.length)).toEqual([0, 1]);
      expect(base.id).toBeGreaterThan(0);
    });

    it('is taken back by Undo: stock, the purchase ledger (as reversals) and the suppliers it made', async () => {
      const before = (await supplier('Fortune Dealer')).balance;
      await owner.post('/api/import/commit', { kind: 'stock', rows: [stock('4', 'Bori', '2000', { supplier: 'Brand New Mills' }), stock('1', 'Pouch', '100', { supplier: 'Fortune Dealer', product: 'Refined Oil — Fortune 1 L Pouch' })], fileName: 'undo-me.xlsx' });
      expect((await supplier('Brand New Mills')).balance).toBe(800000);
      expect((await supplier('Fortune Dealer')).balance).toBe(before + 10000);
      const latest = (await owner.get('/api/imports'))[0];
      await owner.post(`/api/imports/${latest.id}/undo`);
      expect(await supplier('Brand New Mills')).toBeUndefined(); // made by the import, so hidden again
      expect((await supplier('Fortune Dealer')).balance).toBe(before);
      const rows = (await statement('Fortune Dealer')).entries.map((e: any) => e.kind);
      expect(rows).toEqual(['purchase', 'purchase', 'reversal']); // never deleted, reversed
    });
  });

  describe('the dues template', () => {
    it('has a Type column first, then Name and Amount owed', async () => {
      const { wb } = await sheetOf('customers');
      const ws = wb.worksheets[0];
      expect(ws.name).toBe('Dues');
      const headings = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v).replace(/ \*$/, ''));
      expect(headings).toEqual(FIELDS.customers.filter((f) => !f.advanced).map((f) => f.header));
      expect(headings.slice(0, 3)).toEqual(['Type', 'Name', 'Amount owed']);
    });

    it('offers Sale / Purchase and retail / wholesale as lists, and a number check on the amount', async () => {
      const { wb } = await sheetOf('customers');
      const ws = wb.worksheets[0];
      expect(ws.getCell('A2').dataValidation).toMatchObject({ type: 'list', errorStyle: 'stop' });
      expect(ws.getCell('C2').dataValidation).toMatchObject({ type: 'decimal', operator: 'between' }); // minus means paid in advance
      expect(ws.getCell('H2').dataValidation).toMatchObject({ type: 'list' });
      const lists = wb.getWorksheet('Lists')!;
      expect(column(lists, 1).filter(Boolean)).toEqual(['Sale', 'Purchase']);
    });

    it('has Sale and Purchase examples, and they all import', async () => {
      const rows = EXAMPLES.customers.map((e) => e.row);
      expect(rows.map((r) => r.party)).toEqual(['Sale', 'Sale', 'Sale', 'Purchase', 'Purchase']);
      const prev = await owner.post('/api/import/validate', { kind: 'customers', rows });
      expect(prev.rows.map((r: any) => r.errors)).toEqual(rows.map(() => []));
    });

    it('reads Type and the sale / purchase words in any spelling', () => {
      expect(['', 'Sale', 'sales', 'Customer'].map(parseParty)).toEqual(['sale', 'sale', 'sale', 'sale']);
      expect(['Purchase', 'purchase', 'Supplier', 'Vendor'].map(parseParty)).toEqual(['purchase', 'purchase', 'purchase', 'purchase']);
      expect(parseParty('Both')).toBeNull();
    });
  });

  describe('importing dues', () => {
    const asOf = addDays(today, -30);

    it('files Sale rows under customers and Purchase rows under suppliers', async () => {
      const rows = [
        { party: 'Sale', name: 'Sunita Devi', amount: '1250', phone: '98000' },
        { name: 'Old Format Customer', amount: '400' }, // no Type: a customer, as in earlier files
        { party: 'Purchase', name: 'Annapurna Traders', amount: '38000', phone: '97000', area: 'Mandi' },
        { party: 'Purchase', name: 'Ravi Oil Mill', amount: '-2000' }, // paid in advance
        { party: 'Sale', name: 'Annapurna Traders', amount: '10' }, // same name, but a customer: allowed
      ];
      const prev = await owner.post('/api/import/validate', { kind: 'customers', rows });
      expect(prev.rows.map((r: any) => r.errors)).toEqual(rows.map(() => []));
      expect(prev.rows[3].notes).toContain('Paid in advance ₹2,000.00');
      const res = await owner.post('/api/import/commit', { kind: 'customers', rows, fileName: 'dues.xlsx', asOf });
      expect(res.summary).toBe('5 new, 0 updated · customers owe ₹1,660.00 · owed to suppliers ₹36,000.00');

      expect(await customerBalance('Sunita Devi')).toBe(125000);
      expect(await customerBalance('Old Format Customer')).toBe(40000);
      const ann = await supplier('Annapurna Traders');
      expect(ann).toMatchObject({ balance: 3800000, phone: '97000', area: 'Mandi' });
      const entries = (await statement('Annapurna Traders')).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'opening', date: asOf, owed_paise: 3800000, paid_paise: 0 });
      expect((await supplier('Ravi Oil Mill')).balance).toBe(-200000); // they hold our advance
      expect((await statement('Ravi Oil Mill')).entries[0]).toMatchObject({ kind: 'opening', owed_paise: 0, paid_paise: 200000 });
      // The customer "Annapurna Traders" is not the supplier of the same name.
      expect(await customerBalance('Annapurna Traders')).toBe(1000);
    });

    it('only updates the details of a supplier that already has an opening balance', async () => {
      const rows = [{ party: 'Purchase', name: 'annapurna traders', amount: '5000', phone: '96000' }];
      const prev = await owner.post('/api/import/validate', { kind: 'customers', rows });
      expect(prev.rows[0].status).toBe('update');
      expect(prev.rows[0].notes.join(' ')).toMatch(/Already a supplier \(balance ₹38,000.00\)/);
      await owner.post('/api/import/commit', { kind: 'customers', rows, fileName: 'again.xlsx' });
      expect(await supplier('Annapurna Traders')).toMatchObject({ balance: 3800000, phone: '96000', area: 'Mandi' });
      // Undo gives the old phone number back.
      await owner.post(`/api/imports/${(await owner.get('/api/imports'))[0].id}/undo`);
      expect((await supplier('Annapurna Traders')).phone).toBe('97000');
    });

    describe('a supplier that already exists but has no opening balance', () => {
      const rows = [{ party: 'Purchase', name: 'Delivery Only Mills', amount: '7000', phone: '95000' }];
      const asOfDay = addDays(today, -40);
      const latestImport = async () => (await owner.get('/api/imports'))[0].id;
      const openings = async (name: string) => (await statement(name)).entries.filter((e: any) => e.kind === 'opening');

      beforeAll(async () => {
        // Suppliers made by a stock file: they have deliveries, but no opening balance.
        for (const name of ['Delivery Only Mills', 'Advance Mills']) await owner.post('/api/import/commit', { kind: 'stock', rows: [stock('1', 'Bori', '1000', { supplier: name })], fileName: 'd.xlsx' });
      });

      it('gets the amount, dated as on the sheet, on top of their deliveries', async () => {
        expect((await supplier('Delivery Only Mills')).balance).toBe(100000);
        const prev = await owner.post('/api/import/validate', { kind: 'customers', rows });
        expect(prev.rows[0].status).toBe('update');
        expect(prev.rows[0].notes.join(' ')).toMatch(/Already a supplier \(balance ₹1,000.00\) — ₹7,000.00 will be added to what you owe/);
        const res = await owner.post('/api/import/commit', { kind: 'customers', rows, fileName: 'mills.xlsx', asOf: asOfDay });
        expect(res.summary).toContain('owed to suppliers ₹7,000.00');
        expect(await supplier('Delivery Only Mills')).toMatchObject({ balance: 800000, phone: '95000' });
        expect(await openings('Delivery Only Mills')).toMatchObject([{ date: asOfDay, owed_paise: 700000 }]);
      });

      it('does not add it a second time when the same file is uploaded again', async () => {
        const prev = await owner.post('/api/import/validate', { kind: 'customers', rows });
        expect(prev.rows[0].notes.join(' ')).toMatch(/with an opening balance — only details will be updated, not the amount/);
        await owner.post('/api/import/commit', { kind: 'customers', rows, fileName: 'mills-again.xlsx', asOf: asOfDay });
        expect((await supplier('Delivery Only Mills')).balance).toBe(800000);
        expect(await openings('Delivery Only Mills')).toHaveLength(1);
        await owner.post(`/api/imports/${await latestImport()}/undo`); // taking that back changes nothing either
        expect((await supplier('Delivery Only Mills')).balance).toBe(800000);
      });

      it('takes a negative amount as paid in advance, and Undo reverses it so the file can be used again', async () => {
        const adv = [{ party: 'Purchase', name: 'Advance Mills', amount: '-1500' }];
        expect((await owner.post('/api/import/validate', { kind: 'customers', rows: adv })).rows[0].notes.join(' ')).toMatch(/₹1,500.00 paid in advance will be added/);
        await owner.post('/api/import/commit', { kind: 'customers', rows: adv, fileName: 'adv.xlsx', asOf: asOfDay });
        expect((await supplier('Advance Mills')).balance).toBe(100000 - 150000);
        expect(await openings('Advance Mills')).toMatchObject([{ owed_paise: 0, paid_paise: 150000 }]);
        await owner.post(`/api/imports/${await latestImport()}/undo`);
        expect((await supplier('Advance Mills')).balance).toBe(100000);
        // Undone, so it no longer counts as an opening balance.
        expect((await owner.post('/api/import/validate', { kind: 'customers', rows: adv })).rows[0].notes.join(' ')).toMatch(/paid in advance will be added/);
      });

      it('adds nothing for an amount of 0', async () => {
        const zero = [{ party: 'Purchase', name: 'Advance Mills', amount: '0', area: 'Mandi' }];
        await owner.post('/api/import/commit', { kind: 'customers', rows: zero, fileName: 'zero.xlsx', asOf: asOfDay });
        expect(await supplier('Advance Mills')).toMatchObject({ balance: 100000, area: 'Mandi' });
        expect(await openings('Advance Mills')).toHaveLength(1); // only the earlier, reversed one
      });
    });

    it('refuses an unknown type, and two rows for one supplier', async () => {
      const prev = await owner.post('/api/import/validate', {
        kind: 'customers',
        rows: [
          { party: 'Both', name: 'X', amount: '1' },
          { party: 'Purchase', name: 'Twice Traders', amount: '1' },
          { party: 'Purchase', name: 'twice traders', amount: '2', area: 'Elsewhere' },
        ],
      });
      expect(prev.rows[0].errors.join(' ')).toMatch(/Type must be Sale/);
      expect(prev.rows[1].errors.join(' ')).toMatch(/Same supplier as row 4/);
      expect(prev.rows[2].errors.join(' ')).toMatch(/Same supplier as row 3/);
    });

    it('says when a supplier row has customer-only columns', async () => {
      const prev = await owner.post('/api/import/validate', { kind: 'customers', rows: [{ party: 'Purchase', name: 'Some Mill', amount: '1', nickname: 'Bhai', gstin: '09ABCDE1234F1Z5' }] });
      expect(prev.rows[0].errors).toEqual([]);
      expect(prev.rows[0].notes.join(' ')).toMatch(/ignored for a supplier/);
    });

    it('is taken back by Undo: customers and suppliers, with reversals on both ledgers', async () => {
      const rows = [
        { party: 'Sale', name: 'Undo Customer', amount: '700' },
        { party: 'Purchase', name: 'Undo Supplier', amount: '9000' },
      ];
      await owner.post('/api/import/commit', { kind: 'customers', rows, fileName: 'undo.xlsx', asOf });
      expect((await supplier('Undo Supplier')).balance).toBe(900000);
      await owner.post(`/api/imports/${(await owner.get('/api/imports'))[0].id}/undo`);
      expect(await supplier('Undo Supplier')).toBeUndefined();
      expect(await customerBalance('Undo Customer')).toBe(0);
      const all = await ctx.db.k.selectFrom('supplier_ledger').selectAll().where('note', 'like', '%Undo import%').orderBy('id', 'desc').limit(1).execute();
      expect(all.map((r) => [r.kind, r.paid_paise])).toEqual([['reversal', 900000]]);
    });
  });
});
