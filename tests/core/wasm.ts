/**
 * The wasm bridge, driven directly from Node.
 *
 *   node tests/core/wasm.ts [pdf] [page]
 *
 * Loads the Emscripten module `npm run build:wasm` produces and calls its exports
 * the way `demo/core/bridge.ts` does, so a broken export, a mis-framed answer or
 * a changed argument list is found here - in a second, with no browser - rather
 * than in the middle of a suite. What it does not check is how any of it *looks*:
 * that is the browser suites' business.
 *
 * The corpus paper it defaults to is fetched by `npm run pdfs`; any PDF can be
 * passed instead.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const ENGINE = path.join(root, 'demo', 'engine', 'webpdf-core.js');
const WASM = path.join(root, 'demo', 'engine', 'webpdf-core.wasm');

if (!existsSync(WASM)) {
  console.error(`FAIL: ${path.relative(root, WASM)} is not built — run \`npm run build:wasm\` first`);
  process.exit(1);
}

const pdf = process.argv[2] ?? path.join(root, '.scratch', 'pdfs', '1706.03762v7.pdf');
const page = Number(process.argv[3] ?? 0);

/**
 * The module's surface, spelled the way this file calls it.
 *
 * Only the exports used here are named, and every one of them answers with a
 * frame pointer rather than a value: the bridge reads the frame back with
 * `frame()` below, which is exactly what mis-framing would break.
 */
interface CoreModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  lengthBytesUTF8(text: string): number;
  stringToUTF8(text: string, ptr: number, size: number): void;
  _wpdf_out_ptr(): number;
  _wpdf_open(ptr: number, len: number): number;
  _wpdf_plan(id: number, max: number): number;
  _wpdf_stylesheet(id: number): number;
  _wpdf_fonts(id: number): number;
  _wpdf_measure_crop(id: number, page: number, ptr: number, len: number): number;
  _wpdf_crop_check(ptr: number, len: number): number;
  _wpdf_render(
    id: number,
    page: number,
    prefix: number,
    prefixLen: number,
    className: number,
    classLen: number,
    flags: number,
    bionicDim: number,
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number,
  ): number;
  _wpdf_links(id: number, page: number): number;
  _wpdf_save(id: number): number;
  _wpdf_close(id: number): number;
}

/** What `frame()` hands back: the parsed header, and the bytes after it. */
interface Frame {
  header: any;
  payload: Uint8Array;
}

const { default: createModule } = await import(new URL(`file://${ENGINE}`).href);

let m!: CoreModule;
try {
  m = await createModule({
    // Emscripten names the wasm after the *binary* it linked (`engine`), and the
    // build renames it; this is where it actually is. The path is absolute
    // because Node resolves a relative one against the working directory rather
    // than against the glue, which is not where the file lives.
    locateFile: (name: string) => (name.endsWith('.wasm') ? WASM : path.join(path.dirname(ENGINE), name)),
  });
} catch (error) {
  // The glue's stack trace prints its own minified source, so only the message.
  const failure = error as Error;
  console.error(`${failure.name}: ${failure.message}`);
  console.error((failure.stack ?? '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}

/**
 * Put a string in wasm memory; the caller frees it.
 *
 * `len` is the length the bridge expects - the bytes without the terminator, as
 * `bridge.ts` passes it. Handing over the NUL as part of a string is not an error
 * the core can catch: it is a valid UTF-8 byte, and it ends up inside whatever
 * the string was for.
 */
function put(text: string): { ptr: number; size: number } {
  const size = m.lengthBytesUTF8(text) + 1;
  const ptr = m._malloc(size);
  m.stringToUTF8(text, ptr, size);
  return { ptr, size: size - 1 };
}

/** Read the frame a call returned: [u32 header length][header][payload]. */
function frame(len: number, what: string): Frame {
  const out = m._wpdf_out_ptr();
  const headerLen = new DataView(m.HEAPU8.buffer, out, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(m.HEAPU8.subarray(out + 4, out + 4 + headerLen)));
  const payload = m.HEAPU8.slice(out + 4 + headerLen, out + len);
  if (header.error) throw new Error(`${what}: ${header.error}`);
  return { header, payload };
}

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const bytes = new Uint8Array(await readFile(pdf));
const { ptr, size } = put('application/pdf');
m.HEAPU8.set(bytes, ptr);
const opened = frame(m._wpdf_open(ptr, bytes.length), 'open');
m._free(ptr);
const info = opened.header.info;
check('a document opens, and says what it is', info.pageCount > 0, `${info.pageCount} pages, "${info.producer}"`);
check('and it has page boxes and labels for every page', info.pages.length === info.pageCount && info.labels.length === info.pageCount);
check('and its outline', Array.isArray(info.outline), `${info.outline.length} top-level node(s)`);

const id = opened.header.id;

let slices = 0;
let planned: any;
for (;;) {
  const { header } = frame(m._wpdf_plan(id, 8), 'plan');
  slices++;
  planned = header;
  if (header.done) break;
  if (slices > 1000) throw new Error('the plan never finished');
}
check('the font plan walks the document, a slice at a time', planned.walked === planned.total, `${slices} slices, ${planned.walked}/${planned.total} pages`);

const css = new TextDecoder().decode(frame(m._wpdf_stylesheet(id), 'stylesheet').payload);
const faces = (css.match(/@font-face/g) ?? []).length;
check('and produces one @font-face per font', faces > 0, `${Math.round(css.length / 1024)} kB, ${faces} faces`);

// The stylesheet names each face by URI and the bytes come over on their own, so
// a font crosses this boundary as bytes rather than as base64 inside a rule.
const served = frame(m._wpdf_fonts(id), 'fonts');
const fontList = served.header.faces as {
  family: string;
  uri: string;
  format: string;
  mime: string;
  bytes: number;
  offset: number;
  glyphs: number;
}[];
check(
  'and names every face by a URI instead of carrying it',
  !css.includes('base64') &&
    fontList.length === faces &&
    fontList.every((f) => css.includes(`url("${f.uri}")`)),
  `${fontList.length} faces, ${Math.round(served.payload.length / 1024)} kB of bytes`,
);
check(
  'with the bytes to serve at those URIs',
  served.payload.length === fontList.reduce((n, f) => n + f.bytes, 0) &&
    fontList.every(
      (f) =>
        f.bytes > 0 &&
        f.offset >= 0 &&
        /^wpdf-[a-z0-9]+\.(woff|otf)$/.test(f.uri) &&
        f.uri.startsWith(`${f.family}.`) &&
        f.mime.startsWith('font/') &&
        f.glyphs > 0,
    ),
  JSON.stringify(fontList.slice(0, 2)),
);

// The rules are the host's, and the core is handed the expressions themselves:
// a newline joins them, because any other separator can be part of an
// expression. "arXiv:" at the start and a run that is nothing but digits.
const good = put('^arXiv:\n^\\s*[0-9]+\\s*$');
const crop = frame(m._wpdf_measure_crop(id, page, good.ptr, good.size), 'crop');
m._free(good.ptr);
check('a crop box is measured without rendering the page', crop.header.crop === null || crop.header.crop.width > 0, JSON.stringify(crop.header.crop));

const bad = put('^(');
const refused = frame(m._wpdf_crop_check(bad.ptr, bad.size), 'crop_check').header;
m._free(bad.ptr);
check('and a pattern that is not one is refused with a reason', refused.ok === false && String(refused.reason).length > 0, JSON.stringify(refused));

const fine = put('^arXiv:');
const accepted = frame(m._wpdf_crop_check(fine.ptr, fine.size), 'crop_check').header;
m._free(fine.ptr);
check('while a pattern that is one is accepted', accepted.ok === true && accepted.reason === '', JSON.stringify(accepted));

const prefix = put(`p${page}-`);
const className = put('wpdf-page-svg');
const flags = 1 | 2 | 4 | 8; // responsive, embed fonts, bionic, links
const rendered = frame(
  m._wpdf_render(id, page, prefix.ptr, prefix.size, className.ptr, className.size, flags, -1, 0, 0, 0, 0),
  'render',
);
m._free(prefix.ptr);
m._free(className.ptr);
const svg = new TextDecoder().decode(rendered.payload);
check('a page renders to an SVG with real text in it', svg.includes('<text') && svg.includes('@font-face'), `${Math.round(svg.length / 1024)} kB`);
// The other half of the contract: a page that has to stand alone - a saved SVG,
// or one drawn before the plan is ready - carries its own faces, because there
// is no host to serve the URIs the document's stylesheet names.
check('and a standalone page carries its faces inline', svg.includes('base64,'));
check('with every glyph accounted for', rendered.header.stats.asText + rendered.header.stats.asOutlines === rendered.header.stats.glyphs, JSON.stringify(rendered.header.stats));
check('and the class the page’s own stylesheet needs', svg.includes('class="wpdf-page-svg"'));
check('and its size, so a host can lay the page out', rendered.header.width > 0 && rendered.header.height > 0, `${rendered.header.width}x${rendered.header.height}`);

const links = frame(m._wpdf_links(id, page), 'links').header.links;
check('link annotations come back as rectangles and targets', Array.isArray(links), `${links.length} on this page`);

const saved = frame(m._wpdf_save(id), 'save');
check('and the document is written out again', new TextDecoder().decode(saved.payload.slice(0, 5)) === '%PDF-', `${Math.round(saved.payload.length / 1024)} kB`);

// Closing is a call that takes the document out of the module's table, so what
// proves it happened is that the document is no longer there: every call about it
// is now an error rather than a page.
frame(m._wpdf_close(id), 'close');
let gone = false;
try {
  frame(m._wpdf_render(id, page, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0), 'render after close');
} catch {
  gone = true;
}
check('the document closes, and is gone afterwards', gone);

console.log(failures ? '\nWASM CHECK FAILED' : '\nWASM CHECK PASSED');
process.exit(failures ? 1 : 0);
