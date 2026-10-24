import { describe, expect, it } from 'vitest';
import { openDb } from '../server/db/index';
import { migrate } from '../server/db/migrate';

describe('migrations', () => {
  it('add the one-off price column to a database made before it existed', async () => {
    const db = await openDb({ file: ':memory:' });
    await db.k.schema.alterTable('bill_lines').dropColumn('price_override').execute();
    const has = async () => (await db.k.introspection.getTables()).find((t) => t.name === 'bill_lines')!.columns.some((c) => c.name === 'price_override');
    expect(await has()).toBe(false);
    await migrate(db.k, 'sqlite');
    expect(await has()).toBe(true);
    await migrate(db.k, 'sqlite'); // running again is harmless
    expect(await has()).toBe(true);
  });
});

describe('supplier accounts for old deliveries', () => {
  it('gives each typed supplier name an account, once, with no dues', async () => {
    const db = await openDb({ file: ':memory:' });
    const row = (supplier: string, date: string) => ({ supplier, date, note: '', total_paise: 1000, import_id: null, created_by: 1, created_at: new Date().toISOString() });
    // Deliveries as an older version saved them: a name, no supplier account.
    await db.k.schema.alterTable('stock_ins').dropColumn('supplier_id').execute();
    await db.k.insertInto('stock_ins').values([row('Gupta Traders', '2026-09-01'), row('gupta traders', '2026-09-05'), row('Opening stock', '2026-09-06'), row('', '2026-09-07')] as never).execute();
    await migrate(db.k, 'sqlite');
    await migrate(db.k, 'sqlite'); // running again changes nothing
    const suppliers = await db.k.selectFrom('suppliers').selectAll().execute();
    expect(suppliers.map((s) => s.name)).toEqual(['Gupta Traders']);
    const linked = await db.k.selectFrom('stock_ins').select(['supplier', 'supplier_id']).orderBy('id').execute();
    expect(linked.map((r) => r.supplier_id)).toEqual([suppliers[0].id, suppliers[0].id, null, null]);
    expect((await db.k.selectFrom('supplier_ledger').select('id').execute()).length).toBe(0);
  });
});
