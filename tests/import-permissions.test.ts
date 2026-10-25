import { describe, expect, it, beforeAll } from 'vitest';
import { setup, type Client } from './helpers';
import { EXAMPLES } from '../server/lib/importer';

describe('the Entry person uploading a products file', () => {
  let owner: Client;
  let entry: Client;
  const examples = EXAMPLES.products.map((e) => e.row);
  const [sugar, tea, bori] = examples;

  beforeAll(async () => {
    const ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    entry = await ctx.client('amit@shop.in');
    // Sugar and Tea are already in the list.
    await owner.post('/api/import/commit', { kind: 'products', rows: [sugar, tea], fileName: 'owner.xlsx' });
  });

  it('may add new items, including their category and opening stock', async () => {
    const rows = [bori, EXAMPLES.products[3].row];
    const prev = await entry.post('/api/import/validate', { kind: 'products', rows });
    expect(prev.counts).toMatchObject({ new: 2, error: 0 });
    const res = await entry.post('/api/import/commit', { kind: 'products', rows, fileName: 'entry-new.xlsx' });
    expect(res.counts.new).toBe(2);
    const p = (await owner.get('/api/catalog')).products.find((x: any) => x.nameEn === 'Sugar — Dhampur 50 kg');
    expect(p).toMatchObject({ packKind: 'bori', stockMilli: 6000 });
    expect(p.categoryPath).toEqual(['Bori']);
  });

  it('may include rows for existing items that change nothing', async () => {
    const prev = await entry.post('/api/import/validate', { kind: 'products', rows: [sugar, tea] });
    expect(prev.counts).toMatchObject({ same: 2, error: 0 });
  });

  it('cannot change an existing item through a file: that row is an error, and nothing in the file is saved', async () => {
    const dearerSugar = { ...sugar, price: '99', gst: '12' };
    const newItem = { ...examples[5] }; // the tin
    const prev = await entry.post('/api/import/validate', { kind: 'products', rows: [dearerSugar, newItem] });
    expect(prev.rows[0].status).toBe('error');
    expect(prev.rows[0].errors.join(' ')).toMatch(/Only an Owner can change/);
    expect(prev.rows[1].status).toBe('new');
    const r = await entry.req('POST', '/api/import/commit', { kind: 'products', rows: [dearerSugar, newItem], fileName: 'bad.xlsx' });
    expect(r.status).toBe(422);
    const cat = (await owner.get('/api/catalog')).products;
    expect(cat.find((x: any) => x.nameEn === 'Ghee — Amul 15 L')).toBeUndefined(); // all or nothing
    expect(cat.find((x: any) => x.nameEn === 'Sugar').units[0].retail).toBe(4500); // price untouched
  });

  it('still cannot import customer dues or undo an import', async () => {
    expect((await entry.req('POST', '/api/import/commit', { kind: 'customers', rows: [{ name: 'X', amount: '1' }] })).status).toBe(403);
    const imports = await owner.get('/api/imports');
    expect((await entry.req('POST', `/api/imports/${imports[0].id}/undo`)).status).toBe(403);
  });

  it('leaves the Owner free to update existing items from a file', async () => {
    const prev = await owner.post('/api/import/validate', { kind: 'products', rows: [{ ...sugar, price: '46' }] });
    expect(prev.rows[0].status).toBe('update');
    await owner.post('/api/import/commit', { kind: 'products', rows: [{ ...sugar, price: '46' }], fileName: 'owner2.xlsx' });
    expect((await owner.get('/api/catalog')).products.find((x: any) => x.nameEn === 'Sugar').units[0].retail).toBe(4600);
  });
});
