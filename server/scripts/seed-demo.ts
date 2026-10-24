// Fills an empty database with the demo shop from the walkthrough video, for trying Commercia out.
// Usage: npm run seed:demo   (uses data/commercia.db, or COMMERCIA_DB=path)
// Logins: ramesh@shop.in (Admin/Owner) and amit@shop.in (Entry person), password "demo1234".
import { openDb, nowIso } from '../db/index';
import { createApp } from '../app';
import { hashPassword } from '../lib/crypto';
import { setSetting } from '../lib/settings';
import { addDays, istDate } from '../../shared/dates';
import { computeBill } from '../../shared/gst';

const db = await openDb();
const existing = await db.k.selectFrom('users').select('id').executeTakeFirst();
if (existing) {
  console.log('This database already has users — not seeding. Delete data/commercia.db (or use COMMERCIA_DB=…) to start fresh.');
  process.exit(1);
}
const app = createApp(db);

for (const [k, v] of Object.entries({
  shop_name: 'Sharma Kirana Store',
  shop_name_hi: 'शर्मा किराना स्टोर',
  shop_address: 'Aminabad, Lucknow',
  shop_phone: '0522-XXXXXX',
  shop_gstin: '09XXXXX0000X1Z5',
  require_2fa: '0',
})) await setSetting(db.k, k, v);

const users = [
  { name: 'Ramesh Sharma', email: 'ramesh@shop.in', role: 'admin' as const },
  { name: 'Amit Kumar', email: 'amit@shop.in', role: 'entry' as const },
];
for (const u of users) {
  await db.k
    .insertInto('users')
    .values({ ...u, password_hash: hashPassword('demo1234'), active: 1, lang: 'en', totp_enabled: 0, totp_secret: null, session_epoch: 0, created_at: nowIso() })
    .execute();
}

async function client(email: string) {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url}: ${JSON.stringify(json)}`);
    return json;
  };
  await call('POST', '/api/auth/login', { email, password: 'demo1234' });
  return { get: (u: string) => call('GET', u), post: (u: string, b: unknown) => call('POST', u, b) };
}

const owner = await client('ramesh@shop.in');
const amit = await client('amit@shop.in');

const products = [
  { category: 'Sugar > Loose', name: 'Sugar', nameHi: 'चीनी', baseUnit: 'kg', units: 'Bag 50 kg = 50; Bag 25 kg = 25', price: '45', unitPrices: 'Bag 50 kg = 2150; Bag 25 kg = 1090', wholesale: '43', gst: '5', hsn: '1701', reorder: '10', opening: '6 Bag 50 kg', cost: '40', aliases: 'chini, cheeni, shakkar' },
  { category: 'Oil > Mustard', name: 'Mustard Oil', nameHi: 'सरसों तेल', baseUnit: 'L', units: 'Tin 15 L = 15', price: '160', unitPrices: 'Tin 15 L = 2300', gst: '5', hsn: '1514', reorder: '6', opening: '3 Tin 15 L', cost: '142', aliases: 'sarson, sarso tel, kadwa tel' },
  { category: 'Oil > Mustard > Fortune', name: 'Fortune Mustard Oil 1 L', nameHi: 'फॉर्च्यून सरसों तेल', brand: 'Fortune', type: 'mustard', baseUnit: 'pc', units: 'Box of 12 = 12', price: '175', unitPrices: 'Box of 12 = 2040', gst: '5', hsn: '1514', reorder: '12', opening: '2 Box of 12', cost: '158', aliases: 'fortune sarson' },
  { category: 'Oil > Saffola > Sunflower', name: 'Saffola Gold 1 L', nameHi: 'सफोला गोल्ड', brand: 'Saffola', type: 'blended', baseUnit: 'pc', units: 'Box of 12 = 12', price: '195', gst: '5', hsn: '1512', reorder: '6', opening: '18', cost: '176' },
  { category: 'Dal', name: 'Toor Dal (loose)', nameHi: 'अरहर दाल', baseUnit: 'kg', units: 'Bag 25 kg = 25', price: '140', gst: '0', hsn: '0713', reorder: '10', opening: '2 Bag 25 kg', cost: '124', aliases: 'arhar, tuar' },
  { category: 'Dal', name: 'Chana Dal', nameHi: 'चना दाल', baseUnit: 'kg', price: '95', gst: '0', hsn: '0713', reorder: '10', opening: '40', cost: '84' },
  { category: 'Dal', name: 'Moong Dal', nameHi: 'मूंग दाल', baseUnit: 'kg', price: '120', gst: '0', hsn: '0713', reorder: '8', opening: '16', cost: '106' },
  { category: 'Rice', name: 'Basmati Rice', nameHi: 'बासमती चावल', baseUnit: 'kg', units: 'Bag 25 kg = 25; Bag 10 kg = 10', price: '95', unitPrices: 'Bag 25 kg = 2250', gst: '5', hsn: '1006', reorder: '15', opening: '8', cost: '82', aliases: 'chawal' },
  { category: 'Rice', name: 'Sona Masoori Rice', nameHi: 'सोना मसूरी चावल', baseUnit: 'kg', units: 'Bag 25 kg = 25', price: '58', gst: '0', hsn: '1006', reorder: '25', opening: '2 Bag 25 kg', cost: '50' },
  { category: 'Atta', name: 'Aashirvaad Atta 10 kg', nameHi: 'आशीर्वाद आटा', brand: 'Aashirvaad', baseUnit: 'pc', price: '445', gst: '0', hsn: '1101', reorder: '5', opening: '14', cost: '405', aliases: 'aata, gehu' },
  { category: 'Salt', name: 'Salt', nameHi: 'नमक', brand: 'Tata', baseUnit: 'kg', price: '28', gst: '0', hsn: '2501', reorder: '10', opening: '40', cost: '22', aliases: 'namak' },
  { category: 'Tea', name: 'Tea 250g', nameHi: 'चाय', brand: 'Tata', baseUnit: 'pc', units: 'Box of 12 = 12', price: '130', gst: '5', hsn: '0902', reorder: '8', opening: '4 Box of 12', cost: '112', aliases: 'chai, chaipatti' },
  { category: 'Spices', name: 'Haldi Powder 200g', nameHi: 'हल्दी', brand: 'MDH', baseUnit: 'pc', price: '62', gst: '5', hsn: '0910', reorder: '6', opening: '15', cost: '52', aliases: 'turmeric' },
  { category: 'Spices', name: 'Red Chilli Powder 200g', nameHi: 'लाल मिर्च', brand: 'MDH', baseUnit: 'pc', price: '78', gst: '5', hsn: '0904', reorder: '6', opening: '12', cost: '66', aliases: 'mirch' },
  { category: 'Spices', name: 'Jeera 100g', nameHi: 'जीरा', baseUnit: 'pc', price: '55', gst: '5', hsn: '0909', reorder: '6', opening: '18', cost: '45', aliases: 'cumin, zeera' },
  { category: 'Soap', name: 'Bath Soap', nameHi: 'साबुन', brand: 'Lux', baseUnit: 'pc', units: 'Box of 12 = 12', price: '40', unitPrices: 'Box of 12 = 450', gst: '5', hsn: '3401', reorder: '12', opening: '8 Box of 12', cost: '34', aliases: 'sabun' },
  { category: 'Soap', name: 'Rin Detergent Bar', nameHi: 'रिन साबुन', brand: 'Rin', baseUnit: 'pc', price: '12', gst: '18', hsn: '3401', reorder: '20', opening: '120', cost: '9.5' },
  { category: 'Soap', name: 'Surf Excel 1 kg', nameHi: 'सर्फ एक्सेल', brand: 'Surf Excel', baseUnit: 'pc', price: '130', gst: '18', hsn: '3402', reorder: '6', opening: '10', cost: '112' },
  { category: 'Snacks', name: 'Parle-G 250g', nameHi: 'पारले जी', brand: 'Parle', baseUnit: 'pc', units: 'Box of 24 = 24', price: '25', gst: '18', hsn: '1905', reorder: '24', opening: '120', cost: '21', aliases: 'biscuit' },
  { category: 'Snacks', name: 'Maggi 70g', nameHi: 'मैगी', brand: 'Nestle', baseUnit: 'pc', units: 'Box of 48 = 48', price: '14', gst: '18', hsn: '1902', reorder: '24', opening: '144', cost: '12', aliases: 'noodles' },
];
await owner.post('/api/import/commit', { kind: 'products', rows: products, fileName: 'demo-products.xlsx' });

const customers = [
  ['Rakesh Verma', '4320', '9839001234', 'Aminabad'],
  ['Sunita Devi', '1250', '9800004521', 'Naka'],
  ['Kavita Singh', '3400', '9415002233', 'Chowk'],
  ['Meena Joshi', '2050', '9935006677', 'Aminabad'],
  ['Deepak Yadav', '1120', '9450011122', 'Hazratganj'],
  ['Imran Khan', '980', '9889033344', 'Chowk'],
  ['Pooja Gupta', '760', '9721055566', 'Naka'],
  ['Gupta Sweets', '0', '9839077788', 'Aminabad'],
];
await owner.post('/api/import/commit', {
  kind: 'customers',
  rows: customers.map(([name, amount, phone, area]) => ({ name, amount, phone, area })),
  fileName: 'khata.xlsx',
  asOf: addDays(istDate(), -30),
});

const cat = await owner.get('/api/catalog');
const pid = (name: string) => cat.products.find((p: any) => p.nameEn === name);
const unit = (name: string, u?: string) => {
  const p = pid(name);
  return { productId: p.id, unitId: (u ? p.units.find((x: any) => x.name === u) : p.units.find((x: any) => x.isBase)).id };
};
const cust = await owner.get('/api/customers');
const cid = (name: string) => cust.find((c: any) => c.name === name).id;

// A week of walk-in sales so the dashboard chart has something to show.
let seed = 7;
const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const walkIn = ['Sugar', 'Tea 250g', 'Salt', 'Bath Soap', 'Parle-G 250g', 'Maggi 70g', 'Rin Detergent Bar', 'Toor Dal (loose)', 'Mustard Oil', 'Chana Dal'];
for (let d = 6; d >= 1; d--) {
  const date = addDays(istDate(), -d);
  const n = 5 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const items = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(walkIn)))];
    const lines = items.map((it) => ({ ...unit(it), qtyMilli: 1000 * (1 + Math.floor(rnd() * 3)) }));
    const total = computeBill(
      lines.map((l) => {
        const p = cat.products.find((x: any) => x.id === l.productId);
        return { qtyMilli: l.qtyMilli, ratePaise: p.units.find((u: any) => u.id === l.unitId).retail, gstBp: p.gstBp };
      }),
      { inclusive: true },
    ).total;
    await owner.post('/api/bills', { kind: 'receipt', billDate: date, lines, payments: [{ mode: rnd() > 0.45 ? 'cash' : 'upi', amountPaise: total }] });
  }
  // A couple of credit sales.
  await owner.post('/api/bills', { kind: 'tax_invoice', customerId: cid(pick(['Rakesh Verma', 'Kavita Singh', 'Meena Joshi', 'Gupta Sweets'])), billDate: date, lines: [{ ...unit('Sugar', 'Bag 25 kg'), qtyMilli: 1000 }, { ...unit('Mustard Oil'), qtyMilli: 5000 }], payments: [] });
}

// Salt sells out a little so the low-stock list has something, as in the video.
await owner.post('/api/stock/adjust', { ...unit('Salt'), qtyMilli: -28000, reason: 'Count correction' }).catch(() => {});

// Today, as in the video.
const today = istDate();
await amit.post('/api/bills', { kind: 'receipt', billDate: today, lines: [{ ...unit('Sugar'), qtyMilli: 1000 }, { ...unit('Tea 250g'), qtyMilli: 1000 }], payments: [{ mode: 'cash', amountPaise: 17500 }] }); // ₹45 + ₹130, GST included
await amit.post('/api/bills', {
  kind: 'tax_invoice', customerId: cid('Sunita Devi'), billDate: today,
  lines: [{ ...unit('Sugar'), qtyMilli: 4000 }, { ...unit('Mustard Oil'), qtyMilli: 2000 }, { ...unit('Toor Dal (loose)'), qtyMilli: 2000 }, { ...unit('Bath Soap'), qtyMilli: 3000 }],
  payments: [{ mode: 'upi', amountPaise: 50000 }],
});
await amit.post('/api/stock-ins', { supplier: 'Gupta Traders', date: today, lines: [{ ...unit('Sugar', 'Bag 50 kg'), qtyMilli: 1000, ratePaise: 200000 }] });
await owner.post('/api/payments', { customerId: cid('Rakesh Verma'), date: today, parts: [{ mode: 'cash', amountPaise: 70000 }, { mode: 'upi', amountPaise: 30000 }] });
// One rate change by the Entry person, waiting for approval.
await amit.post('/api/bills', { kind: 'receipt', customerId: cid('Pooja Gupta'), billDate: today, lines: [{ ...unit('Mustard Oil'), qtyMilli: 1000, ratePaise: 16500 }], payments: [] });
await owner.post('/api/cash-outs', { date: today, category: 'wages', payee: 'Helper', mode: 'cash', amountPaise: 30000, note: '' });

console.log('Demo shop ready: Sharma Kirana Store');
console.log('  ramesh@shop.in / demo1234  (Admin, Owner)');
console.log('  amit@shop.in   / demo1234  (Entry person)');
process.exit(0);
