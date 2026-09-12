/**
 * What planning a document's fonts costs, and what it saves, per corpus paper.
 *
 * `preplanPages` (default 64) decides how a document is planned. At or under it
 * the whole document is walked, text only, before the first page is laid out,
 * and every face it will ever need is built - so nothing registers while the
 * reader scrolls. Past it the plan keeps a window ahead of the page being
 * rendered, building each face before the page that needs it. Both are one face
 * per *font*; the per-page pipeline, which is what `preplanPages: 0` still does,
 * is one face per page's glyph set.
 *
 * The numbers below are the ones the README quotes. They are wall-clock on one
 * machine and move with it; the family counts are what the design is about.
 *
 *   node tests/font-plan-cost.mjs
 */

import fs from 'node:fs';
import * as mupdf from 'mupdf';

import { FontRegistry } from '../src/core/font/registry.ts';
import { DocumentFontPlan } from '../src/core/font/plan.ts';
import { PAPERS } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

const urls = PAPERS.map((paper) => paper.url);
const files = await ensurePapers(urls, { log: (line) => console.log('  ' + line) });

console.log('\n| document | pages | plan | open | reading | faces | bytes |');
console.log('|---|---|---|---|---|---|---|');

for (const paper of PAPERS) {
  const file = files.get(paper.url);
  if (typeof file !== 'string') continue;
  const bytes = fs.readFileSync(file);

  const probe = mupdf.Document.openDocument(bytes, 'application/pdf');
  const count = probe.countPages();
  probe.destroy();

  for (const mode of ['whole', 'window']) {
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    const registry = new FontRegistry();
    const plan = new DocumentFontPlan(
      mode === 'whole' ? { preplanPages: count } : { preplanPages: 0, ahead: 24 },
    );
    const started = Date.now();
    await plan.cover(doc, 0, registry);
    const open = Date.now() - started;
    // Then read the document the way the viewer does: one cover per page.
    const rest = Date.now();
    for (let i = 1; i < count; i++) await plan.cover(doc, i, registry);
    const reading = Date.now() - rest;
    const assets = registry.assets();
    console.log(
      `| ${paper.label} | ${count} | ${mode} | ${open} ms | ${reading} ms | ${assets.length} | ` +
        `${Math.round(assets.reduce((n, a) => n + a.bytes, 0) / 1024)} kB |`,
    );
    doc.destroy();
  }
}

console.log(
  '\nA windowed plan walks a page at a time as the reader moves, so "reading" is what the\n' +
    'plan spends alongside the render rather than at open. "whole" walks every page before\n' +
    'the first one is drawn, which is why the budget is 64 pages and not "all of them".',
);
