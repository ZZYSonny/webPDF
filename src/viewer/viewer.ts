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
import { debug as DEBUG } from '../core/debug.ts';
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
  | { type: 'render'; page: number; ms: number; asText: number; asOutlines: number }
  | { type: 'error'; error: unknown; page?: number }
  | { type: 'drop-accepted'; name: string };

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
  /** Accept PDFs dropped onto the container. */
  acceptDrop?: boolean;
  className?: string;
  onEvent?: (event: ViewerEvent) => void;
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
  private readonly opt: Required<Omit<PdfViewerOptions, 'onEvent'>> & { onEvent?: (e: ViewerEvent) => void };
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
  private geometry: PageGeometry[] = [];
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
    this.geometry = info.pages.map((p) => ({ width: p.width, height: p.height }));
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
    const delta = this.scrollOffset() - before;

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

  /* ----------------------------------------------------------- navigation */

  goToPage(page: number): void {
    const index = Math.max(0, Math.min((this.info?.pageCount ?? 1) - 1, Math.round(page) - 1));
    this.scrollToOffset(this.layout.offsetOf(index));
    this.update();
  }

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
    });
    return rendered.svg;
  }

  /* ------------------------------------------------------- scroll mapping */

  /** Offset of the viewport's top edge within the laid-out pages. */
  private scrollOffset(): number {
    return -this.host.getBoundingClientRect().top;
  }

  private scrollToOffset(offset: number): void {
    const top = this.host.getBoundingClientRect().top + window.scrollY + offset;
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

  private emit(event: ViewerEvent): void {
    this.opt.onEvent?.(event);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    if (this.zoomFrame) cancelAnimationFrame(this.zoomFrame);
    this.frameRequest = 0;
    this.zoomFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onPageScale);
    window.visualViewport?.removeEventListener('scroll', this.onPageScale);
    document.removeEventListener('keydown', this.onKeyDown);
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
.wpdf-host.wpdf-drop-active::after{content:"";position:absolute;inset:6px;border:2px dashed #2563eb;border-radius:8px;pointer-events:none;z-index:5}
`;
