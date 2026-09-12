/**
 * What a document's own font dictionaries say, and whether it is right.
 *
 * A ligature is the one thing a glyph id cannot say: the page draws one glyph
 * for `fi`, and the face has to be told to write `fi` and draw the one glyph
 * through a `liga` rule. That used to be read out of the rendered page - the
 * text device's characters laid over the glyphs - and is now read out of
 * `/Differences`, `/ToUnicode` and `/CIDToGIDMap`, which is both cheaper and a
 * statement rather than an inference.
 *
 * What is on trial:
 *
 *   1. a CMap, read the way a document writes one;
 *   2. a program's glyph names, out of a Type 1 and out of a bare CFF;
 *   3. the dictionary against the geometry pass it replaced, over the corpus:
 *      the two must never *disagree*, and the dictionary must find at least as
 *      many ligatures as the page ever showed;
 *   4. the plan, handing those letters to the face it builds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';

import { parseCMap, pageEncodings, drawLetters, type FontEncoding } from '../src/core/font/encoding.ts';
import { cffGlyphNames } from '../src/core/font/cff.ts';
import { type1Names } from '../src/core/font/type1.ts';
import { pageGlyphs, programsOnPage } from '../src/core/font/program.ts';
import { DocumentFontPlan } from '../src/core/font/plan.ts';
import { FontRegistry } from '../src/core/font/registry.ts';
import { glyphLetters, LIGATURE_LETTERS } from '../src/core/svg/ligatures.ts';
import { scanGlyphOutlines, scanGlyphPlacements } from '../src/core/svg/glyphs.ts';
import { PAPERS, paperFor } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

/* ------------------------------------------------------------------ */
/* 1. the CMap                                                         */

test('a CMap maps codes to the characters a document reads', () => {
  const cmap = `
%!PS-Adobe-3.0 Resource-CMap
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (TeX) /Ordering (ptmr8r-8r) /Supplement 0 >> def
/CMapName /TeX-ptmr8r-8r-0 def
( a literal string with <30> and > in it )
1 begincodespacerange
<00> <FF>
endcodespacerange
3 beginbfrange
<20> <22> <0020>
<61> <63> <0061>
<80> <81> [<2018> <2019>]
endbfrange
2 beginbfchar
<02> <00660069>
<03> <0066006C>
endbfchar
1 beginbfrange
<01000000> <01FFFFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;

  const map = parseCMap(cmap);
  // bfchar: a two-character destination is the two letters.
  assert.equal(map.get(0x02), 'fi');
  assert.equal(map.get(0x03), 'fl');
  // bfrange: the destination steps its last code unit.
  assert.equal(map.get(0x20), ' ');
  assert.equal(map.get(0x22), '"');
  assert.equal(map.get(0x61), 'a');
  assert.equal(map.get(0x63), 'c');
  // the array form spells each destination out
  assert.equal(map.get(0x80), '\u2018');
  assert.equal(map.get(0x81), '\u2019');
  // a codespace range is not text, and a range four bytes wide is not either
  assert.equal(map.size, 10);
  // the literal string's `<30>` is not a mapping, and neither is the `>` after it
  assert.equal(map.get(0x30), undefined);
});

test('a CMap that ends mid-token is read, not looped on', () => {
  // A stray `>` used to be stepped over by nothing at all: the tokenizer
  // pushed an empty token and never advanced, which is a hang, not a parse.
  const map = parseCMap('beginbfchar <41> <0041> endbfchar > < 00 > junk');
  assert.equal(map.get(0x41), 'A');
});

/* ------------------------------------------------------------------ */
/* 2. the programs                                                     */

/**
 * A bare CFF, small enough to write out by hand.
 *
 * Three glyphs: gid 1 is SID 109 (`fi`) and gid 2 is SID 110 (`fl`), both of
 * them among the 391 strings the CFF specification fixes, and gid 3 is a SID
 * past that table, so its name comes out of the font's own String INDEX. The
 * encoding puts gid 1 at code 65 and gid 2 at code 66, which is the half of a
 * CFF a PDF without an `/Encoding` is read through.
 */
function bareCff(): Uint8Array {
  const header = [1, 0, 4, 1];
  const nameIndex = [0, 0];
  const dictSize = 18; // charset, Encoding, CharStrings: 5-byte operands, 1-byte op
  const topAt = header.length + nameIndex.length;
  const topIndexSize = 2 + 1 + 2 + dictSize;
  const stringsAt = topAt + topIndexSize;
  const custom = 'myfi';
  const stringsIndexSize = 2 + 1 + 2 + custom.length;
  const globalAt = stringsAt + stringsIndexSize;
  const charStringsAt = globalAt + 2;
  const charStringsSize = 2 + 1 + 5; // four glyphs, all with an empty charstring
  const charsetAt = charStringsAt + charStringsSize;
  // Format 0, then a SID per glyph: `fi` and `fl` are standard strings, and the
  // third glyph's SID is past that table, so it comes from the String INDEX.
  const charset = [0, 0, 109, 0, 110, 1, 135];
  const encodingAt = charsetAt + charset.length;
  const encoding = [0, 2, 65, 66]; // format 0, two codes, gid 1 then gid 2

  const bytes = new Uint8Array(encodingAt + encoding.length);
  let at = 0;
  bytes.set(header, at);
  at += header.length;
  bytes.set(nameIndex, at);
  at += nameIndex.length;
  // Top DICT INDEX: one item, one-byte offsets, then the three operators.
  bytes.set([0, 1, 1, 1, 1 + dictSize], at);
  at += 5;
  const operand = (value: number): void => {
    bytes[at++] = 29;
    bytes[at++] = (value >>> 24) & 0xff;
    bytes[at++] = (value >>> 16) & 0xff;
    bytes[at++] = (value >>> 8) & 0xff;
    bytes[at++] = value & 0xff;
  };
  operand(charsetAt);
  bytes[at++] = 15;
  operand(encodingAt);
  bytes[at++] = 16;
  operand(charStringsAt);
  bytes[at++] = 17;
  bytes.set([0, 1, 1, 1, 1 + custom.length], at);
  at += 5;
  for (const ch of custom) bytes[at++] = ch.charCodeAt(0);
  bytes.set([0, 0], at);
  at += 2;
  // CharStrings INDEX: four items, one-byte offsets, all five of them present.
  bytes.set([0, 4, 1, 1, 1, 1, 1, 1], at);
  at += 8;
  bytes.set(charset, at);
  at += charset.length;
  bytes.set(encoding, at);
  return bytes;
}

test('a bare CFF names its glyphs, standard strings and its own', () => {
  const names = cffGlyphNames(bareCff());
  assert.ok(names, 'a bare CFF should be readable');
  assert.deepEqual(names, ['.notdef', 'fi', 'fl', 'myfi']);
});

/* ------------------------------------------------------------------ */

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

test('a Type 1 program names its glyphs in id order', () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');
  const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
  try {
    let programs = 0;
    let ligature = 0;
    const seen = new Set<string>();
    for (let index = 0; index < doc.countPages(); index++) {
      const page = doc.loadPage(index);
      try {
        for (const program of programsOnPage(page).values()) {
          if (program.key !== 'FontFile') continue;
          const names = type1Names(program.bytes);
          if (!names || names.length < 20 || seen.has(program.name)) continue;
          seen.add(program.name);
          // The dict order *is* the glyph order FreeType hands out - pdfTeX's
          // Nimbus subsets put `.notdef` last - so `.notdef` is looked for
          // rather than assumed to be first, and the names have to be unique
          // for a name to identify one glyph.
          assert.ok(names.includes('.notdef'), `${program.name}: the charstrings include .notdef`);
          assert.equal(new Set(names).size, names.length, `${program.name}: names are unique`);
          programs++;
          if (names.includes('fi') && names.includes('fl')) {
            ligature++;
            console.log(`      ${program.name}: ${names.length} glyph names, fi at ${names.indexOf('fi')}, fl at ${names.indexOf('fl')}`);
          }
        }
      } finally {
        page.destroy();
      }
    }
    assert.ok(programs > 0, 'no Type 1 program could be read');
    // The names are what `/Differences` is resolved against, so at least one
    // program in a pdfTeX paper has to carry the ligature names themselves.
    assert.ok(ligature > 0, 'no Type 1 program named a ligature');
  } finally {
    doc.destroy();
  }
});

/* ------------------------------------------------------------------ */
/* 3. the dictionary against the geometry pass                         */

/**
 * Both ways of reading a ligature, over every page of a document.
 *
 * `glyphLetters` is the pass this replaced: it lays the text device's
 * characters over the glyphs and infers which ones a glyph swallowed. The
 * dictionary is what `drawLetters` reads. They are allowed to differ in *which*
 * glyphs they name - the geometry pass is an inference and reads a `R` followed
 * by `t(` as a ligature on the specification's substituted faces - but they are
 * never allowed to disagree about a glyph they both name, and the dictionary is
 * never allowed to name fewer.
 */
function compareLetters(document: { name: string; file: string }): {
  named: number;
  geometry: number;
  disagree: number;
} {
  const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
  const cache = new Map<string, FontEncoding>();
  let named = 0;
  let geometry = 0;
  let disagree = 0;
  try {
    for (let index = 0; index < doc.countPages(); index++) {
      const page = doc.loadPage(index);
      try {
        const programs = programsOnPage(page);
        const { fonts, draws } = pageGlyphs(page, programs);
        if (!draws.length) continue;

        const chars: Array<{ text: string; x: number; y: number; line: number }> = [];
        let line = 0;
        const stext = page.toStructuredText('');
        try {
          stext.walk({
            beginLine() {
              line++;
            },
            onChar: (text: string, origin: number[]) => chars.push({ text, x: origin[0], y: origin[1], line }),
          });
        } finally {
          stext.destroy();
        }
        const placements = draws.map((draw) => ({
          fontId: draw.fontId,
          gid: draw.gid,
          code: draw.code,
          matrix: draw.matrix,
          attrs: [],
          start: 0,
          end: 0,
        }));
        const inferred = new Map<string, string>();
        for (const [key, text] of glyphLetters(chars, placements)) {
          if ([...text].length < 2) continue;
          inferred.set(key, text);
        }

        const read = new Map<string, string>();
        for (const [fontId, byGid] of drawLetters(fonts, draws, pageEncodings(page, programs, cache))) {
          for (const [gid, text] of byGid) read.set(`${fontId}:${gid}`, text);
        }

        for (const [key, text] of read) {
          const other = inferred.get(key);
          if (other === undefined) {
            named++;
            continue;
          }
          if (other !== text) {
            disagree++;
            console.log(`      ${document.name}: page ${index + 1} ${key} dictionary "${text}" geometry "${other}"`);
          } else {
            named++;
          }
        }
        geometry += inferred.size;
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
  return { named, geometry, disagree };
}

test('the dictionary names every ligature the page showed, and never contradicts it', () => {
  assert.ok(documents.length > 0, 'no corpus document could be read');
  let total = 0;
  for (const document of documents) {
    const { named, geometry, disagree } = compareLetters(document);
    assert.equal(disagree, 0, `${document.name}: the dictionary and the page disagree on a ligature`);
    assert.ok(
      named >= geometry,
      `${document.name}: the dictionary named ${named} ligatures and the page showed ${geometry}`,
    );
    assert.ok(named > 0, `${document.name}: no ligature was read at all`);
    console.log(`      ${document.name}: ${named} ligatures read (the page itself showed ${geometry})`);
    total += named;
  }
  assert.ok(total > 100, `only ${total} ligatures were read over the corpus`);
});

/* ------------------------------------------------------------------ */
/* 4. the plan                                                         */

test('the plan hands the document’s own letters to the face it builds', async () => {
  const document = documents[0];
  assert.ok(document, 'no corpus document could be read');
  const doc = mupdf.Document.openDocument(fs.readFileSync(document.file), 'application/pdf');
  try {
    const registry = new FontRegistry();
    const plan = new DocumentFontPlan();
    await plan.start(doc, registry);

    let checked = 0;
    for (let index = 0; index < doc.countPages() && checked === 0; index++) {
      const page = doc.loadPage(index);
      try {
        const buffer = new mupdf.Buffer();
        const writer = new mupdf.DocumentWriter(buffer, 'svg', { text: 'path' });
        let svg: string;
        try {
          const device = writer.beginPage(page.getBounds());
          page.run(device, mupdf.Matrix.identity);
          writer.endPage();
          writer.close();
          svg = buffer.asString();
        } finally {
          writer.destroy();
          buffer.destroy();
        }
        const placements = scanGlyphPlacements(svg);
        const outlines = scanGlyphOutlines(svg);
        const programs = programsOnPage(page);
        // What every dictionary on the page states, as `gid` + the letters:
        // a plan's font id is the *SVG's* numbering, which is not the display
        // list's, so the font is matched by what it says about a glyph.
        const stated = new Set<string>();
        for (const encoding of pageEncodings(page, programs, new Map()).values()) {
          for (const [gid, text] of encoding.letters) stated.add(`${gid}\u0000${text}`);
        }

        const pagePlan = await plan.planPage(outlines, placements);
        assert.ok(pagePlan, `page ${index + 1} was planned and then declined`);
        for (const font of pagePlan.fonts.values()) {
          for (const [gid, text] of font.letters) {
            assert.ok(
              stated.has(`${gid}\u0000${text}`),
              `page ${index + 1}: the face was told gid ${gid} is "${text}" and no dictionary says so`,
            );
            checked++;
          }
        }
      } finally {
        page.destroy();
      }
    }
    assert.ok(checked > 0, 'the plan named no ligature on any page');
    console.log(`      ${checked} ligature glyphs reached the face with the document's own letters`);
  } finally {
    doc.destroy();
  }
});

/* ------------------------------------------------------------------ */

test('a ligature character carries its own letters', () => {
  // The programless half: a substituted face has no glyph names to read, so the
  // only statement is the code the display list reported, and Unicode gave
  // those characters their letters.
  for (const [code, letters] of LIGATURE_LETTERS) {
    assert.ok([...letters].length >= 2, `U+${code.toString(16)} should stand for letters`);
  }
  assert.equal(LIGATURE_LETTERS.get(0xfb01), 'fi');
  assert.equal(LIGATURE_LETTERS.get(0xfb00), 'ff');
  assert.equal(LIGATURE_LETTERS.size, 7);
});
