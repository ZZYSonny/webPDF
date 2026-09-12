/**
 * One font per *font*, for the whole document, instead of one per page.
 *
 * A page's font is built from the glyphs that page drew, so every page mints a
 * new family and every page registers a new `@font-face`. Registering a face
 * re-lays-out the document it lands in - measured at 3347 nodes for a single
 * boundary-crossing gesture - which is why every page is drawn in its own frame.
 *
 * A font built from the program is not limited that way: it can hold every glyph
 * the font has (see `program.ts`), so one face serves the whole document. What a
 * program cannot say is which *character* each glyph is written as, because that
 * is the PDF's encoding rather than the font's, so the plan also walks the
 * document once - text only, drawing nothing - and collects, per program, the
 * glyph ids, the codes they were drawn for, and the letters behind any ligature.
 *
 * The walk is cheap (measured: 4.3 ms a page on a 756-page specification, and
 * 12-19 ms a page on the papers) but it is not free, so a document is planned in
 * one of two ways:
 *
 *   - small enough to afford it (`preplanPages`), and the whole document is
 *     walked and every face built *before the first page is laid out*, which is
 *     the case the viewer needs in order to be a single document;
 *   - otherwise the plan is kept a window ahead of whatever is being rendered,
 *     and a font met for the first time later registers then. That is still one
 *     registration per font and not per page; a 756-page specification spends
 *     its first page on page 1 either way.
 */

import * as mupdf from 'mupdf';

import { glyphsFromFont, glyphsFromProgram, pageGlyphs, programId, programsOnPage, type FontProgram } from './program.ts';
import { glyphLetters, ligatureCode } from '../svg/ligatures.ts';
import { type GlyphOutline, type GlyphPlacement } from '../svg/glyphs.ts';
import { type TextChar } from '../svg/spaces.ts';
import { PUA_BASE, PUA_LIMIT, type OutlineGlyph } from './build.ts';
import { FontRegistry, type FontAsset, type PageFontPlan } from './registry.ts';
import { debug } from '../debug.ts';

/* ------------------------------------------------------------------ */

interface Entry {
  key: string;
  name: string;
  program: FontProgram | null;
  /** gid -> SVG path data in em units, or null when the glyph is blank. */
  outlines: Map<number, string | null>;
  /** Every gid the document drew from this font, codes or not. */
  seen: Set<number>;
  advances: Map<number, number>;
  /** code -> gid, first writer wins: this is the cmap the font is built from. */
  byCode: Map<number, number>;
  /** gid -> every code it was drawn for, in the order they were met. */
  codesByGid: Map<number, number[]>;
  /** gid -> the letters a ligature glyph stands for, when it stands for more. */
  letters: Map<number, string>;
  /** gid -> the code the text is written as. Decided when the font is built. */
  codeOf: Map<number, number>;
  asset: FontAsset | null;
  /** What the built font was made of, so a growing font is rebuilt and not stale. */
  signature: string;
}

const EMPTY: PageFontPlan = { fonts: new Map(), assets: [], built: 0, reused: 0 };

/* ------------------------------------------------------------------ */

function hash(parts: readonly string[]): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      a = Math.imul(a ^ part.charCodeAt(i), 0x01000193);
      b = Math.imul(b ^ part.charCodeAt(i), 0x85ebca6b);
    }
    a = Math.imul(a ^ 0x1f, 0x01000193);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/**
 * The characters on a page, with the origins that tie them to the glyphs.
 *
 * The text pass is what knows a ligature is two letters: the display list
 * reports one glyph for `fi`, and only the text device says that two characters
 * were standing at that point.
 */
function readChars(page: mupdf.Page): TextChar[] {
  const chars: TextChar[] = [];
  let line = 0;
  const stext = page.toStructuredText('');
  try {
    stext.walk({
      beginLine() {
        line++;
      },
      onChar: (c: string, origin: number[]) => chars.push({ text: c, x: origin[0], y: origin[1], line }),
    });
  } finally {
    stext.destroy();
  }
  return chars;
}

/* ------------------------------------------------------------------ */

export interface DocumentFontPlanOptions {
  /**
   * How many pages are worth walking before the first page is laid out. Below
   * this, one `@font-face` per font exists before any page is shown and nothing
   * registers again for the life of the document.
   */
  preplanPages?: number;
  /** How far ahead of the page being rendered the plan is kept. */
  ahead?: number;
  onWarn?: (message: string) => void;
}

export class DocumentFontPlan {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: Required<Pick<DocumentFontPlanOptions, 'preplanPages' | 'ahead'>> & DocumentFontPlanOptions;
  private registry: FontRegistry | null = null;
  /** Pages walked so far, in order. */
  private covered = 0;
  private complete = false;

  constructor(opts: DocumentFontPlanOptions = {}) {
    this.opts = { preplanPages: 200, ahead: 24, ...opts };
  }

  /** True once every page has been walked, so no font can appear later. */
  get planned(): boolean {
    return this.complete;
  }

  /**
   * Walk the document far enough that a render of `index` is covered.
   *
   * A document small enough to be planned whole is planned whole on the first
   * call, whatever page is asked for; past that the plan just stays a window
   * ahead, so the pass costs a page's walk and never a document's.
   */
  async cover(doc: mupdf.Document, index: number, registry: FontRegistry): Promise<void> {
    this.registry = registry;
    const count = doc.countPages();
    const whole = count <= this.opts.preplanPages;
    const upto = whole ? count : Math.min(count, index + this.opts.ahead + 1);
    if (upto > this.covered) {
      const started = Date.now();
      for (let i = this.covered; i < upto; i++) this.walkPage(doc, i);
      this.covered = upto;
      debug('font plan: walked', upto, 'pages in', Date.now() - started, 'ms');
    }
    if (whole) this.complete = true;
    if (this.complete) await this.buildAll();
  }

  /**
   * The faces for a page, or null when the page draws something the plan has
   * not seen - in which case the caller keeps its own per-page fonts, which is
   * correct, only slower.
   */
  async planPage(
    outlines: ReadonlyMap<string, GlyphOutline>,
    placements: readonly GlyphPlacement[],
    opts: { letters?: ReadonlyMap<string, string> } = {},
  ): Promise<PageFontPlan | null> {
    if (!this.registry) return null;

    // fontId -> gids, in the order the page drew them
    const wanted = new Map<number, Map<number, number>>();
    for (const p of placements) {
      let byGid = wanted.get(p.fontId);
      if (!byGid) wanted.set(p.fontId, (byGid = new Map()));
      if (!byGid.has(p.gid)) byGid.set(p.gid, p.code);
    }

    const fonts: PageFontPlan['fonts'] = new Map();
    const assets: FontAsset[] = [];
    const seen = new Set<string>();

    for (const [fontId, byGid] of wanted) {
      // A glyph the page kept as an outline needs no font, so a font this page
      // has nothing readable from is simply absent rather than unresolved.
      const drawn = [...byGid.keys()].filter((gid) => outlines.get(`${fontId}:${gid}`)?.d);
      if (drawn.length === 0) continue;
      const entry = this.match(fontId, drawn, outlines, byGid);
      // Something this page drew that the plan has never seen: rather than guess
      // at a family, the caller keeps building a font for the page it drew.
      if (!entry || !entry.asset) return null;
      const asset = entry.asset;
      if (!seen.has(asset.family)) {
        seen.add(asset.family);
        assets.push(asset);
      }
      fonts.set(fontId, { family: asset.family, codes: entry.codeOf, asset });
    }

    return { fonts, assets, built: 0, reused: assets.length };
  }

  /** Every face the plan has built, for a host that registers them up front. */
  families(): FontAsset[] {
    const out: FontAsset[] = [];
    for (const entry of this.entries.values()) if (entry.asset) out.push(entry.asset);
    return out;
  }

  /* ---------------------------------------------------------------- */

  private walkPage(doc: mupdf.Document, index: number): void {
    const page = doc.loadPage(index);
    try {
      const programs = programsOnPage(page);
      const { fonts, draws } = pageGlyphs(page, programs, (handle, fontId, font) => {
        // A font with no program has no bytes to read, but the display list is
        // holding the substituted face: draw the glyphs it has not drawn yet.
        if (font.program) return;
        const entry = this.entryFor(font);
        const fresh = [...font.gids].filter((gid) => !entry.outlines.has(gid));
        if (fresh.length === 0) return;
        const { outlines, advances } = glyphsFromFont(handle, fresh);
        for (const [gid, d] of outlines) entry.outlines.set(gid, d);
        for (const [gid, advance] of advances) entry.advances.set(gid, advance);
      });

      for (const font of fonts) {
        const entry = this.entryFor(font);
        for (const gid of font.gids) entry.seen.add(gid);
        for (const [gid, code] of font.codes) {
          entry.byCode.set(code, gid);
          const codes = entry.codesByGid.get(gid);
          if (codes) {
            if (!codes.includes(code)) codes.push(code);
          } else {
            entry.codesByGid.set(gid, [code]);
          }
        }
      }

      // Which letters a glyph stands for, matched by the origin the display list
      // gave it - the same comparison the per-page pipeline makes, on the same
      // two coordinates, but from the walk rather than from a rendered page.
      const chars = readChars(page);
      if (chars.length && draws.length) {
        const placements: GlyphPlacement[] = draws.map((d) => ({
          fontId: d.fontId,
          gid: d.gid,
          code: d.code,
          matrix: d.matrix,
          attrs: [],
          start: 0,
          end: 0,
        }));
        for (const [key, letters] of glyphLetters(chars, placements)) {
          if ([...letters].length < 2) continue;
          const gid = Number(key.split(':')[1]);
          const entry = this.entryFor(fonts[Number(key.split(':')[0])]);
          if (!entry.letters.has(gid)) entry.letters.set(gid, letters);
        }
      }
    } finally {
      page.destroy();
    }
  }

  private entryFor(font: { name: string; program: FontProgram | null }): Entry {
    const key = font.program ? programId(font.program) : `named\u0000${font.name}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        name: font.name,
        program: font.program,
        outlines: new Map(),
        seen: new Set(),
        advances: new Map(),
        byCode: new Map(),
        codesByGid: new Map(),
        letters: new Map(),
        codeOf: new Map(),
        asset: null,
        signature: '',
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Draw every glyph of every embedded program, and build every face. */
  private async buildAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!entry.program) continue;
      const fresh = [...entry.seen].filter((gid) => !entry.outlines.has(gid));
      if (fresh.length === 0) continue;
      const { outlines, advances } = glyphsFromProgram(entry.program, fresh);
      for (const [gid, d] of outlines) entry.outlines.set(gid, d);
      for (const [gid, advance] of advances) entry.advances.set(gid, advance);
    }
    for (const entry of this.entries.values()) await this.build(entry);
  }

  private async build(entry: Entry): Promise<void> {
    const registry = this.registry;
    if (!registry) return;
    const gids = [...entry.outlines.keys()].sort((a, b) => a - b);
    if (gids.length === 0) return;

    const signature = hash(gids.map((gid) => `${gid}:${entry.outlines.get(gid) ?? ''}:${entry.codesByGid.get(gid)?.join(',') ?? ''}`));
    if (entry.asset && entry.signature === signature) return;

    // A code belongs to one glyph or it belongs to none: a program used with two
    // encodings can name the same code for two different glyphs, and a cmap that
    // guessed would draw the wrong letter.
    const assigned = new Set<number>();
    for (const [code, gid] of entry.byCode) {
      if (!entry.outlines.has(gid) || assigned.has(code)) continue;
      entry.codeOf.set(gid, code);
      assigned.add(code);
    }
    // A ligature is written as the one character that means it, so `fi` copies
    // as `fi` and not as the `f` the display list recorded for the glyph.
    for (const [gid, letters] of entry.letters) {
      if (!entry.outlines.has(gid)) continue;
      const code = ligatureCode(letters);
      if (code === null || assigned.has(code)) continue;
      entry.codeOf.set(gid, code);
      assigned.add(code);
    }
    // Anything left is reachable by a private-use code: every glyph in the font
    // is one the browser can be asked to draw.
    let nextPua = PUA_BASE;
    for (const gid of gids) {
      if (entry.codeOf.has(gid)) continue;
      while (nextPua <= PUA_LIMIT && assigned.has(nextPua)) nextPua++;
      if (nextPua > PUA_LIMIT) continue;
      entry.codeOf.set(gid, nextPua);
      assigned.add(nextPua++);
    }

    const glyphs: OutlineGlyph[] = [];
    for (const gid of gids) {
      const code = entry.codeOf.get(gid);
      if (code === undefined) continue;
      // Every code the glyph was drawn for goes in the cmap too, so a page that
      // asks for it by its own name still finds the right glyph.
      const codes = [code, ...(entry.codesByGid.get(gid) ?? [])].filter((c, i, all) => all.indexOf(c) === i);
      glyphs.push({ gid, d: entry.outlines.get(gid) ?? '', codes, advanceEm: entry.advances.get(gid) });
    }
    if (glyphs.length === 0) return;

    const family = `wpdf-${hash([entry.key, ...glyphs.map((g) => `${g.gid}:${g.codes.join('.')}:${g.d}`)])}`;
    try {
      const { asset } = await registry.shared(family, glyphs);
      entry.asset = asset;
      entry.signature = signature;
      debug('font plan: built', entry.name, family, glyphs.length, 'glyphs', asset.bytes, 'bytes');
    } catch (err) {
      this.opts.onWarn?.(`could not build a font for ${entry.name}: ${String(err)}`);
    }
  }

  /**
   * Which planned font drew a page's `font_N`.
   *
   * The SVG's numbering is not resource order and not first use - a page can
   * start at `font_4`, and one program gets several ids when a Form XObject
   * carries its own copy - so the link is made by the outlines themselves, which
   * are the same bytes either way. The code the page recorded for each glyph is
   * the tie-break, because two subsets of one face can draw identically.
   */
  private match(
    fontId: number,
    gids: readonly number[],
    outlines: ReadonlyMap<string, GlyphOutline>,
    codes: ReadonlyMap<number, number>,
  ): Entry | null {
    let best: Entry | null = null;
    let bestScore = 0;
    let tied = false;
    for (const entry of this.entries.values()) {
      if (entry.outlines.size === 0) continue;
      let score = 0;
      for (const gid of gids) {
        if (entry.outlines.get(gid) !== outlines.get(`${fontId}:${gid}`)?.d) {
          score = -1;
          break;
        }
        if (entry.byCode.get(codes.get(gid) ?? -1) === gid) score++;
      }
      if (score < 0) continue;
      score += 1;
      if (score > bestScore) {
        best = entry;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    if (!best || tied) return null;
    return best;
  }
}
