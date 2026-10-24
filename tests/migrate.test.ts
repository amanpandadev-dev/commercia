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
