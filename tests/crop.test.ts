/**
 * The crop rules, and the box they produce.
 *
 * The reference is PaperCutter's `cutter.py`, and the rules are checked against
 * the strings it names: an arXiv stamp, a publisher's header, a bare page
 * number, a numbered heading. The box itself is checked against a
 * transliteration of the reference `crop_page` - written here line for line as
 * the Python reads, so a restructured port of it can be compared with it rather
 * than with itself.
 *
 * Pure logic and real documents both: the last section measures the corpus
 * through the engine, because whether the plumbing (structured text, the device
 * bbox log, the viewBox) is wired up is not something a unit test can say.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PdfEngine } from '../src/core/engine.ts';
import { CROP_RULES, contentBox, cropRule, cropViewBox, normaliseRules, padBox, quadBox, unionBox, type CropRect, type CropRuleId } from '../src/core/crop.ts';
import { readSvgDimensions } from '../src/core/svg/package.ts';
import { PAPERS } from '../demo/papers.mjs';
import { ensurePapers } from './pdf-cache.mjs';

const rule = (id: CropRuleId) => {
  const found = cropRule(id);
  assert.ok(found, `rule ${id}`);
  return found;
};

/** Everything the rules remove, as `[id, matching text]`, taken from the marks. */
const MARKS: Array<[CropRuleId, string]> = [
  ['arxiv', 'arXiv:1706.03762v7  [cs.CL]  2 Aug 2023'],
  ['conference-header', 'Published as a conference paper at ICLR 2020'],
  ['page-number', '12'],
  ['page-number', '  7\n'],
  ['section-number', '3.1. Encoder and Decoder Stacks'],
  ['section-number', '2.0.'],
  ['chapter', 'CHAPTER 1. Introduction'],
  ['prime-ai', 'PRIME AI paper'],
];

/** Text that looks like a mark but is not one, and must stay in the box. */
const CONTENT = ['arXiv', 'arxiv:1706.03762', '12a', 'Chapter 1. Introduction', 'Published as a conference paper', 'PRIME AI papers', '.5.2'];

test('every rule removes exactly the mark it names', () => {
  for (const [id, text] of MARKS) {
    assert.equal(rule(id).test(text, ''), true, `${id} should match ${JSON.stringify(text)}`);
  }
  for (const text of CONTENT) {
    const matched = CROP_RULES.filter((r) => r.id !== 'title' && r.test(text, '')).map((r) => r.id);
    assert.deepEqual(matched, [], `${JSON.stringify(text)} should be kept`);
  }
});

test('the title rule needs a title, and matches it exactly', () => {
  assert.equal(rule('title').test('Attention Is All You Need', 'Attention Is All You Need'), true);
  assert.equal(rule('title').test('Attention Is All You Need', 'attention is all you need'), false);
  // PaperCutter only installs this filter when it has a title to install.
  assert.equal(rule('title').test('', ''), false);
  assert.equal(rule('title').test('anything', ''), false);
  assert.equal(rule('title').needsTitle, true);
});

test('a selection is normalised: unknown ids out, rule order in', () => {
  assert.deepEqual(normaliseRules(null), []);
  assert.deepEqual(normaliseRules([]), []);
  assert.deepEqual(normaliseRules(['page-number', 'arxiv']), ['arxiv', 'page-number']);
  assert.deepEqual(normaliseRules(['arxiv', 'arxiv']), ['arxiv']);
  assert.deepEqual(normaliseRules(['nonsense' as CropRuleId]), []);
  // Every rule the module publishes is one a caller can select.
  assert.deepEqual(normaliseRules(CROP_RULES.map((r) => r.id)), CROP_RULES.map((r) => r.id));
});

/* --------------------------------------------------------- the box itself */

/**
 * `crop_page` from PaperCutter's `cutter.py`, as literally as it can be written
 * in JavaScript: the same sentinel box, the same clamp, the same containment
 * test, the same 32 units.
 */
function referenceBox(
  spans: ReadonlyArray<{ text: string; box: CropRect }>,
  drawings: readonly CropRect[],
  page: CropRect,
  filters: ReadonlyArray<(s: string) => boolean>,
): CropRect | null {
  const includeBox = (crop: CropRect, b: CropRect) =>
    crop.x <= b.x && crop.y <= b.y && crop.x + crop.width >= b.x + b.width && crop.y + crop.height >= b.y + b.height;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const span of spans) {
    if (filters.some((f) => f(span.text))) continue;
    const b = [span.box.x, span.box.y, span.box.x + span.box.width, span.box.y + span.box.height];
    box[0] = Math.min(box[0], b[0]);
    box[1] = Math.min(box[1], b[1]);
    box[2] = Math.max(box[2], b[2]);
    box[3] = Math.max(box[3], b[3]);
  }
  for (const rect of drawings) {
    if (!includeBox(page, rect)) continue;
    if (!(Math.abs(rect.height) > 32)) continue;
    box[0] = Math.min(box[0], rect.x);
    box[1] = Math.min(box[1], rect.y);
    box[2] = Math.max(box[2], rect.x + rect.width);
    box[3] = Math.max(box[3], rect.y + rect.height);
  }
  box[1] = Math.max(0, box[1]);
  if (box[0] === Infinity) return null;
  // `set_cropbox` intersects with the page, and refuses an empty result.
  const x0 = Math.max(box[0], page.x);
  const y0 = Math.max(box[1], page.y);
  const x1 = Math.min(box[2], page.x + page.width);
  const y1 = Math.min(box[3], page.y + page.height);
  if (x0 >= x1 || y0 >= y1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const PAGE: CropRect = { x: 0, y: 0, width: 612, height: 792 };

/** A page with a stamp in the margin, a footer, and a figure. */
const SPANS = [
  { text: 'arXiv:1706.03762v7  [cs.CL]  2 Aug 2023', box: { x: 11, y: 224, width: 0, height: 322 } },
  { text: 'Attention Is All You Need', box: { x: 124, y: 73, width: 363, height: 24 } },
  { text: 'The dominant sequence transduction models', box: { x: 124, y: 300, width: 363, height: 60 } },
  { text: '3.1. Encoder and Decoder Stacks', box: { x: 124, y: 420, width: 200, height: 12 } },
  { text: '12', box: { x: 300, y: 744, width: 12, height: 10 } },
];
const DRAWINGS: CropRect[] = [
  { x: 124, y: 100, width: 363, height: 40 }, // a figure, tall enough to keep
  { x: 124, y: 200, width: 363, height: 2 }, // a hairline, too short to keep
  { x: 0, y: 0, width: 612, height: 792 }, // the page itself, as a background fill
];

test('the box is the content, and agrees with the reference script', () => {
  const ported = contentBox({ spans: SPANS, drawings: DRAWINGS, page: PAGE, rules: ['page-number'] });
  const pasted = referenceBox(SPANS, DRAWINGS, PAGE, [(s: string) => /^[0-9]+$/.test(s.trim())]);
  assert.deepEqual(ported, pasted);
  // The page-sized background fill is inside the page, and 792 tall: the
  // reference keeps it, and so the box is the whole page. That is `include_box`
  // being inclusive, not a bug in the port.
  assert.deepEqual(ported, { x: 0, y: 0, width: 612, height: 792 });

  // Without it, the box is the content: the stamp sets the left edge, the
  // figure the top, and the footer the bottom until its rule is on.
  const rest = DRAWINGS.filter((d) => d.height < 700);
  const withStamp = contentBox({ spans: SPANS, drawings: rest, page: PAGE, rules: ['title'] });
  assert.deepEqual(withStamp, referenceBox(SPANS, rest, PAGE, []));
  assert.deepEqual(withStamp, { x: 11, y: 73, width: 476, height: 681 });

  const without = contentBox({ spans: SPANS, drawings: rest, page: PAGE, rules: ['arxiv', 'page-number', 'section-number'] });
  assert.deepEqual(without, referenceBox(SPANS, rest, PAGE, [(s) => s.startsWith('arXiv:'), (s) => /^[0-9]+$/.test(s.trim()), (s) => /^[0-9]\.[0-9]\./.test(s)]));
  assert.deepEqual(without, { x: 124, y: 73, width: 363, height: 287 });
});

test('the rules agree with the reference on every subset', () => {
  const rest = DRAWINGS.filter((d) => d.height < 700);
  const ids: CropRuleId[] = ['arxiv', 'conference-header', 'page-number', 'section-number', 'chapter', 'prime-ai'];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const rules = ids.filter((_, i) => mask & (1 << i));
    const selected = new Set(rules);
    const pasted = referenceBox(
      SPANS,
      rest,
      PAGE,
      CROP_RULES.filter((r) => selected.has(r.id)).map((r) => (s: string) => r.test(s, '')),
    );
    assert.deepEqual(contentBox({ spans: SPANS, drawings: rest, page: PAGE, rules }), pasted, rules.join('+'));
  }
  // ...and one page-sized fill is all it takes to leave the page alone.
  assert.deepEqual(contentBox({ spans: SPANS, drawings: DRAWINGS, page: PAGE, rules: ids }), referenceBox(SPANS, DRAWINGS, PAGE, []));
});

test('nothing selected is no crop, and the top of the box is clamped to the page', () => {
  assert.equal(contentBox({ spans: SPANS, drawings: DRAWINGS, page: PAGE, rules: [] }), null);
  // A span that starts in the trim area is cut at the top of the page rather
  // than pulling the box above it (`box[1] = max(0, box[1])`).
  const straddling = [{ text: 'header', box: { x: 20, y: -10, width: 100, height: 40 } }];
  assert.deepEqual(contentBox({ spans: straddling, drawings: [], page: PAGE, rules: ['page-number'] }), {
    x: 20,
    y: 0,
    width: 100,
    height: 30,
  });
  // A span wholly above the page clamps to an inverted rectangle, which is what
  // `set_cropbox` refuses in the reference script - caught there, and "no crop"
  // here, so the page is left exactly as it is either way.
  const above = [{ text: 'header', box: { x: 20, y: -40, width: 100, height: 20 } }];
  assert.equal(contentBox({ spans: above, drawings: [], page: PAGE, rules: ['page-number'] }), null);
  // A page with nothing on it has nothing to crop to.
  assert.equal(contentBox({ spans: [], drawings: [], page: PAGE, rules: ['arxiv'] }), null);
});

test('padding grows the box on every side, and the page stops it', () => {
  const box: CropRect = { x: 100, y: 100, width: 200, height: 400 };
  const page: CropRect = { x: 0, y: 0, width: 612, height: 792 };
  assert.deepEqual(padBox(box, 0, page), box);
  assert.deepEqual(padBox(box, 6, page), { x: 94, y: 94, width: 212, height: 412 });
  // A crop box cannot be larger than the page it is cutting.
  assert.deepEqual(padBox({ x: 20, y: 20, width: 572, height: 752 }, 40, page), page);
  // Nothing sensible to add, nothing added.
  assert.deepEqual(padBox(box, -5, page), box);
  assert.deepEqual(padBox(box, Number.NaN, page), box);
});

test('a character box comes from all four corners of its quad', () => {
  // `ul, ur, ll, lr`, as MuPDF reports them.
  assert.deepEqual(quadBox([10, 20, 18, 20, 10, 28, 18, 28]), { x: 10, y: 20, width: 8, height: 8 });
  // Set sideways - an arXiv stamp in a margin - the corners share no axis with
  // the page, and reading only the first two would collapse it to a line.
  assert.deepEqual(quadBox([100, 200, 100, 260, 92, 200, 92, 260]), { x: 92, y: 200, width: 8, height: 60 });
  // Which is the shape of the bug this exists to prevent: a span with no height
  // puts the bottom of the box at the *top* of the last line, and the crop then
  // slices that line in half.
  assert.equal(quadBox([10, 20, 18, 20, 10, 28, 18, 28]).height > 0, true);
  assert.deepEqual(unionBox({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 4 }), { x: 0, y: -5, width: 15, height: 15 });
});

test('a viewBox is written compactly and exactly', () => {
  assert.equal(cropViewBox({ x: 0, y: 0, width: 612, height: 792 }), '0 0 612 792');
  assert.equal(cropViewBox({ x: 107.64099884033203, y: 73.71392822265625, width: 398.10216522216797, height: 639.5314331054688 }), '107.641 73.714 398.102 639.531');
});

/* ------------------------------------------------------ through the engine */

const paper = PAPERS[0];
const files = await ensurePapers([paper.url]);
const file = files.get(paper.url);
const bytes = file instanceof Error || !file ? null : new Uint8Array(fs.readFileSync(file));

test('the engine measures a real page, and crops only the viewBox', { skip: bytes ? false : 'no cached paper' }, async () => {
  assert.ok(bytes);
  const engine = new PdfEngine();
  try {
    const info = await engine.open(bytes);
    assert.ok(info.pageCount > 2);
    const all = CROP_RULES.map((r) => r.id);
    const page = 2;
    const box = await engine.measureCrop(page - 1, all);
    assert.ok(box, 'a page of text has a content box');
    // Inside the page, and narrower than it: this paper has a wide margin.
    assert.ok(box.x > 0 && box.y >= 0);
    assert.ok(box.x + box.width <= info.pages[page - 1].width + 1e-6);
    assert.ok(box.width < info.pages[page - 1].width);
    // Asking again is answered from the cache, and answers the same thing.
    assert.deepEqual(await engine.measureCrop(page - 1, all), box);
    // The rule that removes the page number is the one that moves the bottom.
    const numbered = await engine.measureCrop(page - 1, all.filter((id) => id !== 'page-number'));
    assert.ok(numbered && numbered.height !== box.height, 'the page number extends the box');

    const plain = await engine.renderPage(page - 1, { textMode: 'auto' });
    const cropped = await engine.renderPage(page - 1, { textMode: 'auto', crop: all });
    assert.equal(plain.crop, null);
    assert.deepEqual(cropped.crop, box);
    // The whole point: a crop is a window, not an edit. Same elements, same
    // text, a different viewBox.
    const shape = (svg: string) => ({
      elements: svg.match(/<(path|use|image|text|g|rect)\b/g)?.length ?? 0,
      texts: svg.match(/<text\b/g)?.length ?? 0,
    });
    assert.deepEqual(shape(cropped.svg), shape(plain.svg));
    assert.equal(readSvgDimensions(plain.svg)?.viewBox, `0 0 ${info.pages[page - 1].width} ${info.pages[page - 1].height}`);
    assert.equal(readSvgDimensions(cropped.svg)?.viewBox, cropViewBox(box));
    assert.equal(cropped.width, Math.round(box.width * 1000) / 1000);
    // Padding grows the box the SVG is given, and changes nothing about the
    // measurement it came from: that is what makes the field in the demo cheap.
    const padded = await engine.renderPage(page - 1, { textMode: 'auto', crop: all, cropPadding: 6 });
    assert.deepEqual(padded.crop, { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 });
    assert.equal(readSvgDimensions(padded.svg)?.viewBox, cropViewBox(padded.crop!));
    assert.deepEqual(await engine.measureCrop(page - 1, all), box);
    // No rules, no crop.
    assert.equal(await engine.measureCrop(page - 1, []), null);
    assert.equal((await engine.renderPage(page - 1, { textMode: 'auto', crop: [] })).crop, null);
  } finally {
    engine.close();
  }
});
