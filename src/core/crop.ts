/**
 * Cropping a page to its content, with the rules PaperCutter uses.
 *
 * The idea is the one a print shop means by "trim to the type": every page is
 * reduced to the bounding box of what is actually on it, so a PDF whose pages
 * carry two inches of blank margin can be read (or printed) without it. The
 * rules exist because some marks on a page are not content - a publisher's
 * footer, an arXiv stamp in the margin, a bare page number - and a box built
 * from *everything* would keep the margins that exist only to hold them.
 *
 * Ported from PaperCutter's `cutter.py`, which is the reference for both the
 * boxes and the rules; each rule below says which line of it it came from. Two
 * details of that script are deliberately kept because they are what it does,
 * not because they are obviously right:
 *
 *  - a drawing counts only when it is *fully inside* the page box and more than
 *    `MIN_DRAWING_HEIGHT` tall, so a rule or a figcaption frame is kept and a
 *    hairline is not;
 *  - the top of the box is clamped to the page (`box[1] = max(0, box[1])`),
 *    which is what stops a mark in the trim area from pulling it upwards.
 *
 * Nothing here touches a document. It maps spans and drawing boxes to one box,
 * which the renderer then uses as the page's `viewBox` - a crop in the PDF
 * sense, a smaller window onto the same page, never a deletion of the marks
 * outside it.
 */

/** A rectangle in page units, with the page's own origin (points, y down). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A text run as the extractor reports it: the string, and where it sits. */
export interface CropSpan {
  text: string;
  box: CropRect;
}

/**
 * Drawings taller than this are kept whatever they contain: a table rule, a
 * figure, a shaded panel. `32` is PaperCutter's number, in page units.
 */
export const MIN_DRAWING_HEIGHT = 32;

export type CropRuleId = 'arxiv' | 'conference-header' | 'page-number' | 'section-number' | 'chapter' | 'prime-ai' | 'title';

export interface CropRule {
  id: CropRuleId;
  /** What the UI calls it. */
  label: string;
  /** The mark it removes, in a few words, for the second line of a menu row. */
  hint: string;
  /** The test itself, as PaperCutter writes it - shown so nothing is a guess. */
  source: string;
  /** True when the rule can only work with the document's own title. */
  needsTitle?: boolean;
  /** Does this span carry the mark the rule removes? */
  test(text: string, title: string): boolean;
}

/**
 * PaperCutter's filter list, in its order, plus the title filter it installs
 * per document (`common_filter_function`). A span matching any enabled rule is
 * left out of the content box.
 */
export const CROP_RULES: readonly CropRule[] = [
  {
    id: 'arxiv',
    label: 'arXiv stamp',
    hint: 'the identifier arXiv prints in the left margin',
    source: 's.startswith("arXiv:")',
    test: (s) => s.startsWith('arXiv:'),
  },
  {
    id: 'conference-header',
    label: 'Conference header',
    hint: 'the publisher’s line across the top',
    source: 's.startswith("Published as a conference paper at")',
    test: (s) => s.startsWith('Published as a conference paper at'),
  },
  {
    id: 'page-number',
    label: 'Page number',
    hint: 'a span that is nothing but digits',
    source: 's.lstrip().rstrip().isdigit()',
    // Python's `isdigit()` also accepts non-ASCII digits; the port keeps to
    // ASCII, which is what a numbered page is actually set in.
    test: (s) => /^[0-9]+$/.test(s.trim()),
  },
  {
    id: 'section-number',
    label: 'Section number',
    hint: 'a heading that opens with “3.1.”',
    source: 're.match("[0-9]\\\\.[0-9]\\\\.", s)',
    test: (s) => /^[0-9]\.[0-9]\./.test(s),
  },
  {
    id: 'chapter',
    label: 'Chapter heading',
    hint: 'a heading that opens with “CHAPTER 1.”',
    source: 're.match("CHAPTER [0-9]\\\\.", s)',
    test: (s) => /^CHAPTER [0-9]\./.test(s),
  },
  {
    id: 'prime-ai',
    label: 'PRIME AI watermark',
    hint: 'the line “PRIME AI paper”',
    source: 's == "PRIME AI paper"',
    test: (s) => s === 'PRIME AI paper',
  },
  {
    id: 'title',
    label: 'Running title',
    hint: 'the document’s own title, repeated as a header',
    source: 's == title  (common_filter_function)',
    needsTitle: true,
    // No title, no match: PaperCutter only installs this filter when it has one.
    test: (s, title) => title !== '' && s === title,
  },
];

const BY_ID = new Map<string, CropRule>(CROP_RULES.map((rule) => [rule.id, rule]));

/** The rule with this id, or null - ids can arrive from a host or a URL. */
export function cropRule(id: string): CropRule | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The selection a caller asked for, in the order the rules are declared:
 * unknown ids dropped, duplicates collapsed. `null` and `[]` both mean "crop
 * nothing", which is the state a page opens in.
 */
export function normaliseRules(rules: readonly CropRuleId[] | null | undefined): CropRuleId[] {
  if (!rules || rules.length === 0) return [];
  const wanted = new Set<string>(rules);
  return CROP_RULES.filter((rule) => wanted.has(rule.id)).map((rule) => rule.id);
}

/** True when this span carries one of the selected marks. */
function filtered(text: string, rules: readonly CropRule[], title: string): boolean {
  return rules.some((rule) => rule.test(text, title));
}

function isEmpty(box: [number, number, number, number]): boolean {
  return box[0] > box[2] || box[1] > box[3];
}

/** Is `inner` wholly inside `outer`? PaperCutter's `include_box`. */
function contains(outer: CropRect, inner: CropRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

export interface CropInput {
  /** Every text run on the page, in reading order. */
  spans: readonly CropSpan[];
  /** Boxes of the page's fill/stroke/image/shade operations. */
  drawings: readonly CropRect[];
  /** The page's own box: what drawings must fit inside, and the outer limit. */
  page: CropRect;
  /** The document's title, for the rule that needs one. */
  title?: string;
  /** The selected rules. Empty means no crop at all. */
  rules: readonly CropRuleId[];
}

/**
 * The content box of one page, or null when there is nothing to crop to.
 *
 * This is PaperCutter's `crop_page` up to the `set_cropbox` call: the union of
 * the spans no rule removes and the drawings big enough to be content, with the
 * top clamped to the page and the whole thing intersected with it (`set_cropbox`
 * does that intersection itself, and a page cannot be cropped outside itself).
 */
export function contentBox(input: CropInput): CropRect | null {
  const rules = CROP_RULES.filter((rule) => input.rules.includes(rule.id));
  if (rules.length === 0) return null;
  const title = input.title ?? '';

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const union = (box: CropRect): void => {
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.width);
    y1 = Math.max(y1, box.y + box.height);
  };

  for (const span of input.spans) {
    if (span.text === '' || filtered(span.text, rules, title)) continue;
    union(span.box);
  }
  for (const rect of input.drawings) {
    if (rect.height <= MIN_DRAWING_HEIGHT) continue;
    if (!contains(input.page, rect)) continue;
    union(rect);
  }

  if (isEmpty([x0, y0, x1, y1])) return null;
  const top = Math.max(0, y0);
  // Intersected with the page, exactly as `set_cropbox` would.
  const left = Math.max(x0, input.page.x);
  const right = Math.min(x1, input.page.x + input.page.width);
  const bottom = Math.min(y1, input.page.y + input.page.height);
  if (left >= right || top >= bottom) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The `viewBox` a crop turns into: a window onto the page, not a new page. */
export function cropViewBox(box: CropRect): string {
  return `${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}`;
}

/**
 * Grow a box by `padding` on every side, stopped by the page.
 *
 * The reference script crops to the content exactly, which on a page whose text
 * reaches the trim is a box with no room to breathe - and a crop box cannot be
 * larger than the page it is cutting, so the page is the outer limit.
 */
export function padBox(box: CropRect, padding: number, page?: CropRect): CropRect {
  if (!Number.isFinite(padding) || padding <= 0) return box;
  const x = Math.max(page ? page.x : -Infinity, box.x - padding);
  const y = Math.max(page ? page.y : -Infinity, box.y - padding);
  const right = Math.min(page ? page.x + page.width : Infinity, box.x + box.width + padding);
  const bottom = Math.min(page ? page.y + page.height : Infinity, box.y + box.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The box a character occupies, from its quad.
 *
 * MuPDF reports a quad as four corners - upper-left, upper-right, lower-left,
 * lower-right, eight numbers in all - and not as a rectangle: a glyph set
 * sideways, like the arXiv stamp in a margin, has corners that share no axis
 * with the page. All four have to be folded in. Reading only the first two
 * leaves every span a zero-height line at the top of its glyphs, and a box
 * built from those cuts the bottom line off the page - the one mistake here
 * that damages a document instead of merely failing to trim it.
 */
export function quadBox(quad: readonly number[]): CropRect {
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter(Number.isFinite);
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter(Number.isFinite);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The smallest box holding both. */
export function unionBox(a: CropRect, b: CropRect): CropRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Three decimals, trailing zeros dropped: enough for a point, short in markup. */
function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
