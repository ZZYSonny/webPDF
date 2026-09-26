/** Port of bionic-ink: fading changes darkness, not the location of marks.
 * Uses the real core and Chromium; no screenshot baselines or external renderer.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Core, loadCore } from '../../demo/core/bridge.ts';
import { textPdf } from '../helpers/pdf.ts';
import { cachedPapers } from '../pdf-cache.ts';
import { launch } from './cdp.ts';

const core = new Core(await loadCore(new URL('../../demo/engine/webpdf-core.js', import.meta.url)));
const sources = [textPdf(1, 'Helvetica', 'Readable words and efficient reading')];
if (process.argv.includes('--complete')) {
  for (const file of cachedPapers()) sources.push(await readFile(file));
  assert.ok(sources.length > 1, 'complete ink checks require the PDF cache; run npm run pdfs');
}
const browser = await launch();
try {
  const page = await browser.newPage();
  try {
    for (const [index, bytes] of sources.entries()) {
      const id = core.open(bytes).id;
      try {
        core.plan(id, 0);
        const plain = core.render(id, 0, { embedFonts: true });
        const faded = core.render(id, 0, { embedFonts: true, bionic: true, bionicDim: 0.4 });
        const markup = [plain.svg, faded.svg, faded.svg.replace(/ fill-opacity="[^"]*"/g, '')];
        // Function serialization strips TypeScript before it reaches Chromium.
        const result = await page.evaluate(`(${compare.toString()})(${JSON.stringify(markup)}, ${plain.width}, ${plain.height})`);
        const metrics = result as { plain: number; faded: number; restored: number; uncovered: number; ink: number };
        assert.ok(metrics.plain > 0 && metrics.ink > 0, 'nonempty pixels');
        assert.ok(metrics.faded < metrics.plain && metrics.faded > 0, 'fading reaches the pixels');
        assert.ok(Math.abs(metrics.restored / metrics.plain - 1) < 0.005, 'removing fade restores darkness');
        assert.ok(metrics.uncovered / metrics.ink < 0.001, 'fading preserves marks within one pixel');
        console.log(`PASS ink document ${index}: ${JSON.stringify(metrics)}`);
      } finally { core.close(id); }
    }
  } finally { await page.close(); }
} finally { await browser.close(); }

async function compare(markup: string[], width: number, height: number) {
  const w = Math.ceil(width * 2), h = Math.ceil(height * 2);
  async function raster(svg: string) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h); ctx.drawImage(image, 0, 0, w, h);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      const ink = new Uint8Array(w * h); let darkness = 0;
      for (let i = 0; i < ink.length; i++) {
        const shade = Math.min(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
        ink[i] = shade < 245 ? 1 : 0; darkness += 255 - shade;
      }
      return { ink, darkness };
    } finally { URL.revokeObjectURL(url); }
  }
  const [a, b, c] = await Promise.all(markup.map(raster));
  let total = 0, uncovered = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!a.ink[y * w + x]) continue;
    total++; let hit = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h && b.ink[yy * w + xx]) hit = true;
    }
    if (!hit) uncovered++;
  }
  return { plain: a.darkness, faded: b.darkness, restored: c.darkness, uncovered, ink: total };
}
