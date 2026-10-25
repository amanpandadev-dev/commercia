import { describe, expect, it, beforeAll } from 'vitest';
import { setup, type Client } from './helpers';
import { setSetting } from '../server/lib/settings';
import { derivePackName, findPackKind, packOf, parsePackSize, baseLabel, cleanPackKindName } from '../shared/units';

describe('the simple products sheet', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let entry: Client;
  const row = (extra: Record<string, string> = {}) => ({ category: 'Sooji', brand: 'Annapurna', packKind: 'Bag', packSize: '25 kg', price: '1150', ...extra });
  const check = (rows: object[]) => owner.post('/api/import/validate', { kind: 'products', rows });
  const errorsOf = async (r: object) => (await check([r])).rows[0].errors.join(' | ');
  const product = async (name: string) => (await owner.get('/api/catalog')).products.find((x: any) => x.nameEn === name);

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    entry = await ctx.client('amit@shop.in');
  });

  describe('size, type and name', () => {
    it('reads a size however it is written', () => {
      expect(['25kg', '25 KG', '1 ltr', '500ML', '12 pcs', '250 gm', '0.5 kg', '1,5 L'].map((s) => parsePackSize(s)?.label)).toEqual(['25 kg', '25 kg', '1 L', '500 ml', '12 pc', '250 g', '0.5 kg', '1.5 L']);
      expect(['', 'big', '25', 'kg 25', '0 kg', '25 bags'].map((s) => parsePackSize(s))).toEqual([null, null, null, null, null, null]);
    });

    it('finds a pack type by any of its spellings, and builds the name', () => {
      expect(['Bag', 'bags', ' BORI ', 'Can', 'cans', 'pouches'].map((w) => findPackKind(w, [])?.value)).toEqual(['bag', 'bag', 'bori', 'can', 'can', 'pouch']);
      expect(findPackKind('sack', [])).toBeUndefined();
      expect(findPackKind('Sack', ['sack'])?.value).toBe('sack');
      expect(derivePackName({ family: 'Sooji', brand: 'Annapurna', packSize: '25 kg', packKind: 'bag' })).toBe('Sooji — Annapurna 25 kg Bag');
      expect(derivePackName({ family: 'Sooji', brand: '', packSize: '25 kg', packKind: 'bag' })).toBe('Sooji 25 kg Bag');
      expect(derivePackName({ family: '', brand: 'Amul', packSize: '1 L', packKind: 'pouch' })).toBe('Amul 1 L Pouch');
      expect(packOf('sack')).toMatchObject({ name: 'Sack', one: 'sack', many: 'sacks' });
      expect(packOf('box')!.many).toBe('boxes');
      expect(baseLabel('pc', 3000, 'sack')).toBe('3 sacks');
      expect(['can', 'two words', 'loose', 'a', 'b4d', ''].map((w) => cleanPackKindName(w))).toEqual(['can', 'two words', null, null, null, null]);
    });

    it('takes size and type as typed: "bags", "25kg", "BORI"', async () => {
      const r = await check([row({ packKind: 'bags', packSize: '25kg' }), row({ brand: 'Shakti', packKind: 'BORI', packSize: '50 KG' })]);
      expect(r.rows.map((x: any) => x.errors)).toEqual([[], []]);
      expect(r.rows[0].notes).toContain('Will be added as "Sooji — Annapurna 25 kg Bag"');
      expect(r.rows[1].notes).toContain('Will be added as "Sooji — Shakti 50 kg Bori"');
    });

    it('says what is wrong in plain words', async () => {
      const unknown = (await check([row({ packKind: 'Sack' })])).rows[0].errors;
      expect(unknown).toHaveLength(1); // one clear message, not a pile of follow-on ones
      expect(unknown[0]).toMatch(/Pack type "Sack" is not in the list.*add it in Commercia first/);
      expect(await errorsOf(row({ packSize: 'big' }))).toMatch(/Pack size "big" isn't clear/);
      expect(await errorsOf(row({ packSize: '' }))).toMatch(/Pack size is needed/);
      expect(await errorsOf(row({ packKind: '' }))).toMatch(/Choose a Pack type \(or Loose\)/);
      expect(await errorsOf(row({ price: '' }))).toMatch(/Missing price/);
      expect(await errorsOf(row({ category: '' }))).toMatch(/Missing category/);
      expect(await errorsOf(row({ opening: '-3' }))).toMatch(/Bad stock/);
      expect(await errorsOf(row({ packKind: 'Loose', packSize: '5 kg' }))).toMatch(/1 kg or 1 L/);
      expect(await errorsOf(row({ packKind: 'Loose', packSize: '' }))).toMatch(/1 kg or 1 L/);
      expect(await errorsOf(row({ packKind: 'Loose', packSize: '1 pc' }))).toMatch(/1 kg or 1 L/);
    });

    it('catches the same item twice in one file', async () => {
      const r = await check([row(), row()]);
      expect(r.rows[1].errors.join(' ')).toMatch(/Duplicate of row 2/);
    });
  });

  describe('what a new item gets', () => {
    it('gets the shop default GST, and the Settings value is what is used', async () => {
      await setSetting(ctx.db.k, 'default_gst', '12');
      await owner.post('/api/import/commit', { kind: 'products', rows: [row({ brand: 'Gits', packKind: 'Box', packSize: '12 pc', category: 'Besan' })], fileName: 'a.xlsx' });
      expect((await product('Besan — Gits 12 pc Box')).gstBp).toBe(1200);
      await setSetting(ctx.db.k, 'default_gst', '5');
    });

    it('uses the last part of a nested category as the item, and the first part as the group', async () => {
      await owner.post('/api/import/commit', { kind: 'products', rows: [row({ category: 'Bori > Sugar', brand: 'Dhampur', packKind: 'Bori', packSize: '50 kg', price: '2150', opening: '6' })], fileName: 'b.xlsx' });
      const p = await product('Sugar — Dhampur 50 kg Bori');
      expect(p).toMatchObject({ family: 'Sugar', categoryPath: ['Bori', 'Sugar'] });
      const s = await owner.get('/api/reports/stock-summary');
      const bori = s.groups.find((g: any) => g.name === 'Bori');
      expect(bori.columns.map((c: any) => c.label)).toContain('Sugar 50 kg');
      expect(s.rows.find((r: any) => r.brand === 'Dhampur').cells['Bori\u0000sugar 50 kg'].label).toBe('6 bori');
    });

    it('takes the first Hindi alias as the Hindi name, unless one is typed', async () => {
      await owner.post('/api/import/commit', { kind: 'products', rows: [row({ category: 'Atta', brand: 'Shakti Bhog', packKind: 'Bag', packSize: '10 kg', aliases: 'atta, आटा, gehu, गेहूं' })], fileName: 'c.xlsx' });
      expect(await product('Atta — Shakti Bhog 10 kg Bag')).toMatchObject({ nameHi: 'आटा', aliases: 'atta, आटा, gehu, गेहूं' });
      await owner.post('/api/import/commit', { kind: 'products', rows: [row({ category: 'Maida', brand: 'Shakti Bhog', packKind: 'Bag', packSize: '10 kg', aliases: 'मैदा', nameHi: 'मैदा (बारीक)' })], fileName: 'd.xlsx' });
      expect((await product('Maida — Shakti Bhog 10 kg Bag')).nameHi).toBe('मैदा (बारीक)');
    });
  });

  describe('uploading again', () => {
    it('changes nothing when nothing changed, updates when a price changed', async () => {
      const r = row({ category: 'Poha', brand: 'Rajdhani', packKind: 'Packet', packSize: '500 g', price: '60', opening: '10' });
      await owner.post('/api/import/commit', { kind: 'products', rows: [r], fileName: 'e.xlsx' });
      expect((await check([r])).rows[0].status).toBe('same');
      const dearer = { ...r, price: '65', opening: '99' };
      const prev = await check([dearer]);
      expect(prev.rows[0].status).toBe('update');
      expect(prev.rows[0].notes.join(' ')).toMatch(/price ₹60.00 → ₹65.00/);
      expect(prev.rows[0].notes.join(' ')).toMatch(/Opening stock is ignored for existing items/);
      await owner.post('/api/import/commit', { kind: 'products', rows: [dearer], fileName: 'f.xlsx' });
      const p = await product('Poha — Rajdhani 500 g Packet');
      expect(p.units[0].retail).toBe(6500);
      expect(p.stockMilli).toBe(10000); // stock is not touched by a re-upload
    });

    it('leaves GST, HSN and the Hindi name alone, because this sheet has no such columns', async () => {
      // Made in the form with details the sheet cannot carry.
      const flour = await owner.post('/api/categories', { nameEn: 'Gram Flour' });
      await owner.post('/api/products', {
        nameEn: 'Gram Flour — Rajdhani 25 kg Bag', nameHi: 'बेसन', categoryId: flour.id, brand: 'Rajdhani', family: 'Gram Flour', packSize: '25 kg', packKind: 'bag', hsn: '1106', gstBp: 1800, baseUnit: 'pc', loose: false,
        units: [{ name: 'Bag 25 kg', factorMilli: 1000, isBase: true, retail: 240000 }],
      });
      const sameRow = { category: 'Gram Flour', brand: 'Rajdhani', packKind: 'Bag', packSize: '25 kg', price: '2400' };
      expect((await check([sameRow])).rows[0].status).toBe('same'); // the form's name matches the sheet's name
      await owner.post('/api/import/commit', { kind: 'products', rows: [{ ...sameRow, price: '2500' }], fileName: 'g.xlsx' });
      const p = await product('Gram Flour — Rajdhani 25 kg Bag');
      expect(p.units[0].retail).toBe(250000);
      expect(p).toMatchObject({ gstBp: 1800, hsn: '1106', nameHi: 'बेसन', family: 'Gram Flour' });
    });

    it('recognises an item added earlier under another name, by company, pack type and size, instead of adding it twice', async () => {
      const grain = await owner.post('/api/categories', { nameEn: 'Jowar' });
      await owner.post('/api/products', {
        nameEn: 'Jowar Annapurna sack', categoryId: grain.id, brand: 'Annapurna', family: 'Jowar', packSize: '30 kg', packKind: 'bag', gstBp: 0, baseUnit: 'pc', loose: false,
        units: [{ name: 'Bag 30 kg', factorMilli: 1000, isBase: true, retail: 150000 }],
      });
      const sheet = { category: 'Jowar', brand: 'Annapurna', packKind: 'BAG', packSize: '30kg', price: '1500' };
      expect((await check([sheet])).rows[0].status).toBe('same'); // 'BAG' and '30kg' mean the same thing
      const lower = (await check([{ ...sheet, brand: 'annapurna' }])).rows[0];
      expect(lower.status).toBe('update'); // still the same item, with the brand's spelling changed
      expect(lower.notes).toContain('brand');
      const dearer = (await check([{ ...sheet, price: '1600' }])).rows[0];
      expect(dearer.status).toBe('update');
      await owner.post('/api/import/commit', { kind: 'products', rows: [{ ...sheet, price: '1600' }], fileName: 'j.xlsx' });
      const all = (await owner.get('/api/catalog')).products.filter((x: any) => x.family === 'Jowar');
      expect(all).toHaveLength(1); // not two
      expect(all[0]).toMatchObject({ nameEn: 'Jowar Annapurna sack' }); // keeps its own name
      expect(all[0].units[0].retail).toBe(160000);
      // A different size or company is a different item.
      expect((await check([{ ...sheet, packSize: '50 kg' }])).rows[0].status).toBe('new');
      expect((await check([{ ...sheet, brand: 'Shakti' }])).rows[0].status).toBe('new');
    });

    it('lets an Entry person add new rows but not change existing ones, by the same names', async () => {
      const mine = row({ category: 'Ghee', brand: 'Amul', packKind: 'Tin', packSize: '15 L', price: '9100' });
      await owner.post('/api/import/commit', { kind: 'products', rows: [mine], fileName: 'h.xlsx' });
      expect((await entry.post('/api/import/validate', { kind: 'products', rows: [mine] })).rows[0].status).toBe('same');
      const dearer = (await entry.post('/api/import/validate', { kind: 'products', rows: [{ ...mine, price: '9300' }] })).rows[0];
      expect(dearer.status).toBe('error');
    });
  });

  describe('older, fuller sheets', () => {
    it('still read, with the name, GST and units typed in', async () => {
      const old = { category: 'Sugar > Loose', name: 'Old Sheet Sugar', nameHi: 'पुरानी चीनी', baseUnit: 'kg', units: 'Bag 50 kg = 50', price: '45', unitPrices: 'Bag 50 kg = 2150', gst: '0', hsn: '1701' };
      expect((await check([old])).rows[0].errors).toEqual([]);
      await owner.post('/api/import/commit', { kind: 'products', rows: [old], fileName: 'old.xlsx' });
      const p = await product('Old Sheet Sugar');
      expect(p).toMatchObject({ baseUnit: 'kg', loose: true, gstBp: 0, hsn: '1701', nameHi: 'पुरानी चीनी' });
      expect(p.units.map((u: any) => u.name)).toEqual(['kg', 'Bag 50 kg']);
    });
  });

  describe('adding a pack type', () => {
    it('lets anyone adding products add one, once, and then the sheet and the form accept it', async () => {
      expect(await errorsOf(row({ packKind: 'Sack' }))).toMatch(/not in the list/);
      const made = await entry.post('/api/pack-types', { name: 'Sack' });
      expect(made.value).toBe('sack');
      expect(made.packTypes.map((t: any) => t.value)).toEqual(expect.arrayContaining(['bori', 'bag', 'can', 'sack']));
      expect((await entry.req('POST', '/api/pack-types', { name: 'sacks' })).status).toBe(409); // plural of one that exists
      expect((await entry.req('POST', '/api/pack-types', { name: 'Bag' })).status).toBe(409); // built in
      expect((await entry.req('POST', '/api/pack-types', { name: 'Loose' })).status).toBe(400);
      expect((await entry.req('POST', '/api/pack-types', { name: '<b>x</b>' })).status).toBe(400);
      expect(await errorsOf(row({ packKind: 'Sack', category: 'Rice', packSize: '30 kg' }))).toBe('');
      await owner.post('/api/import/commit', { kind: 'products', rows: [row({ packKind: 'sack', category: 'Rice', packSize: '30 kg', opening: '3' })], fileName: 'i.xlsx' });
      const p = await product('Rice — Annapurna 30 kg Sack');
      expect(p).toMatchObject({ packKind: 'sack', stockMilli: 3000 });
      expect(p.units[0].name).toBe('Sack 30 kg');
      // The product form's own API only takes types from the list.
      const bad = await owner.req('POST', '/api/products', { nameEn: 'X', gstBp: 500, baseUnit: 'pc', packKind: 'crate', units: [{ name: 'Crate', factorMilli: 1000, isBase: true, retail: 100 }] });
      expect(bad.status).toBe(400);
    });

    it('shows the new type in the template dropdown', async () => {
      const login = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sunil@shop.in', password: 'password123' }) });
      const res = await ctx.app.request('/api/import/template/products.xlsx', { headers: { Cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] } });
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await res.arrayBuffer());
      const lists = wb.getWorksheet('Lists')!;
      expect(lists.getColumn(1).values.join(',')).toContain('Sack');
      expect(lists.getColumn(2).values.join(',')).toContain('30 kg'); // a size this shop uses now
    });
  });
});
