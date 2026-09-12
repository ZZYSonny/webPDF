/**
 * One face per font, for the whole document.
 *
 * A page's font is built from the glyphs that page drew, so every page mints a
 * family of its own and registering the faces churns the document's layout. The
 * plan walks the document once - text only, drawing no page - and builds a font
 * per *program* instead, which is what lets every page share one face.
 *
 * What is on trial:
 *
 *   1. every page is covered, so a face exists before the page that needs it;
 *   2. the number of families follows the number of *fonts* and not the number
 *      of pages (the whole point, and the number the viewer's smoothness rests
 *      on);
 *   3. the text upgrade, driven by the plan, still turns the page's outlines
 *      into text - and a ligature still names the character a typesetter drew
 *      for two letters, which is the one thing a program cannot say.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';

import { FontRegistry } from '../src/core/font/registry.ts';
import { DocumentFontPlan } from '../src/core/font/plan.ts';
import { PdfEngine } from '../src/core/engine.ts';
import { scanGlyphOutlines, scanGlyphPlacements } from '../src/core/svg/glyphs.ts';
import { glyphLetters, ligatureCode } from '../src/core/svg/ligatures.ts';
import { upgradeGlyphsToText } from '../src/core/svg/text-upgrade.ts';
import { type TextChar } from '../src/core/svg/spaces.ts';
import { PAPERS, paperFor } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

/* ------------------------------------------------------------------ */

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

function readChars(page: mupdf.Page): TextChar[] {
  const chars: TextChar[] = [];
  let line = 0;
  const stext = page.toStructuredText('');
  try {
    stext.walk({
      beginLine() {
        line++;
      },
      onChar: (c: string, origin: number[]) => chars.push({ text: c, x: origin[0], y: origin[1], line }),
    });
  } finally {
    stext.destroy();
  }
  return chars;
}

const documents = await (async () => {
  const urls = PAPERS.slice(0, 2).map((paper) => paper.url);
  const files = await ensurePapers(urls);
  const out: Array<{ name: string; file: string }> = [];
  for (const url of urls) {
    const file = files.get(url);
    if (typeof file === 'string') out.push({ name: paperFor(url)?.label ?? url, file });
  }
  return out;
})();

const PAGES = 3;

test('a document is planned whole, and its faces follow its fonts, not its pages', async () => {
  assert.ok(documents.length > 0, 'no corpus document could be read');

  for (const document of documents) {
    const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
    try {
      const registry = new FontRegistry();
      const plan = new DocumentFontPlan({ preplanPages: 200 });
      await plan.cover(doc, 0, registry);
      assert.equal(plan.planned, true, `${document.name}: a document this size should be planned whole`);

      // The same pages through the old pipeline, so the number means something.
      const perPage = new FontRegistry();
      const planned = new Set<string>();
      const churned = new Set<string>();
      let covered = 0;
      let fellBack = 0;
      const count = Math.min(doc.countPages(), 8);

      for (let index = 0; index < count; index++) {
        const page = doc.loadPage(index);
        try {
          const svg = pageSvg(page);
          const outlines = scanGlyphOutlines(svg);
          const placements = scanGlyphPlacements(svg);
          const letters = glyphLetters(readChars(page), placements);

          const pagePlan = await plan.planPage(outlines, placements, { letters });
          if (!pagePlan) {
            fellBack++;
            continue;
          }
          covered++;
          for (const font of pagePlan.fonts.values()) planned.add(font.family);

          const oldPlan = await perPage.planPage(outlines, placements, { letters });
          for (const font of oldPlan.fonts.values()) churned.add(font.family);
        } finally {
          page.destroy();
        }
      }

      assert.equal(fellBack, 0, `${document.name}: ${fellBack} of ${count} pages could not be covered by the plan`);
      assert.equal(covered, count);
      // The whole claim: a face per font for the document, against a face per
      // page's glyph set - which is what churns the layout on every scroll.
      assert.ok(
        planned.size < churned.size,
        `${document.name}: the plan minted ${planned.size} families and the per-page pipeline ${churned.size}`,
      );
      assert.ok(
        planned.size <= plan.families().length,
        `${document.name}: ${planned.size} families came out of ${plan.families().length} planned faces`,
      );
      console.log(
        `      ${document.name}: ${planned.size} families planned over ${count} pages, ` +
          `against ${churned.size} built page by page (${plan.families().length} faces in the plan)`,
      );
    } finally {
      doc.destroy();
    }
  }
});

test('the plan drives the same text upgrade the per-page fonts did', async () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');

  const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
  try {
    const registry = new FontRegistry();
    const plan = new DocumentFontPlan({ preplanPages: 200 });
    await plan.cover(doc, 0, registry);

    const page = doc.loadPage(0);
    try {
      const svg = pageSvg(page);
      const outlines = scanGlyphOutlines(svg);
      const placements = scanGlyphPlacements(svg);
      const letters = glyphLetters(readChars(page), placements);
      const pagePlan = await plan.planPage(outlines, placements, { letters });
      assert.ok(pagePlan, 'the first page of a paper must be covered');

      const upgraded = upgradeGlyphsToText(
        svg,
        placements,
        {
          familyFor: (fontId) => pagePlan.fonts.get(fontId)?.family ?? null,
          codeFor: (fontId, gid) => pagePlan.fonts.get(fontId)?.codes.get(gid) ?? null,
        },
        { spaces: [] },
      );
      assert.ok(upgraded.stats.converted > 100, `only ${upgraded.stats.converted} glyphs became text`);
      assert.ok(upgraded.stats.runs > 0, 'no text run was produced');
      console.log(
        `      ${upgraded.stats.converted} glyphs became text in ${upgraded.stats.runs} runs, ${upgraded.stats.kept} stayed outlines`,
      );
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
});

test('a ligature keeps the character that stands for both letters', async () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');

  const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
  try {
    const registry = new FontRegistry();
    const plan = new DocumentFontPlan({ preplanPages: 200 });
    await plan.cover(doc, 0, registry);

    let checked = 0;
    for (let index = 0; index < Math.min(doc.countPages(), PAGES); index++) {
      const page = doc.loadPage(index);
      try {
        const svg = pageSvg(page);
        const outlines = scanGlyphOutlines(svg);
        const placements = scanGlyphPlacements(svg);
        const letters = glyphLetters(readChars(page), placements);
        const pagePlan = await plan.planPage(outlines, placements, { letters });
        assert.ok(pagePlan, `page ${index + 1} must be covered`);

        for (const [key, glyph] of letters) {
          if ([...glyph].length < 2) continue;
          const [fontId, gid] = key.split(':').map(Number);
          const codes: Map<number, number> | undefined = pagePlan.fonts.get(fontId)?.codes;
          if (!codes) continue;
          const code: number | undefined = codes.get(gid);
          if (code === undefined) continue;
          assert.equal(
            code,
            ligatureCode(glyph),
            `page ${index + 1}: ${glyph} became U+${code.toString(16)} instead of the ligature's own character`,
          );
          checked++;
        }
      } finally {
        page.destroy();
      }
    }
    assert.ok(checked > 0, 'no ligature was found to check');
  } finally {
    doc.destroy();
  }
});

/**
 * The point of the whole plan: a document whose fonts it covers registers every
 * face it will ever need *before* the first page is laid out, so nothing is
 * registered while the reader is scrolling - which is the cost the viewer's
 * per-page frames exist to hide.
 */
test('a planned engine hands every face over at the first page, and none after', async () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');

  const engine = new PdfEngine({ preplanPages: 64 });
  try {
    await engine.open(new Uint8Array(fs.readFileSync(document.file)));
    assert.ok(engine.plannedFonts().length > 0, 'the engine planned nothing');

    const first = await engine.renderPage(0);
    const upFront = engine.drainNewFonts();
    assert.ok(upFront.length > 0, 'no face was handed over for the first page');
    assert.equal(upFront.length, engine.plannedFonts().length, 'the first page should bring every planned face');

    let later = 0;
    for (let index = 1; index < 4; index++) {
      await engine.renderPage(index);
      later += engine.drainNewFonts().length;
    }
    assert.equal(later, 0, `${later} faces were still being registered after the first page`);
    assert.ok(first.stats.glyphsAsText > 100, `only ${first.stats.glyphsAsText} glyphs became text`);
    console.log(
      `      ${upFront.length} faces handed over at page 1, ${later} on pages 2-4, ` +
        `${first.stats.glyphsAsText} glyphs as text with ${first.stats.glyphsAsOutlines} left as outlines`,
    );
  } finally {
    engine.close();
  }
});

test('a document is left to its own fonts unless the plan is asked for', async () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');

  const engine = new PdfEngine();
  try {
    await engine.open(new Uint8Array(fs.readFileSync(document.file)));
    assert.equal(engine.plannedFonts().length, 0, 'nothing should be planned without `preplanPages`');
    const page = await engine.renderPage(0);
    assert.ok(page.fonts.length > 0, 'the page still needs its own fonts');
  } finally {
    engine.close();
  }
});
