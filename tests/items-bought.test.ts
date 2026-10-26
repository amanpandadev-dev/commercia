import { describe, expect, it, beforeAll } from 'vitest';
import { setup, seedCatalog, type Client } from './helpers';
import { istDate, addDays } from '../shared/dates';

const today = istDate();

describe('what was bought, under the ledgers', () => {
  let owner: Client;
  let items: Awaited<ReturnType<typeof seedCatalog>>;
  let sunita: { id: number };

  beforeAll(async () => {
    const ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    items = await seedCatalog(owner);
    sunita = await owner.post('/api/customers', { name: 'Sunita Devi', phone: '9800004521' });
  });

  describe('a customer', () => {
    const bill = (billDate: string, lines: object[], extra: object = {}) => owner.post('/api/bills', { kind: 'tax_invoice', customerId: sunita.id, billDate, lines, ...extra });
    const ledger = (qs = '') => owner.get(`/api/customers/${sunita.id}/ledger${qs}`);

    it('gets one row per item and unit, added up across bills, with the dated entries untouched', async () => {
      await bill(addDays(today, -5), [
        { productId: items.sugar.id, unitId: items.sugar.kg, qtyMilli: 4000 }, // ₹180
        { productId: items.oil.id, unitId: items.oil.L, qtyMilli: 2000 }, // ₹320
      ]);
      await bill(today, [
        { productId: items.sugar.id, unitId: items.sugar.kg, qtyMilli: 3000 }, // ₹135
        { productId: items.soap.id, unitId: items.soap.box, qtyMilli: 1000 }, // ₹450
      ]);
      const l = await ledger();
      expect(l.entries.map((e: any) => e.kind)).toEqual(['bill', 'bill']); // still by date, one row per bill
      expect(l.items.map((i: any) => [i.name, i.unit, i.qtyMilli, i.amountPaise, i.times])).toEqual([
        ['Bath Soap', 'Box of 12', 1000, 45000, 1],
        ['Fortune Mustard Oil 1 L', 'L', 2000, 32000, 1],
        ['Sugar', 'kg', 7000, 31500, 2],
      ]);
      expect(l.items.find((i: any) => i.name === 'Sugar').lastDate).toBe(today);
    });

    it('follows the date filter', async () => {
      const l = await ledger(`?from=${today}`);
      expect(l.items.map((i: any) => i.name).sort()).toEqual(['Bath Soap', 'Sugar']);
      expect(l.items.find((i: any) => i.name === 'Sugar')).toMatchObject({ qtyMilli: 3000, amountPaise: 13500, times: 1 });
      const old = await ledger(`?to=${addDays(today, -1)}`);
      expect(old.items.map((i: any) => i.name).sort()).toEqual(['Fortune Mustard Oil 1 L', 'Sugar']);
    });

    it('leaves out a cancelled bill', async () => {
      const b = await bill(today, [{ productId: items.dal.id, unitId: items.dal.kg, qtyMilli: 10000 }]);
      expect((await ledger()).items.some((i: any) => i.name === 'Toor Dal (loose)')).toBe(true);
      await owner.post(`/api/bills/${b.id}/cancel`, { reason: 'Typed twice' });
      expect((await ledger()).items.some((i: any) => i.name === 'Toor Dal (loose)')).toBe(false);
    });

    it('counts the amount after the bill discount', async () => {
      await bill(today, [{ productId: items.tea.id, unitId: items.tea.pc, qtyMilli: 2000 }], { discount: { type: 'amount', value: 1000 } }); // 2 × ₹130 = ₹260, less ₹10
      expect((await ledger()).items.find((i: any) => i.name === 'Tea 250g')).toMatchObject({ qtyMilli: 2000, amountPaise: 25000 });
    });

    it('is empty for a customer who bought nothing', async () => {
      const other = await owner.post('/api/customers', { name: 'Nobody Yet', phone: '9800000000' });
      expect((await owner.get(`/api/customers/${other.id}/ledger`)).items).toEqual([]);
    });
  });

  describe('a supplier', () => {
    const delivery = (supplier: string, date: string, lines: object[]) => owner.post('/api/stock-ins', { supplier, date, lines });
    const statement = async (name: string, qs = '') => {
      const id = (await owner.get('/api/supplier-ledger')).find((s: any) => s.name === name).id;
      return owner.get(`/api/supplier-ledger/${id}${qs}`);
    };

    beforeAll(async () => {
      await delivery('Gupta Traders', addDays(today, -9), [{ productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli: 2000, ratePaise: 200000 }]); // 4,000
      await delivery('Gupta Traders', today, [
        { productId: items.sugar.id, unitId: items.sugar.bag, qtyMilli: 1000, ratePaise: 210000 }, // 2,100
        { productId: items.sugar.id, unitId: items.sugar.kg, qtyMilli: 20000, ratePaise: 4000 }, // 800, a different unit
        { productId: items.dal.id, unitId: items.dal.kg, qtyMilli: 5500, ratePaise: 12000 }, // 660
      ]);
      await delivery('Other Mills', today, [{ productId: items.oil.id, unitId: items.oil.L, qtyMilli: 10000, ratePaise: 14000 }]);
    });

    it('lists the items bought, per item and unit, with quantity × rate as the amount', async () => {
      const s = await statement('Gupta Traders');
      expect(s.entries.map((e: any) => e.kind)).toEqual(['purchase', 'purchase']);
      expect(s.items.map((i: any) => [i.name, i.unit, i.qtyMilli, i.amountPaise, i.times])).toEqual([
        ['Sugar', 'Bag 50 kg', 3000, 610000, 2],
        ['Sugar', 'kg', 20000, 80000, 1],
        ['Toor Dal (loose)', 'kg', 5500, 66000, 1],
      ]);
      expect(s.items.reduce((a: number, i: any) => a + i.amountPaise, 0)).toBe(s.totals.purchased); // the list adds up to the ledger
    });

    it('does not mix in another supplier, and follows the date filter', async () => {
      expect((await statement('Other Mills')).items.map((i: any) => i.name)).toEqual(['Fortune Mustard Oil 1 L']);
      const recent = await statement('Gupta Traders', `?from=${today}`);
      expect(recent.items.find((i: any) => i.unit === 'Bag 50 kg')).toMatchObject({ qtyMilli: 1000, amountPaise: 210000, times: 1 });
    });
  });
});
