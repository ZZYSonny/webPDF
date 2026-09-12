/**
 * One font per *font*, for the whole document, instead of one per page.
 *
 * A page's font is built from the glyphs that page drew, so every page mints a
 * new family and every page registers a new `@font-face`. Registering a face
 * re-lays-out the document it lands in: Blink's font-update invalidation walks
 * the whole document, measured at 112.9 ms and 3347 "fonts changed" nodes for a
 * single face added to a document holding a 15-page paper. That is what used to
 * force every page into a frame of its own, and with the frame went selection
 * across pages, find-in-page over the paper, and a caret.
 *
 * A font built from the program is not limited that way: it can hold every glyph
 * the font has (see `program.ts`), so one face serves the whole document. What a
 * program cannot say is which *character* each glyph is written as, because that
 * is the PDF's encoding rather than the font's, so the plan walks the document
 * once - the display list only, drawing nothing - and collects the glyph ids and
 * the codes they were drawn for. The *letters* behind a ligature come from the
 * font dictionaries instead (`encoding.ts`): `/Differences` names the glyph `fi`
 * and a `/ToUnicode` entry longer than one character spells it out, which is
 * both cheaper and more faithful than laying the page's characters over its
 * glyphs to work out which ones a glyph swallowed. Measured on the 756-page
 * specification, that inference was 4.5 s of the plan's 8.1 s walk and it is now
 * gone.
 *
 * Walking the display list is not the expensive part - measured: 4.7 ms a page
 * on the specification, 12-19 on the papers - and it is not optional, because
 * three of the four corpus documents draw a *substituted* face (no program at
 * all) on nearly every page: only a page handle can draw those glyphs, and only
 * the display list says which ones a page used. What a program could not be
 * asked for is its characters, and those come from the dictionaries.
 *
 * The build is the part that cannot be made smaller - drawing every glyph a
 * program has and compiling it is tens to hundreds of milliseconds a face - so
 * a plan is not something to make a reader wait for. It runs in the
 * *background*, from the moment the document is open, a slice at a time:
 * `start()` walks and builds while the host draws its pages the other way (a
 * face per page, in a frame of its own), and hands the thread back between
 * slices so that a page the reader asks for is never queued behind it. When the
 * last face is built the plan is `planned`, and the host can switch to it.
 *
 * Planning the whole document is worth it in *work* even when it is not worth
 * waiting for in time: a face that grows is a face rebuilt, so a plan that keeps
 * up with the reader a page at a time mints a family for every growth, against
 * one per font here. What the background buys is that none of it is on the path
 * to the first page.
 */

import * as mupdf from 'mupdf';

import { glyphsFromFont, glyphsFromProgram, pageGlyphs, programId, programsOnPage, type FontProgram } from './program.ts';
import { drawLetters, pageEncodings, type FontEncoding } from './encoding.ts';
import { ligatureCode } from '../svg/ligatures.ts';
import { glyphKey, type GlyphOutline, type GlyphPlacement } from '../svg/glyphs.ts';
import { PUA_BASE, PUA_LIMIT, type LigatureSubstitution, type OutlineGlyph } from './build.ts';
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
  /**
   * gid -> the letters the text is written as, for a ligature the built face
   * has a `liga` rule for. Empty for a glyph written as its own character.
   */
  lettersOf: Map<number, string>;
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

/* ------------------------------------------------------------------ */

export interface FontPlanProgress {
  /** Pages walked so far. */
  covered: number;
  /** Pages in the document. */
  total: number;
  /** True once every page has been walked and every face built. */
  ready: boolean;
}

/**
 * The thread the walk is running on, as the plan needs to see it.
 *
 * The plan is the least urgent work in the process: a reader waiting for a page
 * always matters more than a face for a page they have not reached. `pause` is
 * where the plan waits for that reader, and `cancelled` is how it is told that
 * the document it was walking has gone away.
 */
export interface PlanHost {
  /** Resolves when nothing more urgent is in flight. */
  pause(): Promise<void>;
  /** True once the document being walked is no longer the open one. */
  cancelled(): boolean;
}

export interface DocumentFontPlanOptions {
  /** How long the walk may hold the thread before handing it back, in ms. */
  sliceMs?: number;
  onWarn?: (message: string) => void;
  /** Called after every page walked, and once more when the plan is ready. */
  onProgress?: (progress: FontPlanProgress) => void;
}

/**
 * Walking the page before handing the thread back.
 *
 * A page of a paper takes 12-19 ms to walk, so this is one page on the slow
 * ones and a few on the fast - which is the granularity at which a render
 * request can be answered while the plan is running.
 */
const SLICE_MS = 8;

export class DocumentFontPlan {
  private readonly entries = new Map<string, Entry>();
  /**
   * The entries that have grown since they were last built.
   *
   * Building a face means hashing every glyph in it, so a plan that rebuilt
   * everything again every time a page was walked would spend the document
   * hashing fonts that had not changed.
   */
  private readonly dirty = new Set<Entry>();
  /**
   * Font dictionaries already read, keyed by the resource's indirect object.
   *
   * A document draws one font on a thousand pages and every page names the same
   * dictionary; parsing a `/ToUnicode` once per page would be the whole cost of
   * the pass.
   */
  private readonly encodings = new Map<string, FontEncoding>();
  private readonly opts: DocumentFontPlanOptions;
  private registry: FontRegistry | null = null;
  private task: Promise<void> | null = null;
  /** Pages walked so far, in order. */
  private covered = 0;
  private total = 0;
  private complete = false;

  constructor(opts: DocumentFontPlanOptions = {}) {
    this.opts = opts;
  }

  /** True once every page has been walked, so no font can appear later. */
  get planned(): boolean {
    return this.complete;
  }

  progress(): FontPlanProgress {
    return { covered: this.covered, total: this.total, ready: this.complete };
  }

  /**
   * Walk the document and build its faces, in the background.
   *
   * Returns the one walk: a second call joins the first rather than starting a
   * second pass, and the promise resolves when the plan is ready, when the host
   * says the document is gone, or when the walk failed (which is a warning to
   * the host, not an exception - a document whose fonts cannot be planned is a
   * document drawn with a face per page, which is what every page did before
   * there was a plan).
   */
  start(doc: mupdf.Document, registry: FontRegistry, host?: PlanHost): Promise<void> {
    this.registry = registry;
    this.task ??= this.run(doc, host).catch((err) => {
      this.opts.onWarn?.(`could not plan the document's fonts: ${String(err)}`);
    });
    return this.task;
  }

  private async run(doc: mupdf.Document, host?: PlanHost): Promise<void> {
    this.total = doc.countPages();
    const started = Date.now();
    let sliced = started;
    while (this.covered < this.total) {
      if (host?.cancelled()) return;
      this.walkPage(doc, this.covered++);
      this.opts.onProgress?.(this.progress());
      if (host && Date.now() - sliced >= (this.opts.sliceMs ?? SLICE_MS)) {
        sliced = Date.now();
        await host.pause();
      }
    }
    debug('font plan: walked', this.total, 'pages in', Date.now() - started, 'ms');
    await this.buildAll(host);
    if (host?.cancelled()) return;
    this.complete = true;
    this.opts.onProgress?.(this.progress());
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
      if (!entry) return null;
      // A font the plan knows but could build nothing from - every glyph of it
      // unnamed, or a build that failed - is not a reason to give the whole page
      // up: its glyphs stay outlines, which is what they would have been anyway.
      const asset = entry.asset;
      if (!asset) continue;
      if (!seen.has(asset.family)) {
        seen.add(asset.family);
        assets.push(asset);
      }
      fonts.set(fontId, { family: asset.family, codes: entry.codeOf, letters: entry.lettersOf, asset });
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
        this.dirty.add(entry);
      });

      for (const font of fonts) {
        const entry = this.entryFor(font);
        let grew = false;
        for (const gid of font.gids) {
          if (!entry.seen.has(gid)) {
            entry.seen.add(gid);
            grew = true;
          }
        }
        for (const [gid, code] of font.codes) {
          if (!entry.byCode.has(code)) grew = true;
          entry.byCode.set(code, gid);
          const codes = entry.codesByGid.get(gid);
          if (codes) {
            if (!codes.includes(code)) {
              codes.push(code);
              grew = true;
            }
          } else {
            entry.codesByGid.set(gid, [code]);
            grew = true;
          }
        }
        if (grew) this.dirty.add(entry);
      }

      // Which letters a glyph stands for is a property of the *document*, not
      // of a rendered page: `/Differences` names the glyph `fi`, a `/ToUnicode`
      // entry longer than one character spells it out, and a code that is the
      // ligature's own character carries its letters with it. Reading those is
      // what replaced the text pass this used to make - laying the page's
      // characters over its glyphs and inferring which ones a glyph swallowed -
      // which was the most expensive thing the plan did and the least certain.
      const letters = drawLetters(fonts, draws, pageEncodings(page, programs, this.encodings));
      for (const [fontId, byGid] of letters) {
        const entry = this.entryFor(fonts[fontId]);
        for (const [gid, text] of byGid) {
          if (entry.letters.has(gid)) continue;
          entry.letters.set(gid, text);
          this.dirty.add(entry);
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
        lettersOf: new Map(),
        asset: null,
        signature: '',
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * Draw every glyph the entries that grew are missing, and build those faces.
   *
   * One font at a time, with the thread handed back in between: a face is the
   * one part of this that cannot be made smaller - drawing a program's glyphs
   * and compiling them is a single synchronous step of tens to hundreds of
   * milliseconds - so it is the unit the plan is sliced into.
   */
  private async buildAll(host?: PlanHost): Promise<void> {
    const entries = [...this.dirty];
    this.dirty.clear();
    for (const entry of entries) {
      if (host?.cancelled()) return;
      if (entry.program) {
        const fresh = [...entry.seen].filter((gid) => !entry.outlines.has(gid));
        if (fresh.length > 0) {
          const { outlines, advances } = glyphsFromProgram(entry.program, fresh);
          for (const [gid, d] of outlines) entry.outlines.set(gid, d);
          for (const [gid, advance] of advances) entry.advances.set(gid, advance);
        }
      }
      await this.build(entry);
      await host?.pause();
    }
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
    // guessed would draw the wrong letter. Decided from scratch, so a font that
    // grew is a font that is encoded again rather than one carrying the answers
    // of an earlier, smaller self. One code really can be claimed by two glyphs
    // over a document's life; the one that loses is left with a private-use code,
    // so its *shape* is right and its character is not - which is the most a
    // single face can do for a document whose producer gave one font two
    // encodings, and is why the text of such a page is the thing to distrust
    // rather than the drawing.
    entry.codeOf.clear();
    entry.lettersOf.clear();
    const assigned = new Set<number>();
    // A glyph that stands for several letters is not the letter the display
    // list named it with: `fi` arrives as `f` from a document that names a
    // ligature after its first letter, and a font that took that `f` would take
    // it away from the real `f`, which would be left with a private-use
    // stand-in. What this glyph is written as is decided below, from its
    // letters.
    for (const [code, gid] of entry.byCode) {
      if (!entry.outlines.has(gid) || entry.letters.has(gid) || assigned.has(code)) continue;
      entry.codeOf.set(gid, code);
      assigned.add(code);
    }
    // A ligature keeps the one character Unicode has for it, so the glyph is
    // reachable by name as well as by its letters; what the *text* says is the
    // letters, and the rule written below is what draws the one glyph for them.
    for (const [gid, letters] of entry.letters) {
      if (!entry.outlines.has(gid)) continue;
      const code = ligatureCode(letters);
      if (code === null || assigned.has(code)) continue;
      entry.codeOf.set(gid, code);
      assigned.add(code);
    }
    // Anything left is reachable by a private-use code: every glyph the document
    // wrote a character for is one the browser can be asked to draw. A glyph no
    // page could name at all is *not* - MuPDF reports no character for it, and
    // inventing one would put a private-use character into the text where the
    // per-page pipeline left an outline.
    let nextPua = PUA_BASE;
    for (const gid of gids) {
      if (entry.codeOf.has(gid)) continue;
      const named = (entry.codesByGid.get(gid)?.length ?? 0) > 0 || entry.letters.has(gid);
      if (!named) continue;
      while (nextPua <= PUA_LIMIT && assigned.has(nextPua)) nextPua++;
      if (nextPua > PUA_LIMIT) continue;
      entry.codeOf.set(gid, nextPua);
      assigned.add(nextPua++);
    }

    const glyphs: OutlineGlyph[] = [];
    // The cmap is built here rather than handed to the font builder, because a
    // code has to reach exactly one glyph. Every code a glyph was drawn with
    // goes in - a page that asks for it under its own name must find it - but a
    // code another glyph already owns is *left out*, not written twice: the
    // writer keeps the last glyph to claim one, so a second claim draws the
    // wrong letter. That is what `assigned` above is for, and this is where it
    // has to be honoured.
    const cmap = new Map<number, number>();
    for (const gid of gids) {
      const code = entry.codeOf.get(gid);
      if (code !== undefined && !cmap.has(code)) cmap.set(code, gid);
    }
    for (const gid of gids) {
      for (const code of entry.codesByGid.get(gid) ?? []) {
        if (!cmap.has(code)) cmap.set(code, gid);
      }
    }
    const codesOf = new Map<number, number[]>();
    for (const [code, gid] of cmap) {
      const list = codesOf.get(gid);
      if (list) list.push(code);
      else codesOf.set(gid, [code]);
    }

    // What the shaper will look up when it reads the letters of a ligature: the
    // cmap as the font is about to be written, backwards. A letter this font has
    // no glyph for is one the browser could not lay out, so the rule is not
    // written for it and the glyph stays reachable under its own character -
    // which is what every text upgrade did before there were rules at all.
    const byCode = new Map<number, number>();
    for (const [code, gid] of cmap) byCode.set(code, gid);
    const ligatures: LigatureSubstitution[] = [];
    for (const [gid, letters] of entry.letters) {
      if (!codesOf.has(gid) || [...letters].length < 2) continue;
      const components: number[] = [];
      let complete = true;
      for (const ch of letters) {
        const component = byCode.get(ch.codePointAt(0) ?? 0);
        if (component === undefined || component === gid || components.includes(component)) {
          complete = false;
          break;
        }
        components.push(component);
      }
      if (!complete) continue;
      ligatures.push({ letters: components, gid });
      entry.lettersOf.set(gid, letters);
    }

    for (const gid of gids) {
      const codes = codesOf.get(gid);
      // A glyph no code could be found for is not reachable anyway, and the
      // font builder's own last-resort numbering knows nothing about the codes
      // chosen above, so it would be free to collide with one of them.
      if (!codes || codes.length === 0) continue;
      glyphs.push({ gid, d: entry.outlines.get(gid) ?? '', codes, advanceEm: entry.advances.get(gid) });
    }
    if (glyphs.length === 0) return;

    const family = `wpdf-${hash([
      entry.key,
      ...glyphs.map((g) => `${g.gid}:${g.codes.join('.')}:${g.d}`),
      ...ligatures.map((l) => `liga:${l.gid}<${l.letters.join(',')}>`),
    ])}`;
    try {
      const { asset } = await registry.shared(family, glyphs, ligatures);
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
   * are the same bytes either way.
   *
   * Two entries can carry the same outlines - the same face embedded twice - and
   * either of them draws the page correctly, so a tie is not a reason to give
   * up: it is a reason to prefer the entry that would write the page's *own*
   * characters for those glyphs, and failing that the larger font, which is the
   * one more likely to still have the glyph next time. Refusing the page
   * instead would send it back to a face of its own, which is the one thing the
   * plan exists to avoid.
   */
  private match(
    fontId: number,
    gids: readonly number[],
    outlines: ReadonlyMap<string, GlyphOutline>,
    codes: ReadonlyMap<number, number>,
  ): Entry | null {
    let best: Entry | null = null;
    let bestScore = -1;
    for (const entry of this.entries.values()) {
      if (entry.outlines.size === 0) continue;
      let agrees = 0;
      let matches = true;
      for (const gid of gids) {
        if (entry.outlines.get(gid) !== outlines.get(glyphKey(fontId, gid))?.d) {
          matches = false;
          break;
        }
        const code = codes.get(gid);
        if (code !== undefined && entry.codeOf.get(gid) === code) agrees++;
      }
      if (!matches) continue;
      // Agreement first, then size: a page's characters are worth more than a
      // font's completeness, and neither is worth a coin toss.
      const score = agrees * 0x10000 + Math.min(entry.outlines.size, 0xffff);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  }
}
