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
 *
 * Windowing is wider than the viewport on purpose, and what is *put in the
 * document* is not the same as what is *rendered*:
 *
 *  - Pages are rendered for a window that reaches a whole viewport past the
 *    viewport on each side, so a page is drawn well before it is looked at.
 *  - A page is never a document of its own for longer than it has to be. The
 *    engine plans the document's fonts in the background - one `@font-face` per
 *    *font*, for every page - and until that plan is ready a page's faces are
 *    its own, built from the glyphs that page drew. Registering a face makes
 *    Chromium lay out every text run of the document it lands in, so while the
 *    plan is being walked each page is drawn in a frame of its own, where its
 *    faces cannot touch another page. When the plan is ready every face the
 *    document will ever need is written in one go and the frames are replaced
 *    by the viewer's own document: from then on the pages are one document, and
 *    selection across pages, find-in-page and a caret are the reader's.
 *    `renderMode` says which of the two a host wants, and `'frames'` is how a
 *    host asks for a page per document and nothing else (`renderMode`).
 *  - A finished page is installed at a quiet moment rather than the moment it
 *    arrives: parsing and laying out 100-300 kB of SVG in the middle of a scroll
 *    costs a frame. A page the reader is looking at, or is one page away from,
 *    still goes in straight away: a hitch is better than a blank page.
 *  - While the reader is at rest, the pages just past the window are rendered
 *    *and installed* - one page per idle frame - so that arriving at one costs a
 *    scroll and nothing else.
 */

import type { DocumentInfo, PdfEngineLike, PdfSource, RenderOptions, RenderedPage } from '../core/engine.ts';
import type { FontAsset } from '../core/font/registry.ts';
import type { FontPlanProgress } from '../core/font/plan.ts';
import { linkTargetOf, type LinkTarget } from '../core/links.ts';
import { debug as DEBUG } from '../core/debug.ts';
import { normaliseRules, padBox, type CropRect, type CropRuleId } from '../core/crop.ts';
import { BIONIC_DIM, bionicDim } from '../core/svg/bionic.ts';
import {
  computeFitScale,
  PageLayout,
  type LayoutOptions,
  type PageGeometry,
  type Viewport,
  type ZoomMode,
} from './layout.ts';

export type RenderMode = 'progressive' | 'frames' | 'global';

/** How the pages are actually being drawn at this moment. */
export type PageMode = 'frames' | 'document';

export type ViewerEvent =
  | { type: 'document-loaded'; info: DocumentInfo }
  /**
   * How the pages are drawn has changed: `frames` while the document's fonts
   * are being planned (or for the whole document, when that is what the host
   * asked for), `document` once they are one document. A viewer that starts in
   * `document` - the plan was ready before the first page, or `planFonts` is
   * off and the host wants one document anyway - never emits `frames`.
   */
  | { type: 'render-mode'; mode: PageMode; plan: FontPlanProgress | null }
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
  /**
   * A page has been rendered. It is not necessarily in the document yet: a page
   * the reader is not near goes in at the next quiet moment, and either way the
   * pages in hand are listed by `preparedPages` (`pageElement` is null until the
   * page is actually inserted).
   */
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
  /**
   * How far past the viewport the rendered window reaches, in viewport heights
   * on each side, on top of `keepPages`. Default 1, which is the distance that
   * gives a page time to be drawn before it is looked at; 0 narrows the window
   * to the pages `keepPages` names (and is only worth it on a device where
   * keeping a page or two more in memory is the binding constraint).
   */
  overscanViewports?: number;
  /**
   * Pages past the window to render while the pipeline has nothing else to do,
   * so that arriving at them costs neither a render nor a font registration.
   * Default 3; 0 renders nothing ahead.
   */
  prepareAhead?: number;
  /** Simultaneous page renders. 1 keeps scrolling smoothest on the main thread. */
  concurrency?: number;
  /**
   * How the pages are drawn while the document's fonts are being planned. See
   * `RenderMode`: `'progressive'` (the default) shows a frame per page until
   * the plan is ready and then one document, `'frames'` keeps a frame per page
   * for good, and `'global'` shows nothing until the pages can be one document.
   */
  renderMode?: RenderMode;
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
  /**
   * The page's own document, while the pages are drawn one to a frame (see
   * `renderMode`). It is made with the slot's first page and kept across a
   * redraw of it, which is what makes a fade, a zoom or a crop of the same page
   * register no face at all.
   */
  frame: HTMLIFrameElement | null;
  /** The frame's stylesheet: its reset, then the page's font faces. */
  sheet: CSSStyleSheet | null;
  /** Families already registered in that frame's document. */
  fonts: Set<string>;
  svg: Element | null;
  /** `empty`: nothing asked for yet. `pending`: asked for, not on screen. `done`: in the DOM. */
  state: 'empty' | 'pending' | 'done';
}

interface QueueEntry {
  index: number;
  priority: number;
  seq: number;
  /** The generation the render was asked for, so a stale answer is dropped. */
  generation: number;
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
 * How long the view has to be still before deferred work runs. Long enough that
 * the pause between two wheel notches does not count as stopping, short enough
 * that the work is done before the reader has finished deciding to read on.
 */
const SETTLE_MS = 150;

/** Pages past the window prepared while the pipeline has nothing else to do. */
const PREPARE_AHEAD = 3;

/** Priority of work that is only being done early. Below every page on screen. */
const WARM_PRIORITY = 100;

/**
 * How long a page's faces may take to register inside its own frame while the
 * reader is at rest.
 *
 * A page of a paper can bring a dozen subsets, and compiling them all is tens
 * of milliseconds - a dropped frame. Nobody is waiting for a prepared page, so
 * it takes the next frame instead. Only the pages off screen are given this
 * budget: a page the reader is arriving at goes in with all of its faces.
 */
const FACE_BUDGET_MS = 6;

/**
 * The keys a host answers for the document, and a page frame must not eat.
 *
 * A frame is a document, so Ctrl+P in one prints the frame and Ctrl+F searches
 * it - not the document the reader is reading. These are taken over inside the
 * page and repeated on the viewer's own document, where the host's listener is;
 * every other key, Ctrl+C included, belongs to the page.
 */
const HOST_KEYS = new Set(['p', 's', 'f', 'o']);

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
  private readonly inFlight = new Map<number, number>();
  /**
   * Pages that have been rendered, keyed by index, whether or not they are in
   * the DOM. A page here can be put on screen without asking the engine for
   * anything; one that is past the window is simply waiting its turn.
   */
  private readonly results = new Map<number, RenderedPage>();
  /** Faces built but not in the stylesheet yet, keyed by family. */
  private readonly stagedFonts = new Map<string, FontAsset>();
  /** Families already in the stylesheet. A face is registered once, ever. */
  private readonly insertedFonts = new Set<string>();
  /** How the pages are drawn right now: a frame each, or the one document. */
  private pageMode: PageMode = 'document';
  /**
   * True while nothing is drawn on purpose: the pages are going to be one
   * document and the document's fonts are not planned yet (`'global'` mode).
   */
  private waiting = false;
  /** Unsubscribes from the plan this document is waiting for, if it is. */
  private unwatchPlan: (() => void) | null = null;
  /** Per-index render generation, bumped when what is on screen is wrong. */
  private readonly generations = new Map<number, number>();
  /** The window the last tick asked for: index -> priority. */
  private window = new Map<number, number>();
  /** Pages actually intersecting the viewport, as of the last tick. */
  private visible: Viewport = { start: 0, end: 0 };
  /** When the view last moved: what tells a scroll in flight from a pause. */
  private lastMoveAt = 0;
  private lastOffset = -1;
  private settleTimer = 0;
  private flushFrame = 0;
  /** The window the engine was last told to keep; it is only told when it moves. */
  private trimKey = '';

  private info: DocumentInfo | null = null;
  /** The pages as the document has them, whatever crop is in force. */
  private baseGeometry: PageGeometry[] = [];
  /** The pages as they are laid out: the same, cropped where a box is known. */
  private geometry: PageGeometry[] = [];
  /** Measured crop boxes, one entry per page; null for "not cropped". */
  private cropBoxes: (CropRect | null)[] = [];
  /**
   * Where the reader was when the crop boxes now being applied started to
   * arrive: read once per batch, and in the coordinates of the layout the boxes
   * have not changed yet.
   */
  private cropPlace: Place | null = null;
  /** The rules in force, empty for no crop at all. */
  private cropRules: CropRuleId[] = [];
  /** Page units kept around the content box, on every side. */
  private padding = 0;
  /** Bionic reading: every word's first letters at full strength, the rest faded. */
  private bionicOn = false;
  /** How much strength the faded part of a word keeps, 0..1. */
  private bionicDimValue = BIONIC_DIM;
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
      overscanViewports: Math.max(0, opts.overscanViewports ?? 1),
      prepareAhead: Math.max(0, Math.round(opts.prepareAhead ?? PREPARE_AHEAD)),
      concurrency: opts.concurrency ?? 1,
      renderMode: opts.renderMode ?? 'progressive',
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
    // `style-src` policy, which matters inside browser extensions. Every page's
    // faces go in here, once each, and the document is told about nothing else.
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

  /**
   * Write the open document out: a fresh copy of what this viewer is holding,
   * compressed, with no encryption on it.
   *
   * Not the bytes the document was opened from - those are the reader's own
   * file, and this is MuPDF writing that document out again - so it is for
   * handing the document on rather than for keeping a file byte for byte. It is
   * what printing is built on: a PDF is exactly what a printer wants, and a
   * password the printer does not have is exactly what it must not be handed.
   *
   * Throws `DocumentNotOpenError` when there is nothing open, and when the
   * engine cannot write a document out at all.
   */
  async save(): Promise<Uint8Array> {
    if (!this.engine.save) throw new Error('This engine cannot write the document out');
    return await this.engine.save();
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
    this.results.clear();
    this.stagedFonts.clear();
    this.generations.clear();
    this.clearFonts();
    // Whatever the last document had been told about its own fonts is not this
    // document's business, and this one is drawn the way `renderMode` asks for
    // from its first page.
    this.watchPlan();
    this.window = new Map();
    this.lastOffset = -1;
    this.trimKey = '';
    // A newly opened document starts at the level the `zoom` option asks for,
    // whatever the previous document was left at - and the mode has to say so, or
    // a fit level would stop re-fitting on a container resize.
    this.mode = typeof this.homeZoom === 'string' ? this.homeZoom : 'custom';
    this.scale = this.resolveScale();
    this.rebuildLayout();
    this.scrollToOffset(0);
    this.currentPage = 1;
    this.emit({ type: 'document-loaded', info });
    this.emit({ type: 'render-mode', mode: this.pageMode, plan: this.planProgress() });
    this.emitZoom();
    this.update();
    if (this.cropRules.length > 0) this.measureCrop();
  }

  /* --------------------------------------------------------- render mode */

  /** How the pages are drawn at this moment, for a host that shows it. */
  get pagesInFrames(): boolean {
    return this.pageMode === 'frames';
  }

  private planProgress(): FontPlanProgress | null {
    return this.engine.planProgress?.() ?? null;
  }

  /**
   * Decide how this document is drawn, and wait for the plan if the answer is
   * going to change.
   *
   * The engine starts planning a document's fonts the moment it is open, so the
   * question is only ever "is it ready yet". It is not, to begin with: a paper's
   * plan is 0.6-2.3 s of walking and building, and a 756-page specification's is
   * 18. What happens in the meantime is the host's choice (`RenderMode`), and it
   * is the whole reason this class has two ways of drawing a page.
   */
  private watchPlan(): void {
    this.unwatchPlan?.();
    this.unwatchPlan = null;
    const plan = this.planProgress();
    const ready = plan?.ready === true;
    const mode = this.opt.renderMode;
    // `'global'` wants one document from the first pixel; the other two ask for
    // one as soon as the plan is ready, and a document whose plan is already in
    // hand starts there.
    this.pageMode = ready || mode === 'global' ? 'document' : 'frames';
    // A document that is going to be one document, and whose plan is not ready
    // yet, draws nothing at all: a page drawn now is a page drawn twice, and the
    // second time is exactly the flash this mode exists to avoid.
    this.waiting = mode === 'global' && !ready && plan !== null;
    if (ready) {
      // Planned already - a one-page document, or a plan that finished while the
      // document was being read - so every face the pages will ever need is in
      // hand now, and they go in as one write before the first page is laid out.
      if (this.pageMode === 'document') void this.registerPlanned();
      return;
    }
    if (mode === 'frames' || plan === null) return;
    this.unwatchPlan = this.engine.onPlanReady?.(this.onPlanReady) ?? null;
  }

  /**
   * The document's fonts are planned: the pages can be one document.
   *
   * Everything the plan built goes in as one write - registering a face
   * re-lays-out every text run in the document however many rules arrive with
   * it, so they may as well all arrive together - and everything on screen is
   * drawn again, because it was drawn with the faces of its own page and is
   * about to be drawn with the document's.
   */
  private onPlanReady = (): void => {
    if (this.destroyed || this.opt.renderMode === 'frames') return;
    const switching = this.pageMode === 'frames';
    this.waiting = false;
    this.pageMode = 'document';
    this.unwatchPlan?.();
    this.unwatchPlan = null;
    if (switching) {
      for (const slot of this.slots.values()) this.forgetFrame(slot);
      this.invalidateAll();
    }
    void this.registerPlanned();
    this.emit({ type: 'render-mode', mode: 'document', plan: this.planProgress() });
    this.update();
  };

  /**
   * Write every face the plan built into this document, once each.
   *
   * A face that is already in is left alone, so this is safe to call at any
   * time: it is the *one* write of a planned document, and an empty one when
   * there is nothing planned.
   */
  private async registerPlanned(): Promise<void> {
    const planned = await this.engine.plannedFonts?.();
    if (this.destroyed || this.pageMode !== 'document' || !planned?.length) return;
    this.insertFonts(planned);
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
      const place = this.placeHere();
      this.padding = pad;
      this.applyCropGeometry();
      this.invalidateAll();
      this.relayout(place);
      this.emitCrop(true);
      return;
    }
    this.padding = pad;
    this.cropRules = next;
    // Whatever pass was running is now measuring for the wrong selection.
    this.cropEpoch++;
    this.cropRunning = false;
    if (next.length === 0) {
      const place = this.placeHere();
      this.cropBoxes = [];
      this.cropMeasured = 0;
      this.applyCropGeometry();
      this.invalidateAll();
      this.relayout(place);
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
   *
   * `dim` is how much strength the faded part of each word keeps, 0..1, and
   * stays where it is put: passing it without `on` is how a host changes the
   * fade while the mode is already on, and leaving it out keeps the value in
   * force (`BIONIC_DIM` until one is given). Either way what is on screen was
   * drawn the other way and is now wrong, so it is re-rendered - never
   * re-measured, because a fade moves nothing.
   */
  setBionic(on: boolean, dim?: number): void {
    const next = on === true;
    const nextDim = bionicDim(dim ?? this.bionicDimValue);
    if (next === this.bionicOn && nextDim === this.bionicDimValue) return;
    this.bionicOn = next;
    this.bionicDimValue = nextDim;
    this.invalidateAll();
    this.update();
  }

  /** Whether pages are drawn with bionic reading's fixation points. */
  get bionic(): boolean {
    return this.bionicOn;
  }

  /** The opacity the faded part of a word is drawn at, 0..1. */
  get bionicDim(): number {
    return this.bionicDimValue;
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
    // Read where the reader is *before* the page's window changes: a crop box is
    // part of the coordinate system a position is expressed in, so a position
    // read after this line would be a position in a document that no longer
    // exists - and the reader would be moved by the box they were measured for.
    this.cropPlace ??= this.placeHere();
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
  /**
   * Re-lay-out the pages without moving the reader.
   *
   * A crop arriving, the padding moving, a rule being unchecked: the pages change
   * size, and what has to survive that is the *point in the document* the reader
   * is on - a sentence is not supposed to slide down the screen because a margin
   * above it was trimmed. So the position is read in the coordinates the document
   * has until now, the layout is rebuilt, and the reader is put back on that
   * point: under a crop that has just removed the top of a page, that is nearer
   * the top of the screen than it was, which is exactly right - the page is
   * shorter and the content has not moved.
   *
   * `place` is passed in by the callers that are *about* to change the boxes,
   * because reading it after that would mix the new crop with the old layout.
   */
  private relayout(place: Place = this.placeHere()): void {
    if (this.geometry.length === 0) {
      this.rebuildLayout();
      return;
    }
    this.rebuildLayout();
    this.goToPlace(place);
    this.update();
  }

  /** Scroll so that a remembered position is at the top of the page area. */
  private goToPlace(place: Place): void {
    const index = Math.max(0, Math.min(this.geometry.length - 1, place.page - 1));
    this.scrollToOffset(
      place.y === null ? this.layout.offsetOf(index) : this.layout.offsetOfPoint(index, this.shownY(index, place.y), this.scale),
    );
  }

  /**
   * Boxes arrive once per page, and every arrival would otherwise re-lay-out the
   * whole document. One per frame is plenty, and the reader never sees a page
   * size change twice in a frame.
   *
   * The position `setCropBox` read before it changed anything is what the layout
   * is rebuilt around, so a batch of boxes arriving between two frames is still
   * one position rather than the last of them.
   */
  private scheduleCropLayout(): void {
    if (this.cropFrame || this.destroyed) return;
    this.cropFrame = requestAnimationFrame(() => {
      this.cropFrame = 0;
      if (this.destroyed) return;
      const place = this.cropPlace ?? this.placeHere();
      this.cropPlace = null;
      this.applyCropGeometry();
      this.relayout(place);
    });
  }

  /**
   * Throw away what is on screen for a page, and anything rendered for it that
   * has not been put there yet. Bumping the generation first is what makes a
   * render already in flight harmless when it lands.
   */
  private invalidateSlot(index: number): void {
    this.generations.set(index, this.generationOf(index) + 1);
    this.results.delete(index);
    const slot = this.slots.get(index);
    if (!slot) return;
    // A page's own document is emptied rather than thrown away: it already
    // holds the faces this page needs, and a face already registered in a
    // document costs nothing to keep. A redraw that wants the same fonts - a
    // fade, a zoom, a crop of the same page - registers none at all. In the
    // viewer's own document, the same is true of the faces registered there.
    const doc = slot.frame?.contentDocument;
    if (doc) doc.body.replaceChildren();
    else slot.el.replaceChildren();
    slot.svg = null;
    slot.state = 'empty';
  }

  private invalidateAll(): void {
    for (const index of new Set([...this.slots.keys(), ...this.results.keys()])) this.invalidateSlot(index);
  }

  private generationOf(index: number): number {
    return this.generations.get(index) ?? 0;
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
   * Where the reader is now: the page, and the point within it in the document's
   * own coordinates - exactly what `goToDestination` takes, so a host can write
   * the position down and hand it back after a reload. `y` is `null` at the top
   * of the page, which is what `goToPage` restores.
   *
   * Deliberately the *reading* position (the top of the page area, a host's
   * chrome accounted for), not the scroll offset: two layouts of the same
   * document at different zooms have nothing in common in pixels and everything
   * in common in pages.
   */
  place(): { page: number; y: number | null } {
    const place = this.placeHere();
    return { page: place.page, y: place.y };
  }

  /**
   * A point on a page, in the coordinates of the page *as it is shown*.
   *
   * Destinations arrive in the document's own coordinates - a link annotation's
   * target is a point on the uncropped page, and so is a remembered position -
   * while the layout measures from the top of whatever the reader is actually
   * looking at. With a crop in force those two differ by the top of the crop,
   * and a jump that ignored it lands a whole margin too far down the page.
   *
   * The top of the crop is `cropBox`, not the measured box underneath it: a
   * margin is part of the window the page is shown through, so under a padded
   * crop a destination differs by the padding as well.
   */
  private shownY(index: number, y: number): number {
    const box = this.cropBox(index + 1);
    return box ? y - box.y : y;
  }

  /** The inverse: from a point on the shown page back to the document's own. */
  private documentY(index: number, y: number): number {
    const box = this.cropBox(index + 1);
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

  /**
   * The SVG element for a page, or null when it is not currently rendered.
   *
   * While the pages are drawn one to a frame (`renderMode`), this is the SVG
   * inside that page's own document: it is a page the viewer can read and
   * measure, but it is not a node of the viewer's document, and a range in the
   * viewer's document cannot reach into it.
   */
  pageElement(page: number): Element | null {
    return this.slots.get(page - 1)?.svg ?? null;
  }

  /**
   * The pages the viewer has rendered and is holding, in page order - on screen
   * or waiting to be. Everything here can be put in front of the reader without
   * asking the engine for anything, which is what makes a page turn free.
   */
  get preparedPages(): number[] {
    return [...this.results.keys()].sort((a, b) => a - b).map((index) => index + 1);
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
      bionicDim: this.bionicDimValue,
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
      const s: PageSlot = { index, el, frame: null, sheet: null, fonts: new Set(), svg: null, state: 'empty' };
      slot = s;
      this.slots.set(index, slot);
      this.pagesEl.appendChild(el);
    }
    return slot;
  }

  /**
   * Forget the element for a page, not the page: what was rendered for it stays
   * in `results`, so scrolling back to it costs a DOM insert rather than a
   * render. A render still in flight for it is left to land - it will be kept
   * as a prepared page.
   */
  private removeSlot(index: number): void {
    const slot = this.slots.get(index);
    if (!slot) return;
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
    // The window reaches a whole viewport past the viewport unless the host says
    // otherwise, so a page is rendered - and its fonts registered - while it is
    // still a screen away from being read.
    const overscan = this.opt.overscanViewports * viewportHeight;
    const wide = overscan > 0 ? this.layout.visibleRange(offset, viewportHeight, overscan) : visible;
    const keep = this.opt.keepPages;
    this.visible = visible;

    const wanted = new Map<number, number>(); // index -> priority
    // The widened range contains the visible one except where either fell back
    // to the nearest page, so the window is the union of the two.
    const first = Math.max(0, Math.min(visible.start, wide.start) - keep);
    const last = Math.min(this.geometry.length - 1, Math.max(visible.end, wide.end) + keep);
    for (let i = first; i <= last; i++) {
      // On screen goes first; otherwise the page that will be reached soonest
      // is the one worth having ready.
      const distance = i < visible.start ? visible.start - i : i > visible.end ? i - visible.end : 0;
      wanted.set(i, distance);
    }
    this.window = wanted;

    // A page prepared past the window stays in the document once it is there:
    // installing it is what `installAhead` does at rest, and removing it on the
    // next tick would throw that work away.
    const held = new Set<number>();
    for (let i = last + 1; i <= last + this.opt.prepareAhead && i < this.geometry.length; i++) {
      if (this.slots.has(i)) held.add(i);
    }
    for (const index of [...this.slots.keys()]) {
      if (!wanted.has(index) && !held.has(index)) this.removeSlot(index);
    }

    for (const [index, priority] of wanted) {
      const slot = this.ensureSlot(index);
      this.positionSlot(slot);
      // Nothing is drawn while the pages are waiting for the plan, but the page
      // boxes are laid out and scrolling already works: what arrives when the
      // plan is ready is the drawing, not the document.
      if (this.waiting || slot.state === 'done') continue;
      // A page that has already been rendered only has to be put in; one that
      // has not must be asked for.
      if (this.results.has(index)) this.consider(index);
      else this.enqueue(index, priority);
    }

    // Re-position slots affected by a layout change even when not re-created.
    for (const slot of this.slots.values()) this.positionSlot(slot);

    // The engine is told what to keep only when the window actually moves: it is
    // a message to another thread, and it releases pages, which costs work.
    const trimKey = [...wanted.keys()].join(',');
    if (trimKey !== this.trimKey) {
      this.trimKey = trimKey;
      this.engine.trimCaches?.([...wanted.keys()]);
    }

    const page = this.layout.currentPage(offset, viewportHeight) + 1;
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.emit({ type: 'page-change', page, pageCount: this.geometry.length });
    }
    // A tick that finds the view somewhere new is the reader moving. This is
    // what "scrolling" means below: not a `scroll` event, but the view having
    // actually moved within the last `SETTLE_MS`.
    if (offset !== this.lastOffset) {
      this.lastOffset = offset;
      this.lastMoveAt = performance.now();
      clearTimeout(this.settleTimer);
      this.settleTimer = 0;
    }
    this.pump();
    this.scheduleFlush();
  }

  /* -------------------------------------------------- window and document */

  /** True while the view is still moving: deferred work has to wait. */
  private scrolling(): boolean {
    return performance.now() - this.lastMoveAt < SETTLE_MS;
  }

  /**
   * Whether a page has to be on screen whatever else is going on: it is in the
   * viewport, or next to it. A page this close is looked at within a flick, so
   * it goes in the moment it is ready - a frame's work is better than a blank
   * page - while everything further out waits for the scroll to stop.
   */
  private aboutToBeSeen(index: number): boolean {
    return index >= this.visible.start - 1 && index <= this.visible.end + 1;
  }

  /**
   * Put a rendered page on screen, now if the moment is right and later if not.
   * A page outside the window keeps its faces staged, which the next quiet
   * moment registers: that is what makes the page free when it is reached.
   */
  private consider(index: number): void {
    const slot = this.slots.get(index);
    if (!slot || !this.window.has(index)) {
      this.scheduleFlush();
      return;
    }
    if (slot.state === 'done') return;
    if (!this.scrolling() || this.aboutToBeSeen(index)) this.insert(slot, index);
    else {
      slot.state = 'pending';
      this.scheduleFlush();
    }
  }

  /**
   * Insert a rendered page into its slot. Faces go first, and always in one
   * write: registering a face is not a no-op however it is spelled. With a
   * planned document there is nothing to write at all - every face the page
   * needs was registered when the plan became the document's.
   */
  private insert(slot: PageSlot, index: number): void {
    const page = this.results.get(index);
    if (!page) return;
    if (this.pageMode === 'frames') {
      const doc = this.frameFor(slot);
      if (doc) {
        // Faces before text, in the page's own document: the page is then laid
        // out once, with what it needs, and never invalidated afterwards.
        this.facesInto(slot, page.fonts);
        this.writeFramed(slot, doc, page);
        return;
      }
      // No frame could be had - a host with frames disabled at the platform
      // level - so the page goes into the viewer's document, faces and all.
      // Correct, and only ever more expensive.
    }
    this.putInDocument(slot, page);
  }

  /** Put a rendered page into the viewer's own document. */
  private putInDocument(slot: PageSlot, page: RenderedPage): void {
    this.releaseFonts();
    slot.el.innerHTML = page.svg;
    slot.svg = slot.el.firstElementChild;
    slot.state = 'done';
    this.positionSlot(slot);
  }

  /** Put a page's markup into the page's own document, now its faces are in. */
  private writeFramed(slot: PageSlot, doc: Document, page: RenderedPage): void {
    doc.body.innerHTML = page.svg;
    slot.svg = doc.body.firstElementChild;
    slot.state = 'done';
    this.positionSlot(slot);
  }

  /* ------------------------------------------------------------ page frames */

  /**
   * The document this page is drawn in, made the first time the page goes in.
   *
   * A frame is left at `about:blank` and written into directly - no navigation,
   * no load event, no second copy of the page - so it is same-origin and stays
   * that way, which is what lets the viewer (and the host) keep reading it. It
   * is never sandboxed for the same reason: a page the viewer cannot reach is a
   * page it cannot search, measure or paint in, and one the reader cannot copy
   * from. Everything a document gives a reader - selection, the clipboard, the
   * context menu, find-in-page, a caret - is the frame's own, because it is a
   * document like any other.
   */
  private frameFor(slot: PageSlot): Document | null {
    const existing = slot.frame?.contentDocument;
    if (existing) return existing;
    const frame = document.createElement('iframe');
    frame.className = 'wpdf-page-frame';
    frame.title = `Page ${slot.index + 1}`;
    // Clipboard access is the frame's own business, not something to inherit by
    // luck: the reader selected the text, and copy should work.
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    slot.el.appendChild(frame);
    const win = frame.contentWindow as (Window & typeof globalThis) | null;
    const doc = frame.contentDocument;
    if (!win || !doc) {
      frame.remove();
      return null;
    }
    slot.frame = frame;
    // A doctype, or the frame quietly lays out in quirks mode.
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    doc.title = `Page ${slot.index + 1}`;
    slot.sheet = this.styleFrame(doc, win);
    this.wireFrame(doc, slot);
    return doc;
  }

  /**
   * The frame's own stylesheet. Constructed where possible: a host page's
   * `style-src` cannot block one, which matters inside browser extensions and
   * when embedding into a page whose CSP is not yours.
   */
  private styleFrame(doc: Document, win: Window & typeof globalThis): CSSStyleSheet | null {
    const ctor = (win as unknown as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
    if (ctor && 'adoptedStyleSheets' in doc && 'replaceSync' in ctor.prototype) {
      const sheet = new ctor();
      sheet.replaceSync(FRAME_CSS);
      doc.adoptedStyleSheets = [sheet];
      return sheet;
    }
    const el = doc.createElement('style');
    el.textContent = FRAME_CSS;
    (doc.head ?? doc.documentElement).appendChild(el);
    return null;
  }

  /**
   * Register a page's faces in that page's document, once each.
   *
   * These are the faces the page itself drew, so they belong to the page and
   * nowhere else: telling the viewer's document about them is what would make
   * it lay out every other page again.
   *
   * `budgetMs` stops the work between faces and reports how many went in, so a
   * page that brings a dozen subsets can be compiled over several frames
   * instead of one. It is for pages nobody is waiting for; a page the reader is
   * arriving at takes the whole cost in the frame it arrives in.
   */
  private facesInto(slot: PageSlot, assets: readonly FontAsset[], budgetMs = Infinity): number {
    const doc = slot.frame?.contentDocument ?? null;
    const started = performance.now();
    let added = 0;
    for (const asset of assets) {
      if (slot.fonts.has(asset.family)) continue;
      if (added > 0 && performance.now() - started >= budgetMs) return added;
      slot.fonts.add(asset.family);
      added++;
      if (slot.sheet) {
        try {
          slot.sheet.insertRule(asset.css, slot.sheet.cssRules.length);
          continue;
        } catch (error) {
          DEBUG('insertRule failed', asset.family, String(error));
        }
      }
      if (!doc) continue;
      let el = doc.querySelector<HTMLStyleElement>('style[data-wpdf="fonts"]');
      if (!el) {
        el = doc.createElement('style');
        el.dataset.wpdf = 'fonts';
        (doc.head ?? doc.documentElement).appendChild(el);
      }
      el.appendChild(doc.createTextNode('\n' + asset.css));
    }
    return added;
  }

  /** Let go of a page's document, and of what was registered in it. */
  private forgetFrame(slot: PageSlot): void {
    slot.frame = null;
    slot.sheet = null;
    slot.fonts.clear();
  }

  /**
   * The gestures the viewer owns, listened for inside the page as well: a frame
   * is a document, and nothing that happens in it bubbles out to this one.
   */
  private wireFrame(doc: Document, slot: PageSlot): void {
    doc.addEventListener('click', this.onClick);
    doc.addEventListener('keydown', this.onLinkKeyDown);
    doc.addEventListener('keydown', this.onKeyDown);
    doc.addEventListener('keydown', this.onFrameKeyDown(slot));
    doc.addEventListener('pointerdown', this.onPagePointerDown(slot));
    if (this.opt.acceptDrop) {
      doc.addEventListener('dragover', this.onDragOver);
      doc.addEventListener('dragleave', this.onDragLeave);
      doc.addEventListener('drop', this.onDrop);
    }
  }

  /**
   * The keys a *host* has taken over, repeated in the viewer's own document.
   *
   * Ctrl+P, Ctrl+S, Ctrl+F and Ctrl+O mean the document - printing it, saving
   * it, searching it, opening another - and a host answers them on its own
   * document, which a page, being a document of its own, does not reach. They
   * are taken over here (so the browser prints the frame instead of the
   * document, or opens its own find bar over one page) and repeated on the
   * page's own box, where the viewer's listeners and the host's are. Everything
   * else - Ctrl+C above all - is left to the page, which is a document the
   * reader can select and copy from.
   */
  private onFrameKeyDown = (slot: PageSlot) => (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (!HOST_KEYS.has(event.key.toLowerCase())) return;
    event.preventDefault();
    slot.el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  };

  /**
   * A pointer went down on a page. The page is a document of its own, so nothing
   * about the gesture reaches this one - but a host that closes a menu when the
   * reader clicks the page (or that wants to know the reader touched it) is
   * entitled to hear about it, so the gesture is repeated here, on the page's
   * own container, in this document's coordinates.
   */
  private onPagePointerDown = (slot: PageSlot) => (event: PointerEvent): void => {
    const frame = slot.frame;
    if (!frame) return;
    const box = frame.getBoundingClientRect();
    slot.el.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: box.left + event.clientX,
        clientY: box.top + event.clientY,
        button: event.button,
        buttons: event.buttons,
        pointerType: event.pointerType,
        isPrimary: event.isPrimary,
      }),
    );
  };

  /**
   * The quiet moment: put in whatever the reader has stopped in front of, and
   * prepare what is coming. One page per frame, because each one is a parse and
   * a paint of a whole page - being idle is not a reason to drop frames.
   */
  private flush(): void {
    if (this.destroyed || this.waiting) return;
    if (this.scrolling()) {
      this.scheduleFlush();
      return;
    }
    // Any face built since the last write goes in now, all of them at once:
    // registering a face costs a layout of every text run in the document
    // however many rules arrive together, so they may as well arrive together.
    this.releaseFonts();

    const waiting = this.waitingPages();
    if (waiting.length > 0) {
      const index = waiting[0];
      const slot = this.slots.get(index);
      if (slot) this.insert(slot, index);
      this.flushFrame = requestAnimationFrame(() => {
        this.flushFrame = 0;
        this.flush();
      });
      return;
    }
    if (this.installAhead()) {
      this.flushFrame = requestAnimationFrame(() => {
        this.flushFrame = 0;
        this.flush();
      });
      return;
    }
    this.warmAhead();
  }

  /** Pages in the window that are rendered but not in the document yet, nearest first. */
  private waitingPages(): number[] {
    const out: number[] = [];
    for (const index of this.window.keys()) {
      const slot = this.slots.get(index);
      if (slot && slot.state !== 'done' && this.results.has(index)) out.push(index);
    }
    return out.sort((a, b) => (this.window.get(a) ?? 0) - (this.window.get(b) ?? 0));
  }

  private scheduleFlush(): void {
    if (this.settleTimer || this.destroyed) return;
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0;
      this.flush();
    }, SETTLE_MS);
  }

  /** The last page index the window reaches, or -1 before a document is open. */
  private lastWindowIndex(): number {
    let last = -1;
    for (const index of this.window.keys()) last = Math.max(last, index);
    return last;
  }

  /**
   * Put the pages that were prepared past the window on screen as well, while the
   * reader is at rest.
   *
   * A page is not free to arrive at just because it has been rendered: it is a
   * whole page of SVG to parse and lay out, and that lands in the frame where
   * the reader reaches the page. They are off-screen here, so doing it now costs
   * nothing to look at, and it is the whole point of preparing them: what a page
   * costs is paid while nobody is waiting for it.
   *
   * One page per idle frame, because being idle is not a reason to drop frames.
   */
  private installAhead(): boolean {
    if (this.opt.prepareAhead <= 0) return false;
    const last = this.lastWindowIndex();
    for (let i = last + 1; i <= last + this.opt.prepareAhead && i < this.geometry.length; i++) {
      const slot = this.slots.get(i);
      if (slot?.state === 'done') continue;
      const page = this.results.get(i);
      // Prepared pages are rendered in order, so the first one still missing is
      // where the line ends: there is nothing beyond it to install yet.
      if (!page) return false;
      const target = slot ?? this.ensureSlot(i);
      if (this.pageMode !== 'frames') {
        this.putInDocument(target, page);
        return true;
      }
      const doc = this.frameFor(target);
      if (!doc) {
        this.putInDocument(target, page);
        return true;
      }
      // A page brings its own faces into its own document, and nobody is
      // waiting for it: what a page costs is paid a few faces per idle frame
      // rather than all at once in the frame the reader arrives on.
      if (target.svg) return true;
      if (this.facesInto(target, page.fonts, FACE_BUDGET_MS) > 0) return true;
      this.writeFramed(target, doc, page);
      return true;
    }
    return false;
  }

  /**
   * Render the pages just past the window while the pipeline has nothing else to
   * do. None of this is extra work - those pages would be rendered on the way to
   * them - and doing it now means their fonts are registered and their SVG is in
   * hand before the reader arrives, which is the whole point: what a page costs
   * is paid while nobody is waiting for it.
   */
  private warmAhead(): void {
    if (this.queue.length > 0 || this.inFlight.size > 0) return;
    const last = this.lastWindowIndex();
    if (last < 0) return;
    for (let i = last + 1; i <= last + this.opt.prepareAhead && i < this.geometry.length; i++) {
      if (this.results.has(i)) continue;
      this.enqueue(i, WARM_PRIORITY);
    }
    this.pump();
  }

  /** Keep the cache to the pages around the reader; the far-away ones go first. */
  private trimResults(): void {
    const limit = this.opt.prepareAhead + this.opt.keepPages + 4;
    if (this.results.size <= limit) return;
    const centre = Math.max(0, this.currentPage - 1);
    for (const index of [...this.results.keys()].sort((a, b) => Math.abs(b - centre) - Math.abs(a - centre) || a - b)) {
      if (this.results.size <= limit) break;
      this.results.delete(index);
    }
  }

  private enqueue(index: number, priority: number): void {
    const slot = this.slots.get(index);
    if (slot?.state === 'done') return;
    // An index is asked for once: a second ask raises its priority and moves it
    // to the current generation, which is what makes re-asking after an
    // invalidation work rather than being swallowed by the stale entry.
    const existing = this.queue.find((entry) => entry.index === index);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      existing.generation = this.generationOf(index);
      return;
    }
    // In flight for an older generation: the answer is dropped when it lands,
    // and `requeue` asks again on the way out.
    if (this.inFlight.has(index)) return;
    this.queue.push({ index, priority, seq: this.seq++, generation: this.generationOf(index) });
    if (slot) slot.state = 'pending';
  }

  private pump(): void {
    if (this.destroyed || this.waiting) return;
    while (this.inFlight.size < this.opt.concurrency && this.queue.length > 0) {
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const entry = this.queue.shift();
      if (!entry) break;
      if (this.generationOf(entry.index) !== entry.generation) continue;
      this.inFlight.set(entry.index, entry.generation);
      void this.render(entry);
    }
  }

  /**
   * Ask again for a page the engine answered for a moment that has passed - a
   * crop, a fade or a zoom changed while the render was in the worker. Without
   * this the page would sit blank until something else happened to re-ask.
   */
  private requeue(index: number): void {
    const slot = this.slots.get(index);
    if (!slot || slot.state === 'done' || !this.window.has(index)) return;
    slot.state = 'empty';
    this.enqueue(index, this.window.get(index) ?? 1);
  }

  private renderOptions(index: number): RenderOptions {
    return {
      textMode: 'auto',
      idPrefix: `p${index}-`,
      responsive: true,
      className: 'wpdf-page-svg',
      crop: this.cropRules,
      cropPadding: this.padding,
      bionic: this.bionicOn,
      bionicDim: this.bionicDimValue,
    };
  }

  private async render(entry: QueueEntry): Promise<void> {
    const index = entry.index;
    let kept = false;
    try {
      DEBUG('render start', index);
      const rendered = await this.engine.renderPage(index, this.renderOptions(index));
      DEBUG('render done', index, rendered.svg.length);
      if (this.destroyed) return;
      // The selection, the zoom or the crop may have moved on while this was in
      // the worker; the generation is what says so.
      if (this.generationOf(index) !== entry.generation) return;

      this.results.set(index, rendered);
      // Faces belong to the document that will draw them. While the pages are
      // one to a frame, a page's faces go into that page's own document when it
      // is put there (`facesInto`), and staging them here would register them in
      // the viewer's document at the switch - faces nothing in it will ever ask
      // for, each one an invalidation of every page on screen.
      if (this.pageMode === 'document') this.stageFonts(rendered.fonts);
      this.trimResults();
      kept = true;
      this.consider(index);

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
      const slot = this.slots.get(index);
      if (slot && this.generationOf(index) === entry.generation) slot.state = 'empty';
      this.emit({ type: 'error', error, page: index + 1 });
    } finally {
      this.inFlight.delete(index);
      if (!this.destroyed) {
        // Nothing usable came of it: either it failed (retry once; a genuine
        // failure will recur and settle) or it answered an older question.
        if (!kept) this.requeue(index);
        this.pump();
        this.scheduleFlush();
      }
    }
  }

  /* ---------------------------------------------------------------- fonts */

  /**
   * Hold a face until the document is told about it. A page's `fonts` are every
   * face it needs, so a face is staged once and never twice - re-registering one
   * is not a no-op for the browser: the font set of the document changes and it
   * lays out every text run again, which is exactly the cost this avoids.
   *
   * A planned document stages nothing after the first page: every face it will
   * ever need was built with the document and written in `load`.
   */
  private stageFonts(assets: readonly FontAsset[]): void {
    for (const asset of assets) {
      if (this.insertedFonts.has(asset.family) || this.stagedFonts.has(asset.family)) continue;
      this.stagedFonts.set(asset.family, asset);
    }
  }

  /** Everything staged, in one write. Called before a page that needs it goes in. */
  private releaseFonts(): void {
    if (this.stagedFonts.size === 0) return;
    const assets = [...this.stagedFonts.values()];
    this.stagedFonts.clear();
    this.insertFonts(assets);
  }

  /**
   * Forget every face this document was told about.
   *
   * A viewer can be handed one document after another, and a page of the old one
   * is never coming back, so the rules for it are not kept: a session that reads
   * a dozen papers would otherwise carry every face of all twelve in one
   * stylesheet, and the browser would keep laying them all out.
   */
  private clearFonts(): void {
    this.stagedFonts.clear();
    this.insertedFonts.clear();
    if (this.fontSheet) {
      try {
        this.fontSheet.replaceSync('');
      } catch {
        /* a sheet the host has taken away; nothing to clear */
      }
    }
    if (this.fontStyleEl) this.fontStyleEl.textContent = '';
  }

  /**
   * Write faces into this document, once each.
   *
   * Registering a face costs a layout of every text run in the document however
   * many rules arrive together, so they may as well arrive together - and a
   * planned document, which is what makes one document possible at all, arrives
   * as one write before the first page is laid out.
   */
  private insertFonts(assets: readonly FontAsset[]): number {
    let added = 0;
    for (const asset of assets) {
      if (this.insertedFonts.has(asset.family)) continue;
      this.insertedFonts.add(asset.family);
      added++;
      if (this.fontSheet) {
        try {
          this.fontSheet.insertRule(asset.css, this.fontSheet.cssRules.length);
          continue;
        } catch (error) {
          DEBUG('insertRule failed', asset.family, String(error));
        }
      }
      if (this.fontStyleEl) {
        this.fontStyleEl.appendChild(document.createTextNode('\n' + asset.css));
      }
    }
    return added;
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
    el.addEventListener('dragover', this.onDragOver);
    el.addEventListener('dragleave', this.onDragLeave);
    el.addEventListener('drop', this.onDrop);
  }

  private stopDrag(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
  }

  private onDragOver = (event: DragEvent): void => {
    this.stopDrag(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.opt.container.classList.add('wpdf-drop-active');
  };

  private onDragLeave = (event: DragEvent): void => {
    this.stopDrag(event);
    this.opt.container.classList.remove('wpdf-drop-active');
  };

  private onDrop = (event: DragEvent): void => {
    this.stopDrag(event);
    this.opt.container.classList.remove('wpdf-drop-active');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    this.emit({ type: 'drop-accepted', name: file.name });
    void this.load(file).catch((error) => this.emit({ type: 'error', error }));
  };

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
    this.unwatchPlan?.();
    this.unwatchPlan = null;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    if (this.zoomFrame) cancelAnimationFrame(this.zoomFrame);
    if (this.cropFrame) cancelAnimationFrame(this.cropFrame);
    if (this.flushFrame) cancelAnimationFrame(this.flushFrame);
    clearTimeout(this.settleTimer);
    this.frameRequest = 0;
    this.zoomFrame = 0;
    this.cropFrame = 0;
    this.flushFrame = 0;
    this.settleTimer = 0;
    this.results.clear();
    this.stagedFonts.clear();
    this.generations.clear();
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
/* A page is a document while the document's fonts are being planned; this is
   the window it is seen through. No border, no scrolling of its own: the box is
   the page, exactly. */
.wpdf-page-frame{display:block;width:100%;height:100%;border:0;background:transparent}
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

/**
 * The stylesheet of a page's own document. It has one job beyond the reset:
 * make the page fill the frame exactly, whatever zoom the layout is at.
 * Everything else is left to the browser - selection colours, find-in-page
 * highlights, the caret, the context menu are a document's own and are not
 * styled here.
 */
const FRAME_CSS = `
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}
.wpdf-page-svg{display:block;width:100%;height:100%}
.wpdf-page-svg a.wpdf-link{cursor:pointer}
.wpdf-page-svg a.wpdf-link:hover>rect{fill:rgba(37,99,235,.16)}
.wpdf-page-svg a.wpdf-link:focus-visible{outline:none}
.wpdf-page-svg a.wpdf-link:focus-visible>rect{fill:rgba(37,99,235,.22);stroke:#2563eb;stroke-width:1}
`;
