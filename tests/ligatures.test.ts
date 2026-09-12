/**
 * The one glyph a typesetter draws for two letters.
 *
 * "fi", "fl" and "ff" are single glyphs in most text faces, and everything that
 * reads a page as *text* has to know that. MuPDF's outline device names a glyph
 * by its first letter only, so the "fi" in "specific" arrives as `f` - and the
 * glyph then looks like a second glyph claiming the code point `f` already has,
 * which is how it used to end up as a private-use character: text that renders
 * correctly, copies as nothing, and tears a word in half for anything that looks
 * for word boundaries. The reader saw it as the one place bionic reading had
 * missed - "fi" left out of the fixation point of "find".
 *
 * The text device knows the whole word, so the letters come from there
 * (`svg/ligatures.ts`) and they are what the text says: the glyph is still in the
 * font, and a `liga` rule the font is built with (`font/build.ts`) draws it for
 * those letters - the page shows one glyph and the reader copies two letters.
 * Bionic reading then counts the word in letters rather than in glyphs
 * (`svg/bionic.ts`), which is what its fixation points are made of. A glyph no
 * letters could be established for keeps its private-use stand-in, which draws
 * identically and claims nothing about what it means.
 *
 *   node tests/ligatures.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as mupdf from 'mupdf';
import { textVide } from 'text-vide';
import { PdfEngine } from '../src/core/engine.ts';
import { bionicSegments } from '../src/core/svg/bionic.ts';
import { glyphLetters, ligatureCode } from '../src/core/svg/ligatures.ts';
import { glyphKey, scanGlyphOutlines, scanGlyphPlacements, type GlyphOutline } from '../src/core/svg/glyphs.ts';
import { FontRegistry } from '../src/core/font/registry.ts';
import { PAPERS } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

/* ------------------------------------------------- what the letters are called */

test('a ligature Unicode has a code point for is named after its letters', () => {
  assert.equal(ligatureCode('ff'), 0xfb00);
  assert.equal(ligatureCode('fi'), 0xfb01);
  assert.equal(ligatureCode('fl'), 0xfb02);
  assert.equal(ligatureCode('ffi'), 0xfb03);
  assert.equal(ligatureCode('ffl'), 0xfb04);
  assert.equal(ligatureCode('st'), 0xfb06);
  // One letter is not a ligature, and neither is a pair Unicode never named.
  assert.equal(ligatureCode('f'), null);
  assert.equal(ligatureCode('fj'), null);
  assert.equal(ligatureCode(''), null);
});

/* -------------------------------------------------- reading them off the page */

/** A glyph as the SVG has it: an origin, and the code MuPDF named it with. */
function glyph(fontId: number, gid: number, x: number, y: number, code: number) {
  return {
    fontId,
    gid,
    code,
    matrix: { a: 10, b: 0, c: 0, d: -10, e: x, f: y },
    attrs: [],
    start: 0,
    end: 0,
  };
}

/** Characters as the text device reports them: one entry per letter it read. */
const at = (x: number, y: number, ...letters: string[]) =>
  letters.map((text) => ({ text, x, y, line: 1 }));

test('a glyph drawn for two letters stands for both of them', () => {
  // "specific": the f and the i are one glyph, and the c that follows starts
  // where that glyph ends - which is where the text device puts the i.
  const chars = [...at(0, 0, 's', 'p', 'e', 'c', 'i'), ...at(10, 0, 'f'), ...at(20, 0, 'i', 'c')];
  const placements = [glyph(1, 7, 10, 0, 0x66), glyph(1, 8, 20, 0, 0x63)];
  const letters = glyphLetters(chars, placements);

  assert.equal(letters.get('1:7'), 'fi');
  assert.equal(letters.get('1:8'), 'c');
});

test('a ligature is read even when the next glyph is kerned closer', () => {
  // The page this comes from ("...are five broad...") kerns the v in under the
  // ligature's own end, so the two do not share an origin.
  const chars = [...at(10, 0, 'f'), ...at(20, 0, 'i'), ...at(19.5, 0, 'v')];
  const placements = [glyph(1, 7, 10, 0, 0x66), glyph(1, 9, 19.5, 0, 0x76)];
  assert.equal(glyphLetters(chars, placements).get('1:7'), 'fi');
});

test('three letters in one glyph are read as three', () => {
  const chars = [...at(0, 0, 'o'), ...at(5, 0, 'f'), ...at(15, 0, 'f', 'i', 'c')];
  const placements = [glyph(2, 3, 5, 0, 0x66), glyph(2, 4, 15, 0, 0x63)];
  assert.equal(glyphLetters(chars, placements).get('2:3'), 'ffi');
});

test('the spaces a page never drew are not letters of a glyph', () => {
  // "a b": the space is a character but has no glyph, and belongs to neither.
  const chars = [...at(0, 0, 'a'), ...at(5, 0, ' '), ...at(9, 0, 'b')];
  const placements = [glyph(1, 1, 0, 0, 0x61), glyph(1, 2, 9, 0, 0x62)];
  const letters = glyphLetters(chars, placements);
  assert.equal(letters.get('1:1'), 'a');
  assert.equal(letters.get('1:2'), 'b');
});

test('a glyph the text device did not describe is left out, and takes nothing with it', () => {
  // A figure's text can be missing from the text device's reading altogether.
  // The glyphs on either side still have to come out right.
  const chars = [...at(0, 0, 'a'), ...at(9, 0, 'b'), ...at(10, 0, 'c')];
  const placements = [glyph(1, 1, 0, 0, 0x61), glyph(1, 2, 4, 0, 0x62), glyph(1, 3, 10, 0, 0x63)];
  const letters = glyphLetters(chars, placements);
  assert.equal(letters.get('1:1'), 'a');
  assert.equal(letters.has('1:2'), false);
  assert.equal(letters.get('1:3'), 'c');
});

test('a glyph whose first letter is not the one MuPDF named is left out', () => {
  const chars = [...at(0, 0, 'x')];
  assert.equal(glyphLetters(chars, [glyph(1, 1, 0, 0, 0x66)]).size, 0);
});

test('a glyph used two ways is left out, rather than guessed at', () => {
  // The same glyph once on its own and once with a letter after it: whatever it
  // is, it is not the same thing both times, and a ligature is not a guess.
  const chars = [...at(0, 0, 'f'), ...at(8, 0, 'f'), ...at(17, 0, 'i'), ...at(18, 0, 'y')];
  const placements = [glyph(1, 7, 0, 0, 0x66), glyph(1, 7, 8, 0, 0x66), glyph(1, 5, 18, 0, 0x79)];
  assert.equal(glyphLetters(chars, placements).has('1:7'), false);
});

test('a ligature at the very end of the page keeps the name it had', () => {
  // Nothing follows it to say where its letters end; a guess would be worse
  // than the code point MuPDF gave.
  const chars = [...at(0, 0, 'f'), ...at(8, 0, 'i')];
  assert.equal(glyphLetters(chars, [glyph(1, 7, 0, 0, 0x66)]).get('1:7'), 'f');
});

test('a glyph the document itself calls a ligature is read by its letters', () => {
  // pdfTeX writes the glyph's own Unicode value into the page's encoding, so
  // the display list names it `U+FB01` rather than the `f` the outline device
  // can only fit. That is the same claim written the other way round, and the
  // text device still has the two letters.
  const chars = [...at(0, 0, 'f'), ...at(8, 0, 'i'), ...at(9, 0, 'c')];
  assert.equal(glyphLetters(chars, [glyph(1, 7, 0, 0, 0xfb01), glyph(1, 8, 9, 0, 0x63)]).get('1:7'), 'fi');
});

test('a glyph called a ligature whose letters are other letters is left out', () => {
  // The name says `fi` and the text device says `fx`: the two disagree, and a
  // glyph the two devices read differently is not one to write text from.
  const chars = [...at(0, 0, 'f'), ...at(8, 0, 'x')];
  assert.equal(glyphLetters(chars, [glyph(1, 7, 0, 0, 0xfb01)]).has('1:7'), false);
});

/* ---------------------------------------------------------- in the built font */

const SQUARE = 'M0 0L.5 0L.5 .5L0 .5Z';

function outline(fontId: number, gid: number): GlyphOutline {
  return { fontId, gid, d: SQUARE, raw: '', start: 0, end: 0 };
}

test('the ligature is named after its letters, whoever is numbered first', async () => {
  // Glyph 1 is the ligature and glyph 2 is the letter it starts with: what a
  // glyph means has to decide the code point, not the order they are numbered.
  const outlines = new Map([
    [glyphKey(1, 1), outline(1, 1)],
    [glyphKey(1, 2), outline(1, 2)],
    [glyphKey(1, 3), outline(1, 3)],
  ]);
  const placements = [glyph(1, 1, 0, 0, 0x66), glyph(1, 2, 10, 0, 0x66), glyph(1, 3, 20, 0, 0x66)];
  const letters = new Map([
    [glyphKey(1, 1), 'fi'],
    [glyphKey(1, 2), 'f'],
    [glyphKey(1, 3), 'fj'], // a ligature Unicode never named
  ]);

  const registry = new FontRegistry({ disableCompression: true });
  const plan = await registry.planPage(outlines, placements, { letters });
  const codes = plan.fonts.get(1)?.codes;

  assert.equal(codes?.get(1), 0xfb01, 'the ligature is the fi character');
  assert.equal(codes?.get(2), 0x66, 'the letter keeps its own code point');
  const pua = codes?.get(3) ?? 0;
  assert.ok(pua >= 0xe000 && pua <= 0xf8ff, `an unnamed ligature falls back to private use, got U+${pua.toString(16)}`);
});

test('without the letters, a duplicate code point still falls back to private use', async () => {
  const outlines = new Map([
    [glyphKey(1, 1), outline(1, 1)],
    [glyphKey(1, 2), outline(1, 2)],
  ]);
  const placements = [glyph(1, 1, 0, 0, 0x66), glyph(1, 2, 10, 0, 0x66)];
  const registry = new FontRegistry({ disableCompression: true });
  const plan = await registry.planPage(outlines, placements);
  const codes = plan.fonts.get(1)?.codes;

  assert.equal(codes?.get(1), 0x66);
  assert.ok((codes?.get(2) ?? 0) >= 0xe000, 'nothing is invented for a glyph nothing is known about');
});

/* -------------------------------------------------------- bionic reading on it */

test('bionic reading counts a ligature as the letters it stands for', () => {
  // "find" is four letters to a reader, so three of them are the fixation
  // point: the ligature - which cannot be drawn half dark - and the n.
  const segments = bionicSegments('We \ufb01nd that');
  assert.deepEqual(
    segments.map((s) => [s.fixation, s.text]),
    [
      [true, 'W'],
      [false, 'e '],
      [true, '\ufb01n'],
      [false, 'd '],
      [true, 'tha'],
      [false, 't'],
    ],
  );
  // The glyph is whole in one stretch, and the characters are accounted for.
  assert.equal(segments.reduce((n, s) => n + s.chars, 0), 'We \ufb01nd that'.length);
  assert.equal(segments.map((s) => s.text).join(''), 'We \ufb01nd that');
});

test('a ligature the fixation point reaches into is marked whole', () => {
  // "specific" is eight letters in seven glyphs; its fixation point is six
  // letters, so it ends inside the ligature and the whole glyph stays marked.
  const [fixation] = bionicSegments('speci\ufb01c');
  assert.equal(fixation.fixation, true);
  assert.equal(fixation.text.normalize('NFKC'), 'specifi');
  assert.equal(fixation.chars, 6, 'characters, because that is what the run has');
});

test('nothing else about the segments changes', () => {
  assert.deepEqual(bionicSegments('hello world'), [
    { fixation: true, text: 'hel', chars: 3 },
    { fixation: false, text: 'lo ', chars: 3 },
    { fixation: true, text: 'wor', chars: 3 },
    { fixation: false, text: 'ld', chars: 2 },
  ]);
  assert.deepEqual(bionicSegments('123'), [{ fixation: false, text: '123', chars: 3 }]);
  assert.deepEqual(bionicSegments('a &amp; b'), [{ fixation: false, text: 'a &amp; b', chars: 5 }]);
  assert.deepEqual(bionicSegments(''), []);
  // A character outside the BMP is still one character, and one glyph.
  assert.deepEqual(bionicSegments('\u{1d400}b'), [
    { fixation: true, text: '\u{1d400}', chars: 1 },
    { fixation: false, text: 'b', chars: 1 },
  ]);
});

/* ------------------------------------------------------------- a real page */

const paper = PAPERS.find((p) => p.url.includes('2303.08774'));
if (!paper) throw new Error('the corpus no longer lists the GPT-4 report');
const files = await ensurePapers([paper.url]);
const file = files.get(paper.url);
const bytes = file instanceof Error || !file ? null : new Uint8Array(fs.readFileSync(file));

/** Page 14: the one that made the ligature visible - "We find that improved…". */
const INDEX = 13;

/** The characters an escaped piece of SVG text stands for. */
const unescape = (s: string): string =>
  s.replace(/&(amp|lt|gt);/g, (_, e: string) => (e === 'amp' ? '&' : e === 'lt' ? '<' : '>'));

/** The text of every `<text>` element, in order. */
function textOf(svg: string): string {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => unescape(m[1].replace(/<[^>]*>/g, '')))
    .join('');
}

/**
 * Every word of one text element, with the letters left at full strength.
 *
 * A word is what a reader would call one: the runs of characters between the
 * spaces, whatever the tspans cut them into.
 */
function wordsWithFixations(element: string): Array<{ word: string; fixed: string }> {
  const out: Array<{ word: string; fixed: string }> = [];
  let word = '';
  let fixed = '';
  const end = (): void => {
    if (word) out.push({ word, fixed });
    word = '';
    fixed = '';
  };
  for (const m of element.matchAll(/<tspan([^>]*)>([\s\S]*?)<\/tspan>/g)) {
    const faded = m[1].includes('fill-opacity');
    for (const char of unescape(m[2])) {
      if (/\s/.test(char)) {
        end();
        continue;
      }
      word += char;
      if (!faded) fixed += char;
    }
  }
  end();
  return out;
}

/** The character a page draws, ignoring what a reader never sees. */
const bare = (s: string): string => s.replace(/\s+/g, '').replace(/\ufffd/g, '').normalize('NFKC');

/** The texts of the `<tspan>`s, split into the faded ones and the rest. */
function tspans(svg: string): { plain: string[]; faded: string[] } {
  const plain: string[] = [];
  const faded: string[] = [];
  for (const m of svg.matchAll(/<tspan([^>]*)>([\s\S]*?)<\/tspan>/g)) {
    (m[1].includes('fill-opacity') ? faded : plain).push(m[2]);
  }
  return { plain, faded };
}

/** Every fixation point `text-vide` finds in a piece of text. */
function fixationPoints(text: string): string {
  return [...textVide(text).matchAll(/<b>([\s\S]*?)<\/b>/g)].map((m) => m[1]).join('');
}

/** The lines of a page, as the text device read them. */
function pageLines(doc: mupdf.Document, index: number): string[] {
  const lines: string[] = [];
  let line = '';
  const stext = doc.loadPage(index).toStructuredText('');
  try {
    stext.walk({
      beginLine() {
        line = '';
      },
      onChar(c: string) {
        line += c;
      },
      endLine() {
        lines.push(line);
      },
    });
  } finally {
    stext.destroy();
  }
  return lines;
}

test('a real page: the ligature is written as its letters, not a stand-in', { skip: bytes ? false : 'no cached paper' }, async () => {
  assert.ok(bytes);
  const engine = new PdfEngine();
  try {
    await engine.open(bytes);
    const rendered = await engine.renderPage(INDEX, { textMode: 'auto' });
    const text = textOf(rendered.svg);

    // "task-specific fine-tuning" and "We find that": every ligature on this
    // page is written as the letters it stands for, which is what a reader
    // searches for, selects, and copies.
    assert.ok(text.includes('specific'), 'the fi of "specific" is written as its letters');
    assert.ok(text.includes('fine-tuning'), 'and the one in "fine-tuning"');
    assert.ok(text.includes('We find'), 'and the one in "find"');
    assert.equal(/[\ue000-\uf8ff]/.test(text), false, 'no glyph is left as a private-use code point');
    assert.equal(/[\ufb00-\ufb06]/.test(text), false, 'and no letter is written as a ligature the page never wrote');

    // And the page says exactly what it draws: every character, in order, named
    // the way the page's own text names it. U+FFFD is what the text device
    // writes for a glyph the document gives no meaning to, which stays an
    // outline here.
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    const lines = pageLines(doc, INDEX);
    doc.destroy();
    assert.equal(bare(text), bare(lines.join('')));

    // The words are still words, in the page's order.
    const words = (s: string): string[] => s.normalize('NFKC').split(/\s+/).filter(Boolean);
    assert.deepEqual(words(text), words(lines.join(' ')));
  } finally {
    engine.close();
  }
});

test('a real page: the fixation points are the ones the page itself has', { skip: bytes ? false : 'no cached paper' }, async () => {
  assert.ok(bytes);
  const engine = new PdfEngine();
  try {
    await engine.open(bytes);
    const rendered = await engine.renderPage(INDEX, { textMode: 'auto', bionic: true });
    // The line the reader saw the bug on - spelled with the ligature, so the
    // search stops before it. The text has to be read out of the element first:
    // the fixation points cut it into tspans, and "task" is two of them.
    const line = 'task-speci';
    const element = [...rendered.svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
      .map((m) => m[0])
      .find((t) => t.replace(/<[^>]*>/g, '').includes(line));
    assert.ok(element, 'the line is one text element');

    const { plain, faded } = tspans(element);
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    const pageLine = pageLines(doc, INDEX).find((l) => l.includes(line)) ?? '';
    doc.destroy();
    assert.ok(pageLine.includes('We find'), 'the line is the one that was wrong');

    // Word by word, the fixation points are the ones the page's own letters
    // would get - "We find" keeps "fin", "specific" keeps "specif". A ligature
    // the fixation stops inside is marked whole, so a word can come out with
    // the last letter or two of its ligature also at full strength; it can
    // never come out with less.
    const got = wordsWithFixations(element);
    const want = pageLine.split(/\s+/).filter(Boolean);
    assert.deepEqual(
      got.map((w) => w.word.normalize('NFKC')),
      want.map((w) => w.normalize('NFKC')),
      'the words of the line',
    );
    for (let i = 0; i < want.length; i++) {
      const page = fixationPoints(want[i]);
      const svg = got[i].fixed.normalize('NFKC');
      assert.ok(
        svg.startsWith(page),
        `"${want[i]}": the page marks ${JSON.stringify(page)}, the SVG ${JSON.stringify(svg)}`,
      );
      assert.ok(
        [...svg].length - [...page].length <= 2,
        `"${want[i]}": only a ligature may be added, the SVG marks ${JSON.stringify(svg)}`,
      );
    }

    // Said the small way round, because this is what a reader saw: the fi of
    // "find" is part of the fixation point, and the d after it is not. The
    // ligature is a tspan of its own - it is one glyph and the shaper has to
    // lay its letters out together - so the marks are read per word.
    assert.equal(got.find((w) => w.word === 'find')?.fixed, 'fin', 'the fi of "find" is marked');
    assert.ok(faded.some((s) => s.startsWith('d')), 'and the d after it is not');
    for (const stretch of faded) assert.ok(/\S/.test(stretch), 'a faded stretch draws something');
  } finally {
    engine.close();
  }
});
