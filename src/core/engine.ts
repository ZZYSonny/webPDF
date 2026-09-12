/**
 * Document + page rendering on top of MuPDF.js.
 *
 * Pages are rendered in *outline* mode, which is always visually correct, and
 * then upgraded to real text glyph-by-glyph (see `svg/text-upgrade.ts`). The
 * engine owns the MuPDF document, the font registry and the glyph cache, and is
 * deliberately free of DOM access so the exact same code can run on the main
 * thread, inside a Web Worker, or under Node for tests.
 */

import * as mupdf from 'mupdf';
import { scanGlyphOutlines, scanGlyphPlacements } from './svg/glyphs.ts';
import { upgradeGlyphsToText } from './svg/text-upgrade.ts';
import { FontRegistry, type FontAsset } from './font/registry.ts';
import { DocumentFontPlan, type FontPlanProgress } from './font/plan.ts';
import { debug } from './debug.ts';
import { inlineFontCss, namespaceSvgIds, readSvgDimensions, rewriteSvgRoot, stripXmlProlog } from './svg/package.ts';
import { injectSvgLinks, type PageLink } from './links.ts';
import {
  contentBox,
  cropViewBox,
  normaliseRules,
  padBox,
  quadBox,
  unionBox,
  type CropRect,
  type CropRuleId,
  type CropSpan,
} from './crop.ts';
import { spaceMarks, type SpaceMark, type TextChar } from './svg/spaces.ts';
import { glyphLetters } from './svg/ligatures.ts';

export type PdfSource =
  | ArrayBuffer
  | Uint8Array
  | Blob
  | { url: string; headers?: Record<string, string> }
  | string;

export interface PageGeometry {
  width: number;
  height: number;
}

export interface OutlineNode {
  title: string;
  page: number; // 1-based, -1 when the destination is not a page
  uri?: string;
  open: boolean;
  children: OutlineNode[];
}

export interface DocumentInfo {
  pageCount: number;
  title: string;
  author: string;
  subject: string;
  producer: string;
  outline: OutlineNode[];
  pages: PageGeometry[];
  labels: string[];
  encrypted: boolean;
}

export type TextMode = 'auto' | 'paths';

export interface RenderOptions {
  textMode?: TextMode;
  /** Unique per page; used to keep `url(#...)` references apart in one document. */
  idPrefix?: string;
  /** Rewrite the root `<svg>` to fill its container. Default true. */
  responsive?: boolean;
  className?: string;
  /**
   * Embed the page's `@font-face` rules inside the SVG. Needed for standalone
   * SVG (export, `<img src>`, a downloaded file); pointless when the host page
   * already carries the stylesheet.
   */
  embedFonts?: boolean;
  /**
   * Add a clickable hit area for every link annotation. Default true. They are
   * invisible, so this costs bytes rather than fidelity; `links` on the result
   * carries the same links as data either way.
   */
  links?: boolean;
  /**
   * Crop the page to its content, minus the marks these rules name (see
   * `crop.ts`). The crop is a `viewBox`, so the SVG keeps every element it had
   * and only shows a smaller part of the page - nothing is removed, and the
   * result is still the whole page's text, selectable and searchable.
   * Empty or omitted: no crop, the page as it is.
   */
  crop?: readonly CropRuleId[] | null;
  /**
   * Page units to grow the crop by, on every side, without measuring anything
   * again: the content box is what the rules produce, and this is how much of
   * the margin around it to keep. Stopped by the page's own edges. Default 0,
   * which is what the reference script crops to.
   */
  cropPadding?: number;
  /**
   * Bionic reading: hold every word's first letters at full strength and fade
   * the rest, so the eye has somewhere to land. The words have to be words, so
   * this is only as good as the spaces in the text - which are written back in
   * whatever this is set to (see `svg/spaces.ts`). Default false: a page looks
   * like the document.
   */
  bionic?: boolean;
  /**
   * How much strength the faded part of each word keeps, 0..1. `BIONIC_DIM` (a
   * half) when omitted, which is the balance the eye wants; only meaningful
   * while `bionic` is on.
   */
  bionicDim?: number;
}

export interface RenderStats {
  glyphsDrawn: number;
  glyphsAsText: number;
  glyphsAsOutlines: number;
  textRuns: number;
  /** Space characters put back into the text: what makes words out of glyphs. */
  spaces: number;
  fontsBuilt: number;
  fontsReused: number;
  ms: number;
}

export interface RenderedPage {
  index: number;
  svg: string;
  width: number;
  height: number;
  /** The crop the SVG was given, in page units, or null when it is uncropped. */
  crop: CropRect | null;
  fonts: FontAsset[];
  /** The page's link annotations, in the page's own coordinates. */
  links: PageLink[];
  stats: RenderStats;
}

export interface EngineOptions {
  /** Embed raw TrueType instead of WOFF (bigger, but no zlib needed). */
  disableCompression?: boolean;
  onWarn?: (message: string) => void;
  /**
   * Plan the document's fonts as one face per *font*, for the whole document,
   * in the background. Default true.
   *
   * The plan is what lets every page be drawn in one document: a face built
   * from the document's own font programs serves every page that uses the font,
   * so nothing registers while the reader scrolls - and registering a face
   * re-lays-out every text run of the document it lands in. Building it is not
   * free (0.6-2.3 s over the corpus papers, 18.3 s for a 756-page
   * specification), so it is never done before the first page: `open` returns
   * as soon as the document is read, pages are drawn from their own fonts while
   * the plan runs, and a host that wants the planned document waits for
   * `planDone()` or watches `planProgress()`.
   *
   * `false` turns it off: every page builds a face from the glyphs it drew,
   * which is what a standalone SVG wants (see `renderDocument`) and what a
   * viewer drawing each page in its own frame wants. See `core/font/plan.ts`.
   */
  planFonts?: boolean;
}

/**
 * The surface the viewer needs from a rendering backend.
 *
 * `PdfEngine` implements it directly; a Web Worker proxy can implement the same
 * shape, which is what lets the viewer move off the main thread without any
 * change to its own code.
 */
export interface PdfEngineLike {
  open(source: PdfSource, password?: string): Promise<DocumentInfo>;
  renderPage(index: number, opts?: RenderOptions): Promise<RenderedPage>;
  /**
   * The box a page would be cropped to under these rules, without rendering it.
   * A viewer needs this ahead of the render, because the cropped size of every
   * page is what its scroll layout is built from.
   *
   * Optional: an engine that cannot read page content boxes this way is still a
   * usable engine, and a viewer that gets no answer simply does not crop.
   */
  measureCrop?(index: number, rules: readonly CropRuleId[]): Promise<CropRect | null>;
  /**
   * Write the open document out again, as a fresh PDF.
   *
   * Optional, like `measureCrop`: an engine that cannot write a document out is
   * still a usable engine. What comes back has no encryption on it, because the
   * caller is the application that has the document open - which is to say one
   * that has already answered for it - and whatever it is handing the bytes to
   * has not.
   */
  save?(): Promise<Uint8Array>;
  drainNewFonts(): FontAsset[];
  /**
   * How far the document's font plan has got, or null when this engine is not
   * planning one (see `EngineOptions.planFonts`).
   */
  planProgress?(): FontPlanProgress | null;
  /**
   * Called when the plan is ready, and immediately (on a later turn) when it
   * already is. Returns the unsubscribe.
   */
  onPlanReady?(cb: () => void): () => void;
  /**
   * Every face the plan has built. A host that is about to draw the document as
   * one document wants them all at once: registering a face re-lays-out every
   * text run in the document however many rules arrive with it, so the one
   * write is the cheapest there is.
   */
  plannedFonts?(): FontAsset[] | Promise<FontAsset[]>;
  /** Resolves when the plan has finished, been cancelled, or was never started. */
  planDone?(): Promise<void>;
  /** Optional: drop everything outside `keep` so memory stays bounded. */
  trimCaches?(keep: readonly number[]): void;
  /** True for a worker-backed engine. Purely informational. */
  readonly isWorkerBacked?: boolean;
  close(): void;
}

export class PasswordRequiredError extends Error {
  constructor() {
    super('This document is password protected');
    this.name = 'PasswordRequiredError';
  }
}

/**
 * What the text pass asks MuPDF for: the vectors and the images as well as the
 * text, so one walk of a page answers everything the crop rules need. (The key
 * is `vectors`, not the `FZ_STEXT_COLLECT_VECTORS` name it comes from.)
 */
const TEXT_OPTIONS = 'vectors=1,preserve-images=1';

/**
 * How often a long measurement hands memory back. Reading every page of a
 * 756-page document one after another runs the wasm store out of room long
 * before the last page otherwise - the same reason `trimCaches` exists.
 */
const SHRINK_EVERY = 32;

export class DocumentNotOpenError extends Error {
  constructor() {
    super('No document is open');
    this.name = 'DocumentNotOpenError';
  }
}

/**
 * One turn of the event loop, as a *macrotask*.
 *
 * The plan walks in slices, and a slice boundary has to be a real turn: the
 * walk's slices are continuations of one another in the microtask queue, so a
 * boundary that awaited an already-resolved promise would go straight on to the
 * next page and nothing else would run until the walk was over - not the
 * worker's message queue, so an `open` still being answered and a page the
 * reader has asked for would both wait for the whole walk, and not the page
 * itself when the engine is inline.
 *
 * A message channel rather than `setTimeout(0)`: the same turn of the event
 * loop, without the clamp a nested timer picks up - a corpus paper is a few
 * hundred slices, so the clamp would be a tax on the plan for nothing.
 */
function turn(): Promise<void> {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0));
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

async function readSource(source: PdfSource): Promise<Uint8Array> {
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch ${source}: ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const { url, headers } = source as { url: string; headers?: Record<string, string> };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Shape of the objects `Document.loadOutline()` returns. */
interface RawOutlineItem {
  title?: string | undefined;
  page?: number | undefined;
  uri?: string | undefined;
  open?: boolean | undefined;
  down?: RawOutlineItem[] | undefined;
}

function toOutline(items: RawOutlineItem[] | null): OutlineNode[] {
  if (!items) return [];
  return items.map((it) => ({
    title: it.title ?? '',
    page: typeof it.page === 'number' ? it.page + 1 : -1,
    uri: it.uri,
    open: !!it.open,
    children: toOutline(it.down ?? null),
  }));
}

/**
 * Every link annotation on a page, as plain data.
 *
 * Nothing here is allowed to fail the page: a broken annotation is skipped, an
 * unresolvable destination is reported with page -1 (the viewer then leaves it
 * alone rather than inventing a target), and an unknown URI is reported as it is
 * - deciding what is safe to open is `links.ts`'s job, at the point where an
 * `href` would be written.
 */
/**
 * Every text run on a page, with the box it occupies.
 *
 * MuPDF reports characters, not spans; a span is the run of characters that
 * share a font, a size and a colour, which is how PyMuPDF groups them and
 * therefore how PaperCutter's rules see the page. Grouping them the same way
 * matters: "3.1." and the heading it introduces are one span when they are set
 * in one style, and the rule for a section number then takes the whole heading
 * out of the box - exactly as the reference script does.
 */
function readSpans(page: mupdf.Page): CropSpan[] {
  const spans: CropSpan[] = [];
  let run: CropSpan | null = null;
  let key = '';
  const stext = page.toStructuredText(TEXT_OPTIONS);
  try {
    stext.walk({
      beginLine() {
        run = null;
      },
      onChar: (c, _origin, font, size, quad, color) => {
        const style = `${font.getName()}|${size}|${color.join(',')}`;
        if (!run || style !== key) {
          key = style;
          run = { text: '', box: quadBox(quad) };
          spans.push(run);
        }
        run.text += c;
        // A quad is four corners, and a span is the box around all of them.
        run.box = unionBox(run.box, quadBox(quad));
      },
      endLine() {
        run = null;
      },
    });
  } finally {
    stext.destroy();
  }
  return spans;
}

/**
 * Everything the text device has to say about a page, on one walk of it.
 *
 * The SVG the outline device produces has no spaces in it - a space has no
 * outline, so there is nothing to draw and nothing to reference - and it names a
 * ligature by its first letter only. Both are read here, from the same page, and
 * both are written back into the text: the spaces (`svg/spaces.ts`) turn
 * "linearattention" into two words for a reader copying it and a word-level tool
 * finding them, and the ligatures (`svg/ligatures.ts`) say what the one glyph a
 * typesetter drew for two letters actually stands for. Text only: the vectors
 * and images a crop rule wants are asked for by `readSpans`.
 */
function readText(page: mupdf.Page): { chars: TextChar[]; spaces: SpaceMark[] } {
  const chars: TextChar[] = [];
  let line = 0;
  // No options: this walk wants the characters and their origins, and asking
  // for the vectors and images as well would read the whole page's graphics to
  // throw them away.
  const stext = page.toStructuredText('');
  try {
    stext.walk({
      beginLine() {
        line++;
      },
      onChar: (c, origin) => chars.push({ text: c, x: origin[0], y: origin[1], line }),
    });
  } finally {
    stext.destroy();
  }
  return { chars, spaces: spaceMarks(chars) };
}

/** The box a rectangle in one space occupies in another, corners and all. */
function mappedBox(rect: readonly number[], ctm: mupdf.Matrix): CropRect {
  const [a, b, c, d, e, f] = ctm;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[0], rect[3]],
    [rect[2], rect[3]],
  ]) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The boxes of everything the page draws - the `get_bboxlog()` half of
 * PaperCutter, which keeps a figure or a table frame in the crop while a
 * hairline or a clipped-away path stays out of it.
 *
 * A device rather than a display list, because the kinds that matter
 * (`fill-path`, `stroke-path`, `fill-image`, `fill-shade`) are the device's own
 * callbacks, and each one arrives with the full transform already applied.
 * `image` and `shade` belong to the caller for the length of the call and must
 * not be dropped here; `path` and `stroke` are kept for us, and are.
 */
function readDrawings(page: mupdf.Page): CropRect[] {
  const boxes: CropRect[] = [];
  // A fill has no stroke state, and the runtime takes `null` for exactly that
  // ("if (strokeState !== null) checkType(...)"), but the published typings ask
  // for a `StrokeState`. One cast, here, rather than a wrong stroke width.
  const noStroke = null as unknown as mupdf.StrokeState;
  const device = new mupdf.Device({
    fillPath(path, _evenOdd, ctm) {
      boxes.push(boxOf(path.getBounds(noStroke, ctm)));
      path.destroy();
    },
    strokePath(path, stroke, ctm) {
      boxes.push(boxOf(path.getBounds(stroke, ctm)));
      path.destroy();
      stroke.destroy();
    },
    fillImage(_image, ctm) {
      boxes.push(mappedBox([0, 0, 1, 1], ctm));
    },
    fillShade(shade, ctm) {
      boxes.push(mappedBox(shade.getBounds(), ctm));
    },
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
  } finally {
    device.close();
    device.destroy();
  }
  return boxes;
}

function boxOf(rect: readonly number[]): CropRect {
  return { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] };
}

function readLinks(doc: mupdf.Document, page: mupdf.Page): PageLink[] {
  const out: PageLink[] = [];
  let links: mupdf.Link[];
  try {
    links = page.getLinks();
  } catch {
    return out;
  }
  for (const link of links) {
    try {
      const b = link.getBounds();
      const rect: [number, number, number, number] = [b[0], b[1], b[2], b[3]];
      if (!rect.every((v) => Number.isFinite(v))) continue;
      const uri = link.getURI();
      if (link.isExternal()) {
        out.push({ kind: 'external', rect, uri });
        continue;
      }
      let page1 = -1;
      let x: number | null = null;
      let y: number | null = null;
      try {
        const dest = doc.resolveLinkDestination(link);
        if (typeof dest.page === 'number' && dest.page >= 0) {
          page1 = dest.page + 1;
          if (Number.isFinite(dest.x)) x = dest.x;
          if (Number.isFinite(dest.y)) y = dest.y;
        }
      } catch {
        /* a named destination that is not there: keep the link, drop the target */
      }
      out.push({ kind: 'internal', rect, page: page1, x, y });
    } catch {
      /* one bad annotation is not worth losing the rest of the page */
    }
  }
  return out;
}

export class PdfEngine implements PdfEngineLike {
  private doc: mupdf.Document | null = null;
  private registry: FontRegistry;
  private pageCache = new Map<number, mupdf.Page>();
  /** Measured crop boxes, keyed by rule set and page. Small: four numbers each. */
  private boxCache = new Map<string, CropRect | null>();
  private measured = 0;
  private info: DocumentInfo | null = null;
  private readonly opts: EngineOptions;
  /** One face per font for the whole document, walking in the background. */
  private plan: DocumentFontPlan | null = null;
  /** The walk itself, so a caller can wait for the planned document. */
  private planning: Promise<void> | null = null;
  /** Renders and measurements in flight. The plan gives way to these. */
  private busy = 0;
  private readonly planListeners = new Set<() => void>();

  constructor(opts: EngineOptions = {}) {
    this.opts = opts;
    this.registry = new FontRegistry({ disableCompression: opts.disableCompression, onWarn: opts.onWarn });
  }

  /** The faces the document font plan has built, for a host that wants them all. */
  plannedFonts(): FontAsset[] {
    return this.plan?.families() ?? [];
  }

  /** How far the plan has got, or null when this document is not planned. */
  planProgress(): FontPlanProgress | null {
    return this.plan ? this.plan.progress() : null;
  }

  /**
   * Called once, when the planned document is ready to be drawn.
   *
   * The subscription is about the plan of the document that is open: opening
   * another one clears it, because a listener that heard "ready" for the
   * document before this one has nothing to say about this one.
   */
  onPlanReady(cb: () => void): () => void {
    this.planListeners.add(cb);
    // A plan that is already ready is not going to say so again, and a host
    // that registers late - a viewer handed a one-page document, say - still
    // has to hear it.
    if (this.plan?.planned) setTimeout(cb, 0);
    return () => this.planListeners.delete(cb);
  }

  /** Resolves when the background walk is done, one way or another. */
  planDone(): Promise<void> {
    return this.planning ?? Promise.resolve();
  }

  private notifyPlanReady(): void {
    for (const cb of [...this.planListeners]) {
      try {
        cb();
      } catch (error) {
        this.opts.onWarn?.(`a plan-ready listener failed: ${String(error)}`);
      }
    }
  }

  /**
   * Hand the thread back for a turn, and wait until nothing more urgent is in
   * flight.
   *
   * The plan walks on the same thread the pages are rendered on, so a page the
   * reader asked for is only not queued behind it because the plan checks. One
   * turn of the event loop at a time, because a render is several of them (it
   * has awaits of its own) and the plan must not hold the thread while it waits.
   *
   * The turn comes first, and it happens whether or not anything has arrived:
   * `busy` counts what is already in flight, and the request this is meant to
   * give way to may still be sitting in the message queue where `busy` cannot
   * see it. A boundary that skipped the turn because nothing had arrived would
   * be no boundary at all - the plan walks in slices of its own, each one the
   * microtask continuation of the last, so it would walk the whole document
   * without the thread ever being handed back.
   */
  private async idle(): Promise<void> {
    do {
      await turn();
    } while (this.busy > 0);
  }

  /** Every `@font-face` rule discovered so far, newest last. */
  fontStylesheet(): string {
    return this.registry.stylesheet();
  }

  /** Fonts registered since the last call, so a host can append them. */
  drainNewFonts(): FontAsset[] {
    const all = this.registry.assets();
    const out = all.slice(this.drained);
    this.drained = all.length;
    return out;
  }

  private drained = 0;

  get isOpen(): boolean {
    return this.doc !== null;
  }

  get documentInfo(): DocumentInfo {
    if (!this.info) throw new DocumentNotOpenError();
    return this.info;
  }

  async open(source: PdfSource, password?: string): Promise<DocumentInfo> {
    this.close();
    this.planListeners.clear();
    const bytes = await readSource(source);
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    if (doc.needsPassword()) {
      if (!password || doc.authenticatePassword(password) === 0) {
        doc.destroy();
        throw new PasswordRequiredError();
      }
    }
    this.doc = doc;
    this.info = this.readInfo(doc);
    // The document's fonts are planned from here, in the *background*: a page is
    // drawn with its own face until the plan is ready, and `planProgress` /
    // `onPlanReady` say when the pages can become one document. Nothing below
    // waits for it - which is the whole point, because planning a 756-page
    // specification is 18 seconds that have no business being in front of the
    // first page.
    this.plan = null;
    this.planning = null;
    if (this.opts.planFonts !== false) {
      const plan = new DocumentFontPlan({
        onWarn: this.opts.onWarn,
        onProgress: (progress) => {
          if (progress.ready) this.notifyPlanReady();
        },
      });
      this.plan = plan;
      this.planning = plan.start(doc, this.registry, {
        pause: () => this.idle(),
        // The document this walk belongs to: `close` drops it before it destroys
        // anything, so a walk that comes back after that stops where it is
        // rather than reading a page out of a document that is gone.
        cancelled: () => this.doc !== doc,
      });
    }
    return this.info;
  }

  private readInfo(doc: mupdf.Document): DocumentInfo {
    const pageCount = doc.countPages();
    const pages: PageGeometry[] = new Array(pageCount);
    const labels: string[] = new Array(pageCount);
    for (let i = 0; i < pageCount; i++) {
      const page = this.loadPage(i);
      const b = page.getBounds();
      pages[i] = { width: b[2] - b[0], height: b[3] - b[1] };
      try {
        labels[i] = page.getLabel();
      } catch {
        labels[i] = String(i + 1);
      }
    }
    // Measuring every page must not pin every page in memory.
    this.trimCaches([]);
    return {
      pageCount,
      title: doc.getMetaData('info:Title') ?? '',
      author: doc.getMetaData('info:Author') ?? '',
      subject: doc.getMetaData('info:Subject') ?? '',
      producer: doc.getMetaData('info:Producer') ?? '',
      outline: toOutline(doc.loadOutline()),
      pages,
      labels,
      encrypted: doc.needsPassword(),
    };
  }

  /**
   * Write the open document out again: MuPDF's own copy of it, compressed and
   * with no encryption on it.
   *
   * Not the bytes the document was opened from. Those are whatever the reader's
   * file was, and this is a fresh write of the same document, so this is for
   * handing the document on - to a printer above all, since a PDF is exactly
   * what a printer wants and a password the printer does not have is exactly
   * what it must not be handed. Saving a file a reader chose is a different
   * job, and the page does that with the file itself.
   */
  async save(): Promise<Uint8Array> {
    if (!this.doc) throw new DocumentNotOpenError();
    // Only a PDF can be written out, and only a PDF is ever opened here: the
    // document is the one this engine was handed as `application/pdf`.
    const buffer = (this.doc as mupdf.PDFDocument).saveToBuffer({ encrypt: 'none', compress: true });
    try {
      // `asUint8Array` is a *view* into MuPDF's memory rather than a copy of it,
      // and that memory is freed by `destroy` below. The bytes are the whole
      // point of the call, so they are copied out of it before it goes.
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  }

  private loadPage(index: number): mupdf.Page {
    if (!this.doc) throw new DocumentNotOpenError();
    let page = this.pageCache.get(index);
    if (!page) {
      page = this.doc.loadPage(index);
      this.pageCache.set(index, page);
    }
    return page;
  }

  /**
   * The box this page's content occupies under `rules` - before any padding,
   * which is a render-time matter (`cropPadding`) and costs nothing to change.
   *
   * Reading a page costs a few milliseconds and is asked for once per page per
   * rule set, so the answers are kept: toggling a rule off and on again is then
   * free rather than a second pass over the document. `null` means "nothing to
   * crop to" - an empty page, or no rules - and the page keeps its own size.
   */
  async measureCrop(index: number, rules: readonly CropRuleId[]): Promise<CropRect | null> {
    this.busy++;
    try {
      return await this.measurePageCrop(index, rules);
    } finally {
      this.busy--;
    }
  }

  private async measurePageCrop(index: number, rules: readonly CropRuleId[]): Promise<CropRect | null> {
    const wanted = normaliseRules(rules);
    if (wanted.length === 0) return null;
    const key = `${wanted.join(',')}|${index}`;
    const cached = this.boxCache.get(key);
    if (cached !== undefined) return cached;

    const page = this.loadPage(index);
    const bounds = page.getBounds('CropBox');
    const box = contentBox({
      spans: readSpans(page),
      drawings: readDrawings(page),
      page: boxOf(bounds),
      title: this.info?.title ?? '',
      rules: wanted,
    });
    debug('measureCrop', index, wanted.join(','), box);
    // A document's worth of pages is the normal case, so the store is handed
    // back periodically rather than only when a caller asks.
    if (++this.measured % SHRINK_EVERY === 0) this.shrink();
    // Two rule sets is the common case (one on, one off); anything past a few
    // means a host is cycling through selections, and the oldest go first.
    if (this.boxCache.size > this.info!.pageCount * 4) {
      for (const oldest of this.boxCache.keys()) {
        this.boxCache.delete(oldest);
        if (this.boxCache.size <= this.info!.pageCount * 2) break;
      }
    }
    this.boxCache.set(key, box);
    return box;
  }

  private shrink(): void {
    try {
      mupdf.shrinkStore(50);
    } catch {
      /* not fatal */
    }
  }

  /** Render one page to SVG, upgrading glyphs to text where it is provably safe. */
  async renderPage(index: number, opts: RenderOptions = {}): Promise<RenderedPage> {
    // A page is a reader waiting, and the plan is not: nothing in this method
    // has to think about the walk, because the walk yields to whatever is in
    // here (see `idle`).
    this.busy++;
    try {
      return await this.renderPageNow(index, opts);
    } finally {
      this.busy--;
    }
  }

  private async renderPageNow(index: number, opts: RenderOptions = {}): Promise<RenderedPage> {
    const started = Date.now();
    const textMode = opts.textMode ?? 'auto';
    const doc = this.doc;
    if (!doc) throw new DocumentNotOpenError();
    const page = this.loadPage(index);
    const links = opts.links === false ? [] : readLinks(doc, page);
    const content = await this.measureCrop(index, opts.crop ?? []);
    // Padding is applied here rather than in `measureCrop`, so changing it is a
    // re-render and never a re-measure.
    const crop = content ? padBox(content, opts.cropPadding ?? 0, boxOf(page.getBounds('CropBox'))) : null;

    debug('renderPage: mupdf render', index);
    // MuPDF objects are only finalised on GC, which is far too late when a long
    // scroll renders hundreds of pages, so every intermediate is released here.
    const buf = new mupdf.Buffer();
    const writer = new mupdf.DocumentWriter(buf, 'svg', { text: 'path' });
    let svg: string;
    try {
      const device = writer.beginPage(page.getBounds());
      page.run(device, mupdf.Matrix.identity);
      writer.endPage();
      writer.close();
      svg = buf.asString();
    } finally {
      writer.destroy();
      buf.destroy();
    }

    debug('renderPage: svg bytes', svg.length);
    const stats: RenderStats = {
      glyphsDrawn: 0,
      glyphsAsText: 0,
      glyphsAsOutlines: 0,
      textRuns: 0,
      spaces: 0,
      fontsBuilt: 0,
      fontsReused: 0,
      ms: 0,
    };
    let fonts: FontAsset[] = [];

    if (textMode !== 'paths') {
      const outlines = scanGlyphOutlines(svg);
      const placements = scanGlyphPlacements(svg);
      stats.glyphsDrawn = placements.length;

      if (placements.length > 0) {
        debug('renderPage: plan fonts', placements.length, 'placements', outlines.size, 'outlines');
        const text = readText(page);
        const letters = glyphLetters(text.chars, placements);
        // The document plan, once it is ready: a font it knows is one face
        // shared by every page, and the page never registers anything of its
        // own. A page it cannot place - a font it never saw, a glyph it never
        // drew, or a plan that is still being walked - falls back to building
        // the page's own font, which is always correct.
        const ready = this.plan?.planned ? this.plan : null;
        const pagePlan =
          (await ready?.planPage(outlines, placements, { letters })) ??
          (await this.registry.planPage(outlines, placements, { letters }));
        debug('renderPage: planned', pagePlan.fonts.size, 'fonts');
        stats.fontsBuilt = pagePlan.built;
        stats.fontsReused = pagePlan.reused;
        const upgraded = upgradeGlyphsToText(
          svg,
          placements,
          {
            familyFor: (fontId) => pagePlan.fonts.get(fontId)?.family ?? null,
            codeFor: (fontId, gid) => pagePlan.fonts.get(fontId)?.codes.get(gid) ?? null,
            lettersFor: (fontId, gid) => pagePlan.fonts.get(fontId)?.letters.get(gid) ?? null,
          },
          { spaces: text.spaces, bionic: opts.bionic, bionicDim: opts.bionicDim },
        );
        svg = upgraded.svg;
        debug('renderPage: upgraded', upgraded.stats);
        stats.textRuns = upgraded.stats.runs;
        stats.glyphsAsText = upgraded.stats.converted;
        stats.glyphsAsOutlines = upgraded.stats.kept;
        stats.spaces = upgraded.stats.spaces;
        fonts = pagePlan.assets;
      }
    }

    svg = stripXmlProlog(svg);
    if (opts.idPrefix) svg = namespaceSvgIds(svg, opts.idPrefix);
    // After the id rewriting, so the hit areas cannot be caught by it: they carry
    // a `data-` copy of the target rather than a fragment `href` that would have
    // to be namespaced too.
    svg = injectSvgLinks(svg, links);
    if (opts.embedFonts && fonts.length) {
      svg = inlineFontCss(svg, fonts.map((f) => f.css).join('\n'));
    }
    // The crop is a `viewBox` on the root: the page keeps every element it had,
    // and the reader sees a window onto it. Applied last, so nothing above had
    // to know about it - coordinates inside the SVG are the page's own either
    // way, which is also what keeps the link hit areas and the search bands
    // where they were.
    svg = rewriteSvgRoot(svg, {
      className: opts.className,
      responsive: opts.responsive,
      viewBox: crop ? cropViewBox(crop) : undefined,
    });

    const dims = readSvgDimensions(svg) ?? { width: 612, height: 792, viewBox: '' };
    stats.ms = Date.now() - started;

    return { index, svg, width: dims.width, height: dims.height, crop, fonts, links, stats };
  }

  /** Release a page and its cached resources. */
  releasePage(index: number): void {
    const page = this.pageCache.get(index);
    if (page) {
      try {
        page.destroy();
      } catch {
        /* already gone */
      }
      this.pageCache.delete(index);
    }
  }

  /** Hint MuPDF that we are done with everything outside `keep`. */
  trimCaches(keep: readonly number[]): void {
    const keepSet = new Set(keep);
    for (const index of [...this.pageCache.keys()]) {
      if (!keepSet.has(index)) this.releasePage(index);
    }
    this.shrink();
  }

  close(): void {
    for (const page of this.pageCache.values()) {
      try {
        page.destroy();
      } catch {
        /* ignore */
      }
    }
    this.pageCache.clear();
    this.boxCache.clear();
    this.measured = 0;
    // Dropped before the document is destroyed, so a walk that is between two
    // pages stops at its next check instead of reading a page that is gone.
    this.plan = null;
    this.planning = null;
    if (this.doc) {
      try {
        this.doc.destroy();
      } catch {
        /* ignore */
      }
      this.doc = null;
    }
    this.info = null;
    this.drained = 0;
    this.registry = new FontRegistry({ disableCompression: this.opts.disableCompression, onWarn: this.opts.onWarn });
  }
}
