import { Hono } from 'hono';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import type { AppEnv } from '../lib/core';
import { HttpError, bad, logActivity, need, requireReauth } from '../lib/core';
import { EXAMPLES, FIELDS, commitImport, mapHeaders, previewImport, undoImport, type ImportKind, type RowData } from '../lib/importer';
import { readSheet, toCsv } from '../lib/sheets';
import { customPackTypes, getSettings, setSetting, type SchemePeriod } from '../lib/settings';
import { LOOSE_WORD, allPackKinds, cleanPackKindName, findPackKind, parsePackSize } from '../../shared/units';
import { runBackup, listBackups } from '../lib/backup';
import { isIsoDate } from '../../shared/dates';
import { can, type Role } from '../../shared/perms';
import type { DB } from '../db/schema';

export const admin = new Hono<AppEnv>();

const kindSchema = z.enum(['products', 'stock', 'customers']);
const permFor: Record<ImportKind, 'import.products' | 'import.stock' | 'import.customers'> = {
  products: 'import.products',
  stock: 'import.stock',
  customers: 'import.customers',
};

/** A products file from someone who can add items but not edit them may only contain new ones. */
const addOnly = (user: { role: Role }, kind: ImportKind) => kind === 'products' && !can(user.role, 'catalog.edit');

// Quantities offered in the stock sheet's dropdown; any other number can be typed.
const QUANTITIES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 25, 30, 40, 50, 60, 100];

// Pack sizes offered in the dropdown, with any size this shop already uses added.
const COMMON_SIZES = [
  '100 g', '200 g', '250 g', '500 g', '1 kg', '2 kg', '5 kg', '10 kg', '15 kg', '20 kg', '25 kg', '26 kg', '28 kg', '30 kg', '40 kg', '50 kg',
  '100 ml', '200 ml', '250 ml', '500 ml', '1 L', '2 L', '5 L', '10 L', '15 L', '1 pc', '6 pc', '12 pc', '24 pc',
];
const UNIT_ORDER = ['g', 'kg', 'ml', 'L', 'pc'];
const bySize = (a: string, b: string) => {
  const x = parsePackSize(a);
  const y = parsePackSize(b);
  if (!x || !y) return a.localeCompare(b);
  return UNIT_ORDER.indexOf(x.unit) - UNIT_ORDER.indexOf(y.unit) || x.qty - y.qty;
};

// ---------- Import templates (IMP-1) ----------
admin.get('/import/template/:file', async (c) => {
  const m = c.req.param('file').match(/^(products|stock|customers)\.(xlsx|csv)$/);
  if (!m) throw bad('Unknown template');
  const kind = m[1] as ImportKind;
  const fields = FIELDS[kind].filter((f) => !f.advanced); // the products template has exactly the eight simple columns
  const title = { products: 'Products', stock: 'Stock deliveries', customers: 'Dues' }[kind];
  const examples = EXAMPLES[kind];
  const rowOf = (e: Record<string, string>) => fields.map((f) => e[f.key] ?? '');
  if (m[2] === 'csv') {
    return new Response(toCsv([fields.map((f) => f.header), ...examples.map((e) => rowOf(e.row))]), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="commercia-${kind}-template.csv"` },
    });
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);
  ws.columns = fields.map((f) => ({ header: f.header + (f.required ? ' *' : ''), key: f.key, width: Math.max(14, Math.min(34, f.header.length + 8)) }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  fields.forEach((f, i) => {
    const cell = head.getCell(i + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDF1EC' } };
    cell.note = f.help; // hover a heading to see how to fill the column
  });
  for (const e of examples) ws.addRow(rowOf(e.row));
  ws.getRows(2, examples.length)?.forEach((r) => (r.font = { italic: true, color: { argb: 'FF6B7280' } }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // The dropdowns read their choices from a hidden sheet, one column per list. Excel wants one validation per column
  // range (cell by cell, ExcelJS merges them into overlapping ranges and Excel "repairs" the file).
  const { k } = c.get('db');
  const LAST = 500;
  const lists = wb.addWorksheet('Lists');
  lists.state = 'hidden';
  let listCols = 0;
  const addList = (heading: string, values: (string | number)[]) => {
    const col = lists.getColumn(++listCols);
    col.values = [heading, ...values];
    return `Lists!$${col.letter}$2:$${col.letter}$${Math.max(values.length, 1) + 1}`;
  };
  const letterOf = (key: string) => ws.getColumn(fields.findIndex((f) => f.key === key) + 1).letter;
  const rangeOf = (key: string) => `${letterOf(key)}2:${letterOf(key)}${LAST}`;
  // (ExcelJS's own typings leave out the worksheet's validation table, which exists at runtime.)
  const rules = (ws as unknown as { dataValidations: { model: Record<string, unknown> } }).dataValidations.model;
  /** A dropdown. `strict` refuses anything else; otherwise it only warns, so a new name can still be typed. */
  const choose = (key: string, range: string, o: { title: string; prompt: string; error: string; strict?: boolean }) => {
    rules[rangeOf(key)] = {
      type: 'list', allowBlank: true, formulae: [range],
      showInputMessage: true, promptTitle: o.title, prompt: o.prompt,
      showErrorMessage: true, errorStyle: o.strict ? 'stop' : 'warning', errorTitle: o.strict ? 'Pick from the list' : 'Not in the list', error: o.error,
    };
  };
  const number = (key: string, o: { min: number; max?: number }) => {
    rules[rangeOf(key)] = {
      type: 'decimal', operator: o.max == null ? 'greaterThanOrEqual' : 'between', formulae: o.max == null ? [o.min] : [o.min, o.max],
      allowBlank: true, showErrorMessage: true, errorStyle: 'stop', errorTitle: 'A number', error: o.min < 0 ? 'Enter a number; a minus sign means paid in advance.' : 'Enter a number, 0 or more.',
    };
  };

  const packTypes = allPackKinds(customPackTypes(await getSettings(k))).map((t) => t.name);
  if (kind === 'products') {
    const types = [...packTypes, LOOSE_WORD];
    const used = (await k.selectFrom('products').select('pack_size').distinct().where('pack_size', '!=', '').execute()).map((r) => r.pack_size);
    const sizes = [...new Map([...COMMON_SIZES, ...used].map((x) => [x.toLowerCase(), x])).values()].sort(bySize);
    choose('packKind', addList('Pack type', types), {
      title: 'Pack type', prompt: 'Pick from the list (Bori, Bag, Can… or Loose).', strict: true,
      error: 'Choose a pack type from the list. To add a new one, add it in Commercia first (Add Product, Pack type, New type), then download this template again.',
    });
    choose('packSize', addList('Pack size', sizes), {
      title: 'Pack size', prompt: 'Pick a size, or type your own: a number and kg, g, L, ml or pc.',
      error: 'Use a number and kg, g, L, ml or pc, like 25 kg or 500 ml. Continue only if that is what you meant.',
    });
    for (const key of ['price', 'opening', 'reorder']) number(key, { min: 0 });
  }

  if (kind === 'stock') {
    const suppliers = (await k.selectFrom('suppliers').select('name').where('active', '=', 1).orderBy('name').execute()).map((r) => r.name);
    const products = (await k.selectFrom('products').select('name_en').where('active', '=', 1).orderBy('name_en').execute()).map((r) => r.name_en);
    choose('product', addList('Product', products), {
      title: 'Product', prompt: 'Pick the item. Add it in Commercia first if it is not in the list.',
      error: 'This is not an item in Commercia yet. Add it first (Import → Products, or Add Product), or Continue only if you typed its code.',
    });
    choose('supplier', addList('Supplier', suppliers), {
      title: 'Supplier', prompt: 'Pick a supplier, or type a new name to add one.',
      error: 'This supplier is not in the list yet. Continue to add them as a new supplier.',
    });
    choose('qty', addList('Quantity', QUANTITIES), {
      title: 'Quantity', prompt: 'Pick a number, or type your own (2.5). It is how many of the Unit next to it.',
      error: 'Use a number, like 10 or 2.5. Continue only if that is what you meant.',
    });
    choose('unit', addList('Unit', [...packTypes, 'kg', 'L', 'pc', 'Carton']), {
      title: 'Unit', prompt: 'Bori, Bag, Can… for whole packs, or kg / L / pc. A bigger unit of the item (Carton) works too.',
      error: 'Pick a unit from the list, or type the exact name of one of the item\'s bigger units. Continue only if that is what you meant.',
    });
    number('rate', { min: 0 });
    // Amount = Quantity × Rate, worked out in the sheet itself. The import works it out again and ignores this column.
    const [q, r, t] = [letterOf('qty'), letterOf('rate'), fields.findIndex((f) => f.key === 'total') + 1];
    for (let row = 2; row <= LAST; row++) {
      const ex = examples[row - 2];
      const cell = ws.getCell(row, t);
      cell.value = { formula: `IF(AND(ISNUMBER(${q}${row}),ISNUMBER(${r}${row})),ROUND(${q}${row}*${r}${row},2),"")`, result: ex ? Number(ex.row.total) : undefined };
      cell.numFmt = '#,##0.00';
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    }
    ws.getColumn(t).numFmt = '#,##0.00';
    wb.calcProperties.fullCalcOnLoad = true;
  }

  if (kind === 'customers') {
    choose('party', addList('Type', ['Sale', 'Purchase']), {
      title: 'Sale or Purchase', prompt: 'Sale = a customer who owes you. Purchase = a supplier you owe.', strict: true,
      error: 'Choose Sale (a customer) or Purchase (a supplier).',
    });
    choose('priceList', addList('Price list', ['retail', 'wholesale']), { title: 'Price list', prompt: 'Customers only: retail or wholesale.', strict: true, error: 'Choose retail or wholesale.' });
    number('amount', { min: -100000000, max: 100000000 });
  }

  const help = wb.addWorksheet('Instructions');
  help.columns = [{ header: 'Column', width: 26 }, { header: 'Required', width: 10 }, { header: 'How to fill it', width: 100 }];
  help.getRow(1).font = { bold: true };
  help.addRow(['Start here', '', 'The grey rows on the first sheet are examples. Delete them before you upload, or they will be added as real items.']);
  for (const f of fields) help.addRow([f.header, f.required ? 'Yes' : '', f.help]);
  help.addRow([]);
  if (kind === 'products') {
    help.addRow(['One row per company and size', '', 'Sugar from two companies, each in 50 kg and 25 kg, is four rows. Each has its own price and stock.']);
    help.addRow(['Names are made for you', '', 'From the columns: Sooji — Annapurna 25 kg Bag. Upload the same file again and nothing changes; change a price and that row is updated.']);
    help.addRow(['GST', '', 'New items get the default GST % in Settings; change one item later in Add Product. Prices include GST.']);
  }
  if (kind === 'stock') {
    help.addRow(['Amount', '', 'Worked out in the sheet: Quantity × Rate for each row (10 bori at 1,200 = 12,000). Fill the Amount cells down for any rows you add below the grey ones.']);
    help.addRow(['Purchase ledger', '', 'All rows with the same Supplier and Date form one delivery. Its total (the sum of its Amounts) is added to what you owe that supplier, in Ledger → Purchase. Pay them there when you pay.']);
    help.addRow(['Tip', '', 'The products must already exist in Commercia. Upload your products first.']);
    help.addRow(['Total of this sheet', '', { formula: `SUM('${title}'!${letterOf('total')}2:${letterOf('total')}${LAST})`, result: examples.reduce((a, e) => a + Number(e.row.total), 0) }]);
  }
  if (kind === 'customers') {
    help.addRow(['Sale and Purchase', '', 'Sale: a customer, and what they owe you (the Sales ledger). Purchase: a supplier, and what you owe them (the Purchase ledger). Leave Type empty for Sale.']);
    help.addRow(['Existing names', '', 'A customer already in Commercia only gets their details (phone, area) updated. A supplier already in Commercia gets the amount too, unless they already have an opening balance: then only their details are updated, so uploading the same file twice never adds it twice.']);
  }
  help.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="commercia-${kind}-template.xlsx"`,
    },
  });
});

// ---------- Upload → preview (IMP-2, IMP-3). The file itself is never stored (Q10). ----------
admin.post('/import/preview', async (c) => {
  const form = await c.req.formData();
  const kind = kindSchema.parse(form.get('kind'));
  await need(c, permFor[kind]);
  const file = form.get('file');
  if (!(file instanceof File)) throw bad('Choose a file');
  if (file.size > 10 * 1024 * 1024) throw bad('File is too large (10 MB max)');
  let sheet;
  try {
    sheet = await readSheet(file.name, await file.arrayBuffer());
  } catch (e) {
    throw bad(e instanceof Error ? e.message : 'Could not read this file');
  }
  if (sheet.rows.length > 5000) throw bad(`This file has ${sheet.rows.length} rows; the limit is 5,000`);
  const { map, missing } = mapHeaders(kind, sheet.headers);
  if (missing.length) throw bad(`Missing column(s): ${missing.join(', ')}. Download the template to see the expected headers.`, { headers: sheet.headers });
  const rows: RowData[] = sheet.rows.map((r) => {
    const d: RowData = {};
    map.forEach((key, i) => {
      if (key) d[key] = (r[i] ?? '').trim();
    });
    return d;
  });
  const preview = await previewImport(c.get('db').k, kind, rows, { newOnly: addOnly(c.get('user'), kind) });
  return c.json({ fileName: file.name, headers: sheet.headers, mapped: map, ...preview });
});

/** Re-check rows after fixing them in the preview. */
admin.post('/import/validate', async (c) => {
  const body = z.object({ kind: kindSchema, rows: z.array(z.record(z.string(), z.string())) }).parse(await c.req.json());
  const user = await need(c, permFor[body.kind]);
  return c.json(await previewImport(c.get('db').k, body.kind, body.rows, { newOnly: addOnly(user, body.kind) }));
});

admin.post('/import/commit', async (c) => {
  const body = z
    .object({ kind: kindSchema, rows: z.array(z.record(z.string(), z.string())).min(1), fileName: z.string().default(''), asOf: z.string().optional() })
    .parse(await c.req.json());
  const user = await need(c, permFor[body.kind]);
  const res = await c.get('db').k.transaction().execute((tx) => commitImport(tx, user, body.kind, body.rows, body.fileName, { asOf: body.asOf, newOnly: addOnly(user, body.kind) }));
  return c.json(res);
});

admin.get('/imports', async (c) => {
  const rows = await c
    .get('db')
    .k.selectFrom('imports as i')
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .select(['i.id', 'i.kind', 'i.file_name', 'i.summary', 'i.undone', 'i.created_at', 'i.created_by', 'u.name as by'])
    .orderBy('i.id', 'desc')
    .limit(20)
    .execute();
  return c.json(rows.map((r) => ({ ...r, summary: (() => { try { return JSON.parse(r.summary).text as string; } catch { return r.summary; } })() })));
});

admin.post('/imports/:id/undo', async (c) => {
  const id = Number(c.req.param('id'));
  const me = c.get('user');
  let user = me;
  if (!can(me.role, 'import.undo')) {
    // Everyone may take back their own import; someone else's is an Owner's call (refused and logged).
    user = await need(c, 'import.undo.own');
    const imp = await c.get('db').k.selectFrom('imports').select('created_by').where('id', '=', id).executeTakeFirst();
    if (!imp || imp.created_by !== me.id) await need(c, 'import.undo');
  }
  await c.get('db').k.transaction().execute((tx) => undoImport(tx, user, id));
  return c.json({ ok: true });
});

// ---------- Pack types: the list in the product form and the dropdown of the products sheet ----------
admin.post('/pack-types', async (c) => {
  const user = await need(c, 'catalog.add');
  const { name } = z.object({ name: z.string() }).parse(await c.req.json());
  const clean = cleanPackKindName(name);
  if (!clean) throw bad('A pack type is a word of 2 to 20 letters, like "can" or "sack" (and not "Loose")');
  const { k } = c.get('db');
  const custom = customPackTypes(await getSettings(k));
  const have = findPackKind(clean, custom);
  if (have) throw new HttpError(409, `"${have.name}" is already in the list`, 'conflict');
  const next = [...custom, clean];
  await setSetting(k, 'pack_types', JSON.stringify(next));
  await logActivity(k, user.id, 'create', 'pack_type', null, `Added pack type "${clean}"`);
  return c.json({ value: clean, packTypes: allPackKinds(next) });
});

// ---------- Settings (ADM-1, GST-1, GST-3) ----------
admin.get('/settings', async (c) => c.json(await getSettings(c.get('db').k)));

admin.patch('/settings', async (c) => {
  const user = await need(c, 'settings.edit');
  const body = z
    .object({
      shop_name: z.string().min(1).optional(),
      shop_name_hi: z.string().optional(),
      shop_address: z.string().optional(),
      shop_phone: z.string().optional(),
      shop_gstin: z.string().toUpperCase().optional(),
      paper: z.enum(['A4', 'thermal']).optional(),
      prefix_receipt: z.string().min(1).max(8).optional(),
      prefix_invoice: z.string().min(1).max(8).optional(),
      prefix_estimate: z.string().min(1).max(8).optional(),
      composition_pct: z.string().optional(),
      prices_include_gst: z.enum(['0', '1']).optional(),
      default_gst: z.enum(['0', '5', '12', '18', '28']).optional(),
      require_2fa: z.enum(['0', '1']).optional(),
      backup_dir: z.string().optional(),
      default_lang: z.enum(['en', 'hi']).optional(),
    })
    .parse(await c.req.json());
  const { k } = c.get('db');
  for (const [key, value] of Object.entries(body)) if (value !== undefined) await setSetting(k, key, value);
  await logActivity(k, user.id, 'update', 'settings', null, `Changed settings: ${Object.keys(body).join(', ')}`);
  return c.json(await getSettings(k));
});

/** GST scheme with the date it applies from (GST-1). Past bills never change. */
admin.post('/settings/gst-scheme', async (c) => {
  const user = await need(c, 'gst.edit');
  const body = z.object({ scheme: z.enum(['regular', 'composition', 'unregistered']), from: z.string() }).parse(await c.req.json());
  if (!isIsoDate(body.from)) throw bad('Bad date');
  const { k } = c.get('db');
  const s = await getSettings(k);
  const periods = (JSON.parse(s.gst_schemes) as SchemePeriod[]).filter((p) => p.from !== body.from);
  periods.push({ from: body.from, scheme: body.scheme });
  periods.sort((a, b) => a.from.localeCompare(b.from));
  await setSetting(k, 'gst_schemes', JSON.stringify(periods));
  await logActivity(k, user.id, 'update', 'settings', null, `GST scheme set to ${body.scheme} from ${body.from}`);
  return c.json(periods);
});

// ---------- Backups (PILOT-5, ADM-3) ----------
admin.get('/backup', async (c) => {
  await need(c, 'backup.run');
  const db = c.get('db');
  const s = await getSettings(db.k);
  return c.json({ lastBackupAt: s.last_backup_at, dir: s.backup_dir || path.resolve('backups'), files: listBackups(s.backup_dir) });
});

admin.post('/backup/now', async (c) => {
  const user = await need(c, 'backup.run');
  const db = c.get('db');
  const res = await runBackup(db);
  await logActivity(db.k, user.id, 'backup', 'database', null, `Backup saved to ${res.file}`);
  return c.json(res);
});

/** Download a copy of the database, e.g. to a USB drive. It is locked with the secret key like every backup. */
admin.get('/backup/download', async (c) => {
  const user = await need(c, 'backup.run');
  await requireReauth(c);
  const db = c.get('db');
  const res = await runBackup(db);
  const data = fs.readFileSync(res.file);
  await logActivity(db.k, user.id, 'backup_download', 'database', null, `${user.name} downloaded a backup (${path.basename(res.file)}, ${Math.round(res.size / 1024)} KB)`);
  return new Response(data, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(res.file)}"` },
  });
});

// ---------- Full export (ADM-5, PILOT-6) and reset (PILOT-7) ----------
const TABLES: (keyof DB)[] = [
  'settings', 'users', 'categories', 'products', 'product_units', 'unit_prices', 'product_gst', 'rate_checks', 'rate_requests',
  'stock_ins', 'stock_movements', 'losses', 'loss_lines', 'customers', 'bills', 'bill_lines', 'payments', 'payment_parts',
  'ledger', 'cash_outs', 'suppliers', 'supplier_ledger', 'activity', 'versions', 'imports', 'counters',
];
export { TABLES };

/** Columns that never leave the database in an export: password hashes and authenticator secrets. */
const NEVER_EXPORTED: Partial<Record<keyof DB, string[]>> = { users: ['password_hash', 'totp_secret'] };

admin.get('/admin/export.json', async (c) => {
  const user = await need(c, 'backup.run');
  await requireReauth(c);
  const { k } = c.get('db');
  const out: Record<string, unknown[]> = {};
  let rows = 0;
  for (const t of TABLES) {
    const hide = NEVER_EXPORTED[t] ?? [];
    out[t] = (await k.selectFrom(t).selectAll().execute()).map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([col]) => !hide.includes(col))));
    rows += out[t].length;
  }
  await logActivity(k, user.id, 'export', 'database', null, `${user.name} exported all data (${rows} rows in ${TABLES.length} tables; no passwords or secrets)`);
  return new Response(JSON.stringify({ app: 'commercia', version: 1, exportedAt: new Date().toISOString(), tables: out }), {
    headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="commercia-export.json"' },
  });
});

/** Wipe test data before go-live; users and settings stay (PILOT-7). Admin only, after typing the shop name. */
admin.post('/admin/reset', async (c) => {
  const user = await need(c, 'data.reset');
  await requireReauth(c);
  const { confirm } = z.object({ confirm: z.string() }).parse(await c.req.json());
  const db = c.get('db');
  const s = await getSettings(db.k);
  if (confirm.trim() !== s.shop_name.trim()) throw new HttpError(400, 'Type the shop name exactly to confirm', 'bad_request');
  // The pilot keeps a file copy first. On Postgres (Supabase) the nightly backups are the safety net.
  if (db.dialect === 'sqlite') await runBackup(db, 'before-reset');
  const wipe: (keyof DB)[] = [
    'categories', 'products', 'product_units', 'unit_prices', 'product_gst', 'rate_checks', 'rate_requests', 'stock_ins', 'stock_movements',
    'losses', 'loss_lines', 'customers', 'bills', 'bill_lines', 'payments', 'payment_parts', 'ledger', 'cash_outs', 'suppliers', 'supplier_ledger', 'versions', 'imports', 'counters',
  ];
  await db.k.transaction().execute(async (tx) => {
    await setSetting(tx, '__allow_purge', '1');
    if (db.dialect === 'postgres') await (await import('kysely')).sql`select set_config('commercia.allow_purge', '1', true)`.execute(tx);
    for (const t of wipe) await tx.deleteFrom(t).execute();
    await tx.deleteFrom('settings').where('key', '=', '__allow_purge').execute();
    await logActivity(tx, user.id, 'reset', 'database', null, 'Wiped test data before go-live (backup kept)');
  });
  return c.json({ ok: true });
});
