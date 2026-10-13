import { describe, expect, it, beforeAll } from 'vitest';
import { setup, seedCatalog, type Client } from './helpers';
import { istDate, addDays } from '../shared/dates';
import { sql } from 'kysely';

const today = istDate();

describe('Commercia API', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let entry: Client;
  let items: Awaited<ReturnType<typeof seedCatalog>>;
  let sunita: { id: number };

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    entry = await ctx.client('amit@shop.in');
    items = await seedCatalog(owner);
    sunita = await owner.post('/api/customers', { name: 'Sunita Devi', phone: '9800004521' });
    // Opening stock.
    await entry.post('/api/stock-ins', {
      supplier: 'Gupta Traders',
      date: today,
      lines: [
        { productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli: 1000, ratePaise: 200000 },
        { productId: items.oil.id, unitId: items.oil.L, qtyMilli: 10000, ratePaise: 14000 },
        { productId: items.dal.id, unitId: items.dal.kg, qtyMilli: 30000, ratePaise: 12000 },
        { productId: items.soap.id, unitId: items.soap.box, qtyMilli: 4000, ratePaise: 40000 },
      ],
    });
  });

  it('counts stock in base units from deliveries (STK-1, UNIT-4)', async () => {
    const cat = await owner.get('/api/catalog');
    const sugar = cat.products.find((p: any) => p.id === items.sugar.id);
    expect(sugar.stockMilli).toBe(50000);
    expect(cat.products.find((p: any) => p.id === items.soap.id).stockMilli).toBe(48000);
  });

  it('a credit sale: GST, stock, split payment and the ledger (BILL-3, BILL-4, LED-2)', async () => {
    // Opening balance ₹1,250 via the dues import.
    await owner.post('/api/import/commit', { kind: 'customers', rows: [{ name: 'Rakesh Verma', amount: '4320' }], fileName: 'dues.csv', asOf: addDays(today, -10) });
    await ctx.db.k.insertInto('ledger').values({ customer_id: sunita.id, date: addDays(today, -11), kind: 'opening', ref_type: null, ref_id: null, debit_paise: 125000, credit_paise: 0, note: 'Opening balance', import_id: null, created_by: 1, created_at: new Date().toISOString() }).execute();

    const bill = await entry.post('/api/bills', {
      kind: 'tax_invoice',
      customerId: sunita.id,
      billDate: today,
      lines: [
        { productId: items.sugar.id, unitId: items.sugar.kg, qtyMilli: 4000 },
        { productId: items.oil.id, unitId: items.oil.L, qtyMilli: 2000 },
        { productId: items.dal.id, unitId: items.dal.kg, qtyMilli: 2000 },
        { productId: items.soap.id, unitId: items.soap.pc, qtyMilli: 3000 },
      ],
      payments: [{ mode: 'upi', amountPaise: 50000 }],
    });
    expect(bill.total).toBe(93100);
    expect(bill.credit).toBe(43100);
    expect(bill.number).toMatch(/^INV\/\d\d-\d\d\/0001$/);

    const ledger = await owner.get(`/api/customers/${sunita.id}/ledger`);
    expect(ledger.balance).toBe(168100); // 1,250 + 931 − 500 = 1,681

    const cat = await owner.get('/api/catalog');
    expect(cat.products.find((p: any) => p.id === items.sugar.id).stockMilli).toBe(46000);
    expect(cat.products.find((p: any) => p.id === items.soap.id).stockMilli).toBe(45000);
  });

  it('sells bags and kilos on one bill (UNIT-4)', async () => {
    await owner.post('/api/stock-ins', { supplier: 'Gupta Traders', date: today, lines: [{ productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli: 10000, ratePaise: 200000 }] });
    const before = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.sugar.id).stockMilli;
    const bill = await owner.post('/api/bills', {
      kind: 'receipt',
      customerId: sunita.id,
      billDate: today,
      lines: [
        { productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli: 2000 },
        { productId: items.sugar.id, unitId: items.sugar.kg, qtyMilli: 7000 },
      ],
      payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    const after = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.sugar.id).stockMilli;
    expect(before - after).toBe(107000);
    const detail = await owner.get(`/api/bills/${bill.id}`);
    expect(detail.lines[0].rate_paise).toBe(215000); // the bag's own price (UNIT-3)
  });

  it('refuses credit without a customer and a tax invoice without a name (BILL-2)', async () => {
    const r1 = await entry.req('POST', '/api/bills', { kind: 'receipt', billDate: today, lines: [{ productId: items.tea.id, unitId: items.tea.pc, qtyMilli: 1000 }], payments: [] });
    expect(r1.status).toBe(400);
    const r2 = await entry.req('POST', '/api/bills', { kind: 'tax_invoice', billDate: today, lines: [{ productId: items.tea.id, unitId: items.tea.pc, qtyMilli: 1000 }], payments: [{ mode: 'cash', amountPaise: 13700 }] });
    expect(r2.status).toBe(400);
  });

  it('numbers bills in sequence even when saved at the same moment (BILL-5)', async () => {
    const mk = () => entry.post('/api/bills', { kind: 'receipt', billDate: today, lines: [{ productId: items.soap.id, unitId: items.soap.pc, qtyMilli: 1000 }], payments: [{ mode: 'cash', amountPaise: 4200 }] });
    const res = await Promise.all([mk(), mk(), mk()]);
    const seqs = res.map((r) => Number(r.number.split('/').pop())).sort((a, b) => a - b);
    expect(seqs[1] - seqs[0]).toBe(1);
    expect(seqs[2] - seqs[1]).toBe(1);
  });

  it('enforces roles on the server, and logs the refusal (AUTH-3, PILOT-4)', async () => {
    const product = (await entry.get('/api/catalog')).products.find((p: any) => p.id === items.sugar.id);
    const r = await entry.req('PATCH', `/api/products/${items.sugar.id}`, {
      nameEn: 'Sugar', gstBp: 500, baseUnit: 'kg', units: product.units.map((u: any) => ({ ...u, retail: 1 })),
    });
    expect(r.status).toBe(403);
    const r2 = await entry.req('POST', '/api/bills/1/cancel', { reason: 'test' });
    expect(r2.status).toBe(403);
    const log = await owner.get('/api/activity');
    expect(log.some((a: any) => a.action === 'refused' && a.summary.includes('catalog.edit'))).toBe(true);
  });

  it("keeps saved bills unchanged when rates change, and routes the Entry person's rate for approval (RATE-1, RATE-5, RATE-6)", async () => {
    const bill = await entry.post('/api/bills', {
      kind: 'receipt', customerId: sunita.id, billDate: today,
      lines: [{ productId: items.oil.id, unitId: items.oil.L, qtyMilli: 1000, ratePaise: 17000 }],
      payments: [],
    });
    expect(bill.ratePending).toBe(true);
    // Official rate unchanged until approval.
    let oil = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.oil.id);
    expect(oil.units[0].retail).toBe(16000);
    const pending = await owner.get('/api/rates/requests');
    const req = pending.find((r: any) => r.bill_id === bill.id);
    expect(req.old_paise).toBe(16000);
    expect(req.new_paise).toBe(17000);

    // Owner rejects and sets ₹165: the official rate becomes 165 and the bill is corrected.
    const balBefore = (await owner.get(`/api/customers/${sunita.id}/ledger`)).balance;
    await owner.post('/api/rates/requests/decide', { decisions: [{ id: req.id, approve: false, finalPaise: 16500 }] });
    oil = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.oil.id);
    expect(oil.units[0].retail).toBe(16500);
    const detail = await owner.get(`/api/bills/${bill.id}`);
    expect(detail.lines[0].rate_paise).toBe(16500);
    expect(detail.bill.rate_pending).toBe(0);
    const balAfter = (await owner.get(`/api/customers/${sunita.id}/ledger`)).balance;
    expect(balBefore - balAfter).toBe(17900 - 17300); // 170+5% → 165+5%

    // An Owner's own rate applies at once.
    await owner.post('/api/rates/check', { unitId: items.tea.pc, list: 'retail', date: today, pricePaise: 13500 });
    const tea = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.tea.id);
    expect(tea.units[0].retail).toBe(13500);
  });

  it('suggests the rate in force on the bill date, not today (RATE-2)', async () => {
    const yesterday = addDays(today, -1);
    const cat = await owner.get(`/api/catalog?date=${yesterday}`);
    expect(cat.products.find((p: any) => p.id === items.tea.id).units[0].retail).toBe(13000);
  });

  it('cancels a bill: stock and ledger reversed, number kept (BILL-6)', async () => {
    const bill = await owner.post('/api/bills', {
      kind: 'receipt', customerId: sunita.id, billDate: today,
      lines: [{ productId: items.dal.id, unitId: items.dal.kg, qtyMilli: 1000 }],
      payments: [{ mode: 'cash', amountPaise: 5000 }],
    });
    const balBefore = (await owner.get(`/api/customers/${sunita.id}/ledger`)).balance;
    const stockBefore = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.dal.id).stockMilli;
    await owner.post(`/api/bills/${bill.id}/cancel`, { reason: 'Typed twice' });
    const detail = await owner.get(`/api/bills/${bill.id}`);
    expect(detail.bill.status).toBe('cancelled');
    expect(detail.bill.number).toBe(bill.number);
    const stockAfter = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.dal.id).stockMilli;
    expect(stockAfter - stockBefore).toBe(1000);
    const balAfter = (await owner.get(`/api/customers/${sunita.id}/ledger`)).balance;
    expect(balBefore - balAfter).toBe(14000 - 5000);
    const again = await owner.req('POST', `/api/bills/${bill.id}/cancel`, { reason: 'again' });
    expect(again.status).toBe(409);
  });

  it('receives split payments and reverses by entry, never by edit (PAY-2, LED-4)', async () => {
    const before = (await owner.get(`/api/customers/${sunita.id}/ledger`)).balance;
    const p = await entry.post('/api/payments', { customerId: sunita.id, date: today, parts: [{ mode: 'cash', amountPaise: 70000 }, { mode: 'upi', amountPaise: 30000 }] });
    const mid = (await owner.get(`/api/customers/${sunita.id}/ledger`)).balance;
    expect(before - mid).toBe(100000);
    await owner.post(`/api/payments/${p.id}/reverse`, { reason: 'Entered for wrong customer' });
    const led = await owner.get(`/api/customers/${sunita.id}/ledger`);
    expect(led.balance).toBe(before);
    expect(led.entries.filter((e: any) => e.kind === 'reversal').length).toBeGreaterThan(0);
    // The database itself refuses to edit ledger rows (HIST-3).
    await expect(sql`update ledger set debit_paise = 0`.execute(ctx.db.k)).rejects.toThrow(/append-only/);
    await expect(sql`delete from activity`.execute(ctx.db.k)).rejects.toThrow(/append-only/);
  });

  it('dues list total equals the dashboard credit due (LED-5, REP-1)', async () => {
    const customers = await owner.get('/api/customers');
    const due = customers.filter((c: any) => c.balance > 0).reduce((a: number, c: any) => a + c.balance, 0);
    const dash = await owner.get('/api/dashboard');
    expect(dash.due).toBe(due);
    expect(dash.todaySales.count).toBeGreaterThan(0);
  });

  it('day book totals add up (DAY-1, DAY-2, PAY-4)', async () => {
    await owner.post('/api/cash-outs', { date: today, category: 'wages', mode: 'cash', amountPaise: 20000, payee: 'Helper' });
    const day = await owner.get(`/api/reports/daybook?from=${today}`);
    const salesEntries = day.entries.filter((e: any) => e.type === 'bill' && !e.title.includes('cancelled'));
    expect(salesEntries.reduce((a: number, e: any) => a + e.amount, 0)).toBe(day.totals.sales);
    expect(day.totals.paidOut.cash).toBe(20000);
    const reg = await owner.get(`/api/reports/payments?from=${today}`);
    expect(reg.totals.upi).toBe(day.totals.salesSplit.upi + day.totals.received.upi);
  });

  it('GST summary excludes cancelled bills and matches line totals (REP-3)', async () => {
    const g = await owner.get(`/api/reports/gst?month=${today.slice(0, 7)}`);
    const sum = g.byHsn.reduce((a: number, r: any) => a + r.cgst, 0);
    expect(sum).toBe(g.totals.cgst);
    expect(g.byRate.find((r: any) => r.gstBp === 0)).toBeTruthy();
  });

  it('records losses: Entry reports, Owner confirms, found goods reverse (LOSS-1..3)', async () => {
    const stock = async () => (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.sugar.id).stockMilli;
    const s0 = await stock();
    const rep = await entry.post('/api/losses', { reason: 'missing', date: today, lines: [{ productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli: 2000 }] });
    expect(await stock()).toBe(s0);
    await owner.post(`/api/losses/${rep.id}/confirm`, { confirm: true });
    expect(await stock()).toBe(s0 - 100000);
    const losses = await owner.get('/api/losses');
    expect(losses.find((l: any) => l.id === rep.id).value_paise).toBe(400000); // 100 kg at ₹40/kg
    await owner.post(`/api/losses/${rep.id}/reverse`, { reason: '2 bags found in godown', lines: [{ productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli: 2000 }] });
    expect(await stock()).toBe(s0);
  });

  it('estimates do not touch stock and convert in one tap (BILL-12)', async () => {
    const s0 = (await owner.get('/api/catalog')).products.find((p: any) => p.id === items.tea.id).stockMilli;
    const est = await entry.post('/api/bills', { kind: 'receipt', estimate: true, billDate: today, lines: [{ productId: items.tea.id, unitId: items.tea.pc, qtyMilli: 2000 }] });
    expect(est.number).toMatch(/^EST\//);
    expect((await owner.get('/api/catalog')).products.find((p: any) => p.id === items.tea.id).stockMilli).toBe(s0);
    const total = est.total;
    const conv = await entry.post(`/api/bills/${est.id}/convert`, { payments: [{ mode: 'cash', amountPaise: total }] });
    expect(conv.total).toBe(total);
    const e = await owner.get(`/api/bills/${est.id}`);
    expect(e.bill.status).toBe('converted');
    expect(e.converted.number).toBe(conv.number);
  });

  it('signs out a deactivated user on the next request (AUTH-4)', async () => {
    const extra = await owner.post('/api/users', { name: 'Temp', email: 'temp@shop.in', role: 'entry', password: 'password123' });
    const temp = await ctx.client('temp@shop.in');
    expect((await temp.req('GET', '/api/account/me')).status).toBe(200);
    await owner.patch(`/api/users/${extra.id}`, { active: false });
    expect((await temp.req('GET', '/api/account/me')).status).toBe(401);
  });
});

describe('spreadsheet import', () => {
  it('previews, creates categories, saves all rows, re-import changes nothing, undo works (IMP-3..7)', async () => {
    const ctx = await setup();
    const owner = await ctx.client('sunil@shop.in');
    const rows = [
      { category: 'Oil > Saffola > Sunflower', name: 'Saffola Sunflower 1 L', nameHi: '', baseUnit: 'pc', price: '180', gst: '5', hsn: '1512', units: 'Box of 12 = 12', unitPrices: 'Box of 12 = 2100', opening: '2 Box of 12', reorder: '6', cost: '160', aliases: 'saffola' },
      { category: 'Sugar > Loose', name: 'Sugar', nameHi: 'चीनी', baseUnit: 'kg', price: '45', gst: '5', units: 'Bag 50 kg = 50', opening: '12 Bag 50 kg', aliases: 'chini' },
      { category: 'Dal', name: 'Bad row', baseUnit: 'kg', price: 'abc', gst: '7' },
    ];
    const prev = await owner.post('/api/import/validate', { kind: 'products', rows });
    expect(prev.counts).toMatchObject({ new: 2, error: 1 });
    expect(prev.rows[2].errors.join(' ')).toMatch(/price/);
    expect(prev.newCategories).toContain('Oil > Saffola > Sunflower');

    const bad = await owner.req('POST', '/api/import/commit', { kind: 'products', rows });
    expect(bad.status).toBe(422);
    // Nothing saved after a failure (IMP-6).
    expect((await owner.get('/api/catalog')).products.length).toBe(0);

    const good = rows.slice(0, 2);
    const res = await owner.post('/api/import/commit', { kind: 'products', rows: good, fileName: 'p.xlsx' });
    expect(res.counts.new).toBe(2);
    const cat = await owner.get('/api/catalog');
    const sugar = cat.products.find((p: any) => p.nameEn === 'Sugar');
    expect(sugar.stockMilli).toBe(600000);
    const saff = cat.products.find((p: any) => p.nameEn.startsWith('Saffola'));
    expect(saff.units.find((u: any) => u.name === 'Box of 12').retail).toBe(210000);
    expect(saff.categoryPath).toEqual(['Oil', 'Saffola', 'Sunflower']);

    const again = await owner.post('/api/import/validate', { kind: 'products', rows: good });
    expect(again.counts).toMatchObject({ new: 0, update: 0, same: 2 });

    const imports = await owner.get('/api/imports');
    await owner.post(`/api/imports/${imports[0].id}/undo`);
    expect((await owner.get('/api/catalog')).products.length).toBe(0);
  });

  it('imports customer dues with duplicate checks and advances (MIG-1..5)', async () => {
    const ctx = await setup();
    const owner = await ctx.client('sunil@shop.in');
    const dup = await owner.post('/api/import/validate', { kind: 'customers', rows: [{ name: 'Ramesh', amount: '100' }, { name: 'Ramesh', amount: '200' }] });
    expect(dup.counts.error).toBe(2);
    await owner.post('/api/import/commit', {
      kind: 'customers',
      rows: [{ name: 'Ramesh', amount: '100', area: 'Aminabad' }, { name: 'Ramesh', amount: '200', area: 'Chowk' }, { name: 'Pooja', amount: '-500' }],
      asOf: '2026-10-01',
    });
    const customers = await owner.get('/api/customers');
    expect(customers.length).toBe(3);
    const pooja = customers.find((c: any) => c.name === 'Pooja');
    expect(pooja.balance).toBe(-50000);
    const led = await owner.get(`/api/customers/${pooja.id}/ledger`);
    expect(led.entries[0].note).toBe('Opening balance as on 01-10-2026');
    // Filling in a phone later leaves the balance alone (MIG-3).
    await owner.patch(`/api/customers/${pooja.id}`, { name: 'Pooja', phone: '9811112222' });
    expect((await owner.get(`/api/customers/${pooja.id}/ledger`)).balance).toBe(-50000);
  });
});
