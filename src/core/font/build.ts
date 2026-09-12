/**
 * Build a web font from glyph outlines harvested out of MuPDF.
 *
 * The PDF pipeline never parses embedded font programs. Instead MuPDF (via
 * FreeType) resolves every font - embedded CFF/Type1/TrueType, substituted
 * base-14 faces, CJK - into normalised outlines whose coordinates we can read
 * straight out of the generated SVG. Re-emitting those outlines as a CFF
 * charstring guarantees that the browser draws *exactly* the same shape that
 * MuPDF would have drawn as a path.
 */

import * as opentypeModule from 'opentype.js';
import { parseSvgPath, pathBounds, type PathCommand } from './svg-path.ts';

/**
 * opentype.js ships both a CJS and an ESM build; the ESM one exposes only named
 * exports while Node's CJS interop hands back the module object as `default`.
 * Normalise both so the same source runs in the browser bundle and under Node.
 */
interface OpenTypeApi {
  Font: typeof opentypeModule.Font;
  Glyph: typeof opentypeModule.Glyph;
  Path: typeof opentypeModule.Path;
}

const opentype: OpenTypeApi =
  (opentypeModule as unknown as { default?: OpenTypeApi }).default ??
  (opentypeModule as unknown as OpenTypeApi);

/**
 * Where to put glyphs that have no real Unicode value.
 *
 * Must stay inside the Basic Multilingual Plane: opentype.js builds its `cmap`
 * with 16-bit segment arithmetic, so a supplementary-plane code point is
 * silently dropped and the glyph becomes unreachable.
 *
 * U+E000..U+F8FF is the BMP Private Use Area - 6400 slots, plenty for one
 * page's worth of glyphs, and never colliding with real text.
 */
export const PUA_BASE = 0xe000;
export const PUA_LIMIT = 0xf8ff;

export interface OutlineGlyph {
  /** Glyph id inside the source font, as used by MuPDF. */
  gid: number;
  /** SVG path data in font units where 1.0 == one em, y pointing up. */
  d: string;
  /** Code points the glyph should be reachable under (real Unicode first). */
  codes: number[];
  /** Advance width in em units. Derived from layout when available. */
  advanceEm?: number;
}

export interface BuildFontOptions {
  familyName: string;
  styleName?: string;
  unitsPerEm?: number;
}

export interface BuiltFontData {
  data: ArrayBuffer;
  unitsPerEm: number;
  glyphCount: number;
}

function toPath(commands: readonly PathCommand[], scale: number): opentype.Path {
  const p = new opentype.Path();
  for (const k of commands) {
    switch (k.c) {
      case 'M':
        p.moveTo(k.x * scale, k.y * scale);
        break;
      case 'L':
        p.lineTo(k.x * scale, k.y * scale);
        break;
      case 'Q':
        p.quadraticCurveTo(k.x1 * scale, k.y1 * scale, k.x * scale, k.y * scale);
        break;
      case 'C':
        p.curveTo(k.x1 * scale, k.y1 * scale, k.x2 * scale, k.y2 * scale, k.x * scale, k.y * scale);
        break;
      case 'Z':
        p.closePath();
        break;
    }
  }
  return p;
}

/**
 * Compile outlines into an OpenType font.
 *
 * opentype.js 2.x writes a `CFF ` table: its charstrings are cubic, so MuPDF's
 * cubics go in *as they are* and come back out as the same curve, rounded to
 * the 1/1000 em grid. Nothing here approximates anything.
 *
 * (It used to convert every cubic to a quadratic first, from when this wrote a
 * `glyf` table. Against a CFF writer that is a pure loss - the quadratic is
 * re-expanded to a cubic on the way out - and it cost up to 0.035 em of shape
 * on a single curve. `tests/font-outline.test.ts` measures the round trip so
 * that cannot come back.)
 *
 * Throws if the input cannot be represented; callers treat that as "this font
 * stays as outlines in the SVG", which is always a correct fallback.
 */
export function buildFontFromOutlines(glyphs: readonly OutlineGlyph[], opts: BuildFontOptions): BuiltFontData {
  const unitsPerEm = opts.unitsPerEm ?? 1000;

  const fontGlyphs: opentype.Glyph[] = [];
  // glyph 0 must be .notdef
  fontGlyphs.push(
    new opentype.Glyph({
      name: '.notdef',
      unicode: 0,
      advanceWidth: Math.round(unitsPerEm * 0.5),
      path: new opentype.Path(),
    }),
  );

  let minY = Infinity;
  let maxY = -Infinity;
  // Every code that has been spoken for, so the last-resort assignment below
  // cannot hand a glyph a code another glyph already answers to - which would
  // make the browser draw the wrong one.
  const claimed = new Set<number>();
  let nextPua = PUA_BASE;

  for (const g of glyphs) {
    let commands: PathCommand[];
    try {
      commands = parseSvgPath(g.d);
    } catch {
      // A glyph we cannot parse becomes blank rather than corrupting the font.
      commands = [];
    }
    const path = toPath(commands, unitsPerEm);

    for (const k of commands) {
      if (k.c === 'M' || k.c === 'L' || k.c === 'Q' || k.c === 'C') {
        if (k.y < minY) minY = k.y;
        if (k.y > maxY) maxY = k.y;
      }
    }

    const bounds = pathBounds(commands);
    const advanceEm =
      g.advanceEm !== undefined && g.advanceEm > 0
        ? g.advanceEm
        : Math.max(bounds.x1, bounds.x0 + 0.02) || 0.5;

    const unicodes = [...new Set(g.codes.filter((c) => Number.isFinite(c) && c > 0 && c <= 0x10ffff))];
    if (unicodes.length === 0) {
      while (nextPua <= PUA_LIMIT && claimed.has(nextPua)) nextPua++;
      // Out of private-use room: the glyph stays in the font with no code at
      // all rather than taking one that already means something else.
      if (nextPua <= PUA_LIMIT) unicodes.push(nextPua++);
    }
    for (const c of unicodes) claimed.add(c);
    fontGlyphs.push(
      new opentype.Glyph({
        name: `gid${g.gid}`,
        unicodes,
        advanceWidth: Math.round(advanceEm * unitsPerEm),
        path,
      }),
    );
  }

  const ascender = Number.isFinite(maxY) ? Math.round(Math.max(maxY, 0.7) * unitsPerEm) : 800;
  const descender = Number.isFinite(minY) ? Math.round(Math.min(minY, -0.2) * unitsPerEm) : -200;

  const font = new opentype.Font({
    familyName: opts.familyName,
    styleName: opts.styleName ?? 'Regular',
    unitsPerEm,
    ascender,
    descender,
    glyphs: fontGlyphs,
  });

  return {
    data: font.toArrayBuffer(),
    unitsPerEm,
    glyphCount: fontGlyphs.length,
  };
}
