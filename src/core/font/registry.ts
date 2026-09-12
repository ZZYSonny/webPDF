/**
 * Turns the outlines MuPDF emitted for a page into browser-installable fonts.
 *
 * For every font used on the page we collect the glyphs that were actually
 * drawn, mint a cmap that maps those glyphs to the code points we are going to
 * write into the SVG, and compile a subset TrueType font. Where a glyph has a
 * real Unicode value (MuPDF records it as `data-text`) we use it, so text stays
 * selectable and searchable; where it stands for several letters at once - a
 * ligature - we use the Unicode character for that ligature, which the caller
 * has read off the page (`svg/ligatures.ts`); otherwise we use a Private Use
 * Area code point, which keeps every glyph reachable without inventing a
 * meaning.
 */

import { buildFontFromOutlines, PUA_BASE, PUA_LIMIT, type OutlineGlyph } from './build.ts';
import { encodeWoff } from './woff.ts';
import { glyphKey, type GlyphOutline, type GlyphPlacement } from '../svg/glyphs.ts';
import { ligatureCode } from '../svg/ligatures.ts';
import { debug } from '../debug.ts';

export interface FontAsset {
  family: string;
  /** A complete `@font-face` rule, sans the surrounding `<style>` element. */
  css: string;
  /** Container the bytes are in: `woff`, or the raw OpenType/CFF font. */
  format: 'woff' | 'opentype';
  /** Size of the encoded font in bytes. */
  bytes: number;
  glyphCount: number;
}

export interface PageFontPlan {
  /** fontId (as used in `font_N_gid`) -> plan for that font. */
  fonts: Map<number, { family: string; codes: Map<number, number>; asset: FontAsset }>;
  /** Every `@font-face` rule the page needs, deduplicated. */
  assets: FontAsset[];
  built: number;
  reused: number;
}

export interface FontRegistryOptions {
  /** Skip WOFF compression and embed raw TrueType. */
  disableCompression?: boolean;
  /** Warn about anything that had to fall back to outlines. */
  onWarn?: (message: string) => void;
}

/* ------------------------------------------------------------------ */

function fnv1a(input: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function contentHash(parts: string[]): string {
  const joined = parts.join('\u0000');
  const a = fnv1a(joined, 0x811c9dc5);
  const b = fnv1a(joined, 0x9e3779b9);
  return a.toString(36) + b.toString(36);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ */

export class FontRegistry {
  private readonly cache = new Map<string, FontAsset>();
  private readonly opts: FontRegistryOptions;
  /** Insertion order of assets, so the emitted CSS is stable. */
  private readonly order: string[] = [];

  constructor(opts: FontRegistryOptions = {}) {
    this.opts = opts;
  }

  /** All `@font-face` rules produced so far, in creation order. */
  stylesheet(): string {
    const rules: string[] = [];
    for (const family of this.order) {
      const asset = this.cache.get(family);
      if (asset) rules.push(asset.css);
    }
    return rules.join('\n');
  }

  assets(): FontAsset[] {
    const out: FontAsset[] = [];
    for (const family of this.order) {
      const asset = this.cache.get(family);
      if (asset) out.push(asset);
    }
    return out;
  }

  /**
   * Build (or reuse) everything needed to render `placements` as text.
   *
   * `outlines` is the full glyph definition table for the page; placements tell
   * us which glyphs are actually drawn and which character each one stands for.
   * `letters` says which letters a glyph stands for when it stands for more
   * than one - a ligature, whose code point is then the ligature's own Unicode
   * character rather than a private-use stand-in (`svg/ligatures.ts`).
   */
  async planPage(
    outlines: ReadonlyMap<string, GlyphOutline>,
    placements: readonly GlyphPlacement[],
    opts: { letters?: ReadonlyMap<string, string> } = {},
  ): Promise<PageFontPlan> {    // fontId -> gid -> preferred code point
    const wanted = new Map<number, Map<number, number>>();
    // fontId -> gid -> advance in em, derived from neighbouring glyph positions
    const advances = new Map<number, Map<number, number>>();

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      let byGid = wanted.get(p.fontId);
      if (!byGid) wanted.set(p.fontId, (byGid = new Map()));
      if (!byGid.has(p.gid) && p.code > 0) byGid.set(p.gid, p.code);

      const next = placements[i + 1];
      if (next && next.fontId === p.fontId) {
        const m = p.matrix;
        const n = next.matrix;
        if (m.a === n.a && m.b === n.b && m.c === n.c && m.d === n.d) {
          const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
          if (k > 0) {
            const dist = Math.hypot(n.e - m.e, n.f - m.f) / k;
            if (dist > 0 && dist < 4) {
              let byFont = advances.get(p.fontId);
              if (!byFont) advances.set(p.fontId, (byFont = new Map()));
              if (!byFont.has(p.gid)) byFont.set(p.gid, dist);
            }
          }
        }
      }
    }

    const fonts: PageFontPlan['fonts'] = new Map();
    const assets: FontAsset[] = [];
    const seen = new Set<string>();
    let built = 0;
    let reused = 0;

    for (const [fontId, byGid] of wanted) {
      const glyphs: OutlineGlyph[] = [];
      const codes = new Map<number, number>();
      const claimed = new Set<number>();
      const parts: string[] = [];
      const advanceByGid = advances.get(fontId);

      /** Every glyph of this font that has an outline to build from. */
      const gids = [...byGid.keys()]
        .sort((x, y) => x - y)
        .filter((gid) => {
          const outline = outlines.get(glyphKey(fontId, gid));
          return Boolean(outline && outline.d !== null);
        });
      const lettersOf = (gid: number): string | undefined => opts.letters?.get(glyphKey(fontId, gid));
      /** How many letters a glyph stands for, or -1 when nothing is known. */
      const letterCount = (gid: number): number => {
        const letters = lettersOf(gid);
        return letters === undefined ? -1 : [...letters].length;
      };
      /** Take a code point for a glyph, if it is one worth taking and free. */
      const claim = (gid: number, code: number | null | undefined): boolean => {
        if (code === null || code === undefined || code <= 0 || claimed.has(code)) return false;
        claimed.add(code);
        codes.set(gid, code);
        return true;
      };

      // What a glyph *means* decides which code point it writes, not the order
      // the glyphs happen to be numbered in - a ligature is often numbered
      // before the letters it is made of. First the glyphs with one letter:
      // they own the letter MuPDF named. Then the ligatures, which get the
      // Unicode presentation form for their letters. Everyone left over - a
      // glyph the text device could not describe, or one whose letters are
      // already spoken for - falls back to a BMP Private Use code, which keeps
      // every glyph reachable without inventing a meaning for it.
      for (const gid of gids) {
        if (letterCount(gid) === 1) claim(gid, byGid.get(gid));
      }
      for (const gid of gids) {
        const letters = lettersOf(gid);
        if (letters !== undefined && letterCount(gid) > 1) claim(gid, ligatureCode(letters));
      }

      let nextPua = PUA_BASE;
      for (const gid of gids) {
        if (codes.has(gid)) continue;
        if (claim(gid, byGid.get(gid))) continue;
        while (nextPua <= PUA_LIMIT && claimed.has(nextPua)) nextPua++;
        // Out of private-use room: leave the glyph as an outline rather than
        // invent a mapping that could collide with real text.
        if (nextPua > PUA_LIMIT) continue;
        claim(gid, nextPua++);
      }

      for (const gid of gids) {
        const outline = outlines.get(glyphKey(fontId, gid));
        const code = codes.get(gid);
        if (!outline || outline.d === null || code === undefined) continue;
        glyphs.push({ gid, d: outline.d, codes: [code], advanceEm: advanceByGid?.get(gid) });
        parts.push(`${gid}\u0001${code}\u0001${outline.d}`);
      }

      if (glyphs.length === 0) continue;

      parts.sort();
      const family = `wpdf-${contentHash(parts)}`;
      let asset = this.cache.get(family);
      if (asset) {
        reused++;
      } else {
        asset = await this.compile(family, glyphs);
        this.cache.set(family, asset);
        this.order.push(family);
        built++;
      }
      if (!seen.has(asset.family)) {
        seen.add(asset.family);
        assets.push(asset);
      }
      fonts.set(fontId, { family: asset.family, codes, asset });
    }

    return { fonts, assets, built, reused };
  }

  /**
   * Build (or reuse) one font under a family name the caller owns.
   *
   * `planPage` mints a family from the glyphs one page drew, which is what makes
   * a page's font its own. A document-wide plan is the other way round: it knows
   * every glyph a *font* has, mints the family once, and every page of the
   * document asks for that same face. Both go through the same cache and the
   * same insertion order, so `assets()` and `stylesheet()` are still the single
   * list of what the document has registered.
   */
  async shared(family: string, glyphs: OutlineGlyph[]): Promise<{ asset: FontAsset; built: boolean }> {
    const existing = this.cache.get(family);
    if (existing) return { asset: existing, built: false };
    const asset = await this.compile(family, glyphs);
    this.cache.set(family, asset);
    this.order.push(family);
    return { asset, built: true };
  }

  private async compile(family: string, glyphs: OutlineGlyph[]): Promise<FontAsset> {
    debug('compile: build', family, glyphs.length, 'glyphs');
    const sfnt = buildFontFromOutlines(glyphs, { familyName: family });
    debug('compile: built', sfnt.data.byteLength, 'bytes');
    const sfntBytes = new Uint8Array(sfnt.data);

    let format: FontAsset['format'] = 'opentype';
    let payload: Uint8Array = sfntBytes;

    if (!this.opts.disableCompression) {
      try {
        const woff = await encodeWoff(sfntBytes);
        if (woff && woff.data.length < sfntBytes.length) {
          payload = woff.data;
          format = 'woff';
        }
      } catch (err) {
        this.opts.onWarn?.(`WOFF compression failed, embedding raw OpenType: ${String(err)}`);
      }
    }

    debug('compile: payload', payload.length, format);
    // What opentype.js writes is an `OTTO` sfnt - CFF charstrings in an
    // OpenType wrapper - so the uncompressed spelling is `font/otf` and
    // `format('opentype')`, not `truetype`. The bytes decide; the label only
    // has to agree with them.
    const mime = format === 'woff' ? 'font/woff' : 'font/otf';
    const css =
      `@font-face{font-family:'${family}';` +
      `src:url(data:${mime};base64,${toBase64(payload)}) format('${format}');` +
      `font-weight:normal;font-style:normal;font-display:block}`;

    return {
      family,
      css,
      format,
      bytes: payload.length,
      glyphCount: glyphs.length,
    };
  }
}
