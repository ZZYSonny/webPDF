/**
 * A virtualised, continuously scrolling PDF viewer.
 *
 * Zoom comes in two flavours, and they do not fight each other:
 *
 *  - A touch pinch is left entirely to the browser. It is a compositor-only
 *    page-scale change owned by the top-level document (measured: zero layout,
 *    zero script, and the browser re-rasters the vector content so it stays
 *    crisp), and panning while zoomed chains into the root scroller - which is
 *    also what keeps the virtualisation window correct.
 *  - Ctrl +/- and Ctrl+0 are *overridden* to walk a ladder of layout zoom
 *    settings (25%…400%, fit-width, fit-page by default) instead of the
 *    browser's own zoom. A key press is discrete and not animated, so paying one
 *    re-layout for it is fine - and it keeps the document geometry, the page
 *    boxes and the zoom indicator consistent, which browser zoom does not.
 *
 * Nothing here resizes or rescales anything while a pinch is in flight, and a
 * pinch never triggers layout at all. Browser zoom (a trackpad pinch on desktop)
 * also deliberately does *not* re-fit: the pages are laid out in CSS pixels, so
 * they keep their size and the browser re-rasters them crisply.
 *
 * Two consequences worth knowing:
 *
 *  - The host element must be in the flow of the *root* scroller. A nested
 *    `overflow:auto` ancestor traps a zoomed page inside one layout viewport,
 *    because the browser only chains a zoomed pan into the root scroller.
 *  - Because the browser scales the whole document, chrome drawn next to the
 *    pages is magnified too (and can pan out of view). Hosts that want fixed
 *    chrome should hide it while `zoomed` is true on `zoom-change` events.
 */

import type { DocumentInfo, PdfEngineLike, PdfSource, RenderOptions } from '../core/engine.ts';
import type { FontAsset } from '../core/font/registry.ts';
import { linkTargetOf, type LinkTarget } from '../core/links.ts';
import { debug as DEBUG } from '../core/debug.ts';
import { normaliseRules, padBox, type CropRect, type CropRuleId } from '../core/crop.ts';
import {
  computeFitScale,
  PageLayout,
  type LayoutOptions,
  type PageGeometry,
  type ZoomMode,
} from './layout.ts';

export type ViewerEvent =
  | { type: 'document-loaded'; info: DocumentInfo }
  | { type: 'page-change'; page: number; pageCount: number }
  | {
      type: 'zoom-change';
      /** Effective zoom: the layout scale multiplied by the browser's page scale. */
      scale: number;
      /** The zoom baked into the layout, before the browser's page scale. */
      layoutScale: number;
      mode: ZoomMode;
      /** The browser's own pinch/zoom factor, 1 when the page is not magnified. */
      pageScale: number;
      /** True while the browser is magnifying the page. */
      zoomed: boolean;
    }
  | { type: 'render'; page: number; ms: number; asText: number; asOutlines: number; spaces: number }
  /**
   * Cropping advanced: `measured` of `total` pages have a box. A crop changes
   * every page's height, so it cannot be applied in one go without reading the
   * whole document first - the boxes arrive a page at a time and the layout
   * follows them, which is what `running` reports the end of.
   */
  | { type: 'crop-change'; rules: readonly CropRuleId[]; measured: number; total: number; running: boolean }
  | { type: 'error'; error: unknown; page?: number }
  | { type: 'drop-accepted'; name: string }
  /**
   * A link in the document was activated, either by a click on its hit area or
   * from the keyboard. Returning `false` from `onEvent` takes the link over: the
   * viewer then does nothing, and the host does whatever it likes with the
   * (mutable) event. Otherwise an internal link jumps and an external one opens
   * in a new tab - unless its scheme is not one a browser will follow, in which
   * case `openable` is false and the viewer only reports it.
   */
  | ({ type: 'link' } & LinkTarget);

export interface PdfViewerOptions {
  container: HTMLElement;
  engine: PdfEngineLike;
  zoom?: number | 'fit-width' | 'fit-page';
  /**
   * The ladder Ctrl+= / Ctrl+- (and `zoomIn` / `zoomOut`) walk. Defaults to the
   * usual viewer presets; hosts with their own zoom UI can pass the same list
   * they render.
   */
  zoomSteps?: readonly (number | 'fit-width' | 'fit-page')[];
  gap?: number;
  padding?: number;
  columns?: 1 | 2;
  /** How many pages beyond the viewport stay rendered, on each side. */
  keepPages?: number;
  /** Simultaneous page renders. 1 keeps scrolling smoothest on the main thread. */
  concurrency?: number;
  /**
   * Render inside a shadow root. Strongly recommended when embedding into a
   * host page (or a browser extension) whose CSS you do not control.
   */
  shadowDom?: boolean;
  /**
   * Pixels of the host's own chrome sitting above the pages - a sticky top bar,
   * say. Every scroll the viewer performs stops this far short, so a page or a
   * link destination is not parked underneath it. Pass a function to have it
   * re-measured (the value is read at each scroll), or leave it out when nothing
   * overlaps the pages.
   */
  scrollMargin?: number | (() => number);
  /**
   * Record a jump to an internal link in the browser's session history, so the
   * Back button returns to the position you were reading (and Forward to where
   * the link went). The URL is never touched - the entries differ only in their
   * state. Default true; set it to false when the host page owns the history
   * (an embedded viewer inside a single-page app, say), in which case Back
   * leaves the document instead of stepping back inside it.
   */
  history?: boolean;
  /** Accept PDFs dropped onto the container. */
  acceptDrop?: boolean;
  className?: string;
  /**
   * Called for every viewer event. Return `false` to take a `link` over; the
   * return value is ignored for everything else.
   */
  onEvent?: (event: ViewerEvent) => void | boolean;
}

interface PageSlot {
  index: number;
  el: HTMLDivElement;
  svg: Element | null;
  state: 'empty' | 'queued' | 'rendering' | 'done';
  /** Bumped whenever the slot is recycled, so late results are discarded. */
  generation: number;
}

interface QueueEntry {
  index: number;
  priority: number;
  seq: number;
}

/**
 * A position in the document: a page, and a point within it (`null` = the page
 * top). Page units, not pixels, so it survives a zoom between the two moments -
 * and `doc` is which document it was, because a history entry outlives the
 * document it was recorded in.
 */
interface Place {
  doc: number;
  page: number;
  y: number | null;
}

/** The state a viewer owns in the browser's history, under one key. */
interface HistoryState {
  webpdf?: Place;
}

const DEFAULT_KEEP = 1;

/**
 * Zoom presets: Ctrl+= and Ctrl+- walk this list, and hosts that render their own
 * zoom control can list the same rungs. It is *not* ordered low to high, because
 * the fit modes move with the window: `stepZoom` sorts by what each rung resolves
 * to at the moment it is used.
 */
export const DEFAULT_ZOOM_STEPS: readonly (number | 'fit-width' | 'fit-page')[] = [
  0.25,
  0.5,
  0.75,
  1,
  1.25,
  1.5,
  2,
  3,
  4,
  'fit-width',
  'fit-page',
];

/** True for a target that consumes keystrokes as text. */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export class PdfViewer {
  private readonly opt: Required<Omit<PdfViewerOptions, 'onEvent'>> & { onEvent?: (e: ViewerEvent) => void | boolean };
  private readonly engine: PdfEngineLike;
  /** The host element; its height is set to the full layout height. */
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly surface: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  /**
   * Font faces are registered on the *document*, never inside the shadow root:
   * Chromium does not load `@font-face` rules declared in a shadow tree, and a
   * document-level face is what makes the SVG text render with the fonts we
   * rebuilt from MuPDF's outlines.
   */
  private readonly fontSheet: CSSStyleSheet | null;
  private readonly fontStyleEl: HTMLStyleElement | null;
  private readonly slots = new Map<number, PageSlot>();
  private readonly queue: QueueEntry[] = [];
  private readonly inFlight = new Set<number>();

  private info: DocumentInfo | null = null;
  /** The pages as the document has them, whatever crop is in force. */
  private baseGeometry: PageGeometry[] = [];
  /** The pages as they are laid out: the same, cropped where a box is known. */
  private geometry: PageGeometry[] = [];
  /** Measured crop boxes, one entry per page; null for "not cropped". */
  private cropBoxes: (CropRect | null)[] = [];
  /** The rules in force, empty for no crop at all. */
  private cropRules: CropRuleId[] = [];
  /** Page units kept around the content box, on every side. */
  private padding = 0;
  /** Bionic reading: every word's first letters at full strength, the rest faded. */
  private bionicOn = false;
  /** Bumped whenever the selection changes, so a running pass gives up. */
  private cropEpoch = 0;
  private cropMeasured = 0;
  private cropRunning = false;
  private cropFrame = 0;
  private layout: PageLayout;
  /** Zoom baked into the layout, in CSS pixels per page unit. */
  private scale = 1;
  /** The browser's page scale (a touch pinch), which this class never sets. */
  private pageScale = 1;
  private mode: ZoomMode = 'custom';
  /** What Ctrl+0 goes back to. */
  private readonly homeZoom: number | 'fit-width' | 'fit-page';
  private seq = 0;
  private frameRequest = 0;
  private zoomFrame = 0;
  private destroyed = false;
  private currentPage = 1;
  private resizeObserver: ResizeObserver | null = null;
  private lastWidth = 0;
  private lastDpr = 1;
  /** Bumped per document, so a history entry cannot land in the wrong one. */
  private docSeq = 0;

  private constructor(opts: PdfViewerOptions) {
    this.engine = opts.engine;
    this.opt = {
      container: opts.container,
      engine: opts.engine,
      zoom: opts.zoom ?? 'fit-width',
      zoomSteps: opts.zoomSteps ?? DEFAULT_ZOOM_STEPS,
      gap: opts.gap ?? 14,
      padding: opts.padding ?? 16,
      columns: opts.columns ?? 1,
      keepPages: opts.keepPages ?? DEFAULT_KEEP,
      concurrency: opts.concurrency ?? 1,
      shadowDom: opts.shadowDom ?? false,
      scrollMargin: opts.scrollMargin ?? 0,
      history: opts.history ?? true,
      acceptDrop: opts.acceptDrop ?? true,
      className: opts.className ?? '',
      onEvent: opts.onEvent,
    };

    const host = opts.container;
    this.host = host;
    host.classList.add('wpdf-host');
    if (this.opt.className) host.classList.add(this.opt.className);

    const doc = host.ownerDocument;
    let mount: HTMLElement = host;
    if (this.opt.shadowDom && typeof host.attachShadow === 'function') {
      const existing = host.shadowRoot;
      const shadow = existing ?? host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '';
      mount = shadow as unknown as HTMLElement;
    }
    const style = document.createElement('style');
    style.textContent = VIEWER_CSS;
    mount.appendChild(style);

    this.root = mount;
    this.surface = document.createElement('div');
    this.surface.className = 'wpdf-surface';
    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'wpdf-pages';
    this.surface.appendChild(this.pagesEl);
    this.root.appendChild(this.surface);

    // Prefer a constructed stylesheet: it is not affected by a host page's
    // `style-src` policy, which matters inside browser extensions.
    const constructed =
      typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in doc && 'replaceSync' in CSSStyleSheet.prototype;
    if (constructed) {
      const sheet = new CSSStyleSheet();
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      this.fontSheet = sheet;
      this.fontStyleEl = null;
    } else {
      const el = doc.createElement('style');
      el.dataset.wpdf = 'fonts';
      doc.head?.appendChild(el);
      this.fontStyleEl = el;
      this.fontSheet = null;
    }

    this.homeZoom = this.opt.zoom;
    // The starting scale comes from that same option, so the mode is only
    // "custom" when it was a factor: `zoom: 'fit-width'` *is* a fit-width layout,
    // and `zoomMode`/`zoom-change` have to say so.
    this.mode = typeof this.opt.zoom === 'string' ? this.opt.zoom : 'custom';
    this.layout = new PageLayout([], {});
    host.style.height = '0px';

    // Capture phase, so a scroll inside any ancestor scroller is seen too.
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onPageScale);
    window.visualViewport?.addEventListener('scroll', this.onPageScale);
    document.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('popstate', this.onPopState);
    // Delegate both link gestures inside the shadow tree, where the hit areas
    // live and where `event.target` is not retargeted to the shadow host.
    this.pagesEl.addEventListener('click', this.onClick);
    this.pagesEl.addEventListener('keydown', this.onLinkKeyDown);
    if (this.opt.acceptDrop) this.installDropTarget();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onContainerResize());
      this.resizeObserver.observe(host);
    }
    this.lastDpr = window.devicePixelRatio || 1;
  }

  static create(opts: PdfViewerOptions): PdfViewer {
    return new PdfViewer(opts);
  }

  /* ---------------------------------------------------------------- load */

  /**
   * Open a document. Throws `PasswordRequiredError` when the file is encrypted;
   * call again with the password to continue.
   */
  async load(source: PdfSource, password?: string): Promise<DocumentInfo> {
    const info = await this.engine.open(source, password);
    this.setDocument(info);
    return info;
  }

  setDocument(info: DocumentInfo): void {
    this.info = info;
    this.docSeq++;
    this.baseGeometry = info.pages.map((p) => ({ width: p.width, height: p.height }));
    // A crop belongs to the document it was measured on; the rules are the
    // reader's and stay, so a selection made on one paper applies to the next.
    this.cropEpoch++;
    this.cropBoxes = [];
    this.cropMeasured = 0;
    this.cropRunning = false;
    this.applyCropGeometry();
    this.clearSlots();
    // A newly opened document starts at the level the `zoom` option asks for,
    // whatever the previous document was left at - and the mode has to say so, or
    // a fit level would stop re-fitting on a container resize.
    this.mode = typeof this.homeZoom === 'string' ? this.homeZoom : 'custom';
    this.scale = this.resolveScale();
    this.rebuildLayout();
    this.scrollToOffset(0);
    this.currentPage = 1;
    this.emit({ type: 'document-loaded', info });
    this.emitZoom();
    this.update();
    if (this.cropRules.length > 0) this.measureCrop();
  }

  get document(): DocumentInfo | null {
    return this.info;
  }

  get pageCount(): number {
    return this.info?.pageCount ?? 0;
  }

  /** Zoom baked into the layout. The browser's pinch multiplies this. */
  get zoom(): number {
    return this.scale;
  }

  /**
   * How the current layout scale was chosen: a fixed factor, or one of the fit
   * modes. Hosts that render a zoom control need it to label the current level
   * (and to know which way +/- should step from here).
   */
  get zoomMode(): ZoomMode {
    return this.mode;
  }

  /** The browser's page scale, or 1 when the page is not magnified. */
  get pageScaleFactor(): number {
    return this.pageScale;
  }

  /** What the user actually sees: layout scale times the browser's page scale. */
  get effectiveZoom(): number {
    return this.scale * this.pageScale;
  }

  /** Whether rendering happens off the main thread. */
  get rendersInWorker(): boolean {
    return this.engine.isWorkerBacked === true;
  }

  /* ---------------------------------------------------------------- zoom */

  /**
   * Set the layout scale. This re-lays-out the pages, so it is deliberately not
   * wired to wheel or pinch gestures: pinch belongs to the browser, and a wheel
   * handler would fight it. Use it for explicit zoom controls.
   */
  setZoom(value: number | 'fit-width' | 'fit-page'): void {
    const anchorPage = Math.max(0, this.currentPage - 1);
    const before = this.layout.offsetOf(anchorPage);
    const delta = this.readingOffset() - before;

    if (typeof value === 'number') {
      this.mode = 'custom';
      this.scale = Math.min(12, Math.max(0.05, value));
    } else {
      this.mode = value;
      this.scale = this.resolveScale();
    }
    this.rebuildLayout();
    this.scrollToOffset(this.layout.offsetOf(anchorPage) + delta);
    this.emitZoom();
    this.update();
  }

  /** One rung up the zoom ladder. Pass a factor for a multiplicative zoom. */
  zoomIn(step?: number): void {
    if (step === undefined) this.stepZoom(1);
    else this.setZoom(this.scale * step);
  }

  /** One rung down the zoom ladder. Pass a factor for a multiplicative zoom. */
  zoomOut(step?: number): void {
    if (step === undefined) this.stepZoom(-1);
    else this.setZoom(this.scale / step);
  }

  /**
   * Move one rung up or down the zoom ladder, starting from whichever rung is
   * closest to the current layout scale. This is what Ctrl+= / Ctrl+- and the
   * toolbar buttons use.
   */
  stepZoom(direction: 1 | -1): void {
    // Resolve and sort by what each rung means *right now*: fit-page is usually
    // smaller than fit-width, and both move with the window, so the ladder
    // cannot be ordered statically.
    const rungs = this.opt.zoomSteps
      .map((step) => ({ step, scale: this.resolveZoom(step) }))
      .sort((a, b) => a.scale - b.scale)
      .filter((rung, i, all) => i === 0 || rung.scale - all[i - 1].scale > 1e-3);
    if (rungs.length === 0) return;
    let nearest = 0;
    for (let i = 1; i < rungs.length; i++) {
      if (Math.abs(rungs[i].scale - this.scale) < Math.abs(rungs[nearest].scale - this.scale)) nearest = i;
    }
    // Already on a rung? Move off it; otherwise snap onto the closest one first.
    const onRung = Math.abs(rungs[nearest].scale - this.scale) < 1e-3;
    const index = onRung ? nearest + direction : nearest;
    this.setZoom(rungs[Math.min(rungs.length - 1, Math.max(0, index))].step);
  }

  /**
   * What a zoom level means right now, without applying it: the factor itself, or
   * the scale a fit mode currently resolves to. A host that renders its own zoom
   * control needs this to label the fit modes, which move with the container -
   * "fit width" is a different percentage in every window.
   */
  resolveZoom(level: number | 'fit-width' | 'fit-page'): number {
    if (typeof level === 'number') return level;
    if (!this.info || this.geometry.length === 0) return 1;
    return computeFitScale(this.geometry, this.host.clientWidth, window.innerHeight, this.layoutOptions(), level);
  }

  private resolveScale(): number {
    if (!this.info || this.geometry.length === 0) return 1;
    if (this.mode === 'fit-width' || this.mode === 'fit-page') {
      return computeFitScale(this.geometry, this.host.clientWidth, window.innerHeight, this.layoutOptions(), this.mode);
    }
    // A factor: the option is the seed, and `setZoom` is the only thing that
    // changes it.
    return typeof this.homeZoom === 'number' ? this.homeZoom : 1;
  }

  private layoutOptions(): LayoutOptions {
    return {
      gap: this.opt.gap,
      padding: this.opt.padding,
      scale: this.scale,
      columns: this.opt.columns,
    };
  }

  private rebuildLayout(): void {
    this.layout = new PageLayout(this.geometry, this.layoutOptions());
    // The host element carries the full document height: it is what gives the
    // surrounding scroller - normally the document itself - its scrollbar.
    this.host.style.height = `${this.layout.height}px`;
    this.pagesEl.style.width = `${this.layout.width}px`;
    this.pagesEl.style.height = `${this.layout.height}px`;
  }

  /* --------------------------------------------------------------- crop */

  /**
   * Show every page cropped to its content, with the marks `rules` name left
   * out of the box (see `core/crop.ts` - the rules are PaperCutter's). `null`
   * or an empty list turns cropping off again, which is where a viewer starts.
   *
   * A crop changes the *size* of every page, so the scroll layout cannot be
   * built until the boxes are known - and knowing them means reading every page
   * of the document, which is far too much to do before the first paint. So the
   * pages are measured in the background, the reader's own page first, and the
   * layout follows the answers as they arrive. `crop-change` reports the
   * progress; a second visit to the same selection is instant, because an
   * engine keeps what it measured.
   */
  setCrop(rules: readonly CropRuleId[] | null, padding = 0): void {
    const next = normaliseRules(rules);
    const pad = Number.isFinite(padding) && padding > 0 ? padding : 0;
    const sameRules = next.join(',') === this.cropRules.join(',');
    if (sameRules && Math.abs(pad - this.padding) < 1e-3) return;
    if (sameRules) {
      // Only the margin moved. Nothing has to be measured again - every page
      // has been measured already - so the pages are re-laid-out and re-rendered
      // straight away, which is what makes the field feel like a control.
      this.padding = pad;
      this.applyCropGeometry();
      this.invalidateAll();
      this.relayout();
      this.emitCrop(true);
      return;
    }
    this.padding = pad;
    this.cropRules = next;
    // Whatever pass was running is now measuring for the wrong selection.
    this.cropEpoch++;
    this.cropRunning = false;
    if (next.length === 0) {
      this.cropBoxes = [];
      this.cropMeasured = 0;
      this.applyCropGeometry();
      this.invalidateAll();
      this.relayout();
      this.emitCrop(true);
      return;
    }
    // Boxes already measured are kept: they were measured with a different
    // selection, but they are a crop, and a page whose new box has not arrived
    // is better off adjusting than snapping back to full size and back again.
    this.measureCrop();
  }

  /** The rules in force. Empty means the pages are shown whole. */
  get crop(): readonly CropRuleId[] {
    return this.cropRules;
  }

  /** How far the measuring pass has got, for a host that shows progress. */
  get cropProgress(): { measured: number; total: number; running: boolean } {
    return { measured: this.cropMeasured, total: this.geometry.length, running: this.cropRunning };
  }

  /**
   * The box a page is currently shown through, in the page's own coordinates,
   * or null when it is shown whole. A host that places something on a page -
   * an annotation, a synced highlight - needs it, because the page it is
   * looking at starts at the top of the crop rather than at the top of the page.
   */
  cropBox(page: number): CropRect | null {
    const content = this.cropBoxes[page - 1];
    const base = this.baseGeometry[page - 1];
    if (!content || !base) return null;
    return padBox(content, this.padding, { x: 0, y: 0, width: base.width, height: base.height });
  }

  /** Page units kept around the content box on every side. 0 by default. */
  get cropPadding(): number {
    return this.padding;
  }

  /* ------------------------------------------------------------- bionic */

  /**
   * Bionic reading: every word's first letters are left as the document set
   * them and the rest of each word is faded, so the eye has somewhere to land
   * and the brain finishes the word.
   *
   * This changes how the text is drawn and nothing else. Every character in
   * these pages carries its own x and y, and fading is an attribute of the
   * character's own `<tspan>`: the pages do not move, do not change size, and do
   * not have to be measured again. That is why this re-renders what is on screen
   * rather than re-laying it out. Default off, so a document opens looking like
   * itself.
   */
  setBionic(on: boolean): void {
    const next = on === true;
    if (next === this.bionicOn) return;
    this.bionicOn = next;
    // What is on screen was drawn without them (or with), and is now wrong.
    this.invalidateAll();
    this.update();
  }

  /** Whether pages are drawn with bionic reading's fixation points. */
  get bionic(): boolean {
    return this.bionicOn;
  }

  private measureCrop(): void {
    const measure = this.engine.measureCrop?.bind(this.engine);
    const rules = this.cropRules;
    const epoch = ++this.cropEpoch;
    const count = this.baseGeometry.length;
    this.cropMeasured = 0;
    this.cropRunning = count > 0 && measure !== undefined;
    this.emitCrop(!this.cropRunning);
    if (!measure) return;

    // The reader's own page comes first: a rule should show what it does where
    // they are looking, not after the rest of a long document has been read.
    const here = Math.max(0, Math.min(count - 1, this.currentPage - 1));
    const order: number[] = [];
    if (count > 0) order.push(here);
    for (let i = 0; i < count; i++) if (i !== here) order.push(i);

    void (async () => {
      for (const index of order) {
        if (this.destroyed || epoch !== this.cropEpoch) return;
        let box: CropRect | null = null;
        try {
          box = await measure(index, rules);
        } catch (error) {
          // A page that cannot be read stays whole; the rest of the pass runs.
          DEBUG('measureCrop failed', index, String(error));
        }
        if (this.destroyed || epoch !== this.cropEpoch) return;
        this.cropMeasured++;
        if (this.setCropBox(index, box)) this.scheduleCropLayout();
        this.emitCrop(false);
      }
      if (this.destroyed || epoch !== this.cropEpoch) return;
      this.cropRunning = false;
      // The last boxes may have arrived with a frame still pending.
      this.applyCropGeometry();
      this.emitCrop(true);
    })();
  }

  /** Record one page's box. Returns true when it changes the page's size. */
  private setCropBox(index: number, box: CropRect | null): boolean {
    const page = this.baseGeometry[index];
    if (!page) return false;
    const previous = this.cropBoxes[index] ?? null;
    const width = box ? box.width : page.width;
    const height = box ? box.height : page.height;
    this.cropBoxes[index] = box;
    const changed = !previous || Math.abs(previous.width - width) > 1e-3 || Math.abs(previous.height - height) > 1e-3;
    // What is on screen was rendered through the old window onto the page.
    if (changed) this.invalidateSlot(index);
    return changed;
  }

  private applyCropGeometry(): void {
    this.geometry = this.baseGeometry.map((page, index) => {
      const box = this.cropBox(index + 1);
      return box ? { width: box.width, height: box.height } : { ...page };
    });
  }

  /**
   * Re-lay-out without moving the reader: whatever page they are on stays where
   * it is on screen, at the same point inside it.
   */
  private relayout(): void {
    if (this.geometry.length === 0) {
      this.rebuildLayout();
      return;
    }
    const anchor = Math.max(0, Math.min(this.geometry.length - 1, this.currentPage - 1));
    const delta = this.readingOffset() - this.layout.offsetOf(anchor);
    this.rebuildLayout();
    this.scrollToOffset(this.layout.offsetOf(anchor) + delta);
    this.update();
  }

  /**
   * Boxes arrive once per page, and every arrival would otherwise re-lay-out the
   * whole document. One per frame is plenty, and the reader never sees a page
   * size change twice in a frame.
   */
  private scheduleCropLayout(): void {
    if (this.cropFrame || this.destroyed) return;
    this.cropFrame = requestAnimationFrame(() => {
      this.cropFrame = 0;
      if (this.destroyed) return;
      this.applyCropGeometry();
      this.relayout();
    });
  }

  /** Drop a rendered page, so it is rendered again through the current crop. */
  private invalidateSlot(index: number): void {
    const slot = this.slots.get(index);
    if (!slot || slot.state === 'empty') return;
    slot.generation++;
    slot.el.innerHTML = '';
    slot.svg = null;
    slot.state = 'empty';
  }

  private invalidateAll(): void {
    for (const index of [...this.slots.keys()]) this.invalidateSlot(index);
  }

  private emitCrop(done: boolean): void {
    this.emit({
      type: 'crop-change',
      rules: this.cropRules,
      measured: done ? this.geometry.length : this.cropMeasured,
      total: this.geometry.length,
      running: !done,
    });
  }

  /* ----------------------------------------------------------- navigation */

  goToPage(page: number): void {
    const index = Math.max(0, Math.min((this.info?.pageCount ?? 1) - 1, Math.round(page) - 1));
    this.scrollToOffset(this.layout.offsetOf(index));
    this.update();
  }

  /**
   * Scroll to a destination: a page, and optionally a point within it in the
   * document's own coordinates (points from the page's top-left, the space
   * `PageLink` uses). This is where an internal link goes; `goToPage` is the
   * same call with no point.
   */
  goToDestination(page: number, y: number | null = null): void {
    if (!this.info) return;
    const index = Math.max(0, Math.min(this.info.pageCount - 1, Math.round(page) - 1));
    const offset =
      y === null ? this.layout.offsetOf(index) : this.layout.offsetOfPoint(index, this.shownY(index, y), this.scale);
    this.scrollToOffset(offset);
    this.update();
  }

  /**
   * A point on a page, in the coordinates of the page *as it is shown*.
   *
   * Destinations arrive in the document's own coordinates - a link annotation's
   * target is a point on the uncropped page, and so is a remembered position -
   * while the layout measures from the top of whatever the reader is actually
   * looking at. With a crop in force those two differ by the top of the crop,
   * and a jump that ignored it lands a whole margin too far down the page.
   */
  private shownY(index: number, y: number): number {
    const box = this.cropBoxes[index];
    return box ? y - box.y : y;
  }

  /** The inverse: from a point on the shown page back to the document's own. */
  private documentY(index: number, y: number): number {
    const box = this.cropBoxes[index];
    return box ? y + box.y : y;
  }

  /* -------------------------------------------------------------- history */

  /** Where the reader is now: the page, and the point at the top of the page area. */
  private placeHere(): Place {
    // Measured from the top of the *page area*, not of the window: a host's
    // chrome covers the first `scrollMargin` pixels, and restoring uses the same
    // margin, so the two cancel out and the position comes back exactly.
    const point = this.layout.pointAt(this.readingOffset(), this.scale);
    // Back into the document's coordinates, so a position remembered under one
    // crop still means the same point under another.
    const y = point.y === null ? null : this.documentY(point.index, point.y);
    return { doc: this.docSeq, page: point.index + 1, y };
  }

  /**
   * Make a jump something Back can undo: the position being left is written into
   * the entry that is current now, and the position being gone to becomes the
   * new entry. Both halves are needed - with only the first, Forward would come
   * back to where the link was *clicked* rather than where it went.
   */
  private rememberPlace(from: Place, to: Place): void {
    if (!this.opt.history || typeof history === 'undefined' || !history.pushState) return;
    try {
      history.replaceState({ webpdf: from } satisfies HistoryState, '');
      history.pushState({ webpdf: to } satisfies HistoryState, '');
    } catch {
      // A host that has frozen history, or a sandboxed document without one:
      // jumping is more important than remembering where from.
    }
  }

  private onPopState = (event: PopStateEvent): void => {
    const place = (event.state as HistoryState | null)?.webpdf;
    if (!place || place.doc !== this.docSeq) return;
    this.goToDestination(place.page, place.y);
  };

  nextPage(): void {
    this.goToPage(this.currentPage + 1);
  }

  prevPage(): void {
    this.goToPage(this.currentPage - 1);
  }

  /** The SVG element for a page, or null when it is not currently rendered. */
  pageElement(page: number): Element | null {
    return this.slots.get(page - 1)?.svg ?? null;
  }

  /** Serialised SVG for a page. Renders it on demand. */
  async exportSvg(page: number): Promise<string> {
    const rendered = await this.engine.renderPage(page - 1, {
      textMode: 'auto',
      embedFonts: true,
      responsive: false,
      idPrefix: `p${page - 1}-`,
      className: 'wpdf-page-svg',
      crop: this.cropRules,
      cropPadding: this.padding,
      bionic: this.bionicOn,
    });
    return rendered.svg;
  }

  /* ------------------------------------------------------- scroll mapping */

  /**
   * Whatever the host has parked over the pages. Scrolling short by it is what
   * keeps a target from disappearing behind that chrome.
   */
  private scrollMargin(): number {
    const raw = typeof this.opt.scrollMargin === 'function' ? this.opt.scrollMargin() : this.opt.scrollMargin;
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /** Offset of the *window's* top edge within the laid-out pages. */
  private scrollOffset(): number {
    return -this.host.getBoundingClientRect().top;
  }

  /**
   * Where the reader actually is: the top of the visible page area, which is
   * `scrollMargin` below the top of the window because the host's chrome covers
   * that much. Anything that re-lays-out and then puts the reader back has to
   * measure from here - `scrollOffset` alone is short by the margin, and the
   * difference accumulates over a layout that changes repeatedly.
   */
  private readingOffset(): number {
    return this.scrollOffset() + this.scrollMargin();
  }

  private scrollToOffset(offset: number): void {
    const top = this.host.getBoundingClientRect().top + window.scrollY + offset - this.scrollMargin();
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }

  /* ------------------------------------------------------------- internals */

  private clearSlots(): void {
    for (const slot of this.slots.values()) slot.el.remove();
    this.slots.clear();
    this.queue.length = 0;
    this.inFlight.clear();
  }

  private ensureSlot(index: number): PageSlot {
    let slot = this.slots.get(index);
    if (!slot) {
      const el = document.createElement('div');
      el.className = 'wpdf-page';
      el.dataset.page = String(index + 1);
      const s: PageSlot = { index, el, svg: null, state: 'empty', generation: 0 };
      slot = s;
      this.slots.set(index, slot);
      this.pagesEl.appendChild(el);
    }
    return slot;
  }

  private removeSlot(index: number): void {
    const slot = this.slots.get(index);
    if (!slot) return;
    slot.generation++;
    slot.el.remove();
    this.slots.delete(index);
  }

  private positionSlot(slot: PageSlot): void {
    const box = this.layout.boxes[slot.index];
    if (!box) return;
    const s = slot.el.style;
    s.left = `${box.left}px`;
    s.top = `${box.top}px`;
    s.width = `${box.width}px`;
    s.height = `${box.height}px`;
  }

  private onScroll = (): void => {
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.tick();
    });
  };

  /** The browser magnified (or un-magnified) the page. Cheap: no layout here. */
  private onPageScale = (): void => {
    if (this.zoomFrame) return;
    this.zoomFrame = requestAnimationFrame(() => {
      this.zoomFrame = 0;
      const next = window.visualViewport?.scale ?? 1;
      if (Math.abs(next - this.pageScale) < 1e-4) return;
      this.pageScale = next;
      this.emitZoom();
    });
  };

  /** An arrow property: it is used directly as a listener, so `this` must hold. */
  private onResize = (): void => {
    // Only the virtualisation window depends on the viewport here; the layout
    // scale is the container's business (see onContainerResize).
    this.update();
  };

  /** Re-derive the layout scale from the container width, if the mode wants it. */
  private refit(): void {
    if (this.mode !== 'fit-width' && this.mode !== 'fit-page') return;
    const next = this.resolveScale();
    if (Math.abs(next - this.scale) > 1e-4) {
      this.scale = next;
      this.rebuildLayout();
      this.emitZoom();
    }
  }

  private onContainerResize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.host.clientWidth;
    const dprChanged = Math.abs(dpr - this.lastDpr) > 1e-6;
    if (width === this.lastWidth && !dprChanged) return;
    this.lastDpr = dpr;
    this.lastWidth = width;
    // Browser zoom changes the CSS pixel width *and* the device pixel ratio. The
    // pages are laid out in CSS pixels and the browser re-rasters them, so
    // re-fitting here would undo the user's zoom and re-lay-out on every step of
    // it. A genuine host resize changes the width with the ratio untouched.
    if (!dprChanged && (this.mode === 'fit-width' || this.mode === 'fit-page')) this.refit();
    this.update();
  }

  /** Synchronous entry point: recompute the window and refresh the DOM. */
  update(): void {
    this.tick();
  }

  private tick(): void {
    if (this.destroyed || !this.info) return;
    const offset = this.scrollOffset();
    const viewportHeight = window.innerHeight || 1;
    const visible = this.layout.visibleRange(offset, viewportHeight, 0);
    const keep = this.opt.keepPages;

    const wanted = new Map<number, number>(); // index -> priority
    const first = Math.max(0, visible.start - keep);
    const last = Math.min(this.geometry.length - 1, visible.end + keep);
    for (let i = first; i <= last; i++) {
      wanted.set(i, i >= visible.start && i <= visible.end ? 0 : 1);
    }

    for (const index of [...this.slots.keys()]) {
      if (!wanted.has(index)) this.removeSlot(index);
    }

    for (const [index, priority] of wanted) {
      const slot = this.ensureSlot(index);
      this.positionSlot(slot);
      if (slot.state === 'empty') this.enqueue(index, priority);
      else if (slot.state === 'queued') this.bumpPriority(index, priority);
    }

    // Re-position slots affected by a layout change even when not re-created.
    for (const slot of this.slots.values()) this.positionSlot(slot);

    this.engine.trimCaches?.([...wanted.keys()]);

    const page = this.layout.currentPage(offset, viewportHeight) + 1;
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.emit({ type: 'page-change', page, pageCount: this.geometry.length });
    }
    this.pump();
  }

  private enqueue(index: number, priority: number): void {
    const slot = this.slots.get(index);
    if (!slot || slot.state !== 'empty') return;
    slot.state = 'queued';
    this.queue.push({ index, priority, seq: this.seq++ });
  }

  private bumpPriority(index: number, priority: number): void {
    for (const entry of this.queue) {
      if (entry.index === index) {
        entry.priority = Math.min(entry.priority, priority);
        return;
      }
    }
  }

  private pump(): void {
    if (this.destroyed) return;
    while (this.inFlight.size < this.opt.concurrency && this.queue.length > 0) {
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const entry = this.queue.shift();
      if (!entry) break;
      const slot = this.slots.get(entry.index);
      if (!slot || slot.state !== 'queued') continue;
      slot.state = 'rendering';
      this.inFlight.add(entry.index);
      void this.renderSlot(slot);
    }
  }

  private async renderSlot(slot: PageSlot): Promise<void> {
    const generation = ++slot.generation;
    const index = slot.index;
    const opts: RenderOptions = {
      textMode: 'auto',
      idPrefix: `p${index}-`,
      responsive: true,
      className: 'wpdf-page-svg',
      crop: this.cropRules,
      cropPadding: this.padding,
      bionic: this.bionicOn,
    };
    try {
      DEBUG('render start', index);
      const rendered = await this.engine.renderPage(index, opts);
      DEBUG('render done', index, rendered.svg.length);
      if (this.destroyed || slot.generation !== generation || this.slots.get(index) !== slot) return;

      this.injectFonts(this.engine.drainNewFonts());
      slot.el.innerHTML = rendered.svg;
      slot.svg = slot.el.firstElementChild;
      slot.state = 'done';
      this.positionSlot(slot);

      this.emit({
        type: 'render',
        page: index + 1,
        ms: rendered.stats.ms,
        asText: rendered.stats.glyphsAsText,
        asOutlines: rendered.stats.glyphsAsOutlines,
        spaces: rendered.stats.spaces,
      });
    } catch (error) {
      DEBUG('render failed', index, String(error));
      if (slot.generation === generation) slot.state = 'empty';
      this.emit({ type: 'error', error, page: index + 1 });
    } finally {
      this.inFlight.delete(index);
      if (!this.destroyed) {
        if (slot.state === 'empty' && this.slots.has(index)) {
          // Retry once on the next tick; a genuine failure will recur and settle.
          this.enqueue(index, 1);
        }
        this.pump();
      }
    }
  }

  private injectFonts(assets: readonly FontAsset[]): void {
    if (assets.length === 0) return;
    for (const asset of assets) {
      if (this.fontSheet) {
        try {
          this.fontSheet.insertRule(asset.css, this.fontSheet.cssRules.length);
          continue;
        } catch {
          // Fall through to the element form below.
        }
      }
      if (this.fontStyleEl) {
        this.fontStyleEl.appendChild(document.createTextNode('\n' + asset.css));
      }
    }
  }

  /* ------------------------------------------------------------- gestures */

  /**
   * A click on a link hit area. Left clicks only: a middle click (which the
   * browser delivers as `auxclick`) keeps its native meaning, and the context
   * menu still offers the anchor's own `href`.
   */
  private onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = linkTargetOf(event.target as Element | null);
    if (!target) return;
    // Own the click from here on, whether or not a host takes it over: the
    // hit areas are not meant to navigate the host page themselves.
    event.preventDefault();
    this.activateLink(target);
  };

  /** The same activation from the keyboard, for a focused hit area. */
  private onLinkKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = linkTargetOf(event.target as Element | null);
    if (!target) return;
    event.preventDefault();
    this.activateLink(target);
  };

  /**
   * Tell the host about a link - the event object is handed out as it is, so a
   * host that wants a different target can simply change the fields before
   * letting the default run - and then do whatever the viewer does with it,
   * unless the host took it over by returning false.
   */
  private activateLink(target: LinkTarget): void {
    const event: { type: 'link' } & LinkTarget = { type: 'link', ...target };
    if (this.emit(event)) this.performLink(event);
  }

  private performLink(event: { type: 'link' } & LinkTarget): void {
    if (event.kind === 'internal') {
      const index = Math.max(0, Math.min((this.info?.pageCount ?? 1) - 1, Math.round(event.page) - 1));
      this.rememberPlace(this.placeHere(), { doc: this.docSeq, page: index + 1, y: event.y });
      this.goToDestination(event.page, event.y);
      return;
    }
    // A URI no browser will follow is reported and left alone; a host that can
    // do something with it (an extension opening a local file, say) takes the
    // link over instead of letting this run.
    if (!event.openable) return;
    window.open(event.uri, '_blank', 'noopener,noreferrer');
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey) {
      // Take the browser's zoom shortcuts over: they would scale the whole app,
      // chrome included, and would leave the layout scale out of step with it.
      switch (event.key) {
        case '+':
        case '=':
          this.stepZoom(1);
          break;
        case '-':
        case '_':
          this.stepZoom(-1);
          break;
        case '0':
          this.setZoom(this.homeZoom);
          break;
        default:
          return;
      }
      event.preventDefault();
      return;
    }
    if (mod || event.altKey) return;
    // Unmodified keys belong to whatever the user is typing into: a search box
    // needs its '-' and its Home/End far more than the viewer needs the zoom.
    if (isEditable(event.target)) return;
    switch (event.key) {
      case 'Home':
        this.goToPage(1);
        break;
      case 'End':
        this.goToPage(this.pageCount);
        break;
      case '+':
      case '=':
        this.zoomIn();
        break;
      case '-':
        this.zoomOut();
        break;
      default:
        // Arrows, space and PageUp/PageDown scroll the document natively.
        return;
    }
    event.preventDefault();
  };

  private installDropTarget(): void {
    const el = this.opt.container;
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('dragover', (e) => {
      stop(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      el.classList.add('wpdf-drop-active');
    });
    el.addEventListener('dragleave', (e) => {
      stop(e);
      el.classList.remove('wpdf-drop-active');
    });
    el.addEventListener('drop', (e) => {
      stop(e);
      el.classList.remove('wpdf-drop-active');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      this.emit({ type: 'drop-accepted', name: file.name });
      void this.load(file).catch((error) => this.emit({ type: 'error', error }));
    });
  }

  private emitZoom(): void {
    this.emit({
      type: 'zoom-change',
      scale: this.effectiveZoom,
      layoutScale: this.scale,
      mode: this.mode,
      pageScale: this.pageScale,
      zoomed: this.pageScale > 1.001,
    });
  }

  /** Returns false when a host handler took the event over by returning false. */
  private emit(event: ViewerEvent): boolean {
    return this.opt.onEvent?.(event) !== false;
  }

  destroy(): void {
    this.destroyed = true;
    this.cropEpoch++;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    if (this.zoomFrame) cancelAnimationFrame(this.zoomFrame);
    if (this.cropFrame) cancelAnimationFrame(this.cropFrame);
    this.frameRequest = 0;
    this.zoomFrame = 0;
    this.cropFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onPageScale);
    window.visualViewport?.removeEventListener('scroll', this.onPageScale);
    document.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('popstate', this.onPopState);
    this.pagesEl.removeEventListener('click', this.onClick);
    this.pagesEl.removeEventListener('keydown', this.onLinkKeyDown);
    this.clearSlots();
    this.surface.remove();
    this.host.style.height = '';
    this.fontStyleEl?.remove();
    if (this.fontSheet) {
      const doc = this.opt.container.ownerDocument;
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== this.fontSheet);
    }
    this.engine.close();
  }
}

const VIEWER_CSS = `
.wpdf-surface{position:relative;width:100%;height:100%;background:var(--wpdf-bg,#f3f4f6)}
.wpdf-pages{position:relative;margin:0 auto}
.wpdf-page{position:absolute;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);overflow:hidden;contain:strict}
.wpdf-page-svg{display:block;width:100%;height:100%}
/* A PDF link is an invisible rectangle, so the only way to know it is there is
   to be told: the hit area lights up under the pointer and under the keyboard.
   It is deliberately not boxed in the page the way an editable field is - a
   document's own pixels stay its own (and so does an exported SVG); the
   affordance belongs to the viewer. */
.wpdf-page-svg a.wpdf-link{cursor:pointer}
.wpdf-page-svg a.wpdf-link:hover>rect{fill:rgba(37,99,235,.16)}
.wpdf-page-svg a.wpdf-link:focus-visible{outline:none}
.wpdf-page-svg a.wpdf-link:focus-visible>rect{fill:rgba(37,99,235,.22);stroke:#2563eb;stroke-width:1}
.wpdf-host.wpdf-drop-active::after{content:"";position:absolute;inset:6px;border:2px dashed #2563eb;border-radius:8px;pointer-events:none;z-index:5}
`;
