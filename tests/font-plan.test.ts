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
import * as fontkit from 'fontkit';

import { FontRegistry, type FontAsset } from '../src/core/font/registry.ts';
import { DocumentFontPlan } from '../src/core/font/plan.ts';
import { PdfEngine } from '../src/core/engine.ts';
import { isUsableCode, scanGlyphOutlines, scanGlyphPlacements } from '../src/core/svg/glyphs.ts';
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

/**
 * The face behind an asset, parsed once per family.
 *
 * Both invariants below ask the font what a character reaches, so both need the
 * bytes out of the `@font-face` rule the viewer would install.
 */
const faces = new Map<string, fontkit.Font>();
function faceFor(asset: FontAsset): fontkit.Font {
  let font = faces.get(asset.family);
  if (!font) {
    const base64 = /base64,([^)]+)\)/.exec(asset.css)?.[1];
    assert.ok(base64, `${asset.family}: the face carries no bytes`);
    font = fontkit.create(Buffer.from(base64, 'base64'));
    faces.set(asset.family, font);
  }
  return font;
}

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
      const count = doc.countPages();

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

test('every character the plan writes reaches the glyph the page drew', async () => {
  assert.ok(documents.length > 0, 'no corpus document could be read');

  // The regression this exists for: the plan keeps *every* code a glyph was
  // drawn with, so that a page asking for it by its own name still finds it, and
  // two glyphs can be drawn with the same code under two encodings. Written
  // twice into the cmap, the second claim wins and the page draws the wrong
  // letter - invisible in the text, because the character is the right one.
  for (const document of documents) {
    const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
    try {
      const registry = new FontRegistry();
      const plan = new DocumentFontPlan({ preplanPages: 200 });
      await plan.cover(doc, 0, registry);

      let checked = 0;
      let unnamed = 0;
      for (let index = 0; index < doc.countPages(); index++) {
        const page = doc.loadPage(index);
        try {
          const svg = pageSvg(page);
          const outlines = scanGlyphOutlines(svg);
          const placements = scanGlyphPlacements(svg);
          const letters = glyphLetters(readChars(page), placements);
          const pagePlan = await plan.planPage(outlines, placements, { letters });
          assert.ok(pagePlan, `${document.name}: page ${index + 1} was covered by the plan and then declined`);

          for (const p of placements) {
            // A glyph MuPDF could not name must stay an outline: writing U+FFFD
            // asks the browser for a character the page never drew.
            if (!isUsableCode(p.code)) {
              const codes: Map<number, number> | undefined = pagePlan.fonts.get(p.fontId)?.codes;
              assert.equal(codes?.get(p.gid), undefined, `${document.name}: page ${index + 1} wrote a glyph with no name as text`);
              unnamed++;
              continue;
            }
            const font = pagePlan.fonts.get(p.fontId);
            if (!font) continue;
            const code = font.codes.get(p.gid);
            if (code === undefined) continue;
            assert.ok(isUsableCode(code), `${document.name}: U+${code.toString(16)} is not a character`);
            assert.equal(
              faceFor(font.asset).glyphForCodePoint(code).name,
              `gid${p.gid}`,
              `${document.name}: page ${index + 1} asks for U+${code.toString(16)} and gets another glyph`,
            );
            checked++;
          }
        } finally {
          page.destroy();
        }
      }
      assert.ok(checked > 1000, `${document.name}: only ${checked} converted glyphs could be checked`);
      console.log(`      ${document.name}: ${checked} characters reach the glyph the page drew (${unnamed} left unnamed)`);
    } finally {
      doc.destroy();
    }
  }
});

test('every ligature the plan writes is drawn by the letters the text says', async () => {
  assert.ok(documents.length > 0, 'no corpus document could be read');

  // The other half of the cmap invariant. A glyph that stands for two letters
  // is written as those letters - which is what a reader copies and searches
  // for - and the face has to draw them as the one glyph the page drew, through
  // the `liga` rule `buildFontFromOutlines` was given. A rule that is missing
  // draws an `f` and an `i` beside each other, which is not the page, and one
  // that points at another glyph draws the wrong letter. (`ligature.mjs` holds
  // Chromium to the same promise in pixels.)
  let checked = 0;
  for (const document of documents) {
    const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
    try {
      const registry = new FontRegistry();
      const plan = new DocumentFontPlan({ preplanPages: 200 });
      await plan.cover(doc, 0, registry);

      for (let index = 0; index < Math.min(doc.countPages(), PAGES); index++) {
        const page = doc.loadPage(index);
        try {
          const svg = pageSvg(page);
          const placements = scanGlyphPlacements(svg);
          const letters = glyphLetters(readChars(page), placements);
          const pagePlan = await plan.planPage(scanGlyphOutlines(svg), placements, { letters });
          assert.ok(pagePlan, `${document.name}: page ${index + 1} was covered by the plan and then declined`);

          for (const p of placements) {
            const font = pagePlan.fonts.get(p.fontId);
            const text: string | undefined = font?.letters.get(p.gid);
            if (!font || text === undefined) continue;
            const run = faceFor(font.asset).layout(text, ['liga']);
            assert.equal(run.glyphs.length, 1, `${document.name}: page ${index + 1} "${text}" is not one glyph`);
            assert.equal(
              run.glyphs[0].name,
              `gid${p.gid}`,
              `${document.name}: page ${index + 1} "${text}" draws another glyph`,
            );
            checked++;
          }
        } finally {
          page.destroy();
        }
      }
    } finally {
      doc.destroy();
    }
  }
  assert.ok(checked > 0, 'no ligature was found to check');
  console.log(`      ${checked} ligatures draw their letters as the page's one glyph`);
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

/**
 * The plan changes which face a page is drawn with, and nothing else.
 *
 * A planned page and a page with its own fonts are the same drawing: the same
 * characters, at the same positions, under the same transform. The family name
 * is the one thing that differs, and it is not geometry. What closes the
 * argument is the test above - every character reaches the glyph the page drew -
 * so "same characters in the same places" is "same ink".
 */
test('a planned page draws what the per-page fonts drew', async () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');
  const bytes = new Uint8Array(fs.readFileSync(document.file));

  /** The glyphs a render writes as text: transform, size, and each (x, y, char). */
  const textRuns = (svg: string): string[] => {
    const runs: string[] = [];
    for (const m of svg.matchAll(/<text([^>]*)>(.*?)<\/text>/g)) {
      const transform = /transform="([^"]*)"/.exec(m[1])?.[1] ?? '';
      const size = /font-size="([^"]*)"/.exec(m[1])?.[1] ?? '';
      const chars: string[] = [];
      for (const t of m[2].matchAll(/<tspan[^>]*x="([^"]*)"[^>]*y="([^"]*)"[^>]*>(.*?)<\/tspan>/g)) {
        const xs = t[1].split(' ');
        const ys = t[2].split(' ');
        const text = [...t[3]];
        for (let i = 0; i < text.length; i++) chars.push(`${xs[i]},${ys[i]},${text[i]}`);
      }
      runs.push(`${transform}|${size}|${chars.join(' ')}`);
    }
    return runs;
  };

  const planned = new PdfEngine();
  const perPage = new PdfEngine({ preplanPages: 0 });
  try {
    await planned.open(bytes);
    await perPage.open(bytes);
    let runs = 0;
    for (let index = 0; index < Math.min(5, planned.documentInfo.pageCount); index++) {
      const a = await perPage.renderPage(index, { textMode: 'auto', responsive: false });
      const b = await planned.renderPage(index, { textMode: 'auto', responsive: false });
      const one = textRuns(a.svg);
      const two = textRuns(b.svg);
      assert.ok(one.length > 0, `page ${index + 1} produced no text`);
      assert.deepEqual(two, one, `page ${index + 1}: the planned render is not the per-page render`);
      assert.equal(
        (b.svg.match(/<use /g) ?? []).length,
        (a.svg.match(/<use /g) ?? []).length,
        `page ${index + 1}: a different number of glyphs stayed outlines`,
      );
      runs += one.length;
    }
    console.log(`      ${runs} text runs across 5 pages, character for character the same`);
  } finally {
    planned.close();
    perPage.close();
  }
});

test('a document is planned by default, and `preplanPages: 0` is how a host opts out', async () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');
  const bytes = new Uint8Array(fs.readFileSync(document.file));

  const planned = new PdfEngine();
  const plain = new PdfEngine({ preplanPages: 0 });
  try {
    await planned.open(bytes);
    await plain.open(bytes);
    assert.ok(planned.plannedFonts().length > 0, 'a document should be planned without being asked');
    assert.equal(plain.plannedFonts().length, 0, '`preplanPages: 0` should plan nothing');

    const mine = await plain.renderPage(0);
    assert.ok(mine.fonts.length > 0, 'a page rendered without the plan still needs its own fonts');
    // The plan is what the viewer's single document rests on, so the faces have
    // to be in hand before the page that needs them is.
    const first = await planned.renderPage(0);
    assert.equal(
      planned.drainNewFonts().length,
      planned.plannedFonts().length,
      'every planned face should arrive with the first page',
    );
    console.log(
      `      planned: ${planned.plannedFonts().length} faces up front, ${first.stats.glyphsAsText} glyphs as text; ` +
        `per-page: ${mine.fonts.length} faces for the page`,
    );
  } finally {
    planned.close();
    plain.close();
  }
});

/**
 * A document past the preplan budget is planned the other way: the window
 * advances with the reading, and every page it reaches is still covered. This is
 * the path a long document takes, and it used to build nothing at all - `cover`
 * only built once the document was complete, so a long document silently got no
 * planned fonts and quietly fell back to a face per page.
 */
test('a document past the budget is planned a window ahead, page by page', async () => {
  // Longer than the window itself, or the first cover would walk the whole
  // document and there would be nothing left to grow into.
  const files = await ensurePapers([PAPERS[2].url]);
  const file = files.get(PAPERS[2].url);
  assert.ok(typeof file === 'string', `${PAPERS[2].label} could not be read`);

  const engine = new PdfEngine({ preplanPages: 3 });
  try {
    await engine.open(new Uint8Array(fs.readFileSync(file)));
    assert.ok(engine.documentInfo.pageCount > 25, `${PAPERS[2].label} should be longer than the window`);
    assert.ok(engine.plannedFonts().length > 0, 'the first window should be planned at open');
    const atOpen = engine.plannedFonts().length;
    let text = 0;
    for (let index = 0; index < 20; index++) {
      const page = await engine.renderPage(index);
      text += page.stats.glyphsAsText;
    }
    assert.ok(
      engine.plannedFonts().length > atOpen,
      `a windowed plan must keep building: ${atOpen} faces at open, ${engine.plannedFonts().length} after 20 pages`,
    );
    assert.ok(text > 5000, `only ${text} glyphs became text through the window`);
    console.log(`      ${atOpen} faces at open, ${engine.plannedFonts().length} after 20 pages, ${text} glyphs as text`);
  } finally {
    engine.close();
  }
});
