/**
 * Which letters a glyph stands for, when it stands for more than one.
 *
 * A typesetter joins letters that collide - "fi", "fl", "ff" - into a single
 * glyph, and the page then draws one outline for two or three characters. The
 * outline device names a glyph by the text it was shown with, and for a ligature
 * that is only the *first* letter: the "fi" in "specific" arrives as
 * `data-text="f"`, indistinguishable from a plain "f" until it turns out that
 * two glyphs claim the same code point.
 *
 * The text device knows the whole word. It takes the ligature apart and reports
 * one character per letter, placing the first at the glyph's own origin and the
 * rest where the glyph ends. Nothing says which character belongs to which
 * glyph, but the two rules that fall out of how it writes them are enough:
 *
 *   - the last character standing at an origin starts the glyph that is drawn
 *     there; the ones before it are the tail of the glyph before;
 *   - every non-space character between one glyph's first character and the
 *     next glyph's first character is one of those tails.
 *
 * Between them they read "f" at the ligature's origin and "i" after it as "fi",
 * while leaving the spaces a page never drew - which sit between two glyphs, not
 * inside one - out of it.
 *
 * Everything is checked rather than trusted: the character has to be at the
 * glyph's origin, its first letter has to be the one MuPDF named, and every use
 * of a glyph has to give the same answer. A glyph whose letters cannot be
 * established is simply absent from the result, and stays a private-use code
 * point - which draws identically and claims nothing about what it means.
 */

import type { GlyphPlacement } from './glyphs.ts';
import { glyphKey } from './glyphs.ts';
import { ANCHOR_EPSILON, isSpaceChar, type TextChar } from './spaces.ts';

/**
 * The letters Unicode has a code point of their own for.
 *
 * These are presentation forms - the character that *is* the ligature - so a
 * reader copies the ligature it can see rather than a private-use code point,
 * and anything that normalises the text (Unicode calls this NFKC) gets the
 * letters back. A ligature Unicode never named keeps its private-use code.
 */
const LIGATURES = new Map<string, number>([
  ['ff', 0xfb00],
  ['fi', 0xfb01],
  ['fl', 0xfb02],
  ['ffi', 0xfb03],
  ['ffl', 0xfb04],
  ['\u017ft', 0xfb05],
  ['st', 0xfb06],
]);

/**
 * The letters each ligature character stands for, by code point.
 *
 * The other direction of the same table, for the one reader that has the
 * character in hand and needs the letters back: bionic reading counts a word in
 * letters, and a ligature is two of them (`bionic.ts`).
 */
export const LIGATURE_LETTERS: ReadonlyMap<number, string> = new Map(
  [...LIGATURES].map(([letters, code]) => [code, letters] as const),
);

/** The code point for these letters, or null when Unicode has none. */
export function ligatureCode(letters: string): number | null {
  return LIGATURES.get(letters) ?? null;
}

/**
 * The letters each glyph on the page was drawn for, where they could be read.
 *
 * Absent glyphs are the ones nothing could be established for; the caller is
 * expected to fall back rather than to guess. `chars` is the text device's
 * character stream and `placements` the SVG's glyphs, in the order each was
 * written, which is the same order: one page, one content stream.
 */
export function glyphLetters(
  chars: readonly TextChar[],
  placements: readonly GlyphPlacement[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (chars.length === 0 || placements.length === 0) return out;

  // The characters at a point, found on a grid the size of the tolerance: a
  // page has thousands of each, and comparing every pair would be the only slow
  // part of a render.
  const cell = (v: number): number => Math.round(v / ANCHOR_EPSILON);
  const grid = new Map<string, number[]>();
  chars.forEach((c, index) => {
    const key = `${cell(c.x)},${cell(c.y)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  });
  const charsAt = (x: number, y: number): number[] => {
    const cx = cell(x);
    const cy = cell(y);
    const found: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const index of bucket) {
          const c = chars[index];
          if (Math.abs(c.x - x) <= ANCHOR_EPSILON && Math.abs(c.y - y) <= ANCHOR_EPSILON) found.push(index);
        }
      }
    }
    return found.sort((a, b) => a - b);
  };

  // The character that starts each glyph: the last one standing at its origin.
  const starts = placements.map((p) => {
    const at = charsAt(p.matrix.e, p.matrix.f);
    return at.length ? at[at.length - 1] : -1;
  });

  const seen = new Map<string, string>();
  const disagreed = new Set<string>();
  placements.forEach((p, index) => {
    const start = starts[index];
    if (start < 0) return;
    const first = chars[start];
    // MuPDF's own name for the glyph has to be the first of its letters, or
    // this is a glyph the text device read differently and nothing is certain.
    if (p.code > 0 && first.text.codePointAt(0) !== p.code) return;

    let letters = first.text;
    const next = starts[index + 1];
    if (next !== undefined && next > start) {
      for (let i = start + 1; i < next; i++) {
        if (!isSpaceChar(chars[i].text)) letters += chars[i].text;
      }
    }

    const key = glyphKey(p.fontId, p.gid);
    const known = seen.get(key);
    if (known === undefined) seen.set(key, letters);
    else if (known !== letters) disagreed.add(key);
  });

  for (const [key, letters] of seen) {
    if (!disagreed.has(key)) out.set(key, letters);
  }
  return out;
}
