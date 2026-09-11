/**
 * Rewrite MuPDF's outline glyphs back into `<text>`.
 *
 * MuPDF's SVG device can emit text two ways: as `<text>` (cheap and crisp, but
 * only correct when the browser actually has a matching font) or as `<use>`
 * references to glyph outlines (always correct, but the page becomes a soup of
 * paths: no selection, no hinting, huge files).
 *
 * We render every page in outline mode - guaranteeing a correct baseline - and
 * then rewrite the glyph runs we can *prove* we have a font for into `<text>`.
 * Because the replacement is derived from the same outlines that were going to
 * be drawn, the visual result is identical. Anything we are unsure about is
 * left untouched.
 *
 * The transform maths: an outline is placed with
 *
 *   <use transform="matrix(a b c d e f)"/>   applying to y-up em-unit outlines
 *
 * An equivalent `<text>` at font-size K uses a y-down text space, so
 *
 *   A = a/K, B = b/K, C = -c/K, D = -d/K, K = sqrt(|ad - bc|)
 *   (X, Y) = [A C; B D]^-1 (e, f)      - the per-character baseline origin
 *
 * Two things are put back at this point rather than later, because this is where
 * a glyph is still a glyph with a position rather than a character in a string:
 * the spaces the outline device could not draw (`spaces.ts`), and the fixation
 * points bionic reading is made of (`bionic.ts`).
 */

import type { GlyphPlacement, Attribute } from './glyphs.ts';
import { ANCHOR_EPSILON, type SpaceMark } from './spaces.ts';
import { bionicDim, bionicSegments } from './bionic.ts';

export interface GlyphEncoding {
  /**
   * Code point to emit for this glyph, or null to leave it as an outline.
   * Returning a code point is a promise that the produced font maps it to a
   * glyph with the same outline.
   */
  codeFor(fontId: number, gid: number): number | null;
  /** Family name to use for a font id, or null to leave it as outlines. */
  familyFor(fontId: number): string | null;
}

export interface UpgradeOptions {
  /** Skip glyphs whose text would need bidi or complex shaping. */
  simpleTextOnly?: boolean;
  /** Drop `<defs>` entries that are no longer referenced. */
  pruneUnusedOutlines?: boolean;
  /** Add text-rendering hints that favour geometric accuracy. */
  preciseTextRendering?: boolean;
  /**
   * Spaces to write back into the text, each in front of the glyph its next
   * character became (see `spaces.ts`). Without them the runs are the words run
   * together, because that is what the outline device drew.
   */
  spaces?: readonly SpaceMark[];
  /**
   * Bionic reading: keep every word's first letters at full strength and fade
   * the rest, so the eye has somewhere to land.
   */
  bionic?: boolean;
  /**
   * How much strength the faded part of a word keeps, 0..1. `BIONIC_DIM` (a
   * half) when omitted; only meaningful while `bionic` is on.
   */
  bionicDim?: number;
}

export interface UpgradeStats {
  runs: number;
  converted: number;
  kept: number;
  /** Space characters written back into the text. */
  spaces: number;
}

export interface UpgradeResult {
  svg: string;
  stats: UpgradeStats;
}

/**
 * Ranges where a browser may reorder or reshape characters, which would break
 * MuPDF's already-resolved glyph positioning. Everything else (Latin, Greek,
 * Cyrillic, CJK, punctuation, Private Use Area) is safe to hand to the text
 * engine one code point per positioned glyph.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0590, 0x08ff], // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic
  [0x0900, 0x0dff], // Indic scripts
  [0x0e00, 0x0fff], // Thai, Lao, Tibetan
  [0x1000, 0x109f], // Myanmar
  [0x1100, 0x11ff], // Hangul Jamo (needs composition)
  [0x1780, 0x17ff], // Khmer
  [0x1900, 0x19ff], // Limbu, New Tai Lue
  [0x1a00, 0x1cff], // Buginese .. Lepcha
  [0xa800, 0xabff], // Syloti Nagri .. Meetei Mayek
  [0xfb1d, 0xfdff], // Hebrew/Arabic presentation forms
  [0xfe70, 0xfeff], // Arabic presentation forms B
  [0x10800, 0x11fff], // historic RTL and Indic scripts
  [0x1e800, 0x1efff], // Mende Kikakui, Adlam
];

export function isSimpleCode(code: number): boolean {
  for (const [lo, hi] of UNSAFE_RANGES) {
    if (code >= lo && code <= hi) return false;
  }
  return true;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const r = Number(n.toFixed(6));
  if (Number.isInteger(r)) return String(r);
  return String(r);
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function serializeAttrs(attrs: readonly Attribute[]): string {
  let s = '';
  for (const a of attrs) s += ` ${a.name}="${a.value}"`;
  return s;
}

function sameLinear(m: { a: number; b: number; c: number; d: number }, n: GlyphPlacement['matrix']): boolean {
  return m.a === n.a && m.b === n.b && m.c === n.c && m.d === n.d;
}

interface Run {
  fontId: number;
  family: string;
  matrix: { a: number; b: number; c: number; d: number };
  attrs: string;
  items: RunItem[];
  source: string;
}

/** A glyph that will be written as text: the font to use, and its character. */
interface ReadyGlyph {
  family: string;
  code: number;
}

interface RunItem {
  x: number;
  y: number;
  code: number;
  /** -1 for a character written back rather than drawn. */
  gid: number;
  /** A space: it has a position but no glyph of its own. */
  synthetic?: boolean;
}

/** True when the placement carries a stroke; those stay as outlines. */
function hasStroke(attrs: readonly Attribute[]): boolean {
  for (const a of attrs) {
    if ((a.name === 'stroke' && a.value !== 'none') || a.name === 'stroke-width') return true;
  }
  return false;
}

/**
 * Which glyph each space goes in front of.
 *
 * A space ends exactly where the next character begins, and the text device
 * reports that character's origin, so a space is matched to the *placement* with
 * that origin. The placements are bucketed on a grid the size of the tolerance,
 * because a page has thousands of them and a document has thousands of spaces,
 * and comparing every pair would be the only slow part of a page render.
 *
 * A space the page draws itself - some fonts do give one an outline - is already
 * in the SVG as a glyph, and writing the character a second time would double
 * it. That holds as long as the glyph becomes text: a drawn space that stays an
 * outline has no character anywhere, so its mark is kept and written in front of
 * the next glyph like any other. (This is not hypothetical: a figure set in Type
 * 3 fonts draws its spaces with a glyph that has no outline to rebuild, and the
 * words of its labels would otherwise arrive glued together.)
 *
 * A space whose next character is not in the SVG at all (it stayed an outline,
 * or it is trailing whitespace with nothing after it) has nothing to sit in
 * front of, and is dropped.
 */
function anchorSpaces(
  placements: readonly GlyphPlacement[],
  marks: readonly SpaceMark[],
  ready: ReadonlyArray<ReadyGlyph | null>,
): Map<number, SpaceMark[]> {
  const out = new Map<number, SpaceMark[]>();
  if (marks.length === 0) return out;

  const cell = (v: number): number => Math.round(v / ANCHOR_EPSILON);
  const grid = new Map<string, number[]>();
  placements.forEach((p, index) => {
    const key = `${cell(p.matrix.e)},${cell(p.matrix.f)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  });

  /** The placement starting at this point, if there is one. */
  const at = (x: number, y: number): number => {
    const cx = cell(x);
    const cy = cell(y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const index of bucket) {
          const p = placements[index];
          if (Math.abs(p.matrix.e - x) <= ANCHOR_EPSILON && Math.abs(p.matrix.f - y) <= ANCHOR_EPSILON) return index;
        }
      }
    }
    return -1;
  };

  for (const mark of marks) {
    if (mark.kind === 'space') {
      const drawn = at(mark.originX, mark.originY);
      if (drawn >= 0 && ready[drawn] !== null) continue;
    }
    const index = at(mark.x, mark.y);
    if (index < 0) continue;
    const bucket = out.get(index);
    if (bucket) bucket.push(mark);
    else out.set(index, [mark]);
  }
  return out;
}

/**
 * The `<tspan>`s a run's characters go in.
 *
 * Normally one, with every position in a single list. With bionic reading on,
 * one per stretch `text-vide` marked: the fixation points stay the text as the
 * document set it, and everything between them is drawn back at a reduced
 * opacity (`bionic.ts` says why fading rather than bolding, and how faint a
 * fade can usefully be). Either way each tspan carries its own slice of the
 * position lists, so a character is drawn exactly where it was - nothing is
 * emboldened into its neighbour, and nothing moves.
 */
function tspans(
  chars: readonly string[],
  xs: readonly string[],
  ys: readonly string[],
  bionic: boolean,
  dim: number,
): string {
  const whole = (): string => `<tspan x="${xs.join(' ')}" y="${ys.join(' ')}">${chars.join('')}</tspan>`;
  if (!bionic) return whole();

  const segments = bionicSegments(chars.join(''));
  // The segments have to account for every glyph exactly once. `text-vide`
  // decides where the words are and this decides where the glyphs are; if the
  // two ever disagree - a release with different word rules, a character it
  // reads as markup - the run is written plain, which is right, rather than
  // faded in the wrong places, which is not.
  if (segments.reduce((n, s) => n + s.chars, 0) !== chars.length) return whole();

  let at = 0;
  let out = '';
  for (const segment of segments) {
    const end = at + segment.chars;
    if (end > at) {
      // A stretch of nothing but whitespace is between two words rather than in
      // one: fading it would be an attribute that draws no pixel.
      const fade = !segment.fixation && segment.text.trim() !== '';
      out +=
        `<tspan${fade ? ` fill-opacity="${String(dim)}"` : ''}` +
        ` x="${xs.slice(at, end).join(' ')}" y="${ys.slice(at, end).join(' ')}">${segment.text}</tspan>`;
    }
    at = end;
  }
  return out;
}

export function upgradeGlyphsToText(
  svg: string,
  placements: readonly GlyphPlacement[],
  enc: GlyphEncoding,
  opts: UpgradeOptions = {},
): UpgradeResult {
  const simpleOnly = opts.simpleTextOnly ?? true;
  const precise = opts.preciseTextRendering ?? true;
  const bionic = opts.bionic ?? false;
  const dim = bionicDim(opts.bionicDim);

  // What each placement is going to become, decided before anything is written
  // because the spaces depend on it: a space the page drew is already text only
  // if the glyph it drew it with becomes text too.
  const ready: Array<ReadyGlyph | null> = placements.map((p): ReadyGlyph | null => {
    if (hasStroke(p.attrs)) return null;
    const family = enc.familyFor(p.fontId);
    if (!family) return null;
    const code = enc.codeFor(p.fontId, p.gid);
    if (code === null || code <= 0) return null;
    if (simpleOnly && !isSimpleCode(code)) return null;
    return { family, code };
  });
  const spaces = anchorSpaces(placements, opts.spaces ?? [], ready);

  const stats: UpgradeStats = { runs: 0, converted: 0, kept: 0, spaces: 0 };
  const pieces: string[] = [];
  let cursor = 0;
  let run: Run | null = null;
  let prevEnd = -1;

  const flush = () => {
    if (!run) return;
    const r = run;
    run = null;

    const { a, b, c, d } = r.matrix;
    const K = Math.sqrt(Math.abs(a * d - b * c));
    if (!(K > 0) || r.items.length === 0) {
      stats.kept += r.items.length;
      pieces.push(r.source);
      return;
    }
    const A = a / K;
    const B = b / K;
    const C = -c / K;
    const D = -d / K;
    const det = A * D - B * C;
    if (Math.abs(det) < 1e-12) {
      stats.kept += r.items.length;
      pieces.push(r.source);
      return;
    }

    const xs: string[] = [];
    const ys: string[] = [];
    const chars: string[] = [];
    let synthetic = 0;
    for (const it of r.items) {
      const X = (D * it.x - C * it.y) / det;
      const Y = (-B * it.x + A * it.y) / det;
      xs.push(fmt(X));
      ys.push(fmt(Y));
      chars.push(escapeText(String.fromCodePoint(it.code)));
      if (it.synthetic) synthetic++;
    }

    let out = `<text${r.attrs} transform="matrix(${fmt(A)} ${fmt(B)} ${fmt(C)} ${fmt(D)} 0 0)" font-size="${fmt(K)}" font-family="${r.family}" font-weight="normal" font-style="normal"`;
    if (precise) out += ' text-rendering="geometricPrecision"';
    out += ' xml:space="preserve">';
    out += tspans(chars, xs, ys, bionic, dim);
    out += '</text>';
    pieces.push(out);
    stats.runs++;
    stats.converted += r.items.length - synthetic;
    stats.spaces += synthetic;
  };

  const canExtend = (p: GlyphPlacement, family: string, code: number): boolean => {
    if (!run) return false;
    if (run.fontId !== p.fontId) return false;
    if (run.family !== family) return false;
    if (!sameLinear(run.matrix, p.matrix)) return false;
    if (prevEnd >= 0 && svg.slice(prevEnd, p.start).trim() !== '') return false;
    return true;
  };

  /** The spaces in front of a glyph, in the order they were read. */
  const pushSpaces = (target: Run, marks: readonly SpaceMark[]): void => {
    for (const mark of marks) target.items.push({ x: mark.x, y: mark.y, code: mark.code, gid: -1, synthetic: true });
  };

  for (const [index, p] of placements.entries()) {
    const planned = ready[index];
    // The spaces whose next character became this glyph.
    const marks = spaces.get(index);

    if (!planned) {
      // This glyph stays an outline, so there is no text to put its spaces in
      // front of; the run that just ended is the same point in the reading
      // order, and putting them there keeps the offset a space is anchored by.
      if (marks && run) pushSpaces(run, marks);
      flush();
      pieces.push(svg.slice(cursor, p.start), svg.slice(p.start, p.end));
      cursor = p.end;
      stats.kept++;
      prevEnd = p.end;
      continue;
    }

    const { family, code: cv } = planned;
    if (!canExtend(p, family, cv)) {
      flush();
      pieces.push(svg.slice(cursor, p.start));
      cursor = p.start;
      run = {
        fontId: p.fontId,
        family,
        matrix: { a: p.matrix.a, b: p.matrix.b, c: p.matrix.c, d: p.matrix.d },
        attrs: serializeAttrs(p.attrs),
        items: [],
        source: '',
      };
    }
    // `run` is non-null: either it survived or we just created one.
    const active = run as unknown as Run;
    if (marks) pushSpaces(active, marks);
    active.source += svg.slice(cursor, p.start) + svg.slice(p.start, p.end);
    cursor = p.end;
    prevEnd = p.end;
    active.items.push({ x: p.matrix.e, y: p.matrix.f, code: cv, gid: p.gid });
  }
  flush();
  pieces.push(svg.slice(cursor));

  let out = pieces.join('');

  if (opts.pruneUnusedOutlines ?? true) out = pruneOutlines(out);

  return { svg: out, stats };
}

/**
 * Drop glyph definitions that no remaining `<use>` points at.
 *
 * Converted runs no longer reference their outlines, and on a text-heavy page
 * those definitions are the bulk of the document. Only self-contained `<path>`
 * definitions are pruned; Type3 `<g>` definitions are left alone because they
 * contain nested markup we would have to balance.
 */
export function pruneOutlines(svg: string): string {
  const used = new Set<string>();
  const re = /#font_(\d+)_(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) used.add(`${m[1]}:${m[2]}`);

  let out = svg.replace(/<path id="font_(\d+)_(\d+)" d="[^"]*"\s*\/>\n?/g, (whole, f: string, g: string) =>
    used.has(`${f}:${g}`) ? whole : '',
  );
  out = out.replace(/<defs>\s*<\/defs>\n?/g, '');
  return out;
}
