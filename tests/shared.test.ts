import { describe, expect, it } from 'vitest';
import { computeBill, financialYear } from '../shared/gst';
import { formatRupees, parseQty, parseRupees } from '../shared/money';
import { parseExtraUnits, stockLabel, toBase } from '../shared/units';
import { SearchIndex } from '../shared/search';
import { totpCode, verifyTotp, base32Decode, base32Encode } from '../server/lib/crypto';

describe('GST and totals', () => {
  it('takes GST back out of an inclusive price, and the total stays qty × price', () => {
    const t = computeBill([{ qtyMilli: 1000, ratePaise: 10500, gstBp: 500 }], { inclusive: true });
    expect(t.taxable).toBe(10000);
    expect(t.cgst).toBe(250);
    expect(t.sgst).toBe(250);
    expect(t.total).toBe(10500);
    expect(t.lines[0].inclusiveRate).toBe(10500);
    // 0% items and unregistered shops: the price is the price.
    expect(computeBill([{ qtyMilli: 2000, ratePaise: 14000, gstBp: 0 }], { inclusive: true }).taxable).toBe(28000);
    const memo = computeBill([{ qtyMilli: 1000, ratePaise: 10500, gstBp: 500 }], { inclusive: true, scheme: 'unregistered' });
    expect(memo.total).toBe(10500);
    expect(memo.cgst + memo.sgst).toBe(0);
  });

  it('keeps CGST equal to SGST and the line whole when an inclusive price does not split evenly', () => {
    const t = computeBill([{ qtyMilli: 3000, ratePaise: 3333, gstBp: 500 }], { inclusive: true });
    const l = t.lines[0];
    expect(l.cgst).toBe(l.sgst);
    expect(l.taxable + l.cgst + l.sgst).toBe(9999);
  });

  it('spreads a discount over inclusive lines before taking the tax out', () => {
    const t = computeBill([{ qtyMilli: 1000, ratePaise: 10500, gstBp: 500 }, { qtyMilli: 1000, ratePaise: 10000, gstBp: 0 }], { inclusive: true, discount: { type: 'amount', value: 2050 } });
    expect(t.discount).toBe(2050);
    expect(t.total).toBe(18500); // 205.00 - 20.50 = 184.50, rounded to the rupee
    expect(t.taxable + t.cgst + t.sgst + t.roundOff).toBe(18500);
  });

  it('matches the PRD worked example (BILL-3)', () => {
    const t = computeBill([
      { qtyMilli: 4000, ratePaise: 4500, gstBp: 500 }, // 4 kg sugar
      { qtyMilli: 2000, ratePaise: 16000, gstBp: 500 }, // 2 L mustard oil
      { qtyMilli: 2000, ratePaise: 14000, gstBp: 0 }, // 2 kg loose dal
      { qtyMilli: 3000, ratePaise: 4000, gstBp: 500 }, // 3 soaps
    ], { kind: 'tax_invoice' });
    expect(t.taxable).toBe(90000);
    expect(t.cgst).toBe(1550);
    expect(t.sgst).toBe(1550);
    expect(t.total).toBe(93100);
    expect(t.roundOff).toBe(0);
    expect(t.printAs).toBe('tax_invoice');
  });

  it('rounds to the rupee and shows the round-off (demo receipt ₹184)', () => {
    const t = computeBill([
      { qtyMilli: 1000, ratePaise: 4500, gstBp: 500 },
      { qtyMilli: 1000, ratePaise: 13000, gstBp: 500 },
    ]);
    expect(t.cgst + t.sgst).toBe(876); // ₹8.76 — per-line halves round up
    expect(t.total).toBe(18400);
    expect(t.roundOff).toBe(18400 - (17500 + 876));
  });

  it('prices loose items by weight (CAT-4)', () => {
    expect(computeBill([{ qtyMilli: 2500, ratePaise: 4500, gstBp: 0 }]).taxable).toBe(11250);
  });

  it('kaccha slip has the same total as a tax invoice (BILL-11)', () => {
    const lines = [{ qtyMilli: 4000, ratePaise: 4500, gstBp: 500 }, { qtyMilli: 1000, ratePaise: 9500, gstBp: 500 }];
    expect(computeBill(lines, { kind: 'kaccha' }).total).toBe(computeBill(lines, { kind: 'tax_invoice' }).total);
    expect(computeBill(lines, { kind: 'kaccha' }).lines[0].inclusiveRate).toBe(4725);
  });

  it('0% only bills print as Bill of Supply; unregistered shops print a cash memo (BILL-13, GST-7)', () => {
    expect(computeBill([{ qtyMilli: 2000, ratePaise: 14000, gstBp: 0 }], { kind: 'tax_invoice' }).printAs).toBe('bill_of_supply');
    const memo = computeBill([{ qtyMilli: 1000, ratePaise: 4500, gstBp: 500 }], { scheme: 'unregistered' });
    expect(memo.printAs).toBe('cash_memo');
    expect(memo.cgst + memo.sgst).toBe(0);
    expect(computeBill([{ qtyMilli: 1000, ratePaise: 4500, gstBp: 500 }], { scheme: 'composition' }).printAs).toBe('bill_of_supply');
  });

  it('applies a bill discount before tax (BILL-10)', () => {
    const t = computeBill([{ qtyMilli: 1000, ratePaise: 10000, gstBp: 500 }, { qtyMilli: 1000, ratePaise: 10000, gstBp: 0 }], { discount: { type: 'percent', value: 1000 } });
    expect(t.discount).toBe(2000);
    expect(t.taxable).toBe(18000);
    expect(t.cgst).toBe(225);
  });

  it('works out the financial year', () => {
    expect(financialYear('2026-10-12')).toBe('26-27');
    expect(financialYear('2027-03-31')).toBe('26-27');
    expect(financialYear('2027-04-01')).toBe('27-28');
  });
});

describe('money and quantities', () => {
  it('uses Indian grouping', () => {
    expect(formatRupees(10000000)).toBe('₹1,00,000.00');
    expect(formatRupees(3321100, { decimals: false })).toBe('₹33,211');
    expect(formatRupees(-50000)).toBe('−₹500.00');
  });
  it('parses input', () => {
    expect(parseRupees('1,250.50')).toBe(125050);
    expect(parseRupees('abc')).toBeNaN();
    expect(parseQty('2.5')).toBe(2500);
  });
});

describe('units and bags (UNIT-4, UNIT-5)', () => {
  const units = [{ name: 'kg', factorMilli: 1000 }, { name: 'Bag 50 kg', factorMilli: 50000 }, { name: 'Bag 25 kg', factorMilli: 25000 }];
  it('converts to the base unit', () => {
    expect(toBase(10000, 50000)).toBe(500000); // 10 bags → 500 kg
    expect(toBase(2000, 50000) + toBase(7000, 1000)).toBe(107000); // 2 bags + 7 kg → 107 kg
  });
  it('shows stock in the largest whole unit plus the rest', () => {
    expect(stockLabel(607000, 'kg', units)).toBe('12 × Bag 50 kg + 7 kg');
    expect(stockLabel(7000, 'kg', units)).toBe('7 kg');
  });
  it('reads the template extra-units cell', () => {
    expect(parseExtraUnits('Bag 50 kg = 50; Bag 25 kg = 25').units).toEqual([
      { name: 'Bag 50 kg', factorMilli: 50000 },
      { name: 'Bag 25 kg', factorMilli: 25000 },
    ]);
    expect(parseExtraUnits('Bag fifty').error).toBeTruthy();
  });
});

describe('search (SRCH-2, SRCH-3)', () => {
  const items = [
    { name: 'Fortune Mustard Oil 1 L', hi: 'सरसों तेल', brand: 'Fortune', type: 'mustard', aliases: 'sarson', cat: 'Oil' },
    { name: 'Fortune Mustard Oil 5 L', hi: 'सरसों तेल', brand: 'Fortune', type: 'mustard', aliases: 'sarson', cat: 'Oil' },
    { name: 'Fortune Sunflower Oil 1 L', hi: '', brand: 'Fortune', type: 'sunflower', aliases: '', cat: 'Oil' },
    { name: 'Saffola Gold 1 L', hi: '', brand: 'Saffola', type: 'blended', aliases: '', cat: 'Oil' },
    { name: 'Sugar', hi: 'चीनी', brand: '', type: '', aliases: 'chini, cheeni', cat: 'Sugar' },
    { name: 'Salt', hi: 'नमक', brand: 'Tata', type: '', aliases: 'namak', cat: 'Salt' },
  ];
  const idx = new SearchIndex(items, (i) => ({ words: [i.name, i.hi, i.brand, i.type, i.aliases, i.cat], primary: [i.name] }));
  it('matches part-words in any order', () => {
    expect(idx.search('fort mus 1')[0].name).toBe('Fortune Mustard Oil 1 L');
    expect(idx.search('mus fort 5')[0].name).toBe('Fortune Mustard Oil 5 L');
  });
  it('finds Hindi names and Roman aliases', () => {
    expect(idx.search('चीनी')[0].name).toBe('Sugar');
    expect(idx.search('chini')[0].name).toBe('Sugar');
    expect(idx.search('sarson')[0].name).toContain('Mustard');
  });
  it('tolerates typos', () => {
    expect(idx.search('saffolla').slice(0, 3).map((i) => i.name)).toContain('Saffola Gold 1 L');
    expect(idx.search('sugr')[0].name).toBe('Sugar');
  });
});

describe('authenticator codes (AUTH-2)', () => {
  it('matches RFC 6238 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });
});
