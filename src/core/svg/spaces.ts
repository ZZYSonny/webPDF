/**
 * Put the spaces back into the page's text.
 *
 * MuPDF's SVG device draws a glyph by referencing its outline, and a space has
 * no outline to reference, so it draws nothing at all. The page comes out with
 * its words run together - "Providedproperattributionisprovided" - and that
 * glued string is what a reader copies, what a spell checker sees, and what any
 * word-level tool has to work with. Bionic reading is the immediate reason this
 * matters (it can only bold the first letters of a *word* if it can find where
 * the words are), but a plain copy is reason enough.
 *
 * The text device knows better: it reports every character it read, spaces
 * included, each with the origin the character starts at. A space has no ink, so
 * writing the character back cannot change what the page looks like; all it
 * needs is somewhere to sit, and the character *after* a space starts exactly
 * where that space ended. Anchoring to the next character rather than to the
 * space's own box is also what keeps this correct for rotated text, where a
 * bounding box says nothing about the direction of the advance.
 *
 * Two things are not a space in the character stream but are one in the text: a
 * line break, which the device reports by ending a line rather than by writing a
 * character, and a space that some font does have an outline for, which the
 * device reports *and* the SVG draws. The first is added, the second is left to
 * the glyph that already carries it.
 */

/** One character the text device reported, at the origin it starts at. */
export interface TextChar {
  text: string;
  x: number;
  y: number;
  /** Which line of the page it was read on. Consecutive lines are read in order. */
  line: number;
}

/**
 * A space, and where to write it: the origin of the character it precedes.
 *
 * That is the point a space ends at, so it is the position that keeps the
 * character inside the line of the glyph it belongs to - and a space has no ink,
 * so where it is written is the only thing its position can affect. (It matters:
 * a space read on the line *below* the glyph it precedes would otherwise put the
 * element's own box outside the line, and a cropped page measures its lines.)
 *
 * `originX`/`originY` are where the page itself put the space, which is how a
 * space the document draws is told apart from one it only left a gap for. `code`
 * is the character itself: a no-break space is put back as one.
 */
export interface SpaceMark {
  /**
   * `space` for a character the page's own text has, `break` for the one a line
   * break stands for. The difference matters to the caller: a space may already
   * be drawn as a glyph, a break never is.
   */
  kind: 'space' | 'break';
  /**
   * Where the page put the space - how a space the document draws is told apart
   * from one it only left a gap for. Not where the character is written; see
   * below. (A `break` has no such glyph, and the two points coincide.)
   */
  originX: number;
  originY: number;
  /** Where the character is written: the origin of the character it precedes. */
  x: number;
  y: number;
  code: number;
}

/**
 * The Unicode space separators, plus the tab.
 *
 * Only characters that are *spaces*: a line break is where the text device ends
 * a line, not a character with a position, and inserting one into the middle of
 * a run would be a lie about the document. A no-break space is kept as itself -
 * it is a real space for a word segmenter, which is all this has to be.
 */
const SPACE = /[\t\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;

export function isSpaceChar(text: string): boolean {
  return SPACE.test(text);
}

/**
 * Every space in `chars`, each pointing at the character it precedes, plus one
 * for every line break.
 *
 * A run of spaces points at the *same* character: two spaces in a row both sit
 * in front of the next word, and keeping them in order is what makes them come
 * out as two spaces. Trailing whitespace - a space with nothing after it on the
 * page - is dropped: there is no glyph to attach it to, and no text for it to
 * separate.
 *
 * A line break is a space too - the words on either side of it are separate
 * words, and a reader copying the page expects to find them apart. It is only
 * added when the break is what separates them: a line that already ends (or
 * whose successor already starts) with a space is separated once, not twice.
 */
export function spaceMarks(chars: readonly TextChar[]): SpaceMark[] {
  const marks: SpaceMark[] = [];
  let line = -1;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char.line !== line) {
      const before = chars[i - 1];
      if (before && !isSpaceChar(before.text) && !isSpaceChar(char.text)) {
        marks.push({ kind: 'break', originX: char.x, originY: char.y, x: char.x, y: char.y, code: 0x20 });
      }
      line = char.line;
    }
    if (!isSpaceChar(char.text)) continue;

    let j = i;
    while (j < chars.length && isSpaceChar(chars[j].text)) j++;
    const after = chars[j];
    if (!after) break;
    marks.push({
      kind: 'space',
      originX: char.x,
      originY: char.y,
      x: after.x,
      y: after.y,
      code: char.text.codePointAt(0) ?? 0x20,
    });
  }
  return marks;
}
