/**
 * A document's own font program can be drawn by MuPDF, glyph by glyph, without a
 * page - and what comes out is the outline the page's SVG carries, byte for byte.
 *
 * That is the whole basis for a document-wide font: if a glyph can be read out
 * of the program by id, one font can cover every page, and the viewer stops
 * registering a new `@font-face` for every page it shows.
 *
 * Two things are on trial, because a plan built on either being false would be
 * quietly wrong:
 *
 *   1. `glyphsFromProgram` returns the program's outline *as the page drew it*,
 *      not a second interpretation of the same font that happens to be close.
 *   2. A page's `font_N` can be identified from the outlines it drew, which is
 *      the only link that survives contact with real files: the SVG's numbering
 *      is neither resource order nor first use (a page can start at `font_4`,
 *      and one program appears under several ids when a Form XObject carries its
 *      own copy), so counting fonts cannot identify them.
 *
 * A glyph the page left as an empty definition proves nothing and is skipped,
 * and a font with no embedded program (a base-14 face FreeType substitutes) has
 * nothing to read. The test reports how many of each it skipped, and refuses to
 * pass if the corpus stopped embedding programs or every glyph came back blank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';

import { glyphsFromProgram, pageFonts, programId, programsOnPage, type FontProgram } from '../src/core/font/program.ts';
import { scanGlyphOutlines } from '../src/core/svg/glyphs.ts';
import { PAPERS, paperFor } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

/* ------------------------------------------------------------------ */

/** Render a page the way the engine does, but without the text upgrade. */
function pageSvg(page: mupdf.Page): string {
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

const documents = await (async () => {
  const urls = PAPERS.slice(0, 3).map((paper) => paper.url);
  const files = await ensurePapers(urls);
  const out: Array<{ name: string; file: string }> = [];
  for (const url of urls) {
    const file = files.get(url);
    if (typeof file === 'string') out.push({ name: paperFor(url)?.label ?? url, file });
  }
  return out;
})();

const PAGES = 3;

test('a program draws the page the outlines the page drew', () => {
  assert.ok(documents.length > 0, 'no corpus document could be read, so nothing was compared');

  let compared = 0;
  let linked = 0;
  let blank = 0;
  let unembedded = 0;
  let ambiguous = 0;

  for (const document of documents) {
    const pdf = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
    try {
      const count = Math.min(pdf.countPages(), PAGES);
      for (let index = 0; index < count; index++) {
        const page = pdf.loadPage(index);
        try {
          const programs = programsOnPage(page);
          // What each font instance on the page declares, by gid.
          const instances = pageFonts(page, programs).map((font) => ({
            name: font.name,
            id: font.program ? programId(font.program) : null,
            drawn: font.program ? glyphsFromProgram(font.program, [...font.gids]).outlines : null,
          }));

          const outlines = scanGlyphOutlines(pageSvg(page));
          const byFont = new Map<number, Map<number, string>>();
          for (const [key, outline] of outlines) {
            const [fontId, gid] = key.split(':').map(Number);
            if (!outline.d) {
              blank++;
              continue;
            }
            if (!byFont.has(fontId)) byFont.set(fontId, new Map());
            byFont.get(fontId)!.set(gid, outline.d);
          }

          for (const [fontId, paths] of byFont) {
            const first = paths.entries().next().value as [number, string];
            const hits = instances.filter((instance) => instance.drawn?.get(first[0]) === first[1]);
            if (hits.length === 0) {
              unembedded += paths.size;
              continue;
            }
            const identities = new Set(hits.map((hit) => hit.id));
            if (identities.size !== 1) {
              ambiguous++;
              continue;
            }
            for (const [gid, d] of paths) {
              assert.equal(
                hits[0].drawn?.get(gid),
                d,
                `${document.name} page ${index + 1} font_${fontId} (${hits[0].name}): gid ${gid} is not the outline the page drew`,
              );
              compared++;
            }
            linked++;
          }
        } finally {
          page.destroy();
        }
      }
    } finally {
      pdf.destroy();
    }
  }

  // The test is worthless if the corpus stopped embedding programs, or if every
  // glyph it drew came back blank.
  assert.ok(linked > 0, 'no embedded program was linked to a page font');
  assert.ok(compared > 500, `only ${compared} glyphs were compared`);
  assert.ok(blank < compared, `every glyph was blank (${blank})`);
  console.log(
    `      ${compared} glyphs matched byte for byte, ${linked} page fonts linked by their outlines` +
      ` (${blank} blank, ${unembedded} from fonts with no program, ${ambiguous} ambiguous)`,
  );
});

test('the widths come from the program, in em units', () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');

  const pdf = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
  try {
    const page = pdf.loadPage(0);
    try {
      const measured: number[] = [];
      for (const font of pageFonts(page)) {
        if (!font.program) continue;
        const { advances } = glyphsFromProgram(font.program, [...font.gids]);
        assert.ok(advances.size > 0, `${font.name}: the program declared no advance at all`);
        for (const [gid, advance] of advances) {
          // Every advance of a real face is a fraction of an em. Font units
          // (1000 or 2048 of them) or a raw numerator would not be.
          assert.ok(advance > 0.05 && advance < 3, `${font.name} gid ${gid}: advance ${advance} is not in em units`);
          measured.push(advance);
        }
      }
      assert.ok(measured.length > 20, `only ${measured.length} advances were read`);
    } finally {
      page.destroy();
    }
  } finally {
    pdf.destroy();
  }
});

test('a program is identified by its bytes, so two pages agree on one font', () => {
  const a: FontProgram = { name: 'AAAAAA+Thing', key: 'FontFile', bytes: new Uint8Array([1, 2, 3]) };
  const b: FontProgram = { name: 'BBBBBB+Thing', key: 'FontFile', bytes: new Uint8Array([1, 2, 3]) };
  const c: FontProgram = { name: 'AAAAAA+Thing', key: 'FontFile', bytes: new Uint8Array([1, 2, 4]) };
  const d: FontProgram = { name: 'AAAAAA+Thing', key: 'FontFile2', bytes: new Uint8Array([1, 2, 3]) };
  assert.equal(programId(a), programId(a));
  assert.notEqual(programId(a), programId(c), 'different bytes must not share a family');
  assert.notEqual(programId(a), programId(d), 'the container is part of what the bytes mean');
  // The subset prefix is per producer, so it is not part of the identity: two
  // differently-prefixed copies of one font are one font to a reader.
  assert.equal(programId(a), programId(b));
});
