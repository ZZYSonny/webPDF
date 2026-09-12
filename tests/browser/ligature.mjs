/**
 * A ligature is drawn by its letters.
 *
 * The text says `fi` - which is what a reader copies, searches for and selects -
 * and the browser is expected to draw the one glyph the typesetter drew for it.
 * That is a promise made by the `liga` rule the font is built with
 * (`src/core/font/build.ts`), and it is a promise no whole-page comparison of
 * text and pixels can keep an eye on: the unligated `f` and `i` cover almost
 * every pixel of the ligature, so the fidelity check passes either way
 * (measured on ResNet page 2: 100.000% coverage and an ink ratio of 1.0075 with
 * the rule removed, against 1.0071 with it).
 *
 * So this asks the question the small way: take a ligature the document really
 * draws, and render it twice with its own face - once as its letters, once as
 * the one character the glyph is reachable by. If the shaper joins the letters
 * the two rasters are the same pixels; if it does not, they are an `f` and an
 * `i` beside each other and nothing like it.
 *
 *   node tests/browser/ligature.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mupdf from 'mupdf';

import { FontRegistry } from '../../src/core/font/registry.ts';
import { DocumentFontPlan } from '../../src/core/font/plan.ts';
import { scanGlyphOutlines, scanGlyphPlacements } from '../../src/core/svg/glyphs.ts';
import { glyphLetters } from '../../src/core/svg/ligatures.ts';
import { PAPERS } from '../../demo/papers.mjs';
import { ensurePapers } from '../pdf-cache.mjs';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = await ensurePapers(PAPERS.map((p) => p.url));
let failed = false;

function pageSvg(page) {
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'svg', { text: 'path' });
  try {
    const device = writer.beginPage(page.getBounds());
    page.run(device, mupdf.Matrix.identity);
    device.close();
    writer.endPage();
    writer.close();
    return buffer.asString();
  } finally {
    writer.destroy();
    buffer.destroy();
  }
}

function readChars(page) {
  const chars = [];
  let line = 0;
  const stext = page.toStructuredText('');
  try {
    stext.walk({
      beginLine() {
        line++;
      },
      onChar: (c, origin) => chars.push({ text: c, x: origin[0], y: origin[1], line }),
    });
  } finally {
    stext.destroy();
  }
  return chars;
}

/** A ligature a document really draws, in a face the plan built for it. */
async function findLigature(paper) {
  const file = files.get(paper.url);
  if (typeof file !== 'string') return null;
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  try {
    const registry = new FontRegistry({ disableCompression: true });
    const plan = new DocumentFontPlan();
    await plan.start(doc, registry);
    for (let index = 0; index < Math.min(doc.countPages(), 8); index++) {
      const page = doc.loadPage(index);
      try {
        const svg = pageSvg(page);
        const outlines = scanGlyphOutlines(svg);
        const placements = scanGlyphPlacements(svg);
        const letters = glyphLetters(readChars(page), placements);
        const planned = await plan.planPage(outlines, placements, { letters });
        if (!planned) continue;
        for (const p of placements) {
          const font = planned.fonts.get(p.fontId);
          if (!font) continue;
          const text = font.letters.get(p.gid);
          const code = font.codes.get(p.gid);
          if (text === undefined || code === undefined || [...text].length < 2) continue;
          return {
            letters: text,
            code,
            family: font.family,
            css: font.asset.css,
            where: `${paper.label} page ${index + 1}, gid ${p.gid}`,
          };
        }
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
  return null;
}

const found = [];
for (const paper of PAPERS) {
  const ligature = await findLigature(paper);
  if (ligature) found.push(ligature);
}

if (found.length === 0) {
  console.log('no document with a ligature could be read - nothing to check');
  process.exit(0);
}

/**
 * One `<text>` of one SVG, with the face inside it.
 *
 * The face has to be in the SVG and not on the page: the raster is taken by
 * loading the markup as an *image*, which is a document of its own and knows
 * nothing about the stylesheet that embeds it. That is also how the engine
 * exports a standalone page (`inlineFontCss`).
 */
const oneText = (css, family, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">` +
  `<style type="text/css"><![CDATA[\n${css}\n]]></style>` +
  `<text x="20" y="600" font-family="${family}" font-size="400" text-rendering="geometricPrecision" ` +
  `fill="#000" xml:space="preserve">${body}</text></svg>`;

/** The run of letters, written as one `<text>` with one position. */
const lettersSvg = (l, family, css) => oneText(css, family, l.letters);

/** The same glyph, reached by the one character it is named with. */
const glyphSvg = (l, family, css) => oneText(css, family, String.fromCodePoint(l.code));

const jobs = found.map((l, i) => ({
  ...l,
  family: `${l.family}-${i}`,
  css: l.css.replace(`font-family:'${l.family}'`, `font-family:'${l.family}-${i}'`),
}));

const html = `<!doctype html>
<meta charset="utf-8">
<title>ligature</title>
<body>
<pre id="report">running</pre>
${jobs
  .map(
    (j, i) =>
      `<script id="a${i}" type="text/plain">${scriptSafe(lettersSvg(j, j.family, j.css))}</script>\n` +
      `<script id="b${i}" type="text/plain">${scriptSafe(glyphSvg(j, j.family, j.css))}</script>`,
  )
  .join('\n')}
<script>
const JOBS = ${JSON.stringify(jobs.map((j) => ({ where: j.where, letters: j.letters })))};

async function raster(markup) {
  const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('SVG failed to load as an image'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 1600;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function mask(data) {
  const m = new Uint8Array(data.length / 4);
  let n = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const dark = data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200;
    m[j] = dark ? 1 : 0;
    if (dark) n++;
  }
  return { m, n };
}

(async () => {
  const out = [];
  try {
    for (let i = 0; i < JOBS.length; i++) {
      const [A, B] = await Promise.all([
        raster(document.getElementById('a' + i).textContent),
        raster(document.getElementById('b' + i).textContent),
      ]);
      const a = mask(A);
      const b = mask(B);
      let differ = 0;
      for (let j = 0; j < a.m.length; j++) if (a.m[j] !== b.m[j]) differ++;
      const identical = differ === 0 && a.n === b.n && a.n > 0;
      out.push(
        (identical ? 'PASS ' : 'FAIL ') + JOBS[i].where + ' "' + JOBS[i].letters + '": ' +
          'ink(letters)=' + a.n + ' ink(glyph)=' + b.n + ' pixelsDiffering=' + differ,
      );
      if (!identical) out.push('       the letters are not being drawn as the ligature');
    }
  } catch (e) {
    out.push('ERROR ' + (e && e.stack || e));
  }
  document.getElementById('report').textContent = out.join('\\n');
  document.title = out.some((l) => !l.startsWith('PASS')) ? 'FAIL' : 'PASS';
})();
</script>
</body>`;

function scriptSafe(s) {
  return s.replace(/<\/script/gi, '<\\/script');
}

const file = path.join(here, 'out', 'ligature.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, html);

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport(1200, 1600);
  await page.goto(`file://${file}`);
  await page.waitFor(() => document.title === 'PASS' || document.title === 'FAIL', { label: 'the ligature report' });
  const report = String(await page.evaluate('document.getElementById("report").textContent'));
  console.log(report.split('\n').map((l) => '  ' + l).join('\n'));
  if (!report.split('\n').some((l) => l.startsWith('PASS'))) failed = true;
  if (report.includes('FAIL') || report.includes('ERROR')) failed = true;
  await page.screenshot(path.join(here, 'out', 'ligature.png'));
  await page.close();
} catch (err) {
  failed = true;
  console.error('  ' + String(err));
} finally {
  await browser.close();
}

console.log(failed ? '\nLIGATURE FAILED' : '\nLIGATURE PASSED');
process.exit(failed ? 1 : 0);
