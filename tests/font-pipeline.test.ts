/**
 * End-to-end check of the outline -> web font -> text upgrade pipeline.
 *
 * Runs the real MuPDF wasm build over real PDFs, without a browser.
 *
 *   node tests/font-pipeline.test.ts [pdf ...]
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mupdf from 'mupdf';
import { scanGlyphOutlines, scanGlyphPlacements } from '../src/core/svg/glyphs.ts';
import { upgradeGlyphsToText } from '../src/core/svg/text-upgrade.ts';
import { FontRegistry } from '../src/core/font/registry.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Extra corpora can be dropped in `.scratch/pdfs`; the bundled samples always run. */
const pdfDirs = [path.join(here, '..', '.scratch', 'pdfs'), path.join(here, '..', 'demo', 'public')];

function renderPathSvg(doc: mupdf.Document, pageIndex: number): string {
  const page = doc.loadPage(pageIndex);
  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, 'svg', { text: 'path' });
  const dev = writer.beginPage(page.getBounds());
  page.run(dev, mupdf.Matrix.identity);
  writer.endPage();
  writer.close();
  return buf.asString();
}

function pdfFiles(): string[] {
  const explicit = process.argv.slice(2).filter((a) => a.endsWith('.pdf'));
  if (explicit.length) return explicit;
  const found: string[] = [];
  for (const dir of pdfDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.pdf')) found.push(path.join(dir, f));
    }
  }
  return found;
}

for (const file of pdfFiles()) {
  test(`font pipeline: ${path.basename(file)}`, async () => {
    const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf');
    const registry = new FontRegistry({ disableCompression: false });
    const pages = Math.min(doc.countPages(), 5);
    let convertedTotal = 0;

    for (let i = 0; i < pages; i++) {
      const svg = renderPathSvg(doc, i);
      const outlines = scanGlyphOutlines(svg);
      const placements = scanGlyphPlacements(svg);
      assert.ok(placements.length >= 0);

      const plan = await registry.planPage(outlines, placements);
      // Regression guard: opentype.js builds `cmap` with 16-bit segment maths,
      // so any code point above the BMP silently becomes unreachable glyph 0.
      for (const [fontId, planned] of plan.fonts) {
        for (const [gid, code] of planned.codes) {
          assert.ok(code > 0 && code <= 0xffff, `font ${fontId} gid ${gid} got code U+${code.toString(16)}`);
        }
      }

      const familyOf = (fontId: number) => plan.fonts.get(fontId)?.family ?? null;
      const codeOf = (fontId: number, gid: number) => plan.fonts.get(fontId)?.codes.get(gid) ?? null;

      const result = upgradeGlyphsToText(svg, placements, { familyFor: familyOf, codeFor: codeOf });


      // The rewrite must not lose glyphs: every placement is either text or outline.
      assert.equal(result.stats.converted + result.stats.kept, placements.length, 'glyph accounting');

      // Balanced tags, no stray attribute soup.
      assert.equal(count(result.svg, '<text'), count(result.svg, '</text>'), 'balanced <text>');
      assert.equal(count(result.svg, '<tspan'), count(result.svg, '</tspan>'), 'balanced <tspan>');
      assert.ok(!/font-family="null"/.test(result.svg));

      convertedTotal += result.stats.converted;

      // Anything still referenced must still be defined.
      for (const m of result.svg.matchAll(/#font_(\d+)_(\d+)"/g)) {
        assert.ok(outlines.has(`${m[1]}:${m[2]}`), `dangling glyph reference ${m[0]}`);
      }
    }

    const assets = registry.assets();
    const bytes = assets.reduce((a, f) => a + f.bytes, 0);
    console.log(
      `  ${path.basename(file)}: pages=${pages} fonts=${assets.length} ` +
        `glyphs->text=${convertedTotal} fontBytes=${(bytes / 1024).toFixed(1)}KiB ` +
        `formats=${[...new Set(assets.map((a) => a.format))].join(',')}`,
    );
    assert.ok(assets.length >= 0);
  });
}

function count(s: string, needle: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = s.indexOf(needle, i);
    if (j < 0) return n;
    n++;
    i = j + needle.length;
  }
}
