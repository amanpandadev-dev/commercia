import { describe, expect, it, beforeAll } from 'vitest';
import { sql } from 'kysely';
import { setup, seedCatalog, type Client } from './helpers';
import { istDate, addDays } from '../shared/dates';

const today = istDate();

describe('suppliers and the purchase ledger', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let entry: Client;
  let items: Awaited<ReturnType<typeof seedCatalog>>;
  const sugarBags = (qtyMilli: number, ratePaise?: number) => ({ productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli, ...(ratePaise ? { ratePaise } : {}) });
  const ledger = async (id: number, qs = '') => owner.get(`/api/supplier-ledger/${id}${qs}`);
  const supplierId = async (name: string) => (await owner.get('/api/supplier-ledger')).find((s: any) => s.name === name).id;

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    entry = await ctx.client('amit@shop.in');
    items = await seedCatalog(owner);
  });

  it('puts the invoice amount on what we owe when a named supplier delivers, and the part paid now comes off it', async () => {
    const res = await owner.post('/api/stock-ins', {
      supplier: 'Gupta Traders', date: today, invoiceNo: 'GT-101', amountPaise: 400000,
      payments: [{ mode: 'cash', amountPaise: 100000 }, { mode: 'upi', amountPaise: 50000, reference: 'UTR123' }],
      lines: [sugarBags(2000, 200000)],
    });
    expect(res.id).toBeGreaterThan(0);
    const id = await supplierId('Gupta Traders');
    const l = await ledger(id);
    expect(l.balance).toBe(250000); // 4000 invoice - 1500 paid now
    expect(l.entries.map((e: any) => e.kind)).toEqual(['purchase', 'payment', 'payment']);
    expect(l.entries[0]).toMatchObject({ owed_paise: 400000, invoiceNo: 'GT-101' });
    expect(l.entries[2]).toMatchObject({ mode: 'upi', paid_paise: 50000 });
    expect(l.entries[2].note).toContain('UTR123');
    // The payments also left the till, so the day's cash flow shows them going out.
    const flow = await owner.get(`/api/reports/cashflow?from=${today}&to=${today}`);
    expect(flow.modes.find((m: any) => m.mode === 'cash').outTotal).toBe(100000);
    expect(flow.modes.find((m: any) => m.mode === 'upi').out[0]).toMatchObject({ name: 'Gupta Traders', category: 'supplier', amount: 50000 });
  });

  it('defaults the invoice amount to the lines, and refuses overpaying or paying nobody', async () => {
    const r = await owner.post('/api/stock-ins', { supplier: 'Mehta & Sons', date: today, lines: [sugarBags(1000, 210000)] });
    expect(r.id).toBeGreaterThan(0);
    expect((await ledger(await supplierId('Mehta & Sons'))).balance).toBe(210000);
    const over = await owner.req('POST', '/api/stock-ins', { supplier: 'Mehta & Sons', date: today, amountPaise: 1000, payments: [{ mode: 'cash', amountPaise: 2000 }], lines: [sugarBags(1000)] });
    expect(over.status).toBe(400);
    const nobody = await owner.req('POST', '/api/stock-ins', { supplier: '', date: today, amountPaise: 5000, payments: [{ mode: 'cash', amountPaise: 1000 }], lines: [sugarBags(1000)] });
    expect(nobody.status).toBe(400);
    // Nothing was saved by the refused ones.
    expect((await ledger(await supplierId('Mehta & Sons'))).balance).toBe(210000);
  });

  it('matches supplier names however they are capitalised, and leaves no account when no supplier is named', async () => {
    const before = (await owner.get('/api/supplier-ledger')).length;
    await owner.post('/api/stock-ins', { supplier: 'gupta traders ', date: today, amountPaise: 50000, lines: [sugarBags(1000)] });
    await owner.post('/api/stock-ins', { supplier: '', date: today, lines: [sugarBags(1000)] });
    expect((await owner.get('/api/supplier-ledger')).length).toBe(before);
    expect((await ledger(await supplierId('Gupta Traders'))).balance).toBe(300000);
  });

  it('lets the Entry person record a delivery and its invoice amount, but not pay, nor see what is owed', async () => {
    const r = await entry.post('/api/stock-ins', { supplier: 'Mehta & Sons', date: today, invoiceNo: 'M-7', amountPaise: 30000, lines: [sugarBags(1000)] });
    expect(r.id).toBeGreaterThan(0);
    expect((await ledger(await supplierId('Mehta & Sons'))).balance).toBe(240000);
    const pay = await entry.req('POST', '/api/stock-ins', { supplier: 'Mehta & Sons', date: today, amountPaise: 30000, payments: [{ mode: 'cash', amountPaise: 30000 }], lines: [sugarBags(1000)] });
    expect(pay.status).toBe(403);
    expect((await entry.req('GET', '/api/supplier-ledger')).status).toBe(403);
    expect((await entry.req('POST', `/api/suppliers/${await supplierId('Mehta & Sons')}/payments`, { date: today, parts: [{ mode: 'cash', amountPaise: 100 }] })).status).toBe(403);
    expect((await entry.get('/api/suppliers'))).toContain('Mehta & Sons'); // names for the Stock in screen
    expect((await entry.get('/api/dashboard')).payable).toBeNull();
    expect((await owner.get('/api/dashboard')).payable).toBeGreaterThan(0);
  });

  it('records a later payment in several modes, and reverses it with both rows kept', async () => {
    const id = await supplierId('Mehta & Sons');
    const before = (await ledger(id)).balance;
    await owner.post(`/api/suppliers/${id}/payments`, { date: today, parts: [{ mode: 'cash', amountPaise: 100000 }, { mode: 'cheque', amountPaise: 40000, reference: 'CHQ 55' }], note: 'Settling' });
    let l = await ledger(id);
    expect(l.balance).toBe(before - 140000);
    const pay = l.entries.find((e: any) => e.mode === 'cheque');
    expect(pay.note).toContain('CHQ 55');

    const outsBefore = (await owner.get(`/api/reports/cashflow?from=${today}&to=${today}`)).modes.find((m: any) => m.mode === 'cheque').outTotal;
    expect(outsBefore).toBe(40000);
    await owner.post(`/api/supplier-ledger/entries/${pay.id}/reverse`, { reason: 'Cheque bounced' });
    l = await ledger(id);
    expect(l.balance).toBe(before - 100000);
    expect(l.entries.find((e: any) => e.id === pay.id).reversed).toBe(1);
    expect(l.entries.some((e: any) => e.kind === 'reversal' && e.owed_paise === 40000)).toBe(true);
    expect((await owner.get(`/api/reports/cashflow?from=${today}&to=${today}`)).modes.find((m: any) => m.mode === 'cheque').outTotal).toBe(0);
    expect((await owner.req('POST', `/api/supplier-ledger/entries/${pay.id}/reverse`, { reason: 'again' })).status).toBe(409);
    expect((await owner.req('POST', `/api/supplier-ledger/entries/${l.entries[0].id}/reverse`, { reason: 'not a payment' })).status).toBe(400);
    expect((await entry.req('POST', `/api/supplier-ledger/entries/${pay.id}/reverse`, { reason: 'x' })).status).toBe(403);
  });

  it('keeps ledger rows from being edited or deleted, and fixes a wrong invoice with a visible correction', async () => {
    const id = await supplierId('Gupta Traders');
    await expect(sql`UPDATE supplier_ledger SET owed_paise = 1 WHERE supplier_id = ${id}`.execute(ctx.db.k)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM supplier_ledger WHERE supplier_id = ${id}`.execute(ctx.db.k)).rejects.toThrow(/append-only/);
    const before = (await ledger(id)).balance;
    await owner.post(`/api/suppliers/${id}/corrections`, { date: today, direction: 'paid', amountPaise: 5000, reason: 'Invoice GT-101 was ₹50 less' });
    const l = await ledger(id);
    expect(l.balance).toBe(before - 5000);
    expect(l.entries[l.entries.length - 1]).toMatchObject({ kind: 'correction', paid_paise: 5000 });
    expect((await owner.req('POST', `/api/suppliers/${id}/corrections`, { date: today, direction: 'owed', amountPaise: 100, reason: '' })).status).toBe(400);
  });

  it('adds a supplier with an opening balance, refuses a duplicate name, and renames', async () => {
    const r = await owner.post('/api/suppliers', { name: 'Kanpur Agro', phone: '9811100000', area: 'Kanpur', openingPaise: 123400, asOf: '2026-10-01' });
    const l = await ledger(r.id);
    expect(l.balance).toBe(123400);
    expect(l.entries[0]).toMatchObject({ kind: 'opening', note: 'Opening balance as on 01-10-2026' });
    expect((await owner.req('POST', '/api/suppliers', { name: 'KANPUR AGRO' })).status).toBe(409);
    await owner.patch(`/api/suppliers/${r.id}`, { name: 'Kanpur Agro Ltd', phone: '9811100000', area: 'Kanpur' });
    expect((await ledger(r.id)).supplier.name).toBe('Kanpur Agro Ltd');
    expect((await owner.req('PATCH', `/api/suppliers/${r.id}`, { name: 'gupta traders' })).status).toBe(409);
    expect((await entry.req('POST', '/api/suppliers', { name: 'Nope' })).status).toBe(403);
  });

  it('filters the list by name, dues and how overdue, and the statement by dates, type and mode', async () => {
    const old = await owner.post('/api/suppliers', { name: 'Old Dues Co', openingPaise: 80000, asOf: addDays(today, -45) });
    const q = await owner.get('/api/supplier-ledger?q=old%20dues');
    expect(q.map((s: any) => s.name)).toEqual(['Old Dues Co']);
    expect((await owner.get('/api/supplier-ledger?due=1')).every((s: any) => s.balance > 0)).toBe(true);
    const overdue = await owner.get('/api/supplier-ledger?overdue=30');
    expect(overdue.map((s: any) => s.name)).toContain('Old Dues Co');
    expect(overdue.map((s: any) => s.name)).not.toContain('Gupta Traders'); // everything of theirs is from today
    expect(overdue.find((s: any) => s.name === 'Old Dues Co').ageing).toMatchObject({ b30: 80000, oldest: addDays(today, -45) });
    expect((await owner.get('/api/supplier-ledger?overdue=60')).map((s: any) => s.name)).not.toContain('Old Dues Co');

    await owner.post(`/api/suppliers/${old.id}/payments`, { date: addDays(today, -10), parts: [{ mode: 'upi', amountPaise: 30000 }] });
    await owner.post(`/api/suppliers/${old.id}/payments`, { date: addDays(today, -2), parts: [{ mode: 'cash', amountPaise: 10000 }] });
    const all = await ledger(old.id);
    expect(all.balance).toBe(40000);
    expect(all.entries.map((e: any) => e.balance)).toEqual([80000, 50000, 40000]); // running balance
    const upi = await ledger(old.id, '?mode=upi');
    expect(upi.entries).toHaveLength(1);
    expect(upi.entries[0].balance).toBe(50000); // true balance even when filtered
    expect(upi.totals).toEqual({ purchased: 0, paid: 30000 });
    expect((await ledger(old.id, '?type=purchases')).entries.map((e: any) => e.kind)).toEqual(['opening']);
    expect((await ledger(old.id, '?type=payments')).entries).toHaveLength(2);
    const recent = await ledger(old.id, `?from=${addDays(today, -5)}`);
    expect(recent.opening).toBe(50000);
    expect(recent.entries).toHaveLength(1);
    expect(recent.closing).toBe(40000);
  });

  it('puts an imported delivery on the purchase ledger too: quantity × rate', async () => {
    await owner.post('/api/import/commit', {
      kind: 'stock', fileName: 's.xlsx',
      rows: [{ date: addDays(today, -20), supplier: 'Historic Mills', product: 'Sugar', qty: '1', unit: 'Bag 50 kg', rate: '2000' }],
    });
    const h = (await owner.get('/api/supplier-ledger')).find((s: any) => s.name === 'Historic Mills');
    expect(h).toBeTruthy();
    expect(h.balance).toBe(200000); // 1 bag at 2,000
    const l = await ledger(h.id);
    expect(l.entries.map((e: any) => [e.kind, e.owed_paise])).toEqual([['purchase', 200000]]);
    expect(l.entries[0].date).toBe(addDays(today, -20));
  });

  it('is wiped with the rest of the test data before go-live', async () => {
    const admin = await ctx.client('ramesh@shop.in');
    await admin.post('/api/admin/reset', { confirm: 'Sharma Kirana Store' });
    expect((await admin.get('/api/supplier-ledger')).length).toBe(0);
    expect((await ctx.db.k.selectFrom('supplier_ledger').select('id').execute()).length).toBe(0);
  });
});
