import { describe, expect, it, beforeAll } from 'vitest';
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import { readSheet, toCsv, neutralizeFormula, SHEET_LIMITS } from '../server/lib/sheets';
import { assertSafeZip, ZIP_LIMITS } from '../server/lib/zipSafety';
import { setup, type Client } from './helpers';

const crc32 = (b: Buffer) => {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};

interface Part {
  name: string;
  data: Buffer; // the real content
  method?: 0 | 8 | 99;
  /** What the headers claim, when that is to be a lie. */
  claimUncompressed?: number;
  flags?: number;
}
/** Builds a zip by hand, so a file whose headers lie can be made too. */
function zip(parts: Part[], opts: { eocdOffsetShift?: number; entriesClaim?: number } = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const method = p.method ?? 8;
    const stored = method === 8 ? zlib.deflateRawSync(p.data) : p.data;
    const name = Buffer.from(p.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(p.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(p.data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(p.claimUncompressed ?? p.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, stored);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(p.flags ?? 0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(p.data), 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(p.claimUncompressed ?? p.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + stored.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.entriesClaim ?? parts.length, 8);
  end.writeUInt16LE(opts.entriesClaim ?? parts.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset + (opts.eocdOffsetShift ?? 0), 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}
const xlsx = async (fill: (ws: ExcelJS.Worksheet) => void) => {
  const wb = new ExcelJS.Workbook();
  fill(wb.addWorksheet('Sheet1'));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
};
const asBuf = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('zip safety', () => {
  it('lets a real spreadsheet through', async () => {
    const file = await xlsx((ws) => {
      ws.addRow(['Name', 'Amount']);
      for (let i = 0; i < 2000; i++) ws.addRow([`Customer ${i}`, i]);
    });
    expect(() => assertSafeZip(file)).not.toThrow();
    const read = await readSheet('dues.xlsx', asBuf(file));
    expect(read.rows).toHaveLength(2000);
  });

  it('refuses a bomb: a few KB that unpack to far too much (and does it fast)', () => {
    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(120 * 1024 * 1024) }]); // 120 MB of zeros
    expect(bomb.length).toBeLessThan(400 * 1024);
    const t = Date.now();
    expect(() => assertSafeZip(bomb)).toThrow(/shrinks far more|too large|too much/);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('refuses a bomb whose headers lie about the size', () => {
    const lie = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(80 * 1024 * 1024), claimUncompressed: 1000 }]);
    expect(() => assertSafeZip(lie)).toThrow(/more than it says|damaged|lies/);
  });

  it('refuses many small parts adding up to too much, too many parts, odd names, passwords, odd packing, and damage', () => {
    const chunk = Buffer.alloc(30 * 1024 * 1024, 'a');
    expect(() => assertSafeZip(zip([1, 2, 3, 4].map((i) => ({ name: `p${i}.xml`, data: chunk, method: 0 as const }))))).toThrow(/unpacks to too much/);
    const many = zip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `f${i}.xml`, data: Buffer.from('x') })));
    expect(() => assertSafeZip(many)).toThrow(/parts/);
    for (const name of ['../../evil.xml', '/etc/passwd', 'a/../../b', 'C:\\x']) expect(() => assertSafeZip(zip([{ name, data: Buffer.from('x') }])), name).toThrow(/suspicious name/);
    expect(() => assertSafeZip(zip([{ name: 'a.xml', data: Buffer.from('x'), flags: 1 }]))).toThrow(/password/);
    expect(() => assertSafeZip(zip([{ name: 'a.xml', data: Buffer.from('x'), method: 99 }]))).toThrow(/unusual way/);
    const ok = zip([{ name: 'a.xml', data: Buffer.from('hello hello hello') }]);
    expect(() => assertSafeZip(ok)).not.toThrow();
    expect(() => assertSafeZip(ok.subarray(0, ok.length - 30))).toThrow(/damaged|incomplete/);
    expect(() => assertSafeZip(zip([{ name: 'a.xml', data: Buffer.from('x') }], { eocdOffsetShift: 1000 }))).toThrow(/damaged/);
    expect(() => assertSafeZip(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)]))).toThrow(/damaged|incomplete/);
  });
});

describe('reading by content, not by name', () => {
  const text = (s: string) => asBuf(Buffer.from(s));
  it('refuses a program, a picture, text or an old .xls that is named like a spreadsheet', async () => {
    await expect(readSheet('x.xlsx', text('MZ\x90\x00 this is a program'))).rejects.toThrow(/does not look like a spreadsheet/);
    await expect(readSheet('x.xlsx', text('Name,Amount\nA,1\n'))).rejects.toThrow(/does not look like a spreadsheet/); // text is not an .xlsx
    await expect(readSheet('x.csv', asBuf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])))).rejects.toThrow(/does not look like a spreadsheet/); // a PNG named .csv
    await expect(readSheet('x.csv', asBuf(Buffer.from('Name,Amount\0\0\0\n')))).rejects.toThrow(/does not look like a spreadsheet/);
    await expect(readSheet('old.xls', asBuf(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)])))).rejects.toThrow(/Old \.xls files/);
    await expect(readSheet('x.xlsx', asBuf(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)])))).rejects.toThrow(/Old \.xls files/); // by content, whatever the name
  });

  it('reads a zip as a spreadsheet whatever its name, and a csv as text', async () => {
    const file = await xlsx((ws) => ws.addRow(['Name']) && ws.addRow(['A']));
    expect((await readSheet('renamed.csv', asBuf(file))).rows).toEqual([['A']]);
    expect((await readSheet('d.csv', text('Name,Amount\nRamesh,100\n'))).rows).toEqual([['Ramesh', '100']]);
  });

  it('reads nothing from a zip that is not a workbook (the import then says its columns are missing)', async () => {
    const notExcel = zip([{ name: 'hello.txt', data: Buffer.from('hello') }]);
    expect(await readSheet('x.xlsx', asBuf(notExcel))).toEqual({ headers: [], rows: [] });
  });

  it('caps columns, the length of a cell and the number of rows, in csv and xlsx', async () => {
    const wide = Array.from({ length: SHEET_LIMITS.columns + 1 }, (_, i) => `c${i}`).join(',');
    await expect(readSheet('w.csv', text(`${wide}\n`))).rejects.toThrow(/columns/);
    await expect(readSheet('l.csv', text(`Name\n${'x'.repeat(SHEET_LIMITS.cellChars + 1)}\n`))).rejects.toThrow(/characters; the limit/);
    await expect(readSheet('r.csv', text(`Name\n${'a\n'.repeat(SHEET_LIMITS.rows + 1)}`))).rejects.toThrow(/rows; the limit/);
    const rows = await xlsx((ws) => { ws.addRow(['Name']); for (let i = 0; i < SHEET_LIMITS.rows + 5; i++) ws.addRow([`n${i}`]); });
    await expect(readSheet('r.xlsx', asBuf(rows))).rejects.toThrow(/rows; the limit/);
    const longCell = await xlsx((ws) => ws.addRow(['Name']) && ws.addRow(['y'.repeat(SHEET_LIMITS.cellChars + 1)]));
    await expect(readSheet('l.xlsx', asBuf(longCell))).rejects.toThrow(/characters; the limit/);
    const wideSheet = await xlsx((ws) => ws.addRow(Array.from({ length: SHEET_LIMITS.columns + 2 }, (_, i) => `c${i}`)));
    await expect(readSheet('w.xlsx', asBuf(wideSheet))).rejects.toThrow(/columns/);
    // exactly at the limits is fine
    const edge = await xlsx((ws) => { ws.addRow(['Name']); for (let i = 0; i < SHEET_LIMITS.rows; i++) ws.addRow([`n${i}`]); });
    expect((await readSheet('e.xlsx', asBuf(edge))).rows).toHaveLength(SHEET_LIMITS.rows);
  });
});

describe('through the app', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let cookie = '';
  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    const login = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sunil@shop.in', password: 'password123' }) });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  });
  const upload = (name: string, bytes: Buffer, kind = 'products') => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', new File([new Uint8Array(bytes)], name));
    return ctx.app.request('/api/import/preview', { method: 'POST', headers: { Cookie: cookie }, body: form });
  };

  it('answers a zip bomb with a clear refusal, quickly, and the server carries on', async () => {
    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(120 * 1024 * 1024) }]);
    const t = Date.now();
    const r = await upload('bomb.xlsx', bomb);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not a safe Excel file/);
    expect(Date.now() - t).toBeLessThan(5000);
    expect((await ctx.app.request('/api/health')).status).toBe(200);
  });

  it('answers a disguised file with a clear refusal, and still takes a real one', async () => {
    expect((await (await upload('x.xlsx', Buffer.from('MZ not a spreadsheet'))).json()).error).toMatch(/does not look like a spreadsheet/);
    const good = await xlsx((ws) => {
      ws.addRow(['Category', 'Pack type', 'Pack size', 'Pack price']);
      ws.addRow(['Sugar', 'Bori', '50 kg', 2150]);
    });
    const r = await upload('ok.xlsx', good);
    expect(r.status).toBe(200);
    expect((await r.json()).counts.new).toBe(1);
  });

  it('writes exports so a cell cannot run as a formula, leaves numbers alone, and logs who exported what', async () => {
    const evil = ['=HYPERLINK("http://evil.example","click")', '+1+1', '-2+3', '@SUM(1)', '\tcmd', 'Normal name', '-500'];
    const res = await ctx.app.request('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ fileName: 'customers', sheets: [{ name: 'S', columns: [{ header: '=Header', key: 'n' }, { header: 'Amount', key: 'a', type: 'money' }], rows: evil.map((n, i) => ({ n, a: -(i + 1) * 100 })) }] }),
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe("'=Header");
    expect(ws.getColumn(1).values.slice(2)).toEqual(["'=HYPERLINK(\"http://evil.example\",\"click\")", "'+1+1", "'-2+3", "'@SUM(1)", "'\tcmd", 'Normal name', "'-500"]);
    expect(ws.getColumn(2).values.slice(2)).toEqual([-1, -2, -3, -4, -5, -6, -7]); // money stays a number, even when negative
    const log = (await owner.get('/api/activity')).find((a: any) => a.action === 'export' && /customers/.test(a.summary));
    expect(log.summary).toBe('Sunil Sharma exported "customers" (7 rows in 1 sheet)');
  });
});

describe('csv exports', () => {
  it('can neutralize formulas for data exports, and leaves templates exactly as they are', () => {
    expect(neutralizeFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeFormula('hello')).toBe('hello');
    expect(neutralizeFormula(-5)).toBe(-5);
    expect(toCsv([['Name', 'Amount'], ['=BAD()', -500]], { neutralize: true })).toContain("'=BAD()");
    expect(toCsv([['Name', 'Amount'], ['Pooja', '-500']])).toContain('Pooja,-500'); // the dues template's example stays a number
  });
});
