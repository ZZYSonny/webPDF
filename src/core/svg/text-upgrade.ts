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
 */

import type { GlyphPlacement, Attribute } from './glyphs.ts';

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
}

export interface UpgradeStats {
  runs: number;
  converted: number;
  kept: number;
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
  items: { x: number; y: number; code: number; gid: number; advanceEm?: number }[];
  source: string;
}

/** True when the placement carries a stroke; those stay as outlines. */
function hasStroke(attrs: readonly Attribute[]): boolean {
  for (const a of attrs) {
    if ((a.name === 'stroke' && a.value !== 'none') || a.name === 'stroke-width') return true;
  }
  return false;
}

export function upgradeGlyphsToText(
  svg: string,
  placements: readonly GlyphPlacement[],
  enc: GlyphEncoding,
  opts: UpgradeOptions = {},
): UpgradeResult {
  const simpleOnly = opts.simpleTextOnly ?? true;
  const precise = opts.preciseTextRendering ?? true;

  const stats: UpgradeStats = { runs: 0, converted: 0, kept: 0 };
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
    let text = '';
    for (const it of r.items) {
      const X = (D * it.x - C * it.y) / det;
      const Y = (-B * it.x + A * it.y) / det;
      xs.push(fmt(X));
      ys.push(fmt(Y));
      text += escapeText(String.fromCodePoint(it.code));
    }

    let out = `<text${r.attrs} transform="matrix(${fmt(A)} ${fmt(B)} ${fmt(C)} ${fmt(D)} 0 0)" font-size="${fmt(K)}" font-family="${r.family}" font-weight="normal" font-style="normal"`;
    if (precise) out += ' text-rendering="geometricPrecision"';
    out += ' xml:space="preserve">';
    out += `<tspan x="${xs.join(' ')}" y="${ys.join(' ')}">${text}</tspan>`;
    out += '</text>';
    pieces.push(out);
    stats.runs++;
    stats.converted += r.items.length;
  };

  const canExtend = (p: GlyphPlacement, family: string, code: number): boolean => {
    if (!run) return false;
    if (run.fontId !== p.fontId) return false;
    if (run.family !== family) return false;
    if (!sameLinear(run.matrix, p.matrix)) return false;
    if (prevEnd >= 0 && svg.slice(prevEnd, p.start).trim() !== '') return false;
    return true;
  };

  for (const p of placements) {
    const family = enc.familyFor(p.fontId);
    const code = family && !hasStroke(p.attrs) ? enc.codeFor(p.fontId, p.gid) : null;
    const ok = code !== null && code > 0 && (!simpleOnly || isSimpleCode(code));

    if (!ok) {
      flush();
      pieces.push(svg.slice(cursor, p.start), svg.slice(p.start, p.end));
      cursor = p.end;
      stats.kept++;
      prevEnd = p.end;
      continue;
    }

    const cv = code as number;
    if (!canExtend(p, family as string, cv)) {
      flush();
      pieces.push(svg.slice(cursor, p.start));
      cursor = p.start;
      run = {
        fontId: p.fontId,
        family: family as string,
        matrix: { a: p.matrix.a, b: p.matrix.b, c: p.matrix.c, d: p.matrix.d },
        attrs: serializeAttrs(p.attrs),
        items: [],
        source: '',
      };
    }
    // `run` is non-null: either it survived or we just created one.
    const active = run as unknown as Run;
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
