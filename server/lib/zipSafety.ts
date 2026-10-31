// A spreadsheet (.xlsx) is a zip file, and a zip file can be a bomb: a few kilobytes that unpack to gigabytes. Before the
// file is handed to the spreadsheet reader, its table of contents is read and every entry is unpacked into a size limit, so a
// file whose headers lie about its sizes is caught too. Nothing is written to disk.
import zlib from 'node:zlib';

export const ZIP_LIMITS = {
  entries: 300,
  /** All entries together, once unpacked. A 5,000-row sheet is a few MB. */
  totalBytes: 100 * 1024 * 1024,
  entryBytes: 60 * 1024 * 1024,
  /** Largest believable shrinkage for an entry over 1 MB (sheet XML shrinks 10 to 50 times). */
  ratio: 250,
};

export class UnsafeFile extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function looksLikeZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);
}
/** The older binary Excel format (.xls), which is not supported. */
export const looksLikeOldExcel = (b: Uint8Array) => b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

export function assertSafeZip(b: Uint8Array, limits = ZIP_LIMITS): void {
  const bad = (why: string) => new UnsafeFile(`This file is not a safe Excel file (${why}). Open it in Excel and save it again as .xlsx.`);
  // The end-of-central-directory record is within the last 64 KB.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('it is damaged or incomplete');
  const count = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw bad('it uses a format for huge files');
  if (count === 0 || count > limits.entries) throw bad(`it has ${count} parts`);
  if (cdOffset + cdSize > b.length) throw bad('it is damaged');

  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw bad('it is damaged');
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const compressed = u32(b, p + 20);
    const declared = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = Buffer.from(b.subarray(p + 46, p + 46 + nameLen)).toString('latin1');
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw bad('it is password protected');
    if (/(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-z]:|\0/i.test(name)) throw bad('a part has a suspicious name');
    if (declared > limits.entryBytes) throw bad('a part is too large');
    if (declared > 1024 * 1024 && declared / Math.max(compressed, 1) > limits.ratio) throw bad('a part shrinks far more than a spreadsheet does');
    total += declared;
    if (total > limits.totalBytes) throw bad('it unpacks to too much');

    // Look at the real data, not the claim: unpack it into the size the headers promised.
    if (local + 30 > b.length || u32(b, local) !== 0x04034b50) throw bad('it is damaged');
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    if (start + compressed > b.length) throw bad('it is damaged');
    const data = b.subarray(start, start + compressed);
    if (method === 0) {
      if (compressed !== declared) throw bad('a part lies about its size');
    } else if (method === 8) {
      try {
        const out = zlib.inflateRawSync(data, { maxOutputLength: declared + 64 });
        if (out.length !== declared) throw bad('a part lies about its size');
      } catch (e) {
        if (e instanceof UnsafeFile) throw e;
        throw bad('a part unpacks to more than it says, or is damaged');
      }
    } else throw bad('it uses an unusual way of packing');
  }
}
