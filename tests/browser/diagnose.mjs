/**
 * In-browser diagnosis of one generated SVG: what does the DOM think the text
 * elements are, and did the generated fonts actually load?
 *
 *   node tests/browser/diagnose.mjs <pdf> <page>
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
const b = await engine.renderPage(page, { textMode: 'auto', responsive: false, idPrefix: 'b-' });

fs.writeFileSync(path.join(outDir, 'diag-ref.svg'), a.svg);
fs.writeFileSync(path.join(outDir, 'diag-text.svg'), b.svg);

const html = `<!doctype html><html><head><meta charset="utf-8"><title>diag</title></head>
<body style="margin:0;background:#fff">
<div id="host" style="width:612px">${b.svg}</div>
<pre id="out" style="font:12px monospace"></pre>
<script>
(async () => {
  const lines = [];
  const texts = [...document.querySelectorAll('#host text')];
  lines.push('text elements: ' + texts.length);
  lines.push('font faces in document.fonts: ' + document.fonts.size);
  try { await document.fonts.ready; } catch (e) { lines.push('fonts.ready error ' + e); }
  const fams = [...new Set([...document.fonts].map(f => f.family))];
  lines.push('loaded families: ' + JSON.stringify(fams));
  for (const f of document.fonts) lines.push('  face ' + f.family + ' status=' + f.status);
  if (texts.length) {
    const t = texts[0];
    const bb = t.getBBox();
    const cs = getComputedStyle(t);
    lines.push('first text bbox: ' + [bb.x, bb.y, bb.width, bb.height].map(n => n.toFixed(2)).join(','));
    lines.push('computed font-family: ' + cs.fontFamily + ' size=' + cs.fontSize + ' fill=' + cs.fill + ' visibility=' + cs.visibility + ' display=' + cs.display);
    lines.push('getBoundingClientRect: ' + JSON.stringify(t.getBoundingClientRect()));
    const r = t.getBoundingClientRect();
    lines.push('numberOfChars=' + t.getNumberOfChars() + ' computedTextLength=' + t.getComputedTextLength().toFixed(2));
  }
  // Pick a text node in the middle of the page and report its box.
  const mid = texts[Math.floor(texts.length / 2)];
  if (mid) {
    const bb = mid.getBBox();
    lines.push('mid text bbox: ' + [bb.x, bb.y, bb.width, bb.height].map(n => n.toFixed(2)).join(',') + ' chars=' + mid.textContent.slice(0,20));
  }
  document.getElementById('out').textContent = lines.join('\\n');
})();
</script></body></html>`;

const file = path.join(outDir, 'diagnose.html');
fs.writeFileSync(file, html);

const dom = execFileSync(
  process.env.CHROMIUM || '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${path.join(here, '..', '..', '.scratch', 'chrome-profile')}`,
    '--no-first-run',
    '--virtual-time-budget=15000',
    '--dump-dom',
    `file://${file}`,
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
);
const m = /<pre id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
console.log(
  (m ? m[1] : '(no output)')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"'),
);
engine.close();
