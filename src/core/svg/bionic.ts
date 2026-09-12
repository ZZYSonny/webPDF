/**
 * Bionic reading, from the `text-vide` package.
 *
 * The method gives every word a *fixation point* - its first letters, so the eye
 * has somewhere to land and the brain finishes the word on its own. `text-vide`
 * decides how many letters that is (a table indexed by word length, which is why
 * the answer is not simply "the first three") and returns the text with `<b>`
 * tags around each one.
 *
 * What comes back is markup, and markup cannot be dropped into an SVG `<text>`:
 * inside foreign content the HTML parser treats `<b>` as a breakout tag, and in
 * SVG 1.1 an element it does not know is not rendered at all. So the tags are
 * used as what they are - a record of where the fixation points are - and read
 * back out here as segments. A segment carries one more thing the markup cannot:
 * how many *characters* of the run it accounts for, because the caller has one
 * positioned glyph per character and has to slice them to match. Escaped
 * entities count as one character (`&amp;` is a single `&` glyph), which is the
 * same way the SVG itself counts them.
 *
 * The text handed in must already be escaped: `text-vide` skips HTML entities
 * when it looks for words (its own `ignoreHtmlEntity`), so escaping first is
 * what keeps `&amp;` from being read as the word "amp" and torn apart.
 */

import { textVide } from 'text-vide';
import { LIGATURE_LETTERS } from './ligatures.ts';

export interface BionicSegment {
  /** Whether this stretch of text is a word's fixation point. */
  fixation: boolean;
  /** The text itself, exactly as it was given (escaped). */
  text: string;
  /** How many characters it covers: one positioned glyph each. */
  chars: number;
}

/**
 * How much of its strength the rest of a word is drawn at, by default.
 *
 * The fixation points are the text as the document set it and everything around
 * them is faded, rather than the fixation points being emboldened: these fonts
 * are rebuilt from the page's own outlines and have one weight, so `bold` is the
 * browser's synthetic emboldening, which smears the letterforms of a text face
 * and crowds the letter after the last bold one. Fading costs nothing, works on
 * any colour of text (it is an opacity, not a grey), and leaves the glyphs
 * themselves untouched.
 *
 * A half is the balance the eye wants: dark enough that the whole word is still
 * comfortably readable, light enough that the fixation points lead. How much of
 * a word is held is a matter of taste and of eyesight, so it is a setting
 * (`bionicDim` on the render options, `PdfViewer.setBionic`) rather than a
 * constant - but it is a *fade*, and a fade has to leave something of the word:
 * below about 0.2 the remainder reads as a printing fault, and at 1 nothing is
 * faded at all.
 */
export const BIONIC_DIM = 0.5;

/** The faintest a word's remainder may be drawn: any less and it is not there. */
export const BIONIC_MIN_DIM = 0.05;

/**
 * The dim actually used to draw a page: the caller's number when it is one, and
 * the default when it is not. Clamped rather than rejected - a host offering a
 * slider cannot send a page to opacity 0 by accident.
 */
export function bionicDim(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return BIONIC_DIM;
  return Math.min(1, Math.max(BIONIC_MIN_DIM, value));
}

const FIXATION = /<b>([\s\S]*?)<\/b>/g;
/** A character reference: one character, however many bytes it takes to write. */
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);/y;

/** Characters, not code units: a character outside the BMP is still one glyph. */
export function charCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; ) {
    ENTITY.lastIndex = i;
    const entity = ENTITY.exec(text);
    if (entity) {
      i = ENTITY.lastIndex;
      n++;
      continue;
    }
    const code = text.codePointAt(i) ?? 0;
    i += code > 0xffff ? 2 : 1;
    n++;
  }
  return n;
}

/** Where one character of the input sits in it. */
interface Bounds {
  start: number;
  end: number;
}

interface SpelledOut {
  /** The text with every ligature spelled out, ready for `text-vide`. */
  marked: string;
  /** For every character of the input, where it starts and ends in the input. */
  bounds: Bounds[];
  /** For every character of `marked`, which character of the input it is. */
  owner: number[];
}

/** The text with every ligature spelled out, and the input behind each character. */
function spellOut(text: string): SpelledOut {
  let marked = '';
  const bounds: Bounds[] = [];
  const owner: number[] = [];
  for (let i = 0; i < text.length; ) {
    const at = bounds.length;
    ENTITY.lastIndex = i;
    const entity = ENTITY.exec(text);
    const code = entity ? 0 : (text.codePointAt(i) ?? 0);
    const end = entity ? ENTITY.lastIndex : i + (code > 0xffff ? 2 : 1);
    const letters = entity ? undefined : LIGATURE_LETTERS.get(code);
    const written = letters ?? text.slice(i, end);
    marked += written;
    bounds.push({ start: i, end });
    // A ligature writes two characters for the one it is, everything else one.
    for (let k = 0; k < (letters ? letters.length : 1); k++) owner.push(at);
    i = end;
  }
  return { marked, bounds, owner };
}

/**
 * The text as a run of stretches, each marked as a fixation point or not.
 *
 * Concatenating `text` reproduces the input exactly; `chars` sums to the number
 * of characters in it. The caller checks that sum against the glyphs it has, so
 * a future `text-vide` that marks characters differently degrades to plain text
 * rather than to fixation points in the wrong places.
 *
 * A ligature is spelled out before the words are looked for - the one glyph a
 * typesetter drew for "fi" is two letters to a reader, and how many letters a
 * word has is how `text-vide` decides how much of it to mark. The marks are then
 * read back onto the characters that are really there, and a glyph the fixation
 * reaches into is marked whole: it is one outline and cannot be drawn half dark.
 */
export function bionicSegments(text: string): BionicSegment[] {
  if (!text) return [];
  const { marked, bounds, owner } = spellOut(text);
  const fixed: boolean[] = new Array<boolean>(bounds.length).fill(false);

  // The marks arrive in the order of the characters they cover, so one cursor
  // walks them: the stretch `text-vide` wrote is a run of characters of the
  // spelled-out text, and `owner` says which character of the input each is.
  let at = 0;
  const mark = (stretch: string, fixation: boolean): void => {
    for (let i = 0; i < charCount(stretch) && at < owner.length; i++, at++) {
      if (fixation) fixed[owner[at]] = true;
    }
  };

  const markup = textVide(marked);
  let cursor = 0;
  FIXATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIXATION.exec(markup))) {
    mark(markup.slice(cursor, match.index), false);
    mark(match[1], true);
    cursor = match.index + match[0].length;
  }
  mark(markup.slice(cursor), false);

  const out: BionicSegment[] = [];
  let i = 0;
  while (i < fixed.length) {
    let j = i;
    while (j < fixed.length && fixed[j] === fixed[i]) j++;
    out.push({ fixation: fixed[i], text: text.slice(bounds[i].start, bounds[j - 1].end), chars: j - i });
    i = j;
  }
  return out;
}
