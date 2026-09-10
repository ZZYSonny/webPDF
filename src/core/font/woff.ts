/**
 * WOFF (level 1) encoder.
 *
 * The generated subset fonts are small, and shipping a second multi-megabyte
 * wasm blob just to gain the last few hundred bytes of WOFF2 brotli was not
 * worth the integration risk. WOFF is understood by every browser, works inside
 * `<img src="...svg">` documents, and needs nothing beyond the platform's own
 * zlib through `CompressionStream`.
 *
 * Layout follows https://www.w3.org/TR/WOFF/ - a 44 byte header, one 20 byte
 * directory entry per sfnt table, then the (optionally zlib compressed) tables,
 * each padded to a four byte boundary.
 */

const WOFF_SIGNATURE = 0x774f4646; // 'wOFF'

export interface WoffEncodeResult {
  data: Uint8Array;
  /** Bytes saved by compressing the tables. */
  saved: number;
}

interface SfntTable {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Parse the sfnt table directory emitted by the font writer. */
export function parseSfnt(ttf: Uint8Array): { flavor: number; tables: SfntTable[] } {
  const view = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const flavor = view.getUint32(0);
  const numTables = view.getUint16(4);
  const tables: SfntTable[] = [];
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    tables.push({
      tag: readTag(view, p),
      checksum: view.getUint32(p + 4),
      offset: view.getUint32(p + 8),
      length: view.getUint32(p + 12),
    });
  }
  return { flavor, tables };
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  const Ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!Ctor) return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new Ctor('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Re-wrap a TrueType/OpenType font as WOFF.
 *
 * Falls back to returning the original bytes when `CompressionStream` is not
 * available (older runtimes); the caller then declares the font as `truetype`.
 */
export async function encodeWoff(ttf: Uint8Array): Promise<WoffEncodeResult | null> {
  const { flavor, tables } = parseSfnt(ttf);
  if (tables.length === 0) return null;

  const encoded: { table: SfntTable; payload: Uint8Array; compressed: boolean }[] = [];
  let saved = 0;

  for (const table of tables) {
    const raw = ttf.subarray(table.offset, table.offset + table.length);
    const z = await deflate(raw);
    if (z && z.length < raw.length) {
      saved += raw.length - z.length;
      encoded.push({ table, payload: z, compressed: true });
    } else {
      encoded.push({ table, payload: raw, compressed: false });
    }
  }

  const headerSize = 44 + tables.length * 20;
  let total = headerSize;
  for (const e of encoded) total += pad4(e.payload.length);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  let sfntSize = 12 + tables.length * 16;
  for (const t of tables) sfntSize += pad4(t.length);

  view.setUint32(0, WOFF_SIGNATURE);
  view.setUint32(4, flavor);
  view.setUint32(8, total);
  view.setUint16(12, tables.length);
  view.setUint16(14, 0);
  view.setUint32(16, sfntSize);
  view.setUint16(20, 1);
  view.setUint16(22, 0);
  view.setUint32(24, 0);
  view.setUint32(28, 0);
  view.setUint32(32, 0);
  view.setUint32(36, 0);
  view.setUint32(40, 0);

  let offset = headerSize;
  for (let i = 0; i < encoded.length; i++) {
    const { table, payload } = encoded[i];
    const p = 44 + i * 20;
    for (let c = 0; c < 4; c++) out[p + c] = table.tag.charCodeAt(c);
    view.setUint32(p + 4, offset);
    view.setUint32(p + 8, payload.length);
    view.setUint32(p + 12, table.length);
    view.setUint32(p + 16, table.checksum);
    out.set(payload, offset);
    offset += pad4(payload.length);
  }

  return { data: out, saved };
}

/** Total uncompressed size of an sfnt file, for metrics. */
export function sfntSize(ttf: Uint8Array): number {
  const { tables } = parseSfnt(ttf);
  let size = 12 + tables.length * 16;
  for (const t of tables) size += pad4(t.length);
  return size;
}
