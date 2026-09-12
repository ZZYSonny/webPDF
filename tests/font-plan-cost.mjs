/**
 * What planning a document's fonts costs, and what it saves, per corpus paper.
 *
 * The plan is one face per *font* for the whole document, walked and built in
 * the background: `open` returns as soon as the document is read, the pages are
 * drawn with their own faces while the plan runs, and the document becomes one
 * document when it is ready. This prints both halves of that - what opening
 * costs, and how long the plan takes to arrive behind it - and what it built.
 *
 * The per-page pipeline, which is what `planFonts: false` still does, is the
 * other column and the reason any of this exists: one family per page's glyph
 * set, every one of them registered into the document while the reader reads.
 * `tests/font-plan.test.ts` measures that over whole documents, so it is not
 * repeated here.
 *
 * The numbers below are the ones the README quotes. They are wall-clock on one
 * machine and move with it; the family counts are what the design is about.
 *
 *   node tests/font-plan-cost.mjs
 */

import fs from 'node:fs';

import { PdfEngine } from '../src/core/engine.ts';
import { PAPERS } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

const urls = PAPERS.map((paper) => paper.url);
const files = await ensurePapers(urls, { log: (line) => console.log('  ' + line) });

console.log('\n| document | pages | open | plan ready after | faces | bytes |');
console.log('|---|---|---|---|---|---|');

for (const paper of PAPERS) {
  const file = files.get(paper.url);
  if (typeof file !== 'string') continue;
  const bytes = new Uint8Array(fs.readFileSync(file));

  const engine = new PdfEngine();
  try {
    const opening = Date.now();
    await engine.open(bytes);
    const open = Date.now() - opening;
    const count = engine.documentInfo.pageCount;
    const started = Date.now();
    await engine.planDone();
    const plan = Date.now() - started;
    const assets = engine.plannedFonts();
    console.log(
      `| ${paper.label} | ${count} | ${open} ms | ${plan} ms | ${assets.length} | ` +
        `${Math.round(assets.reduce((n, asset) => n + asset.bytes, 0) / 1024)} kB |`,
    );
  } finally {
    engine.close();
  }
}

console.log(
  '\n"open" is the document read and no page drawn: the plan is walked and built\n' +
    'behind the first page, in slices, and the viewer draws a frame per page until\n' +
    'it is ready. The face count is what the plan is for - one per *font* for the\n' +
    'whole document, against one per page\'s glyph set (`planFonts: false`).',
);
