/**
 * The spaces in the text, and bionic reading on top of them.
 *
 * An outline SVG has no spaces in it at all - a space has no outline to draw, so
 * there is nothing for MuPDF to reference - and the page arrives with its words
 * run together: "linearattentionisallyouneed". That is what a reader copies and
 * what any word-level tool sees, so the engine writes the spaces back from the
 * text device's own character stream (`svg/spaces.ts`).
 *
 * The first half of this file is that logic on characters written out by hand;
 * the second half is the same thing through the engine on a real paper, where
 * the assertion that matters is that the SVG's words are the page's words, in
 * order. Bionic reading (`svg/bionic.ts`) is checked for the property that makes
 * it usable at all: it changes how a character is drawn and never where it is.
 *
 *   node tests/spaces.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as mupdf from 'mupdf';
import { PdfEngine } from '../src/core/engine.ts';
import { isSpaceChar, spaceMarks, type TextChar } from '../src/core/svg/spaces.ts';
import { bionicSegments } from '../src/core/svg/bionic.ts';
import { scanGlyphPlacements } from '../src/core/svg/glyphs.ts';
import { upgradeGlyphsToText } from '../src/core/svg/text-upgrade.ts';
import { PAPERS } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

/** Characters, as the text device reports them: a string, and an origin. */
const chars = (...spec: Array<[string, number, number, number]>): TextChar[] =>
  spec.map(([text, x, y, line]) => ({ text, x, y, line }));

/* ------------------------------------------------------- which is a space */

test('a space is a space, a letter is not', () => {
  for (const text of [' ', '\t', '\u00a0', '\u2009', '\u3000']) assert.equal(isSpaceChar(text), true, JSON.stringify(text));
  for (const text of ['a', '.', '-', '\u200b', '\n', '']) assert.equal(isSpaceChar(text), false, JSON.stringify(text));
});

test('a space points at the character that starts where it ended', () => {
  // "a b", the space at 10 with the b starting at 13.
  const marks = spaceMarks(chars(['a', 0, 0, 0], [' ', 10, 0, 0], ['b', 13, 0, 0]));
  assert.deepEqual(marks, [{ kind: 'space', originX: 10, originY: 0, x: 13, y: 0, code: 0x20 }]);
});

test('a run of spaces stays in order, in front of the same character', () => {
  // Two spaces after a full stop: both go in front of the next word, and the
  // order they are written in is the order they were read in.
  const marks = spaceMarks(chars(['a', 0, 0, 0], ['.', 5, 0, 0], [' ', 10, 0, 0], [' ', 13, 0, 0], ['B', 16, 0, 0]));
  assert.deepEqual(
    marks.map((m) => [m.kind, m.originX, m.x]),
    [
      ['space', 10, 16],
      ['space', 13, 16],
    ],
  );
});

test('a no-break space is put back as itself', () => {
  const marks = spaceMarks(chars(['a', 0, 0, 0], ['\u00a0', 10, 0, 0], ['b', 13, 0, 0]));
  assert.equal(marks[0].code, 0xa0);
});

test('trailing whitespace has nothing to sit in front of', () => {
  assert.deepEqual(spaceMarks(chars(['a', 0, 0, 0], [' ', 10, 0, 0])), []);
  assert.deepEqual(spaceMarks(chars(['a', 0, 0, 0], [' ', 10, 0, 0], [' ', 13, 0, 0])), []);
});

test('a line break separates the words it broke, exactly once', () => {
  // "on" / "two": nothing was written where the line broke, so the break itself
  // has to stand for the space.
  const broken = spaceMarks(chars(['o', 0, 0, 0], ['n', 5, 0, 0], ['t', 0, 10, 1], ['w', 4, 10, 1]));
  assert.deepEqual(broken, [{ kind: 'break', originX: 0, originY: 10, x: 0, y: 10, code: 0x20 }]);

  // A line that already ends in a space is separated once, not twice: the space
  // is the separator, and the break adds nothing.
  const trailing = spaceMarks(chars(['o', 0, 0, 0], ['n', 5, 0, 0], [' ', 10, 0, 0], ['t', 0, 10, 1]));
  assert.deepEqual(
    trailing.map((m) => [m.kind, m.x, m.y]),
    [['space', 0, 10]],
  );

  // The same on the other side: a line that starts with a space.
  const leading = spaceMarks(chars(['o', 0, 0, 0], ['n', 5, 0, 0], [' ', 0, 10, 1], ['t', 3, 10, 1]));
  assert.deepEqual(
    leading.map((m) => [m.kind, m.x, m.y]),
    [['space', 3, 10]],
  );

  // The very first line has nothing before it to be separated from.
  assert.deepEqual(spaceMarks(chars(['a', 0, 0, 0])), []);
});

/* ------------------------------------------------- back into the SVG text */

/** A page of glyphs in the shape MuPDF writes: `<defs>` outlines, `<use>`s. */
function page(glyphs: Array<{ gid: number; code: number; x: number; y: number }>): string {
  const defs = [...new Set(glyphs.map((g) => g.gid))]
    .map((gid) => `<path id="font_1_${gid}" d="M0 0 L500 0 L500 700 L0 700 Z"/>`)
    .join('');
  const uses = glyphs
    .map((g) => `<use xlink:href="#font_1_${g.gid}" data-text="&#x${g.code.toString(16)};" transform="matrix(10 0 0 10 ${g.x} ${g.y})"/>`)
    .join('');
  return `<svg viewBox="0 0 612 792"><defs>${defs}</defs>${uses}</svg>`;
}

/** The letters of a small alphabet, by glyph id. */
const LETTERS: Record<number, string> = { 1: 'h', 2: 'e', 3: 'l', 4: 'o', 5: 'w', 6: 'r', 7: 'd', 32: ' ' };
const enc = {
  familyFor: (): string => 'wpdf-test',
  codeFor: (_fontId: number, gid: number): number | null => LETTERS[gid]?.codePointAt(0) ?? null,
};

/** The text of every `<text>` element, in order. */
const textOf = (svg: string): string =>
  [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]*>/g, '')).join('');

/** Every x in the markup, in order: one per character, whatever the tspans. */
const xsOf = (svg: string): string[] =>
  [...svg.matchAll(/<tspan[^>]*\sx="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));

const boldOf = (svg: string): string[] =>
  [...svg.matchAll(/<tspan font-weight="bold"[^>]*>([\s\S]*?)<\/tspan>/g)].map((m) => m[1]);

const plainOf = (svg: string): string[] =>
  [...svg.matchAll(/<tspan(?! font-weight)[^>]*>([\s\S]*?)<\/tspan>/g)].map((m) => m[1]);

/** "hello world": h e l l o, a space, w o r l d - the space drawn by nothing. */
const HELLO = page([
  { gid: 1, code: 0x68, x: 0, y: 0 },
  { gid: 2, code: 0x65, x: 5, y: 0 },
  { gid: 3, code: 0x6c, x: 10, y: 0 },
  { gid: 3, code: 0x6c, x: 15, y: 0 },
  { gid: 4, code: 0x6f, x: 20, y: 0 },
  { gid: 5, code: 0x77, x: 30, y: 0 },
  { gid: 4, code: 0x6f, x: 35, y: 0 },
  { gid: 6, code: 0x72, x: 40, y: 0 },
  { gid: 3, code: 0x6c, x: 45, y: 0 },
  { gid: 7, code: 0x64, x: 50, y: 0 },
]);

test('a space is written back between the glyphs it separated', () => {
  const placements = scanGlyphPlacements(HELLO);
  const spaces = spaceMarks(chars(['h', 0, 0, 0], [' ', 25, 0, 0], ['w', 30, 0, 0]));
  const plain = upgradeGlyphsToText(HELLO, placements, enc);
  const spaced = upgradeGlyphsToText(HELLO, placements, enc, { spaces });

  assert.equal(textOf(plain.svg), 'helloworld');
  assert.equal(textOf(spaced.svg), 'hello world');
  assert.equal(spaced.stats.spaces, 1);
  assert.equal(spaced.stats.converted, plain.stats.converted);
  // The space has a position of its own, and the glyph after it keeps the one
  // it had: writing the character back moves nothing.
  assert.deepEqual(xsOf(spaced.svg).slice(0, 5), xsOf(plain.svg).slice(0, 5));
  assert.deepEqual(xsOf(spaced.svg).slice(6), xsOf(plain.svg).slice(5));
  // The space is written where the next character starts: its own origin was
  // 25, and where the character goes is where `w` begins.
  assert.deepEqual(xsOf(spaced.svg).slice(5, 6), ['30']);
});

test('a space the page draws itself is not written twice', () => {
  // Some fonts do give a space an outline. Then the glyph is in the SVG, the
  // character is already in the text, and the mark has nothing left to add.
  const drawn = page([
    { gid: 4, code: 0x6f, x: 0, y: 0 },
    { gid: 32, code: 0x20, x: 5, y: 0 },
    { gid: 5, code: 0x77, x: 10, y: 0 },
  ]);
  const placements = scanGlyphPlacements(drawn);
  const spaces = spaceMarks(chars(['o', 0, 0, 0], [' ', 5, 0, 0], ['w', 10, 0, 0]));
  const result = upgradeGlyphsToText(drawn, placements, enc, { spaces });
  assert.equal(textOf(result.svg), 'o w');
  assert.equal(result.stats.spaces, 0);
});

test('a space in front of a glyph that stays an outline joins the run before it', () => {
  // The middle glyph is not in the alphabet, so it stays a path - and the space
  // in front of it still belongs in the text, at the end of the run before it,
  // which is the same point in the reading order.
  const two = page([
    { gid: 1, code: 0x68, x: 0, y: 0 },
    { gid: 9, code: 0x39, x: 8, y: 0 },
    { gid: 5, code: 0x77, x: 13, y: 0 },
  ]);
  const placements = scanGlyphPlacements(two);
  // 'h', a space, the unreachable glyph, then 'w' - so the space points at the
  // glyph that stays an outline.
  const spaces = spaceMarks(chars(['h', 0, 0, 0], [' ', 5, 0, 0], ['\u0009', 8, 0, 0], ['w', 13, 0, 0]));
  const result = upgradeGlyphsToText(two, placements, enc, { spaces });
  assert.equal(textOf(result.svg), 'h w');
  assert.equal(result.stats.spaces, 1);
  assert.equal(result.stats.kept, 1);
});

test('a space whose character is not in the SVG at all is dropped', () => {
  const placements = scanGlyphPlacements(HELLO);
  // Anchored at 999,999: nothing is drawn there.
  const spaces = spaceMarks(chars(['h', 0, 0, 0], [' ', 990, 999, 0], ['w', 999, 999, 0]));
  const result = upgradeGlyphsToText(HELLO, placements, enc, { spaces });
  assert.equal(textOf(result.svg), 'helloworld');
  assert.equal(result.stats.spaces, 0);
});

test('a line break is written back as a space between the lines', () => {
  // "or" ends the first line and "do" starts the second: one run either way,
  // because both lines are set in the same font at the same place.
  const lines = page([
    { gid: 4, code: 0x6f, x: 0, y: 0 },
    { gid: 6, code: 0x72, x: 5, y: 0 },
    { gid: 7, code: 0x64, x: 0, y: 20 },
    { gid: 4, code: 0x6f, x: 5, y: 20 },
  ]);
  const placements = scanGlyphPlacements(lines);
  const spaces = spaceMarks(chars(['o', 0, 0, 0], ['r', 5, 0, 0], ['d', 0, 20, 1], ['o', 5, 20, 1]));
  const result = upgradeGlyphsToText(lines, placements, enc, { spaces });
  assert.equal(textOf(result.svg), 'or do');
});

/* -------------------------------------------------------------- bionic */

test('bionic segments are the text, split at the fixation points', () => {
  const text = 'Bionic reading is a new method facilitating the reading process.';
  const segments = bionicSegments(text);
  // Whatever it does, it does not change the text.
  assert.equal(segments.map((s) => s.text).join(''), text);
  assert.equal(
    segments.reduce((n, s) => n + s.chars, 0),
    [...text].length,
  );
  const bold = segments.filter((s) => s.bold).map((s) => s.text);
  assert.ok(bold.length >= 8, 'every word gets a fixation point');
  // A fixation point is a word's beginning, never a word's end or a space.
  for (const word of bold) assert.match(word, /^[A-Za-z]+$/);
  assert.equal(bold[0], 'Bion');
});

test('a character reference is one character, and is left alone', () => {
  // The text handed to text-vide is escaped, so `&amp;` is one character of the
  // page and not the word "amp".
  const segments = bionicSegments('a &amp; b &lt; c');
  assert.equal(segments.map((s) => s.text).join(''), 'a &amp; b &lt; c');
  assert.equal(
    segments.reduce((n, s) => n + s.chars, 0),
    9, // a, space, &, space, b, space, <, space, c
  );
  assert.deepEqual(bionicSegments('').length, 0);
  // Text with no words at all comes back as it was.
  assert.equal(
    bionicSegments('12 + 34 = 46').map((s) => s.text).join(''),
    '12 + 34 = 46',
  );
});

test('bionic bolds the words and moves nothing', () => {
  const placements = scanGlyphPlacements(HELLO);
  const spaces = spaceMarks(chars(['h', 0, 0, 0], [' ', 25, 0, 0], ['w', 30, 0, 0]));
  const plain = upgradeGlyphsToText(HELLO, placements, enc, { spaces });
  const bionic = upgradeGlyphsToText(HELLO, placements, enc, { spaces, bionic: true });

  assert.equal(textOf(bionic.svg), 'hello world');
  assert.deepEqual(xsOf(bionic.svg), xsOf(plain.svg));
  assert.equal(bionic.stats.converted, plain.stats.converted);
  // One bold tspan per word, each carrying the glyphs of its own prefix - and
  // `text-vide`'s own answer for a five-letter word is three letters, which is
  // why this is not simply "the first three of every word".
  assert.deepEqual(boldOf(bionic.svg), ['hel', 'wor']);
  // The rest of each word, and the space between them, are still there.
  assert.deepEqual(plainOf(bionic.svg), ['lo ', 'ld']);
  assert.equal(bionic.svg.match(/<tspan/g)?.length, 4);
});

/* ------------------------------------------------------ through the engine */

const paper = PAPERS[0];
const files = await ensurePapers([paper.url]);
const file = files.get(paper.url);
const bytes = file instanceof Error || !file ? null : new Uint8Array(fs.readFileSync(file));

/** The page's own text, one string per line, as the text device read it. */
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

const words = (text: string): string[] => text.normalize('NFKC').split(/\s+/).filter(Boolean);

/**
 * A word from the SVG as a pattern for the word the text device read.
 *
 * A private-use character is how a font encodes a ligature: the glyph is one
 * glyph - "fi" - and MuPDF's cmap gives it a code of its own, which is why the
 * SVG can read "efficient" where the device read "efficient". The ligature
 * stands for the letters it was made from, so it is allowed to match one or two
 * of them; every other character has to match exactly.
 */
function wordPattern(word: string): RegExp {
  let out = '^';
  for (const char of word) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0xe000 && code <= 0xf8ff ? '..?' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

test('a real page: the SVG words are the page words', { skip: bytes ? false : 'no cached paper' }, async () => {
  assert.ok(bytes);
  const engine = new PdfEngine();
  try {
    await engine.open(bytes);
    const index = 1;
    const rendered = await engine.renderPage(index, { textMode: 'auto' });
    assert.equal(rendered.stats.glyphsAsOutlines, 0, 'every glyph on this page is text');

    const text = textOf(rendered.svg);
    // The words are apart, which is the whole point: this is what a reader
    // copies, and what bionic reading needs to find the words at all.
    assert.ok(rendered.stats.spaces > 100, `spaces written back: ${rendered.stats.spaces}`);
    assert.ok(/\bthe\b/.test(text), 'the words are words');
    assert.ok(!/[a-z]{25}/.test(text), 'nothing is a 25-letter word');

    // And they are the page's words - all of them, in order, allowing for the
    // ligatures a font draws as a single glyph.
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    const reference = words(pageLines(doc, index).join(' '));
    doc.destroy();
    const got = words(text);
    assert.equal(got.length, reference.length, 'word count');
    for (let i = 0; i < reference.length; i++) {
      assert.match(reference[i], wordPattern(got[i]), `word ${i}`);
    }
  } finally {
    engine.close();
  }
});

test('a real page: bionic reading draws the same glyphs in the same places', { skip: bytes ? false : 'no cached paper' }, async () => {
  assert.ok(bytes);
  const engine = new PdfEngine();
  try {
    await engine.open(bytes);
    const index = 1;
    const plain = await engine.renderPage(index, { textMode: 'auto' });
    const bionic = await engine.renderPage(index, { textMode: 'auto', bionic: true });

    // The same page: same characters, same positions, same number of text
    // elements. Only the markup inside them differs.
    assert.equal(textOf(bionic.svg), textOf(plain.svg));
    assert.deepEqual(xsOf(bionic.svg), xsOf(plain.svg));
    assert.equal(bionic.svg.match(/<text\b/g)?.length, plain.svg.match(/<text\b/g)?.length);
    assert.equal(bionic.stats.spaces, plain.stats.spaces);

    const bold = boldOf(bionic.svg);
    assert.ok(bold.length > 100, `fixation points: ${bold.length}`);
    assert.equal(boldOf(plain.svg).length, 0, 'nothing is bold without it');
    for (const run of bold) assert.ok(!/\s/.test(run), `a fixation point is inside a word: ${JSON.stringify(run)}`);
    // The same runs, cut into more pieces: one extra tspan per fixation point
    // (the rest of the word it is the start of).
    assert.ok((bionic.svg.match(/<tspan/g)?.length ?? 0) > (plain.svg.match(/<tspan/g)?.length ?? 0));
    assert.equal(plainOf(bionic.svg).length, plainOf(plain.svg).length + bold.length);

    // And a crop is still the same window, whatever the text is drawn like.
    const rules = ['arxiv', 'page-number'] as const;
    const cropped = await engine.renderPage(index, { textMode: 'auto', crop: rules });
    const croppedBionic = await engine.renderPage(index, { textMode: 'auto', crop: rules, bionic: true });
    assert.deepEqual(croppedBionic.crop, cropped.crop);
  } finally {
    engine.close();
  }
});
