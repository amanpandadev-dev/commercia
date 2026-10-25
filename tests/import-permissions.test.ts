import { describe, expect, it, beforeAll } from 'vitest';
import { setup, type Client } from './helpers';
import { EXAMPLES } from '../server/lib/importer';

describe('the Entry person uploading a products file', () => {
  let owner: Client;
  let entry: Client;
  const [dhampur, balrampur, sooji, refined, can] = EXAMPLES.products.map((e) => e.row);
  const retail = async (name: string) => (await owner.get('/api/catalog')).products.find((x: any) => x.nameEn === name)?.units[0].retail;

  beforeAll(async () => {
    const ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    entry = await ctx.client('amit@shop.in');
    // The two Sugar boris are already in the list.
    await owner.post('/api/import/commit', { kind: 'products', rows: [dhampur, balrampur], fileName: 'owner.xlsx' });
  });

  it('may add new items, including their category and stock', async () => {
    const rows = [sooji, refined];
    const prev = await entry.post('/api/import/validate', { kind: 'products', rows });
    expect(prev.counts).toMatchObject({ new: 2, error: 0 });
    const res = await entry.post('/api/import/commit', { kind: 'products', rows, fileName: 'entry-new.xlsx' });
    expect(res.counts.new).toBe(2);
    const p = (await owner.get('/api/catalog')).products.find((x: any) => x.nameEn === 'Sooji — Annapurna 25 kg Bag');
    expect(p).toMatchObject({ packKind: 'bag', stockMilli: 8000 });
    expect(p.categoryPath).toEqual(['Sooji']);
  });

  it('may include rows for existing items that change nothing', async () => {
    const prev = await entry.post('/api/import/validate', { kind: 'products', rows: [dhampur, balrampur] });
    expect(prev.counts).toMatchObject({ same: 2, error: 0 });
  });

  it('cannot change an existing item through a file: that row is an error, and nothing in the file is saved', async () => {
    const dearer = { ...dhampur, price: '2200' };
    const prev = await entry.post('/api/import/validate', { kind: 'products', rows: [dearer, can] });
    expect(prev.rows[0].status).toBe('error');
    expect(prev.rows[0].errors.join(' ')).toMatch(/Only an Owner can change/);
    expect(prev.rows[1].status).toBe('new');
    const r = await entry.req('POST', '/api/import/commit', { kind: 'products', rows: [dearer, can], fileName: 'bad.xlsx' });
    expect(r.status).toBe(422);
    expect(await retail('Mustard Oil — Fortune 15 L Can')).toBeUndefined(); // all or nothing
    expect(await retail('Sugar — Dhampur 50 kg Bori')).toBe(215000); // price untouched
  });

  it('still cannot import customer dues', async () => {
    expect((await entry.req('POST', '/api/import/commit', { kind: 'customers', rows: [{ name: 'X', amount: '1' }] })).status).toBe(403);
  });

  it('can undo an import they made themselves, and only while it is the latest', async () => {
    await entry.post('/api/import/commit', { kind: 'products', rows: [can], fileName: 'mine.xlsx' });
    expect(await retail('Mustard Oil — Fortune 15 L Can')).toBe(230000);
    const mine = (await entry.get('/api/imports'))[0];
    expect(mine.created_by).toBeGreaterThan(0);
    await entry.post(`/api/imports/${mine.id}/undo`);
    expect(await retail('Mustard Oil — Fortune 15 L Can')).toBeUndefined();
    expect((await entry.get('/api/imports'))[0].undone).toBe(1);
    expect((await entry.req('POST', `/api/imports/${mine.id}/undo`)).status).toBe(409); // twice is refused, as for anyone
  });

  it("cannot undo an Owner's import, and the refusal is logged", async () => {
    await owner.post('/api/import/commit', { kind: 'products', rows: [can], fileName: 'owners.xlsx' });
    const theirs = (await owner.get('/api/imports'))[0];
    expect((await entry.req('POST', `/api/imports/${theirs.id}/undo`)).status).toBe(403);
    expect((await owner.get('/api/activity')).some((a: any) => a.action === 'refused' && a.summary.includes('import.undo'))).toBe(true);
    expect((await entry.req('POST', '/api/imports/99999/undo')).status).toBe(403);
    await owner.post(`/api/imports/${theirs.id}/undo`); // the Owner still can
  });

  it('leaves the Owner free to update existing items from a file', async () => {
    const dearer = { ...dhampur, price: '2200' };
    const prev = await owner.post('/api/import/validate', { kind: 'products', rows: [dearer] });
    expect(prev.rows[0].status).toBe('update');
    await owner.post('/api/import/commit', { kind: 'products', rows: [dearer], fileName: 'owner2.xlsx' });
    expect(await retail('Sugar — Dhampur 50 kg Bori')).toBe(220000);
  });
});
