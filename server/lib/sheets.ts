import ExcelJS from 'exceljs';
import { UnsafeFile, assertSafeZip, looksLikeOldExcel, looksLikeZip } from './zipSafety';

/** What a file may hold: rows, columns, and the length of one cell. The import itself caps rows at 5,000. */
export const SHEET_LIMITS = { rows: 5000, columns: 60, cellChars: 2000, worksheets: 50 };

/**
 * Reads the first sheet of an .xlsx or .csv into rows of strings keyed by header. The file is judged by what is in it,
 * not by its name: a zip is unpacked only after it has been checked for size tricks, a text file must be text, and an
 * old .xls, a program or a picture renamed to .xlsx is refused.
 */
export async function readSheet(fileName: string, data: ArrayBuffer): Promise<{ headers: string[]; rows: string[][] }> {
  const bytes = new Uint8Array(data);
  if (looksLikeOldExcel(bytes)) {
    throw new Error('Old .xls files can\'t be read. In Excel use File → Save As → "Excel Workbook (.xlsx)" and upload that.');
  }
  if (looksLikeZip(bytes)) {
    try {
      assertSafeZip(bytes);
    } catch (e) {
      if (e instanceof UnsafeFile) throw new Error(e.message);
      throw e;
    }
    return readXlsx(data);
  }
  // Not a zip: it must be plain text (a .csv), with no binary bytes in it.
  if (!/\.(csv|txt)$/i.test(fileName) || bytes.subarray(0, 65536).includes(0)) {
    throw new Error('This does not look like a spreadsheet. Upload an Excel file (.xlsx) or a .csv saved from Excel or Google Sheets.');
  }
  return checked(parseCsv(new TextDecoder('utf-8').decode(data)));
}

/** The caps, applied to whatever was read. */
function checked(sheet: { headers: string[]; rows: string[][] }): { headers: string[]; rows: string[][] } {
  const { rows, columns, cellChars } = SHEET_LIMITS;
  if (sheet.rows.length > rows) throw new Error(`This file has ${sheet.rows.length} rows; the limit is ${rows.toLocaleString('en-IN')}.`);
  const width = Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length));
  if (width > columns) throw new Error(`This file has ${width} columns; the limit is ${columns}. Check that it is the right file.`);
  for (const r of [sheet.headers, ...sheet.rows]) for (const v of r) if (v.length > cellChars) throw new Error(`A cell in this file has ${v.length} characters; the limit is ${cellChars}.`);
  return sheet;
}

async function readXlsx(data: ArrayBuffer): Promise<{ headers: string[]; rows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data);
  } catch {
    throw new Error('This Excel file could not be read. Open it in Excel and save it again as .xlsx.');
  }
  if (wb.worksheets.length > SHEET_LIMITS.worksheets) throw new Error(`This workbook has ${wb.worksheets.length} sheets.`);
  const ws = wb.worksheets.find((w) => !/^instructions?$/i.test(w.name) && w.rowCount > 0) ?? wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  if (ws.columnCount > SHEET_LIMITS.columns) throw new Error(`This sheet has ${ws.columnCount} columns; the limit is ${SHEET_LIMITS.columns}. Check that it is the right file.`);
  const all: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // (the first row is the header; stop as soon as there are too many, rather than reading on)
    if (all.length > SHEET_LIMITS.rows + 1 + 1000 && all.every((r) => r.every((v) => v === ''))) return;
    const vals: string[] = [];
    const count = Math.max(row.cellCount, ws.columnCount);
    for (let i = 1; i <= count; i++) vals.push(cellText(row.getCell(i).value));
    all.push(vals);
  });
  const [headers = [], ...rows] = all;
  return checked({ headers: headers.map((h) => h.trim()), rows: rows.filter((r) => r.some((v) => v.trim() !== '')) });
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if ('formula' in v || 'sharedFormula' in v) return ''; // a formula that was never worked out (the file was not saved by Excel)
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
  }
  return String(v).trim();
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  const [headers = [], ...rows] = out;
  return { headers: headers.map((h) => h.trim()), rows: rows.filter((r) => r.some((v) => v.trim() !== '')).map((r) => r.map((v) => v.trim())) };
}

/**
 * A cell that starts with = + - @ (or a tab or return) is read as a formula by Excel and Google Sheets when a file is opened
 * ("=HYPERLINK(...)" or worse), so a name typed by one person could do things when another opens the export. A single quote in
 * front makes it plain text. Numbers are left alone: a negative amount is a number, not text.
 */
export function neutralizeFormula<T>(v: T): T | string {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** `neutralize` for exports of people's data (the templates, whose example "-500" is meant as a number, do not use it). */
export function toCsv(rows: (string | number)[][], opts: { neutralize?: boolean } = {}): string {
  const esc = (v: string | number) => {
    const s = String(opts.neutralize ? neutralizeFormula(v) : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens Hindi text as UTF-8 (IMP-1).
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
