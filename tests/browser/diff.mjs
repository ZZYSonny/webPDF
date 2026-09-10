/**
 * Visual difference map between MuPDF's outline render and webpdf's text
 * render. Overlapping ink shows as yellow, outline-only ink as red, text-only
 * ink as green - so any systematic offset or missing glyph is obvious.
 *
 *   node tests/browser/diff.mjs <pdf> <page>
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PdfEngine } from '../../src/core/engine.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

const engine = new PdfEngine();
await engine.open(fs.readFileSync(process.argv[2]));
const page = Number(process.argv[3] ?? 0);

const a = await engine.renderPage(page, { textMode: 'paths', responsive: false, idPrefix: 'a-' });
const b = await engine.renderPage(page, { textMode: 'auto', responsive: false, embedFonts: true, idPrefix: 'b-' });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>diff</title>
<style>body{margin:0;background:#111;color:#eee;font:12px system-ui}canvas{display:block;background:#000}
#wrap{display:flex;gap:10px;padding:10px}pre{padding:0 10px;font:12px monospace}</style></head>
<body><div id="wrap"></div><pre id="out">…</pre>
<script id="A" type="text/plain">${a.svg.replace(/<\/script>/gi, '<\\/script>')}</script>
<script id="B" type="text/plain">${b.svg.replace(/<\/script>/gi, '<\\/script>')}</script>
<script>
const SCALE = 1.5;
const W = ${Math.round(a.width)}, H = ${Math.round(a.height)};
async function raster(markup) {
  const url = URL.createObjectURL(new Blob([markup], {type:'image/svg+xml;charset=utf-8'}));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = Math.round(W*SCALE); c.height = Math.round(H*SCALE);
    const ctx = c.getContext('2d', {willReadFrequently:true});
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
    ctx.drawImage(img,0,0,c.width,c.height);
    return ctx.getImageData(0,0,c.width,c.height);
  } finally { URL.revokeObjectURL(url); }
}
(async () => {
  const [A,B] = await Promise.all([raster(document.getElementById('A').textContent), raster(document.getElementById('B').textContent)]);
  const c = document.createElement('canvas'); c.width=A.width; c.height=A.height;
  const ctx = c.getContext('2d');
  const outImg = ctx.createImageData(A.width, A.height);
  let aOnly=0,bOnly=0,both=0;
  for (let i=0;i<A.data.length;i+=4) {
    const av = 255 - Math.min(255, Math.round((A.data[i]+A.data[i+1]+A.data[i+2])/3));
    const bv = 255 - Math.min(255, Math.round((B.data[i]+B.data[i+1]+B.data[i+2])/3));
    const ai = av>40, bi = bv>40;
    if (ai) aOnly++; if (bi) bOnly++; if (ai&&bi) both++;
    outImg.data[i]   = ai ? 255 : 0;
    outImg.data[i+1] = bi ? 255 : 0;
    outImg.data[i+2] = 0;
    outImg.data[i+3] = 255;
  }
  ctx.putImageData(outImg, 0, 0);
  document.getElementById('wrap').appendChild(c);
  const inter = both / Math.max(1, Math.max(aOnly,bOnly));
  document.getElementById('out').textContent =
    'outline ink px=' + aOnly + '\\ntext ink px=' + bOnly + '\\noverlap px=' + both +
    '\\nIoU-ish=' + inter.toFixed(5) + '\\nscale=' + SCALE;
})();
</script></body></html>`;

const file = path.join(outDir, 'diff.html');
fs.writeFileSync(file, html);

const png = path.join(outDir, `diff-page-${page}.png`);
execFileSync(
  process.env.CHROMIUM || '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${path.join(here, '..', '..', '.scratch', 'chrome-profile')}`,
    '--no-first-run',
    '--hide-scrollbars',
    '--virtual-time-budget=20000',
    `--window-size=${Math.round(a.width * 1.5) + 40},${Math.round(a.height * 1.5) + 120}`,
    `--screenshot=${png}`,
    `file://${file}`,
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
console.log(png);
engine.close();
