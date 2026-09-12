/**
 * Reading glyphs out of the document's own font program.
 *
 * A PDF embeds a font program in four containers - Type 1 (`/FontFile`), a
 * TrueType subset (`/FontFile2`), a bare CFF table or a complete OpenType font
 * (`/FontFile3`) - and only the last is a web font. That looked like it meant
 * four conversions before any of them could be served to a browser.
 *
 * It does not. MuPDF will draw a glyph straight out of a program it is handed,
 * with no page and no PDF in sight: build an empty `Text`, `showGlyph` the glyph
 * ids wanted, and run it through the SVG writer. FreeType resolves the program
 * exactly as it does for the page, so the outlines come back *byte for byte*
 * identical to the ones the page's own SVG carries -
 * `tests/font-program.test.ts` holds that to account, glyph by glyph - and
 * `advanceGlyph` gives the width the program really declares, instead of the
 * distance to whatever glyph happened to be drawn next on the page.
 *
 * That is what makes a *document-wide* font possible at all. A font built from a
 * page's outlines covers the glyphs that page drew and nothing else, so a new
 * page means a new `@font-face`; a font built from the program covers every
 * glyph it can draw, so one face serves the whole document. Registering a face
 * re-lays-out the document it lands in, so "one face per document font" rather
 * than "one per page" is the difference between a viewer that can be one
 * document and one that has to give every page its own frame.
 */

import * as mupdf from 'mupdf';

/** Which descriptor key the program was found under. */
export type ProgramKey = 'FontFile' | 'FontFile2' | 'FontFile3';

export interface FontProgram {
  /** `/BaseFont` with its subset prefix left on: `AECCXO+NimbusRomNo9L-Regu`. */
  name: string;
  key: ProgramKey;
  bytes: Uint8Array;
}

/** Outlines and advances for one font, addressed by glyph id. */
export interface ProgramGlyphs {
  /** SVG path data in em units (1.0 == one em, y up); null when the glyph is blank. */
  outlines: Map<number, string | null>;
  /** Advance width in em units, as the program declares it. Absent when not > 0. */
  advances: Map<number, number>;
}

/**
 * The glyphs the SVG writer draws for a `font_N_gid` definition: one path, or an
 * empty group for a glyph with no outline at all (a space, or a mark).
 */
const RE_DEF_PATH = /<path id="font_(\d+)_(\d+)" d="([^"]*)"\s*\/>/g;

/**
 * A page box big enough for anything: the glyphs are drawn at the origin in em
 * units and an SVG writer does not clip, so the numbers are what matter, not the
 * window. Fixed so the output cannot depend on the page being read.
 */
const EXTRACT_BOX: [number, number, number, number] = [-4, -4, 4, 4];

/* ------------------------------------------------------------------ */
/* finding the programs                                                */

/**
 * Every embedded font program reachable from a page, keyed by `/BaseFont`.
 *
 * A font resource can be a Type 0 font whose descendant carries the descriptor,
 * which is the usual shape for a CID font, so both are followed. The first
 * program found under a name wins: that is the one FreeType would read.
 */
export function programsOnPage(page: mupdf.Page): Map<string, FontProgram> {
  const out = new Map<string, FontProgram>();
  if (!(page instanceof mupdf.PDFPage)) return out;
  // A page of a document that is not really a PDF can have no object at all, and
  // asking a null object for its resources is an error rather than an empty
  // answer. There is nothing to read either way.
  let fonts: mupdf.PDFObject | null = null;
  try {
    const object = page.getObject();
    fonts = object ? (object.getInheritable('Resources')?.get('Font') ?? null) : null;
  } catch {
    return out;
  }
  if (!fonts || fonts.isNull()) return out;

  try {
    fonts.forEach((font) => {
      const subtype = String(font.get('Subtype') ?? '');
      const descriptors: mupdf.PDFObject[] = [];
      if (subtype.includes('Type0') || subtype.includes('CIDFont')) {
        const descendants = font.get('DescendantFonts');
        for (let i = 0; i < descendants.length; i++) descriptors.push(descendants.get(i).get('FontDescriptor'));
      } else {
        descriptors.push(font.get('FontDescriptor'));
      }
      for (const descriptor of descriptors) {
        if (descriptor.isNull()) continue;
        const name = String(descriptor.get('FontName') ?? '').replace(/^\//, '');
        if (!name || out.has(name)) continue;
        for (const key of PROGRAM_KEYS) {
          const ref = descriptor.get(key);
          if (ref.isNull()) continue;
          const bytes = readStream(ref);
          if (bytes) out.set(name, { name, key, bytes });
          break;
        }
      }
    });
  } catch {
    // A malformed font dictionary costs this page its programs, not the render.
  }
  return out;
}

const PROGRAM_KEYS: readonly ProgramKey[] = ['FontFile', 'FontFile2', 'FontFile3'];

/**
 * The bytes of a stream object. `asUint8Array` is a view on the wasm heap, so it
 * is copied before the buffer that owns it is destroyed.
 */
function readStream(ref: mupdf.PDFObject): Uint8Array | null {
  let buffer: mupdf.Buffer | null = null;
  try {
    buffer = ref.readStream();
    const view = buffer.asUint8Array();
    return new Uint8Array(view);
  } catch {
    return null;
  } finally {
    buffer?.destroy();
  }
}

/**
 * A font the page actually drew with, as the display list sees it.
 *
 * The SVG's own `font_N` numbering cannot be predicted: it is not resource
 * order and it is not first use - a page can start at `font_4`, and one program
 * appears under several ids because a Form XObject carries its own copy of it.
 * What the display list does say, exactly, is which font drew which glyph and
 * what character that glyph stands for, so that is what a page's fonts are read
 * from.
 */
export interface PageFont {
  /** `Font.getName()`: the `/BaseFont`, with its subset prefix. */
  name: string;
  /** The embedded program, or null for a font FreeType substituted (base 14). */
  program: FontProgram | null;
  /** Every glyph id the page drew from this font. */
  gids: Set<number>;
  /** gid -> the code point it was drawn for. The first one wins. */
  codes: Map<number, number>;
}

/**
 * Walk the page's display list and report every font it drew with, in first-use
 * order.
 *
 * Every text callback is followed - a glyph shown as a clip still counts, and
 * leaving one out would leave its font unknown. Nothing is drawn: the device
 * does nothing but look, which is why a whole document can be walked for a font
 * plan at a cost of a couple of milliseconds a page.
 */
export function pageFonts(page: mupdf.Page, programs?: Map<string, FontProgram>): PageFont[] {
  return pageGlyphs(page, programs).fonts;
}

/** One glyph the page drew: which font, which id, for which code, and where. */
export interface GlyphDraw {
  /** Index into `PageGlyphs.fonts`. */
  fontId: number;
  gid: number;
  /** The code point the display list recorded for it, or 0. */
  code: number;
  /**
   * The glyph's text matrix, in the page's own coordinates - the same ones the
   * generated SVG and the text device's characters use (y down from the top of
   * the page). The display list hands this over y *up*, which is why it is
   * turned round here: everything that pairs a glyph with a character, a
   * ligature above all, matches them by this origin.
   */
  matrix: { a: number; b: number; c: number; d: number; e: number; f: number };
}

export interface PageGlyphs {
  fonts: PageFont[];
  /** Every glyph the page drew, in the order it drew them. */
  draws: GlyphDraw[];
}

/**
 * The page's fonts and the glyph stream they drew, from one walk.
 *
 * `visit` is called once per font instance with the handle the display list
 * used, before this returns and while the page is still alive. It exists for
 * the fonts that have no program to read - the base-14 faces FreeType
 * substitutes - which can still be drawn, but only through their handle.
 */
export function pageGlyphs(
  page: mupdf.Page,
  programs?: Map<string, FontProgram>,
  visit?: (handle: mupdf.Font, fontId: number, font: PageFont) => void,
): PageGlyphs {
  const known = programs ?? programsOnPage(page);
  const fonts: PageFont[] = [];
  const byName = new Map<string, number>();
  const handles: mupdf.Font[] = [];
  const draws: GlyphDraw[] = [];

  // The display list reports a glyph's origin with y running *up* the page; the
  // SVG writer, and the text device the ligatures are read from, both run it
  // down. Folding the box turns one into the other, which is what lets a glyph
  // be paired with the characters standing at the same point.
  const bounds = page.getBounds();
  const fold = bounds[1] + bounds[3];

  const note = (font: mupdf.Font, trm: mupdf.Matrix, gid: number, unicode: number): void => {
    // MuPDF reports -1 for a glyph it could not resolve.
    if (!Number.isInteger(gid) || gid < 0) return;
    let name: string;
    try {
      name = font.getName();
    } catch {
      return;
    }
    let fontId = byName.get(name);
    if (fontId === undefined) {
      fontId = fonts.length;
      byName.set(name, fontId);
      handles.push(font);
      fonts.push({ name, program: known.get(name) ?? null, gids: new Set(), codes: new Map() });
    }
    const entry = fonts[fontId];
    entry.gids.add(gid);
    // The first code wins for a gid, as the SVG's own `data-text` does.
    if (unicode > 0 && !entry.codes.has(gid)) entry.codes.set(gid, unicode);
    draws.push({
      fontId,
      gid,
      code: unicode,
      matrix: { a: trm[0], b: trm[1], c: trm[2], d: -trm[3], e: trm[4], f: fold - trm[5] },
    });
  };
  const walk = (text: mupdf.Text): void => {
    text.walk({
      showGlyph: (font: mupdf.Font, trm: mupdf.Matrix, gid: number, unicode: number) => note(font, trm, gid, unicode),
    });
  };
  const device = new mupdf.Device({
    fillText: walk,
    strokeText: walk,
    clipText: walk,
    clipStrokeText: walk,
    ignoreText: walk,
  });
  try {
    page.run(device, mupdf.Matrix.identity);
  } finally {
    device.close();
    device.destroy();
  }
  if (visit) for (let i = 0; i < fonts.length; i++) visit(handles[i], i, fonts[i]);
  return { fonts, draws };
}

/* ------------------------------------------------------------------ */
/* reading the glyphs                                                  */

/** Draw `gids` out of an already-loaded font and read back what it declared. */
export function glyphsFromFont(font: mupdf.Font, gids: readonly number[]): ProgramGlyphs {
  const advances = new Map<number, number>();
  const drawable: number[] = [];
  for (const gid of gids) {
    // MuPDF reports -1 for a glyph it could not resolve, and FreeType answers
    // with a warning on stderr rather than an error. Nothing to draw, nothing
    // to ask about.
    if (!Number.isInteger(gid) || gid < 0) continue;
    let advance = 0;
    try {
      advance = font.advanceGlyph(gid);
    } catch {
      advance = 0;
    }
    if (Number.isFinite(advance) && advance > 0) advances.set(gid, advance);
    drawable.push(gid);
  }
  return { outlines: drawGlyphs(font, drawable), advances };
}

/** Draw `gids` out of an embedded program, by loading it the way MuPDF would. */
export function glyphsFromProgram(program: FontProgram, gids: readonly number[]): ProgramGlyphs {
  if (gids.length === 0) return { outlines: new Map(), advances: new Map() };
  const font = new mupdf.Font(program.name, program.bytes, 0);
  try {
    return glyphsFromFont(font, gids);
  } finally {
    font.destroy();
  }
}

/**
 * Ask MuPDF to draw every glyph at the origin, and read the paths back.
 *
 * One `Text` for the whole set, so one pass and one SVG: the writer numbers the
 * font once and every glyph lands under the same `font_N`. A glyph the program
 * cannot draw (an id past its end, a blank) is emitted as an empty group, and
 * comes back null rather than missing, so a caller can tell "blank" from "not
 * asked for".
 */
function drawGlyphs(font: mupdf.Font, gids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (gids.length === 0) return out;

  const text = new mupdf.Text();
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'svg', { text: 'path' });
  try {
    for (const gid of gids) {
      if (out.has(gid)) continue;
      // Present and null from the start, so a caller can tell a blank glyph from
      // one that was never asked for.
      out.set(gid, null);
      try {
        text.showGlyph(font, mupdf.Matrix.identity, gid, 0);
      } catch {
        /* an id this program has no glyph for */
      }
    }

    const device = writer.beginPage(EXTRACT_BOX);
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    device.close();
    writer.endPage();
    writer.close();

    for (const m of buffer.asString().matchAll(RE_DEF_PATH)) out.set(Number(m[2]), m[3]);
  } finally {
    writer.destroy();
    buffer.destroy();
    text.destroy();
  }
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * An identity for a program that two pages of the same document agree on.
 *
 * Content-addressed, because that is what a family name has to be: two subsets
 * are the same font exactly when their bytes are, and the subset prefix a
 * producer chose is not evidence either way.
 */
export function programId(program: FontProgram): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < program.bytes.length; i++) {
    hash ^= program.bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${program.key}|${program.bytes.length}|${(hash >>> 0).toString(36)}`;
}
