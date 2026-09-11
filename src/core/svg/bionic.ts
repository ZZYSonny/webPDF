/**
 * Bionic reading, from the `text-vide` package.
 *
 * The method bolds the first letters of each word so the eye has somewhere to
 * land and the brain finishes the word on its own. `text-vide` decides how many
 * letters that is - a table indexed by word length, which is why the answer is
 * not simply "the first three" - and returns the text with `<b>` tags around
 * each fixation point.
 *
 * What comes back is markup, and markup cannot be dropped into an SVG `<text>`:
 * inside foreign content the HTML parser treats `<b>` as a breakout tag, and in
 * SVG 1.1 an element it does not know is not rendered at all. So the tags are
 * used as what they are - a record of which characters are bold - and read back
 * out here as segments. A segment carries one more thing the markup cannot: how
 * many *characters* of the run it accounts for, because the caller has one
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
  /** Whether this stretch of text is a fixation point. */
  bold: boolean;
  /** The text itself, exactly as it was given (escaped). */
  text: string;
  /** How many characters it covers: one positioned glyph each. */
  chars: number;
}

const BOLD = /<b>([\s\S]*?)<\/b>/g;
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
 * The text as a run of plain and bold stretches, in order.
 *
 * Concatenating `text` reproduces the input exactly; `chars` sums to the number
 * of characters in it. The caller checks that sum against the glyphs it has, so
 * a future `text-vide` that marks characters differently degrades to plain text
 * rather than to bold in the wrong places.
 */
export function bionicSegments(text: string): BionicSegment[] {
  if (!text) return [];
  const marked = textVide(text);
  const out: BionicSegment[] = [];
  let at = 0;
  BOLD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOLD.exec(marked))) {
    if (match.index > at) {
      const plain = marked.slice(at, match.index);
      out.push({ bold: false, text: plain, chars: charCount(plain) });
    }
    out.push({ bold: true, text: match[1], chars: charCount(match[1]) });
    at = match.index + match[0].length;
  }
  if (at < marked.length) {
    const rest = marked.slice(at);
    out.push({ bold: false, text: rest, chars: charCount(rest) });
  }
  return out;
}
