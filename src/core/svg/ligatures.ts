/**
 * Which letters a glyph stands for, when it stands for more than one.
 *
 * A typesetter joins letters that collide - "fi", "fl", "ff" - into a single
 * glyph, and the page then draws one outline for two or three characters. The
 * outline device names a glyph by the text it was shown with, and for a ligature
 * that is only the *first* letter: the "fi" in "specific" arrives as
 * `data-text="f"`, indistinguishable from a plain "f" until it turns out that
 * two glyphs claim the same code point. A document whose own encoding is honest
 * about the ligature names it with the ligature's character instead - `U+FB01`
 * arrives as `data-text="&#xfb01;"` - which is the same claim written the other
 * way round: either way the glyph is one glyph and the letters are two, and
 * either way it is the text device that knows which two.
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
  // part of a render. A cell is the two rounded coordinates packed into one
  // number rather than a string - the walk probes this map nine times a glyph,
  // eighteen million times on a 756-page specification, and a template literal
  // per probe was most of what that cost. Packing is safe: the map is only ever
  // probed at the cell itself and its eight neighbours, and two cells that land
  // on the same number are thousands of points apart, so the coordinate check
  // below still decides what is at a point.
  const grid = new Map<number, number[]>();
  for (let index = 0; index < chars.length; index++) {
    const c = chars[index];
    const key = Math.round(c.y / ANCHOR_EPSILON) * 0x40000 + Math.round(c.x / ANCHOR_EPSILON);
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  }

  /**
   * The last character standing at a point, or -1.
   *
   * Only that character is ever wanted, so the candidates are not collected and
   * sorted: the largest index that is in the cell *and* within the tolerance is
   * the one the sort would have put last.
   */
  const lastAt = (x: number, y: number): number => {
    const cx = Math.round(x / ANCHOR_EPSILON);
    const cy = Math.round(y / ANCHOR_EPSILON);
    let best = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get((cy + dy) * 0x40000 + (cx + dx));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const index = bucket[i];
          if (index <= best) continue;
          const c = chars[index];
          if (Math.abs(c.x - x) <= ANCHOR_EPSILON && Math.abs(c.y - y) <= ANCHOR_EPSILON) best = index;
        }
      }
    }
    return best;
  };

  // The character that starts each glyph: the last one standing at its origin.
  const starts = placements.map((p) => lastAt(p.matrix.e, p.matrix.f));

  const seen = new Map<string, string>();
  const disagreed = new Set<string>();
  for (let index = 0; index < placements.length; index++) {
    const p = placements[index];
    const start = starts[index];
    if (start < 0) continue;
    const first = chars[start];
    // MuPDF names a glyph by the text it was shown with. For a ligature that is
    // usually only the first letter - the display list has no room for the
    // second - but a document whose own encoding says the glyph *is* the
    // ligature (`U+FB01`, and pdfTeX writes that) names it with the ligature's
    // character instead. The name to match is the first letter either way; the
    // rest of the letters come from the text device, which is the only one that
    // has them.
    const named = LIGATURE_LETTERS.get(p.code);
    const head = named?.slice(0, 1) ?? (p.code > 0 ? String.fromCodePoint(p.code) : first.text);
    if (p.code > 0 && first.text !== head) continue;

    let letters = first.text;
    const next = starts[index + 1];
    if (next !== undefined && next > start) {
      for (let i = start + 1; i < next; i++) {
        if (!isSpaceChar(chars[i].text)) letters += chars[i].text;
      }
    }
    // A glyph named after a ligature whose letters the text device does not
    // spell that way is one the two devices read differently, and nothing about
    // it is certain: `fi` and `fx` are not the same claim.
    if (named !== undefined && letters !== named) continue;

    const key = glyphKey(p.fontId, p.gid);
    const known = seen.get(key);
    if (known === undefined) seen.set(key, letters);
    else if (known !== letters) disagreed.add(key);
  }

  for (const [key, letters] of seen) {
    if (!disagreed.has(key)) out.set(key, letters);
  }
  return out;
}
