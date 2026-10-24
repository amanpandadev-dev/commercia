// Go-live in one step (PILOT-6): copy every row from the pilot's SQLite file into Postgres
// (Supabase), then check that stock, dues and sales totals match to the paisa.
//
//   DATABASE_URL=postgres://… npx tsx server/scripts/move-to-postgres.ts [path/to/commercia.db]
//
// The target database must be empty (fresh Supabase project). Nothing in the SQLite file changes.
import fs from 'node:fs';
import { sql } from 'kysely';
import { openDb, type Db } from '../db/index';
import { TABLES } from '../routes/admin';
import { customerBalances, stockMap } from '../lib/catalog';
import { toNum } from '../lib/core';
import { supplierBalances } from '../lib/suppliers';

const file = process.argv[2] ?? 'data/commercia.db';
const url = process.env.DATABASE_URL;
if (!url || !/^postgres/.test(url)) {
  console.error('Set DATABASE_URL to the Supabase Postgres connection string.');
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`No SQLite file at ${file}`);
  process.exit(1);
}
const src = await openDb({ file });
if (!(await src.k.selectFrom('users').select('id').executeTakeFirst())) {
  console.error(`${file} has no users — is this the right file?`);
  process.exit(1);
}
const dst = await openDb({ url });

const already = await dst.k.selectFrom('users').select('id').executeTakeFirst();
if (already) {
  console.error('The target database already has data. Use a fresh, empty database.');
  process.exit(1);
}

const BATCH = 500;
await dst.k.transaction().execute(async (tx) => {
  for (const t of TABLES) {
    const rows = await src.k.selectFrom(t).selectAll().execute();
    for (let i = 0; i < rows.length; i += BATCH) {
      await tx.insertInto(t).values(rows.slice(i, i + BATCH) as never).execute();
    }
    // Serial ids continue after the copied ones.
    if (rows.length && 'id' in (rows[0] as object)) {
      await sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT MAX(id) FROM ${t}))`).execute(tx);
    }
    console.log(`  ${t.padEnd(16)} ${rows.length} rows`);
  }
});

async function totals(db: Db) {
  const stock = [...(await stockMap(db.k)).entries()].sort((a, b) => a[0] - b[0]);
  const dues = [...(await customerBalances(db.k)).entries()].sort((a, b) => a[0] - b[0]);
  const payables = [...(await supplierBalances(db.k)).entries()].sort((a, b) => a[0] - b[0]);
  const cashOut = await db.k.selectFrom('cash_outs').select((eb) => eb.fn.sum<number>('amount_paise').as('t')).executeTakeFirst();
  const sales = await db.k
    .selectFrom('bills')
    .select([(eb) => eb.fn.sum<number>('total_paise').as('t'), (eb) => eb.fn.countAll<number>().as('n')])
    .where('status', '=', 'active')
    .executeTakeFirst();
  const pays = await db.k.selectFrom('payment_parts').select((eb) => eb.fn.sum<number>('amount_paise').as('t')).executeTakeFirst();
  return {
    stock: JSON.stringify(stock),
    dues: JSON.stringify(dues),
    suppliers: JSON.stringify(payables),
    sales: `${toNum(sales?.t)} paise in ${toNum(sales?.n)} bills`,
    payments: `${toNum(pays?.t)} paise`,
    cashOuts: `${toNum(cashOut?.t)} paise`,
  };
}

const a = await totals(src);
const b = await totals(dst);
let ok = true;
for (const k of Object.keys(a) as (keyof typeof a)[]) {
  const same = a[k] === b[k];
  ok &&= same;
  console.log(`${same ? '✓' : '✗'} ${k}: ${k === 'stock' || k === 'dues' || k === 'suppliers' ? (same ? 'identical' : 'DIFFERENT') : `${a[k]} → ${b[k]}`}`);
}
console.log(ok ? '\nAll totals match. Point the app at DATABASE_URL to go live.' : '\nTotals differ — do not go live; keep using the SQLite file.');
process.exit(ok ? 0 : 2);
