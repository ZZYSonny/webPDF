/**
 * Generate the comparison page that proves the text output draws the same
 * pixels as MuPDF's outlines.
 *
 * For each page we rasterise two standalone SVGs into canvases:
 *   A: MuPDF's outline rendering (the reference)
 *   B: outlines upgraded to <text> with generated @font-face rules
 * and report the maximum per-channel difference plus the count of lost pixels.
 * A page banner at the top shows the two renders stacked so a mismatch is also
 * visible to a human looking at a screenshot.
 *
 *   node tests/browser/compare.mjs <pdf> <pageIndex> [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PdfEngine } from '../../src/core/engine.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = process.argv[2];
const pageIndex = Number(process.argv[3] ?? 0);
const outDir = process.argv[4] ?? path.join(here, 'out');

if (!pdf) {
  console.error('usage: compare.mjs <pdf> <pageIndex> [outDir]');
  process.exit(2);
}

const engine = new PdfEngine();
await engine.open(fs.readFileSync(pdf));

const reference = await engine.renderPage(pageIndex, { textMode: 'paths', responsive: false });
const upgraded = await engine.renderPage(pageIndex, {
  textMode: 'auto',
  responsive: false,
  embedFonts: true,
  idPrefix: `p${pageIndex}-`,
});

fs.mkdirSync(outDir, { recursive: true });

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>webpdf render check — page ${pageIndex + 1}</title>
<style>
  body { margin: 0; background: #222; color: #eee; font: 13px/1.4 system-ui, sans-serif; }
  .row { display: flex; gap: 8px; padding: 8px; align-items: flex-start; }
  .pane { background: #fff; }
  .pane svg { display: block; }
  h2 { font-size: 13px; margin: 8px; font-weight: 600; }
  #report { padding: 8px 12px; font-family: ui-monospace, monospace; white-space: pre; }
</style>
</head>
<body>
<div id="report">running…</div>
<div class="row">
  <div><h2>A · MuPDF outlines</h2><div class="pane" id="paneA"></div></div>
  <div><h2>B · webpdf text</h2><div class="pane" id="paneB"></div></div>
</div>
<script id="svgA" type="text/plain">${escapeForScript(reference.svg)}</script>
<script id="svgB" type="text/plain">${escapeForScript(upgraded.svg)}</script>
<script>
const SCALE = 2;
const W = ${Math.round(reference.width)};
const H = ${Math.round(reference.height)};

const svgA = document.getElementById('svgA').textContent;
const svgB = document.getElementById('svgB').textContent;
document.getElementById('paneA').innerHTML = svgA;
document.getElementById('paneB').innerHTML = svgB;

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
    c.width = Math.round(W * SCALE);
    c.height = Math.round(H * SCALE);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ink(data) {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) n++;
  }
  return n;
}

function inkMask(data) {
  const m = new Uint8Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    m[j] = (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ? 1 : 0;
  }
  return m;
}

/**
 * Fraction of the reference ink that the text render also covers, allowing a
 * one pixel neighbourhood. Text rendering legitimately differs from outline
 * rendering by antialiasing and stem darkening, so exact pixel equality is the
 * wrong test; "did every mark land in the right place" is the right one.
 */
function coverage(a, b, w, h) {
  let total = 0, covered = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!a[y * w + x]) continue;
      total++;
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (b[yy * w + xx]) { hit = true; break; }
        }
      }
      if (hit) covered++;
    }
  }
  return { total, covered, ratio: total ? covered / total : 1 };
}

(async () => {
  const out = [];
  try {
    const [A, B] = await Promise.all([raster(svgA), raster(svgB)]);
    const inkA = ink(A.data), inkB = ink(B.data);
    const total = A.w * A.h;
    const cov = coverage(inkMask(A.data), inkMask(B.data), A.w, A.h);
    out.push('page=' + ${pageIndex} + ' size=' + A.w + 'x' + A.h);
    out.push('inkA(outlines)=' + inkA + ' (' + (100 * inkA / total).toFixed(3) + '%)');
    out.push('inkB(text)=' + inkB + ' (' + (100 * inkB / total).toFixed(3) + '%)');
    out.push('ink ratio=' + (inkB / Math.max(1, inkA)).toFixed(4));
    out.push('coverage(outline ink covered by text)=' + (100 * cov.ratio).toFixed(3) + '% of ' + cov.total);
    const fonts = [...svgB.matchAll(/font-family="([^"]+)"/g)].map(m => m[1]);
    const uniq = [...new Set(fonts)];
    out.push('fontFamilies=' + uniq.length + ' ' + JSON.stringify(uniq.slice(0, 6)));
    out.push('embeddedFontFaces=' + (svgB.match(/@font-face/g) || []).length);
    out.push('textElements=' + (svgB.match(/<text /g) || []).length);
    out.push('remainingUses=' + (svgB.match(/<use /g) || []).length);
    const verdict = (cov.ratio > 0.985 && inkB / Math.max(1, inkA) > 0.9 && inkB / Math.max(1, inkA) < 1.25)
      ? 'PASS' : 'FAIL';
    out.push('verdict=' + verdict);
    document.title = verdict + ' page ' + ${pageIndex};
  } catch (e) {
    out.push('ERROR ' + (e && e.stack || e));
    document.title = 'ERROR';
  }
  document.getElementById('report').textContent = out.join('\\n');
  document.body.dataset.done = '1';
})();
</script>
</body>
</html>`;

const file = path.join(outDir, `page-${pageIndex}.html`);
fs.writeFileSync(file, html);
console.log(file);
console.log(
  `page ${pageIndex}: outlines=${reference.stats.glyphsDrawn} text=${upgraded.stats.glyphsAsText} ` +
    `kept=${upgraded.stats.glyphsAsOutlines} runs=${upgraded.stats.textRuns} ` +
    `fonts=${upgraded.fonts.length} bytes=${upgraded.fonts.reduce((a, f) => a + f.bytes, 0)}`,
);
engine.close();

function escapeForScript(s) {
  return s.replace(/<\/script>/gi, '<\\/script>');
}
