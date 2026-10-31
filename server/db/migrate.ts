import { sql, type Kysely, type ColumnDefinitionBuilder, type CreateTableBuilder } from 'kysely';
import type { DB } from './schema';
import type { Dialect } from './index';

type Col = (c: ColumnDefinitionBuilder) => ColumnDefinitionBuilder;

/** Creates every table if missing. Database-specific bits stay in this folder (PILOT-3). */
export async function migrate(db: Kysely<DB>, dialect: Dialect): Promise<void> {
  const idCol = <T extends string>(t: CreateTableBuilder<T, never>) =>
    dialect === 'postgres'
      ? t.addColumn('id', 'serial', (c) => c.primaryKey())
      : t.addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement());

  const notNull: Col = (c) => c.notNull();
  const zero: Col = (c) => c.notNull().defaultTo(0);
  const empty: Col = (c) => c.notNull().defaultTo('');

  await db.schema
    .createTable('settings')
    .ifNotExists()
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', notNull)
    .execute();

  await db.schema
    .createTable('counters')
    .ifNotExists()
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('value', 'integer', notNull)
    .execute();

  await idCol(db.schema.createTable('users').ifNotExists())
    .addColumn('name', 'text', notNull)
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', notNull)
    .addColumn('role', 'text', notNull)
    .addColumn('active', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('lang', 'text', (c) => c.notNull().defaultTo('en'))
    .addColumn('totp_secret', 'text')
    .addColumn('totp_enabled', 'integer', zero)
    .addColumn('session_epoch', 'integer', zero)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await db.schema
    .createTable('sessions')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'integer', notNull)
    .addColumn('epoch', 'integer', notNull)
    .addColumn('totp_ok', 'integer', zero)
    .addColumn('created_at', 'text', notNull)
    .addColumn('last_seen', 'text', notNull)
    .addColumn('expires_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('categories').ifNotExists())
    .addColumn('parent_id', 'integer')
    .addColumn('name_en', 'text', notNull)
    .addColumn('name_hi', 'text', empty)
    .addColumn('sort', 'integer', zero)
    .execute();

  await idCol(db.schema.createTable('products').ifNotExists())
    .addColumn('code', 'text')
    .addColumn('category_id', 'integer')
    .addColumn('name_en', 'text', notNull)
    .addColumn('name_hi', 'text', empty)
    .addColumn('brand', 'text', empty)
    .addColumn('type', 'text', empty)
    .addColumn('hsn', 'text', empty)
    .addColumn('base_unit', 'text', notNull)
    .addColumn('loose', 'integer', zero)
    .addColumn('step_milli', 'integer', (c) => c.notNull().defaultTo(1000))
    .addColumn('reorder_milli', 'integer')
    .addColumn('reorder_unit_id', 'integer')
    .addColumn('family', 'text', empty)
    .addColumn('pack_size', 'text', empty)
    .addColumn('pack_kind', 'text', empty)
    .addColumn('aliases', 'text', empty)
    .addColumn('buy_unit_id', 'integer')
    .addColumn('sell_unit_id', 'integer')
    .addColumn('active', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', notNull)
    .addColumn('updated_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('product_units').ifNotExists())
    .addColumn('product_id', 'integer', notNull)
    .addColumn('name', 'text', notNull)
    .addColumn('factor_milli', 'integer', notNull)
    .addColumn('is_base', 'integer', zero)
    .addColumn('active', 'integer', (c) => c.notNull().defaultTo(1))
    .execute();

  await idCol(db.schema.createTable('unit_prices').ifNotExists())
    .addColumn('unit_id', 'integer', notNull)
    .addColumn('list', 'text', notNull)
    .addColumn('price_paise', 'integer', notNull)
    .addColumn('from_date', 'text', notNull)
    .addColumn('set_by', 'integer', notNull)
    .addColumn('approved_by', 'integer')
    .addColumn('source', 'text', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('product_gst').ifNotExists())
    .addColumn('product_id', 'integer', notNull)
    .addColumn('gst_bp', 'integer', notNull)
    .addColumn('from_date', 'text', notNull)
    .addColumn('set_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await db.schema
    .createTable('rate_checks')
    .ifNotExists()
    .addColumn('unit_id', 'integer', notNull)
    .addColumn('list', 'text', notNull)
    .addColumn('date', 'text', notNull)
    .addColumn('checked_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .addPrimaryKeyConstraint('rate_checks_pk', ['unit_id', 'list', 'date'])
    .execute();

  await idCol(db.schema.createTable('rate_requests').ifNotExists())
    .addColumn('unit_id', 'integer', notNull)
    .addColumn('list', 'text', notNull)
    .addColumn('for_date', 'text', notNull)
    .addColumn('old_paise', 'integer', notNull)
    .addColumn('new_paise', 'integer', notNull)
    .addColumn('bill_id', 'integer')
    .addColumn('status', 'text', notNull)
    .addColumn('final_paise', 'integer')
    .addColumn('requested_by', 'integer', notNull)
    .addColumn('decided_by', 'integer')
    .addColumn('decided_at', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('stock_ins').ifNotExists())
    .addColumn('supplier', 'text', empty)
    .addColumn('date', 'text', notNull)
    .addColumn('note', 'text', empty)
    .addColumn('total_paise', 'integer', zero)
    .addColumn('import_id', 'integer')
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('stock_movements').ifNotExists())
    .addColumn('product_id', 'integer', notNull)
    .addColumn('qty_milli', 'integer', notNull)
    .addColumn('kind', 'text', notNull)
    .addColumn('ref_type', 'text')
    .addColumn('ref_id', 'integer')
    .addColumn('unit_id', 'integer')
    .addColumn('unit_qty_milli', 'integer')
    .addColumn('rate_paise', 'integer')
    .addColumn('note', 'text', empty)
    .addColumn('date', 'text', notNull)
    .addColumn('import_id', 'integer')
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('losses').ifNotExists())
    .addColumn('reason', 'text', notNull)
    .addColumn('date', 'text', notNull)
    .addColumn('notes', 'text', empty)
    .addColumn('status', 'text', notNull)
    .addColumn('value_paise', 'integer', zero)
    .addColumn('reverses_id', 'integer')
    .addColumn('reported_by', 'integer', notNull)
    .addColumn('confirmed_by', 'integer')
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('loss_lines').ifNotExists())
    .addColumn('loss_id', 'integer', notNull)
    .addColumn('product_id', 'integer', notNull)
    .addColumn('unit_id', 'integer', notNull)
    .addColumn('qty_milli', 'integer', notNull)
    .addColumn('base_milli', 'integer', notNull)
    .addColumn('value_paise', 'integer', zero)
    .execute();

  await idCol(db.schema.createTable('customers').ifNotExists())
    .addColumn('name', 'text', notNull)
    .addColumn('nickname', 'text', empty)
    .addColumn('phone', 'text', empty)
    .addColumn('area', 'text', empty)
    .addColumn('gstin', 'text', empty)
    .addColumn('price_list', 'text', (c) => c.notNull().defaultTo('retail'))
    .addColumn('active', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('bills').ifNotExists())
    .addColumn('number', 'text', notNull)
    .addColumn('series', 'text', notNull)
    .addColumn('fy', 'text', notNull)
    .addColumn('seq', 'integer', notNull)
    .addColumn('kind', 'text', notNull)
    .addColumn('print_as', 'text', notNull)
    .addColumn('status', 'text', notNull)
    .addColumn('customer_id', 'integer')
    .addColumn('customer_name', 'text', empty)
    .addColumn('customer_gstin', 'text', empty)
    .addColumn('bill_date', 'text', notNull)
    .addColumn('subtotal_paise', 'integer', zero)
    .addColumn('discount_paise', 'integer', zero)
    .addColumn('taxable_paise', 'integer', zero)
    .addColumn('cgst_paise', 'integer', zero)
    .addColumn('sgst_paise', 'integer', zero)
    .addColumn('round_off_paise', 'integer', zero)
    .addColumn('total_paise', 'integer', zero)
    .addColumn('gst_inclusive', 'integer', zero)
    .addColumn('paid_paise', 'integer', zero)
    .addColumn('credit_paise', 'integer', zero)
    .addColumn('rate_pending', 'integer', zero)
    .addColumn('needs_review', 'integer', zero)
    .addColumn('paper_ref', 'text', empty)
    .addColumn('converted_to', 'integer')
    .addColumn('cancel_reason', 'text', empty)
    .addColumn('cancelled_by', 'integer')
    .addColumn('cancelled_at', 'text')
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('bill_lines').ifNotExists())
    .addColumn('bill_id', 'integer', notNull)
    .addColumn('product_id', 'integer', notNull)
    .addColumn('unit_id', 'integer', notNull)
    .addColumn('name_en', 'text', notNull)
    .addColumn('name_hi', 'text', empty)
    .addColumn('unit_name', 'text', notNull)
    .addColumn('factor_milli', 'integer', notNull)
    .addColumn('hsn', 'text', empty)
    .addColumn('qty_milli', 'integer', notNull)
    .addColumn('rate_paise', 'integer', notNull)
    .addColumn('official_rate_paise', 'integer', notNull)
    .addColumn('gst_bp', 'integer', notNull)
    .addColumn('amount_paise', 'integer', notNull)
    .addColumn('discount_paise', 'integer', zero)
    .addColumn('taxable_paise', 'integer', notNull)
    .addColumn('cgst_paise', 'integer', notNull)
    .addColumn('sgst_paise', 'integer', notNull)
    .addColumn('base_milli', 'integer', notNull)
    .addColumn('price_override', 'integer', zero)
    .execute();
  await idCol(db.schema.createTable('payments').ifNotExists())
    .addColumn('customer_id', 'integer')
    .addColumn('bill_id', 'integer')
    .addColumn('date', 'text', notNull)
    .addColumn('total_paise', 'integer', notNull)
    .addColumn('note', 'text', empty)
    .addColumn('reversal_of', 'integer')
    .addColumn('reversed', 'integer', zero)
    .addColumn('at_billing', 'integer', zero)
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('payment_parts').ifNotExists())
    .addColumn('payment_id', 'integer', notNull)
    .addColumn('mode', 'text', notNull)
    .addColumn('amount_paise', 'integer', notNull)
    .addColumn('reference', 'text', empty)
    .execute();

  await idCol(db.schema.createTable('ledger').ifNotExists())
    .addColumn('customer_id', 'integer', notNull)
    .addColumn('date', 'text', notNull)
    .addColumn('kind', 'text', notNull)
    .addColumn('ref_type', 'text')
    .addColumn('ref_id', 'integer')
    .addColumn('debit_paise', 'integer', zero)
    .addColumn('credit_paise', 'integer', zero)
    .addColumn('note', 'text', empty)
    .addColumn('import_id', 'integer')
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('cash_outs').ifNotExists())
    .addColumn('date', 'text', notNull)
    .addColumn('category', 'text', notNull)
    .addColumn('payee', 'text', empty)
    .addColumn('mode', 'text', notNull)
    .addColumn('amount_paise', 'integer', notNull)
    .addColumn('note', 'text', empty)
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('suppliers').ifNotExists())
    .addColumn('name', 'text', notNull)
    .addColumn('phone', 'text', empty)
    .addColumn('area', 'text', empty)
    .addColumn('active', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('supplier_ledger').ifNotExists())
    .addColumn('supplier_id', 'integer', notNull)
    .addColumn('date', 'text', notNull)
    .addColumn('kind', 'text', notNull)
    .addColumn('ref_type', 'text')
    .addColumn('ref_id', 'integer')
    .addColumn('owed_paise', 'integer', zero)
    .addColumn('paid_paise', 'integer', zero)
    .addColumn('note', 'text', empty)
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await db.schema
    .createTable('auth_throttle')
    .ifNotExists()
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('fails', 'integer', zero)
    .addColumn('window_start', 'text', notNull)
    .addColumn('locked_until', 'text')
    .addColumn('strikes', 'integer', zero)
    .addColumn('last_fail', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('known_devices').ifNotExists())
    .addColumn('user_id', 'integer', notNull)
    .addColumn('device_hash', 'text', notNull)
    .addColumn('label', 'text', empty)
    .addColumn('first_seen', 'text', notNull)
    .addColumn('last_seen', 'text', notNull)
    .addColumn('last_ip', 'text', empty)
    .execute();

  await idCol(db.schema.createTable('recovery_codes').ifNotExists())
    .addColumn('user_id', 'integer', notNull)
    .addColumn('code_hash', 'text', notNull)
    .addColumn('used_at', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('enrolment_codes').ifNotExists())
    .addColumn('user_id', 'integer', notNull)
    .addColumn('kind', 'text', notNull)
    .addColumn('code_hash', 'text', notNull)
    .addColumn('issued_by', 'integer')
    .addColumn('expires_at', 'text', notNull)
    .addColumn('attempts', 'integer', zero)
    .addColumn('used_at', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('password_resets').ifNotExists())
    .addColumn('user_id', 'integer', notNull)
    .addColumn('kind', 'text', notNull)
    .addColumn('code_hash', 'text')
    .addColumn('requested_at', 'text', notNull)
    .addColumn('issued_at', 'text')
    .addColumn('issued_by', 'integer')
    .addColumn('expires_at', 'text')
    .addColumn('attempts', 'integer', zero)
    .addColumn('used_at', 'text')
    .addColumn('dismissed', 'integer', zero)
    .execute();

  await idCol(db.schema.createTable('activity').ifNotExists())
    .addColumn('user_id', 'integer')
    .addColumn('action', 'text', notNull)
    .addColumn('entity', 'text', notNull)
    .addColumn('entity_id', 'integer')
    .addColumn('summary', 'text', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('versions').ifNotExists())
    .addColumn('entity', 'text', notNull)
    .addColumn('entity_id', 'integer', notNull)
    .addColumn('version', 'integer', notNull)
    .addColumn('data', 'text', notNull)
    .addColumn('reason', 'text', empty)
    .addColumn('changed_by', 'integer')
    .addColumn('created_at', 'text', notNull)
    .execute();

  await idCol(db.schema.createTable('imports').ifNotExists())
    .addColumn('kind', 'text', notNull)
    .addColumn('file_name', 'text', empty)
    .addColumn('summary', 'text', empty)
    .addColumn('undone', 'integer', zero)
    .addColumn('created_by', 'integer', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();

  // Columns added after the first release: databases made earlier get them here.
  const addColumnIfMissing = async (table: string, column: string, type: 'integer' | 'text', build: Col) => {
    const t = (await db.introspection.getTables()).find((x) => x.name === table);
    if (t && !t.columns.some((c) => c.name === column)) await db.schema.alterTable(table).addColumn(column, type, build).execute();
  };
  await addColumnIfMissing('users', 'totp_pending', 'text', (c) => c);
  await addColumnIfMissing('users', 'totp_last_step', 'integer', (c) => c);
  await addColumnIfMissing('sessions', 'enrol_ok', 'integer', zero);
  await addColumnIfMissing('sessions', 'reauth_until', 'text', (c) => c);
  await addColumnIfMissing('sessions', 'ip', 'text', empty);
  await addColumnIfMissing('sessions', 'device', 'text', empty);
  await addColumnIfMissing('sessions', 'ua_hash', 'text', empty);
  await addColumnIfMissing('bill_lines', 'price_override', 'integer', zero);
  await addColumnIfMissing('bills', 'gst_inclusive', 'integer', zero);
  await addColumnIfMissing('products', 'family', 'text', empty);
  await addColumnIfMissing('products', 'pack_size', 'text', empty);
  await addColumnIfMissing('products', 'pack_kind', 'text', empty);
  const nullable: Col = (c) => c;
  await addColumnIfMissing('stock_ins', 'supplier_id', 'integer', nullable);
  await addColumnIfMissing('stock_ins', 'invoice_no', 'text', empty);
  await addColumnIfMissing('stock_ins', 'amount_paise', 'integer', zero);
  await addColumnIfMissing('stock_ins', 'paid_paise', 'integer', zero);
  await addColumnIfMissing('cash_outs', 'supplier_id', 'integer', nullable);
  await addColumnIfMissing('cash_outs', 'stock_in_id', 'integer', nullable);
  await addColumnIfMissing('cash_outs', 'reversal_of', 'integer', nullable);
  await addColumnIfMissing('cash_outs', 'reversed', 'integer', zero);

  // Deliveries typed before suppliers had accounts: give each name an account (no dues; they count as paid).
  const known = new Map((await db.selectFrom('suppliers').select(['id', 'name']).execute()).map((r) => [r.name.trim().toLowerCase(), r.id]));
  const unlinked = await db.selectFrom('stock_ins').select('supplier').distinct().where('supplier_id', 'is', null).where('supplier', '!=', '').where('supplier', '!=', 'Opening stock').execute();
  for (const { supplier } of unlinked) {
    const key = supplier.trim().toLowerCase();
    let id = known.get(key);
    if (!id) {
      id = (await db.insertInto('suppliers').values({ name: supplier.trim(), phone: '', area: '', active: 1, created_at: new Date().toISOString() }).returning('id').executeTakeFirstOrThrow()).id;
      known.set(key, id);
    }
    await db.updateTable('stock_ins').set({ supplier_id: id }).where('supplier', '=', supplier).where('supplier_id', 'is', null).execute();
  }

  const indexes: [string, keyof DB, string[]][] = [
    ['idx_units_product', 'product_units', ['product_id']],
    ['idx_prices_unit', 'unit_prices', ['unit_id', 'list', 'from_date']],
    ['idx_gst_product', 'product_gst', ['product_id', 'from_date']],
    ['idx_moves_product', 'stock_movements', ['product_id']],
    ['idx_moves_date', 'stock_movements', ['date']],
    ['idx_bills_date', 'bills', ['bill_date']],
    ['idx_bills_customer', 'bills', ['customer_id']],
    ['idx_lines_bill', 'bill_lines', ['bill_id']],
    ['idx_parts_payment', 'payment_parts', ['payment_id']],
    ['idx_payments_date', 'payments', ['date']],
    ['idx_ledger_customer', 'ledger', ['customer_id']],
    ['idx_supplier_ledger_supplier', 'supplier_ledger', ['supplier_id']],
    ['idx_cash_outs_supplier', 'cash_outs', ['supplier_id']],
    ['idx_password_resets_user', 'password_resets', ['user_id']],
    ['idx_recovery_codes_user', 'recovery_codes', ['user_id']],
    ['idx_known_devices_user', 'known_devices', ['user_id']],
    ['idx_enrolment_codes_user', 'enrolment_codes', ['user_id']],
    ['idx_versions_entity', 'versions', ['entity', 'entity_id']],
    ['idx_activity_time', 'activity', ['created_at']],
  ];
  for (const [name, table, cols] of indexes) {
    await db.schema.createIndex(name).ifNotExists().on(table).columns(cols).execute();
  }
  await db.schema.createIndex('idx_bills_number').ifNotExists().unique().on('bills').column('number').execute();

  // History, activity log and ledger rows can't be changed or deleted by anyone (HIST-3, REP-5, LED-4).
  const appendOnly = ['activity', 'versions', 'ledger', 'payment_parts', 'supplier_ledger'];
  if (dialect === 'sqlite') {
    for (const t of appendOnly) {
      await sql
        .raw(
          `CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} rows are append-only'); END;`,
        )
        .execute(db);
      await sql
        .raw(
          `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} WHEN (SELECT value FROM settings WHERE key = '__allow_purge') IS NOT '1' BEGIN SELECT RAISE(ABORT, '${t} rows are append-only'); END;`,
        )
        .execute(db);
    }
  } else {
    await sql
      .raw(
        `CREATE OR REPLACE FUNCTION commercia_append_only() RETURNS trigger AS $$
         BEGIN
           IF TG_OP = 'DELETE' AND current_setting('commercia.allow_purge', true) = '1' THEN RETURN OLD; END IF;
           RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
         END $$ LANGUAGE plpgsql;`,
      )
      .execute(db);
    for (const t of appendOnly) {
      await sql
        .raw(
          `DROP TRIGGER IF EXISTS ${t}_append_only ON ${t};
           CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION commercia_append_only();`,
        )
        .execute(db);
    }
  }
}
