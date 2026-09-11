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

export interface BionicSegment {
  /** Whether this stretch of text is a word's fixation point. */
  fixation: boolean;
  /** The text itself, exactly as it was given (escaped). */
  text: string;
  /** How many characters it covers: one positioned glyph each. */
  chars: number;
}

/**
 * How much of its strength the rest of a word is drawn at.
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
 * comfortably readable, light enough that the fixation points lead. It is a
 * single number on purpose - anything between about 0.4 and 0.6 reads well, and
 * below 0.3 the remainder starts to look like a printing fault.
 */
export const BIONIC_DIM = 0.5;

const FIXATION = /<b>([\s\S]*?)<\/b>/g;
/** A character reference: one character, however many bytes it takes to write. */
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);/y;

/** Characters, not code units: a character outside the BMP is still one glyph. */
function charCount(text: string): number {
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

/**
 * The text as a run of stretches, each marked as a fixation point or not.
 *
 * Concatenating `text` reproduces the input exactly; `chars` sums to the number
 * of characters in it. The caller checks that sum against the glyphs it has, so
 * a future `text-vide` that marks characters differently degrades to plain text
 * rather than to fixation points in the wrong places.
 */
export function bionicSegments(text: string): BionicSegment[] {
  if (!text) return [];
  const marked = textVide(text);
  const out: BionicSegment[] = [];
  let at = 0;
  FIXATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIXATION.exec(marked))) {
    if (match.index > at) {
      const plain = marked.slice(at, match.index);
      out.push({ fixation: false, text: plain, chars: charCount(plain) });
    }
    out.push({ fixation: true, text: match[1], chars: charCount(match[1]) });
    at = match.index + match[0].length;
  }
  if (at < marked.length) {
    const rest = marked.slice(at);
    out.push({ fixation: false, text: rest, chars: charCount(rest) });
  }
  return out;
}
