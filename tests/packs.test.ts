import { describe, expect, it, beforeAll } from 'vitest';
import { setup, type Client } from './helpers';
import { istDate, addDays } from '../shared/dates';
import { baseLabel, cartonUnitName, packUnitName, stockLabel } from '../shared/units';

const today = istDate();

describe('whole-pack items (bori, bag, tin, pouch)', () => {
  let owner: Client;
  let entry: Client;
  let catId: Record<string, number>;
  const product = async (body: object) => owner.post('/api/products', body);
  const whole = (name: string, extra: object) => ({
    nameEn: name, gstBp: 0, baseUnit: 'pc', loose: false, packKind: 'bag', stepMilli: 1000,
    units: [{ name: 'Bag 25 kg', factorMilli: 1000, isBase: true, retail: 110000 }], ...extra,
  });

  beforeAll(async () => {
    const ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    entry = await ctx.client('amit@shop.in');
    catId = {};
    for (const n of ['Bag', 'Bori', 'Refined']) catId[n] = (await owner.post('/api/categories', { nameEn: n, parentId: null })).id;
  });

  it('labels packs by what they are, and cartons as bigger units', () => {
    expect(packUnitName('bori', '50 kg')).toBe('Bori 50 kg');
    expect(packUnitName('tin', '15 L')).toBe('Tin 15 L');
    expect(cartonUnitName(12, '1 L')).toBe('Carton (12 × 1 L)');
    expect(cartonUnitName(24, '')).toBe('Carton of 24');
    expect(baseLabel('pc', 7000, 'bag')).toBe('7 bags');
    expect(baseLabel('pc', 1000, 'bag')).toBe('1 bag');
    expect(baseLabel('pc', 3000, 'bori')).toBe('3 bori');
    expect(baseLabel('pc', 3000)).toBe('3 pcs');
    expect(baseLabel('kg', 3000, 'bag')).toBe('3 kg'); // loose items ignore the pack word
    const units = [{ name: 'Pouch 1 L', factorMilli: 1000 }, { name: 'Carton (12 × 1 L)', factorMilli: 12000 }];
    expect(stockLabel(30000, 'pc', units, 'pouch')).toBe('2 × Carton (12 × 1 L) + 6 pouches');
  });

  it('keeps one product per item, company and pack size, each with its own price and stock', async () => {
    const a = await product(whole('Sooji — Annapurna 25 kg', { categoryId: catId.Bag, brand: 'Annapurna', family: 'Sooji', packSize: '25 kg' }));
    const b = await product(whole('Sooji — Shakti 25 kg', { categoryId: catId.Bag, brand: 'Shakti', family: 'Sooji', packSize: '25 kg', units: [{ name: 'Bag 25 kg', factorMilli: 1000, isBase: true, retail: 120000 }] }));
    const cat = await owner.get('/api/catalog');
    const pa = cat.products.find((p: any) => p.id === a.id);
    const pb = cat.products.find((p: any) => p.id === b.id);
    expect(pa).toMatchObject({ family: 'Sooji', packSize: '25 kg', packKind: 'bag', loose: false, brand: 'Annapurna' });
    expect(pa.units[0].retail).toBe(110000);
    expect(pb.units[0].retail).toBe(120000);

    await entry.post('/api/stock-ins', { supplier: 'Gupta Traders', date: today, lines: [{ productId: a.id, unitId: pa.units[0].id, qtyMilli: 10000, ratePaise: 100000 }, { productId: b.id, unitId: pb.units[0].id, qtyMilli: 4000, ratePaise: 110000 }] });
    await owner.post('/api/bills', { kind: 'receipt', billDate: today, lines: [{ productId: a.id, unitId: pa.units[0].id, qtyMilli: 3000 }], payments: [{ mode: 'cash', amountPaise: 330000 }] });
    const after = await owner.get('/api/catalog');
    expect(after.products.find((p: any) => p.id === a.id).stockMilli).toBe(7000);
    expect(after.products.find((p: any) => p.id === b.id).stockMilli).toBe(4000);
  });

  it('refuses a whole-pack item that is also sold loose or counted in kg', async () => {
    const r1 = await owner.req('POST', '/api/products', whole('Bad A', { loose: true }));
    expect(r1.status).toBe(400);
    const r2 = await owner.req('POST', '/api/products', whole('Bad B', { baseUnit: 'kg', units: [{ name: 'kg', factorMilli: 1000, isBase: true, retail: 4500 }] }));
    expect(r2.status).toBe(400);
  });

  it('lays stock out by category, item and pack size against companies, with cartons broken down (stock summary)', async () => {
    const oil = await product({
      nameEn: 'Fortune Refined 1 L', gstBp: 500, baseUnit: 'pc', loose: false, packKind: 'pouch', categoryId: catId.Refined, brand: 'Fortune', family: 'Refined Oil', packSize: '1 L',
      units: [{ name: 'Pouch 1 L', factorMilli: 1000, isBase: true, retail: 15000 }, { name: 'Carton (12 × 1 L)', factorMilli: 12000, isBase: false, retail: 175000 }],
    });
    const cat = await owner.get('/api/catalog');
    const po = cat.products.find((p: any) => p.id === oil.id);
    await entry.post('/api/stock-ins', { supplier: 'Gupta Traders', date: today, lines: [{ productId: oil.id, unitId: po.units.find((u: any) => u.isBase).id, qtyMilli: 30000, ratePaise: 14000 }] });

    const s = await entry.get('/api/reports/stock-summary'); // the Entry person may look at stock
    expect(s.asOf).toBe(today);
    expect(s.groups.map((g: any) => g.name)).toEqual(['Bag', 'Refined']);
    const bag = s.groups.find((g: any) => g.name === 'Bag');
    expect(bag.columns.map((c: any) => c.label)).toEqual(['Sooji 25 kg']);
    const ann = s.rows.find((r: any) => r.brand === 'Annapurna');
    expect(ann.cells['Bag\u0000sooji 25 kg']).toMatchObject({ qtyMilli: 7000, label: '7 bags' });
    expect(s.rows.find((r: any) => r.brand === 'Shakti').cells['Bag\u0000sooji 25 kg'].label).toBe('4 bags');
    expect(s.rows.find((r: any) => r.brand === 'Fortune').cells['Refined\u0000refined oil 1 l'].label).toBe('2 × Carton (12 × 1 L) + 6 pouches');
    expect(ann.cells['Refined\u0000refined oil 1 l']).toBeUndefined();
  });

  it('shows the stock as it stood on an earlier day', async () => {
    const cat = await owner.get('/api/catalog');
    const a = cat.products.find((p: any) => p.brand === 'Annapurna');
    // Everything above happened today; yesterday there was nothing.
    const y = await owner.get(`/api/reports/stock-summary?asOf=${addDays(today, -1)}`);
    expect(y.rows.find((r: any) => r.brand === 'Annapurna').cells['Bag\u0000sooji 25 kg'].qtyMilli).toBe(0);
    await owner.post('/api/stock/adjust', { productId: a.id, unitId: a.units[0].id, qtyMilli: 2000, reason: 'Found two bags' });
    const t = await owner.get(`/api/reports/stock-summary?asOf=${today}`);
    expect(t.rows.find((r: any) => r.brand === 'Annapurna').cells['Bag\u0000sooji 25 kg'].qtyMilli).toBe(9000);
    expect((await owner.req('GET', `/api/reports/stock-summary?asOf=${addDays(today, 3)}`)).status).toBe(400);
  });

  it('imports pack type, family and size, and names the base unit after the pack', async () => {
    const rows = [{ category: 'Bori', name: 'Suji — Aashirvaad 50 kg', baseUnit: '', packKind: 'Bori', packSize: '50 kg', family: 'Sooji', brand: 'Aashirvaad', price: '2400', gst: '0', opening: '5' }];
    const prev = await owner.post('/api/import/validate', { kind: 'products', rows });
    expect(prev.counts).toMatchObject({ new: 1, error: 0 });
    await owner.post('/api/import/commit', { kind: 'products', rows, fileName: 'p.xlsx' });
    const p = (await owner.get('/api/catalog')).products.find((x: any) => x.brand === 'Aashirvaad');
    expect(p).toMatchObject({ packKind: 'bori', packSize: '50 kg', family: 'Sooji', baseUnit: 'pc', loose: false, stockMilli: 5000 });
    expect(p.units[0].name).toBe('Bori 50 kg');
    const bad = await owner.post('/api/import/validate', { kind: 'products', rows: [{ ...rows[0], name: 'X', packKind: 'sack' }] });
    expect(bad.rows[0].errors.join(' ')).toMatch(/Pack type/);
  });
});
