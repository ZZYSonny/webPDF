/**
 * What font programs a PDF embeds, and what a browser will do with each.
 *
 * This is the measurement behind the "the PDF's own font program is not reused"
 * limitation. It answers two questions with one run:
 *
 *   1. What is actually inside the corpus - `/FontFile` Type 1, `/FontFile2`
 *      TrueType, `/FontFile3` bare CFF or a complete OpenType font - and can
 *      FreeType read each one? (It can read all of them: that is why the
 *      outline pipeline works on any of them.)
 *   2. Will this Chromium take those bytes as a `@font-face`? An embedded font
 *      program is not a web font: Chromium puts every one through its font
 *      sanitizer, and a producer's subset is missing things a sanitizer wants.
 *
 * The tool also writes the two tables a bare TrueType subset is missing (`cmap`
 * and `post`) and shows that *then* it loads - which is what "reuse the program"
 * would take, per container. Nothing here is used by the viewer: the point is
 * to record what the shortcut would cost before anyone builds it.
 *
 *   node tests/font-programs.mjs [pdf ...] [--pages N] [--no-browser]
 *
 * With no argument the whole corpus runs, downloaded first if the cache is
 * cold. `--no-browser` stops after the survey, which needs no Chromium.
 */

import fs from 'node:fs';
import * as mupdf from 'mupdf';

import { PAPERS, paperFor, pdfName } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';
import { launch } from './browser/cdp.mjs';
import { buildFontFromOutlines } from '../src/core/font/build.ts';
import { encodeWoff } from '../src/core/font/woff.ts';

const args = process.argv.slice(2);
const pagesArg = args.indexOf('--pages');
const MAX_PAGES = pagesArg >= 0 ? Number(args[pagesArg + 1]) : 8;
const withBrowser = !args.includes('--no-browser');
const files = args.filter((a) => !a.startsWith('-') && (pagesArg < 0 || args.indexOf(a) !== pagesArg + 1));

/* ------------------------------------------------------------------ */
/* the survey                                                          */

/** Which container the bytes are in, by their own magic number. */
function classify(b) {
  if (!b || b.length < 4) return 'empty';
  if (b[0] === 0x80 && b[1] === 0x01) return 'PFB (Type 1)';
  if (b[0] === 0x25 && b[1] === 0x21) return 'PFA (Type 1)';
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'TrueType';
  if (b[0] === 0x4f && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x4f) return 'OpenType/CFF';
  if (b[0] === 0x74 && b[1] === 0x74 && b[2] === 0x63 && b[3] === 0x66) return 'collection (TTC)';
  if (b[0] === 0x01 && b[1] === 0x00 && b[2] === 0x04) return 'bare CFF';
  return `unknown (${[...b.slice(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join(' ')})`;
}

/** Every embedded font program on a page, as {name, key, bytes}. */
function programsOnPage(page) {
  const out = [];
  const fonts = page.getObject().getInheritable('Resources')?.get('Font');
  if (!fonts || fonts.isNull()) return out;
  fonts.forEach((font) => {
    const subtype = String(font.get('Subtype') ?? '');
    const descriptors = [];
    if (subtype.includes('Type0') || subtype.includes('CIDFont')) {
      const descendants = font.get('DescendantFonts');
      for (let i = 0; i < descendants.length; i++) descriptors.push(descendants.get(i).get('FontDescriptor'));
    } else {
      descriptors.push(font.get('FontDescriptor'));
    }
    for (const fd of descriptors) {
      if (fd.isNull()) continue;
      const name = String(fd.get('FontName') ?? '').replace(/^\//, '');
      for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
        const ref = fd.get(key);
        if (ref.isNull()) continue;
        const buf = ref.readStream();
        let bytes;
        try {
          bytes = new Uint8Array(buf.asUint8Array());
        } finally {
          buf.destroy();
        }
        out.push({ name, key, bytes });
      }
    }
  });
  return out;
}

/** What the corpus holds, one row per (container, where it came from). */
async function survey(documents) {
  const rows = new Map();
  const samples = new Map();
  let loaded = 0;
  let unreadable = 0;
  const seen = new Set();

  for (const { name, file } of documents) {
    const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf');
    const pages = Math.min(doc.countPages(), MAX_PAGES);
    for (let i = 0; i < pages; i++) {
      const page = doc.loadPage(i);
      for (const program of programsOnPage(page)) {
        const id = `${program.name}|${program.key}|${program.bytes.length}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const container = classify(program.bytes);
        const row = rows.get(`${container} ${program.key}`) ?? { count: 0, bytes: 0, docs: new Set() };
        row.count++;
        row.bytes += program.bytes.length;
        row.docs.add(name);
        rows.set(`${container} ${program.key}`, row);
        if (!samples.has(container)) samples.set(container, { ...program, container });
        try {
          const font = new mupdf.Font(program.name, program.bytes, 0);
          try {
            font.advanceGlyph(1);
          } finally {
            font.destroy();
          }
          loaded++;
        } catch {
          unreadable++;
        }
      }
      page.destroy();
    }
    doc.destroy();
  }
  return { rows, samples, loaded, unreadable };
}

/* ------------------------------------------------------------------ */
/* repairing a TrueType subset far enough to be a web font             */

/**
 * A format 4 `cmap` with one segment per code point, plus the `post` table the
 * sanitizer insists on. Written here because the answer to "could the PDF's own
 * program be served" is only interesting if it is put to the browser.
 */
function sfntTables(ttf) {
  const view = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const numTables = view.getUint16(4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(...ttf.subarray(p, p + 4));
    const offset = view.getUint32(p + 8);
    const length = view.getUint32(p + 12);
    tables.push({ tag, data: ttf.subarray(offset, offset + length) });
  }
  return { flavor: view.getUint32(0), tables };
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum = (sum + (((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0;
  }
  return sum >>> 0;
}

function buildSfnt(flavor, tables) {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const n = sorted.length;
  const headSize = 12 + n * 16;
  let total = headSize;
  for (const t of sorted) total += (t.data.length + 3) & ~3;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const pow = 2 ** Math.floor(Math.log2(n));
  view.setUint32(0, flavor);
  view.setUint16(4, n);
  view.setUint16(6, pow * 16);
  view.setUint16(8, Math.floor(Math.log2(n)));
  view.setUint16(10, n * 16 - pow * 16);

  let offset = headSize;
  for (let i = 0; i < n; i++) {
    const t = sorted[i];
    const p = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[p + c] = t.tag.charCodeAt(c);
    const forSum = t.tag === 'head' ? t.data.slice() : t.data;
    if (t.tag === 'head') new DataView(forSum.buffer, forSum.byteOffset).setUint32(8, 0);
    view.setUint32(p + 4, checksum(forSum));
    view.setUint32(p + 8, offset);
    view.setUint32(p + 12, t.data.length);
    out.set(t.data, offset);
    offset += (t.data.length + 3) & ~3;
  }
  const head = sorted.findIndex((t) => t.tag === 'head');
  if (head >= 0) {
    const at = view.getUint32(12 + head * 16 + 8) + 8;
    view.setUint32(at, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}

/** The `cmap`/`post` a subset TrueType program is missing to be a web font. */
function repairTruetype(ttf, pairs = [[0x41, 1], [0x42, 2], [0x43, 3], [0x44, 4], [0x20, 5]]) {
  const { flavor, tables } = sfntTables(ttf);
  const have = new Set(tables.map((t) => t.tag));

  if (!have.has('cmap')) {
    const segs = [...pairs].sort((a, b) => a[0] - b[0]);
    const segCount = segs.length + 1;
    const length = 16 + segCount * 8;
    const sub = new Uint8Array(length);
    const v = new DataView(sub.buffer);
    v.setUint16(0, 4);
    v.setUint16(2, length);
    v.setUint16(6, segCount * 2);
    const pow = 2 ** Math.floor(Math.log2(segCount));
    v.setUint16(8, pow * 2);
    v.setUint16(10, Math.floor(Math.log2(segCount)));
    v.setUint16(12, segCount * 2 - pow * 2);
    const endAt = 14;
    const startAt = endAt + segCount * 2 + 2;
    const deltaAt = startAt + segCount * 2;
    const rangeAt = deltaAt + segCount * 2;
    for (let i = 0; i < segCount; i++) {
      const [code, gid] = i < segs.length ? segs[i] : [0xffff, 0];
      v.setUint16(endAt + i * 2, code);
      v.setUint16(startAt + i * 2, code);
      const delta = i < segs.length ? (gid - code) & 0xffff : 1;
      v.setInt16(deltaAt + i * 2, delta > 0x7fff ? delta - 0x10000 : delta);
      v.setUint16(rangeAt + i * 2, 0);
    }
    const cmap = new Uint8Array(12 + length);
    const cv = new DataView(cmap.buffer);
    cv.setUint16(2, 1);
    cv.setUint16(4, 3);
    cv.setUint16(6, 1);
    cv.setUint32(8, 12);
    cmap.set(sub, 12);
    tables.push({ tag: 'cmap', data: cmap });
  }
  if (!have.has('post')) {
    const post = new Uint8Array(32);
    new DataView(post.buffer).setUint32(0, 0x00030000);
    tables.push({ tag: 'post', data: post });
  }
  return buildSfnt(flavor, tables);
}

/* ------------------------------------------------------------------ */
/* what the browser does with each                                     */

async function acceptance(cases) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const expression = `(async () => {
      const cases = ${JSON.stringify(cases)};
      const out = [];
      for (const c of cases) {
        const face = new FontFace('probe-' + out.length, "url(" + c.url + ") format('" + c.format + "')");
        try {
          await Promise.race([face.load(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 8000))]);
          out.push({ name: c.name, verdict: 'accepted' });
        } catch (err) {
          out.push({ name: c.name, verdict: 'refused', why: err.message || String(err) });
        }
      }
      return out;
    })()`;
    return await page.evaluate(expression);
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */

const documents = files.length
  ? files.map((f) => ({ name: f.split('/').pop(), file: f }))
  : [...(await ensurePapers(PAPERS.map((p) => p.url)))]
      .filter(([, file]) => typeof file === 'string')
      .map(([url, file]) => ({ name: paperFor(url)?.label ?? pdfName(url), file }));

if (!documents.length) {
  console.error('no document could be read, so nothing was measured');
  process.exit(1);
}

const { rows, samples, loaded, unreadable } = await survey(documents);

console.log(`\nembedded font programs, first ${MAX_PAGES} pages of each document\n`);
for (const [key, row] of [...rows].sort((a, b) => b[1].count - a[1].count)) {
  console.log(
    `  ${String(row.count).padStart(4)}  ${(row.bytes / 1024).toFixed(0).padStart(6)} KiB  ${key.padEnd(28)} [${row.docs.size} documents]`,
  );
}
console.log(`  FreeType read ${loaded} of them, and could not read ${unreadable}`);
console.log(
  '\nA PDF may embed: a Type 1 program (no web font container has ever held one),\n' +
    'a bare CFF table (a browser needs an sfnt around it), a TrueType subset (often\n' +
    'with no cmap at all), or a complete OpenType font. Only the last is a web font\n' +
    'already.',
);

if (!withBrowser) process.exit(0);

const built = buildFontFromOutlines(
  [{ gid: 1, d: 'M0 0C0 .5523 .4477 1 1 1L1 0Z', codes: [0x41], advanceEm: 1 }],
  { familyName: 'font-programs-probe' },
);
const woff = await encodeWoff(new Uint8Array(built.data));

const dataUrl = (bytes, mime) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const cases = [];
for (const [container, sample] of samples) {
  const mime = container.startsWith('TrueType') ? 'font/ttf' : container.includes('OpenType') ? 'font/otf' : 'font/type1';
  const format = container.startsWith('TrueType') ? 'truetype' : container.includes('OpenType') ? 'opentype' : 'truetype';
  cases.push({ name: `${container} as it is (${sample.key})`, url: dataUrl(sample.bytes, mime), format });
  if (container.startsWith('TrueType')) {
    cases.push({ name: 'TrueType with cmap + post written in', url: dataUrl(repairTruetype(sample.bytes), 'font/ttf'), format: 'truetype' });
  }
}
cases.push({ name: 'this project, CFF sfnt', url: dataUrl(new Uint8Array(built.data), 'font/otf'), format: 'opentype' });
cases.push({ name: 'this project, WOFF', url: dataUrl(woff.data, 'font/woff'), format: 'woff' });

console.log('\nwhat this Chromium does with each, as a @font-face\n');
for (const result of await acceptance(cases)) {
  const why = result.verdict === 'refused' ? ` (${result.why})` : '';
  console.log(`  ${result.verdict.toUpperCase().padEnd(8)} ${result.name}${why}`);
}
