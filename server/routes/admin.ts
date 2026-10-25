import { Hono } from 'hono';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import type { AppEnv } from '../lib/core';
import { HttpError, bad, logActivity, need } from '../lib/core';
import { EXAMPLES, FIELDS, commitImport, mapHeaders, previewImport, undoImport, type ImportKind, type RowData } from '../lib/importer';
import { readSheet, toCsv } from '../lib/sheets';
import { getSettings, setSetting, type SchemePeriod } from '../lib/settings';
import { runBackup, listBackups } from '../lib/backup';
import { isIsoDate } from '../../shared/dates';
import type { DB } from '../db/schema';

export const admin = new Hono<AppEnv>();

const kindSchema = z.enum(['products', 'stock', 'customers']);
const permFor: Record<ImportKind, 'import.products' | 'import.stock' | 'import.customers'> = {
  products: 'import.products',
  stock: 'import.stock',
  customers: 'import.customers',
};

// ---------- Import templates (IMP-1) ----------
admin.get('/import/template/:file', async (c) => {
  const m = c.req.param('file').match(/^(products|stock|customers)\.(xlsx|csv)$/);
  if (!m) throw bad('Unknown template');
  const kind = m[1] as ImportKind;
  const fields = FIELDS[kind];
  const title = { products: 'Products', stock: 'Stock deliveries', customers: 'Customer dues' }[kind];
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
    // Whole-pack columns are shaded differently, so it is clear they are only for bori / bag / tin / pouch items.
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f.wholePack ? 'FFFCE3C4' : 'FFDDF1EC' } };
    cell.note = f.help; // hover a heading to see how to fill the column
  });
  for (const e of examples) ws.addRow(rowOf(e.row));
  ws.getRows(2, examples.length)?.forEach((r) => (r.font = { italic: true, color: { argb: 'FF6B7280' } }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const help = wb.addWorksheet('Instructions');
  help.columns = [{ header: 'Column', width: 30 }, { header: 'Required', width: 10 }, { header: 'How to fill it', width: 100 }];
  help.getRow(1).font = { bold: true };
  help.addRow(['Start here', '', 'The grey rows on the first sheet are examples: delete them (or overwrite them) before you upload, or they will be added as real items.']);
  if (kind === 'products') {
    help.addRow(['Which columns do I fill?', '', '']);
    const kinds: [string, string][] = [
      ['Loose, sold by kg or litre (sugar, dal, oil)', 'Category path, Product name, Base unit = kg or L, Selling price, GST %. Optional: Extra units and their prices if it also comes in bags or tins.'],
      ['Packet or piece (tea, soap, biscuits)', 'Category path, Product name, Base unit = pc, Selling price, GST %. Optional: Extra units such as Box of 12 = 12.'],
      ['Bori or Bag, sold WHOLE (one product per company and size)', 'Category path, Product name, Brand, Pack type = Bori or Bag, Pack size, Item group, Selling price of ONE bori / bag, GST %. Leave Base unit empty. Opening stock is the number of bori / bags.'],
      ['Tin, pouch, jar or bottle (ghee, refined oil), sold whole', 'The same as bori / bag, with Pack type = Tin, Pouch, Jar or Bottle. For cartons add Extra units: Carton (12 × 1 L) = 12.'],
    ];
    for (const [k, v] of kinds) help.addRow([k, '', v]);
    help.addRow(['One product per company and size', '', 'Sooji by two companies in two sizes is FOUR rows: each has its own price and stock. "Item group" (Sooji) is what lines them up in the Stock summary.']);
    help.addRow([]);
  }
  help.addRow(['Every column', '', '']);
  for (const f of fields) help.addRow([f.header, f.required ? 'Yes' : '', f.help]);
  help.addRow([]);
  help.addRow(['Tip', '', 'Keep the first row as headings. Hindi text is fine (use a normal Unicode Hindi font, not Kruti Dev).']);
  if (kind === 'products') help.addRow(['Tip', '', 'Uploading the same file again changes nothing. Items are matched by Code, otherwise by Product name.']);
  if (kind === 'stock') help.addRow(['Tip', '', 'The product names must already exist in Commercia. Upload your products first.']);
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
  const preview = await previewImport(c.get('db').k, kind, rows);
  return c.json({ fileName: file.name, headers: sheet.headers, mapped: map, ...preview });
});

/** Re-check rows after fixing them in the preview. */
admin.post('/import/validate', async (c) => {
  const body = z.object({ kind: kindSchema, rows: z.array(z.record(z.string(), z.string())) }).parse(await c.req.json());
  await need(c, permFor[body.kind]);
  return c.json(await previewImport(c.get('db').k, body.kind, body.rows));
});

admin.post('/import/commit', async (c) => {
  const body = z
    .object({ kind: kindSchema, rows: z.array(z.record(z.string(), z.string())).min(1), fileName: z.string().default(''), asOf: z.string().optional() })
    .parse(await c.req.json());
  const user = await need(c, permFor[body.kind]);
  const res = await c.get('db').k.transaction().execute((tx) => commitImport(tx, user, body.kind, body.rows, body.fileName, { asOf: body.asOf }));
  return c.json(res);
});

admin.get('/imports', async (c) => {
  const rows = await c
    .get('db')
    .k.selectFrom('imports as i')
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .select(['i.id', 'i.kind', 'i.file_name', 'i.summary', 'i.undone', 'i.created_at', 'u.name as by'])
    .orderBy('i.id', 'desc')
    .limit(20)
    .execute();
  return c.json(rows.map((r) => ({ ...r, summary: (() => { try { return JSON.parse(r.summary).text as string; } catch { return r.summary; } })() })));
});

admin.post('/imports/:id/undo', async (c) => {
  const user = await need(c, 'import.undo');
  const id = Number(c.req.param('id'));
  await c.get('db').k.transaction().execute((tx) => undoImport(tx, user, id));
  return c.json({ ok: true });
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

/** Download a copy of the database, e.g. to a USB drive. */
admin.get('/backup/download', async (c) => {
  await need(c, 'backup.run');
  const db = c.get('db');
  const res = await runBackup(db);
  const data = fs.readFileSync(res.file);
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

admin.get('/admin/export.json', async (c) => {
  const user = await need(c, 'backup.run');
  const { k } = c.get('db');
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = await k.selectFrom(t).selectAll().execute();
  await logActivity(k, user.id, 'export', 'database', null, 'Exported all data');
  return new Response(JSON.stringify({ app: 'commercia', version: 1, exportedAt: new Date().toISOString(), tables: out }), {
    headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="commercia-export.json"' },
  });
});

/** Wipe test data before go-live; users and settings stay (PILOT-7). Admin only, after typing the shop name. */
admin.post('/admin/reset', async (c) => {
  const user = await need(c, 'data.reset');
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
