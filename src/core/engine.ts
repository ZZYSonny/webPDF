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
import { debug } from './debug.ts';
import { inlineFontCss, namespaceSvgIds, readSvgDimensions, rewriteSvgRoot, stripXmlProlog } from './svg/package.ts';

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
}

export interface RenderStats {
  glyphsDrawn: number;
  glyphsAsText: number;
  glyphsAsOutlines: number;
  textRuns: number;
  fontsBuilt: number;
  fontsReused: number;
  ms: number;
}

export interface RenderedPage {
  index: number;
  svg: string;
  width: number;
  height: number;
  fonts: FontAsset[];
  stats: RenderStats;
}

export interface EngineOptions {
  /** Embed raw TrueType instead of WOFF (bigger, but no zlib needed). */
  disableCompression?: boolean;
  onWarn?: (message: string) => void;
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
  drainNewFonts(): FontAsset[];
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

export class DocumentNotOpenError extends Error {
  constructor() {
    super('No document is open');
    this.name = 'DocumentNotOpenError';
  }
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

export class PdfEngine implements PdfEngineLike {
  private doc: mupdf.Document | null = null;
  private registry: FontRegistry;
  private pageCache = new Map<number, mupdf.Page>();
  private info: DocumentInfo | null = null;
  private readonly opts: EngineOptions;

  constructor(opts: EngineOptions = {}) {
    this.opts = opts;
    this.registry = new FontRegistry({ disableCompression: opts.disableCompression, onWarn: opts.onWarn });
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

  private loadPage(index: number): mupdf.Page {
    if (!this.doc) throw new DocumentNotOpenError();
    let page = this.pageCache.get(index);
    if (!page) {
      page = this.doc.loadPage(index);
      this.pageCache.set(index, page);
    }
    return page;
  }

  /** Render one page to SVG, upgrading glyphs to text where it is provably safe. */
  async renderPage(index: number, opts: RenderOptions = {}): Promise<RenderedPage> {
    const started = Date.now();
    const textMode = opts.textMode ?? 'auto';
    const page = this.loadPage(index);

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
        const plan = await this.registry.planPage(outlines, placements);
        debug('renderPage: planned', plan.fonts.size, 'fonts');
        stats.fontsBuilt = plan.built;
        stats.fontsReused = plan.reused;
        const upgraded = upgradeGlyphsToText(svg, placements, {
          familyFor: (fontId) => plan.fonts.get(fontId)?.family ?? null,
          codeFor: (fontId, gid) => plan.fonts.get(fontId)?.codes.get(gid) ?? null,
        });
        svg = upgraded.svg;
        debug('renderPage: upgraded', upgraded.stats);
        stats.textRuns = upgraded.stats.runs;
        stats.glyphsAsText = upgraded.stats.converted;
        stats.glyphsAsOutlines = upgraded.stats.kept;
        fonts = plan.assets;
      }
    }

    svg = stripXmlProlog(svg);
    if (opts.idPrefix) svg = namespaceSvgIds(svg, opts.idPrefix);
    if (opts.embedFonts && fonts.length) {
      svg = inlineFontCss(svg, fonts.map((f) => f.css).join('\n'));
    }
    svg = rewriteSvgRoot(svg, { className: opts.className, responsive: opts.responsive });

    const dims = readSvgDimensions(svg) ?? { width: 612, height: 792, viewBox: '' };
    stats.ms = Date.now() - started;

    return { index, svg, width: dims.width, height: dims.height, fonts, stats };
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
    try {
      mupdf.shrinkStore(50);
    } catch {
      /* not fatal */
    }
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
