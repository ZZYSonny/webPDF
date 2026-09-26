/** Ports corpus-bench/dev-sweep/bionic-diff/deepseek-fonts to the current bridge.
 * node tests/core/corpus.ts [--complete] [--benchmark] [pdf ...]
 * Default: first/middle/last pages; --complete: every page. Timings are reports,
 * never machine-dependent pass/fail limits. Explicit paths need no downloads.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Core, loadCore } from '../../demo/core/bridge.ts';
import { ensurePapers } from '../pdf-cache.ts';
import { checkBionic, checkFonts, checkGroups } from './checks.ts';

const args = process.argv.slice(2);
for (const arg of args) if (arg.startsWith('--') && !['--complete', '--benchmark'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
let files = args.filter((arg) => !arg.startsWith('--'));
if (!files.length) {
  const cached = await ensurePapers();
  files = [...cached.values()].map((file) => {
    if (file instanceof Error) throw file;
    return file;
  });
}
assert.ok(files.length, 'at least one PDF must be checked');
const engine = process.env.WEBPDF_TEST_ENGINE
  ? pathToFileURL(path.resolve(process.env.WEBPDF_TEST_ENGINE, 'webpdf-core.js'))
  : new URL('../../demo/engine/webpdf-core.js', import.meta.url);
const core = new Core(await loadCore(engine));
let totalPages = 0;
for (const file of files) {
  const started = performance.now();
  const { id, info } = core.open(await readFile(file));
  const count = (info as { pageCount: number }).pageCount;
  assert.ok(count > 0, `${file}: must contain pages`);
  try {
    let done = false;
    for (let i = 0; i <= count && !done; i++) done = core.plan(id, 8).done;
    assert.ok(done, `${file}: plan finishes`);
    const faces = checkFonts(core, id);
    const pages = args.includes('--complete') ? Array.from({ length: count }, (_, i) => i) : [...new Set([0, Math.floor(count / 2), count - 1])];
    for (const page of pages) {
      const plain = core.render(id, page, { embedFonts: true, links: true });
      assert.ok(plain.width > 0 && plain.height > 0);
      assert.match(plain.svg, /<svg\b/);
      checkGroups(plain.svg);
      const stats = plain.stats as { glyphs: number; asText: number; asOutlines: number; runs: number };
      // Empty outlines can be omitted; stroked text is counted separately.
      for (const value of Object.values(stats)) assert.ok(Number.isInteger(value) && value >= 0);
      assert.equal(stats.runs, (plain.svg.match(/<text[\s>]/g) ?? []).length);
      const faded = core.render(id, page, { embedFonts: true, links: true, bionic: true });
      checkBionic(plain.svg, faded.svg);
      assert.ok(Array.isArray(core.links(id, page)));
      core.measureCrop(id, page, ['^arXiv:', '^\\s*[0-9]+\\s*$']);
      if (args.includes('--benchmark')) {
        const samples: number[] = [];
        // The plain/faded renders above warm the page before timed repetitions.
        for (let run = 0; run < 5; run++) {
          const t = performance.now();
          core.render(id, page, { embedFonts: true, links: true, bionic: true });
          samples.push(performance.now() - t);
        }
        samples.sort((a, b) => a - b);
        console.log(JSON.stringify({ file: path.basename(file), page, medianMs: samples[2], maxMs: samples[4], svgBytes: Buffer.byteLength(plain.svg) }));
      }
    }
    const saved = core.open(core.save(id)).id;
    try {
      core.plan(saved, 0);
      assert.match(core.render(saved, 0, { embedFonts: true }).svg, /<svg\b/);
    } finally { core.close(saved); }
    totalPages += pages.length;
    console.log(`PASS ${path.basename(file)}: ${pages.length}/${count} pages, ${faces} fonts, ${(performance.now() - started).toFixed(0)} ms`);
  } finally { core.close(id); }
}
console.log(`CORPUS PASSED: ${files.length} documents, ${totalPages} pages`);
