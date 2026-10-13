import ExcelJS from 'exceljs';

/** Reads the first sheet of an .xlsx or .csv into rows of strings keyed by header. */
export async function readSheet(fileName: string, data: ArrayBuffer): Promise<{ headers: string[]; rows: string[][] }> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return parseCsv(new TextDecoder('utf-8').decode(data));
  if (lower.endsWith('.xls')) {
    throw new Error('Old .xls files can\'t be read. In Excel use File → Save As → "Excel Workbook (.xlsx)" and upload that.');
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets.find((w) => !/^instructions?$/i.test(w.name) && w.rowCount > 0) ?? wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const all: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals: string[] = [];
    const count = Math.max(row.cellCount, ws.columnCount);
    for (let i = 1; i <= count; i++) vals.push(cellText(row.getCell(i).value));
    all.push(vals);
  });
  const [headers = [], ...rows] = all;
  return { headers: headers.map((h) => h.trim()), rows: rows.filter((r) => r.some((v) => v.trim() !== '')) };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
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

export function toCsv(rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens Hindi text as UTF-8 (IMP-1).
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
