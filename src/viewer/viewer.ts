/**
 * A virtualised, continuously scrolling PDF viewer.
 *
 * Only the pages touching the viewport plus a small neighbourhood are ever in
 * the DOM; everything else is represented by an absolutely positioned box whose
 * geometry was computed up front. Because the renderer emits resolution
 * independent SVG, zooming never re-renders a page - it only restyles boxes.
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
  | { type: 'zoom-change'; scale: number; mode: ZoomMode }
  | { type: 'render'; page: number; ms: number; asText: number; asOutlines: number }
  | { type: 'error'; error: unknown; page?: number }
  | { type: 'drop-accepted'; name: string };

export interface PdfViewerOptions {
  container: HTMLElement;
  engine: PdfEngineLike;
  zoom?: number | 'fit-width' | 'fit-page';
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

export class PdfViewer {
  private readonly opt: Required<Omit<PdfViewerOptions, 'onEvent'>> & { onEvent?: (e: ViewerEvent) => void };
  private readonly engine: PdfEngineLike;
  private readonly root: HTMLElement;
  private readonly scroller: HTMLDivElement;
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
  private zoomMode: ZoomMode = 'custom';
  private scale = 1;
  private seq = 0;
  private frame = 0;
  private destroyed = false;
  private currentPage = 1;
  private resizeObserver: ResizeObserver | null = null;

  private constructor(opts: PdfViewerOptions) {
    this.engine = opts.engine;
    this.opt = {
      container: opts.container,
      engine: opts.engine,
      zoom: opts.zoom ?? 'fit-width',
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
    host.classList.add('wpdf-host');
    if (this.opt.className) host.classList.add(this.opt.className);

    const doc = host.ownerDocument;
    let mount: HTMLElement = host;
    if (this.opt.shadowDom && typeof host.attachShadow === 'function') {
      const existing = host.shadowRoot;
      const shadow = existing ?? host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '';
      const style = document.createElement('style');
      style.textContent = VIEWER_CSS;
      shadow.appendChild(style);
      const surface = document.createElement('div');
      surface.className = 'wpdf-surface';
      shadow.appendChild(surface);
      mount = surface;
    } else {
      const style = document.createElement('style');
      style.textContent = VIEWER_CSS;
      host.appendChild(style);
    }

    // Prefer a constructed stylesheet: it is not affected by a host page's
    // `style-src` policy, which matters inside browser extensions.
    const constructed =
      typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in doc && 'replaceSync' in CSSStyleSheet.prototype
        ? new CSSStyleSheet()
        : null;
    if (constructed) {
      this.fontSheet = constructed;
      this.fontStyleEl = null;
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, constructed];
    } else {
      this.fontSheet = null;
      const el = doc.createElement('style');
      el.dataset.wpdf = 'fonts';
      doc.head?.appendChild(el);
      this.fontStyleEl = el;
    }

    this.root = mount;
    this.scroller = document.createElement('div');
    this.scroller.className = 'wpdf-scroller';
    this.scroller.tabIndex = 0;
    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'wpdf-pages';
    this.scroller.appendChild(this.pagesEl);
    this.root.appendChild(this.scroller);

    this.layout = new PageLayout([], {});
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.scroller.addEventListener('keydown', this.onKeyDown);
    this.scroller.addEventListener('wheel', this.onWheel, { passive: false });
    if (this.opt.acceptDrop) this.installDropTarget();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.scroller);
    }
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
    this.scale = this.resolveScale();
    this.rebuildLayout();
    this.scroller.scrollTop = 0;
    this.currentPage = 1;
    this.emit({ type: 'document-loaded', info });
    this.emit({ type: 'zoom-change', scale: this.scale, mode: this.zoomMode });
    this.update();
  }

  get document(): DocumentInfo | null {
    return this.info;
  }

  get pageCount(): number {
    return this.info?.pageCount ?? 0;
  }

  get zoom(): number {
    return this.scale;
  }

  /** Whether rendering happens off the main thread. */
  get rendersInWorker(): boolean {
    return this.engine.isWorkerBacked === true;
  }

  /* ---------------------------------------------------------------- zoom */

  setZoom(value: number | 'fit-width' | 'fit-page'): void {
    const anchorPage = Math.max(0, this.currentPage - 1);
    const before = this.layout.offsetOf(anchorPage);
    const delta = this.scroller.scrollTop - before;

    if (typeof value === 'number') {
      this.zoomMode = 'custom';
      this.scale = Math.min(12, Math.max(0.05, value));
    } else {
      this.zoomMode = value;
      this.scale = this.resolveScale();
    }
    this.rebuildLayout();
    this.scroller.scrollTop = this.layout.offsetOf(anchorPage) + delta;
    this.emit({ type: 'zoom-change', scale: this.scale, mode: this.zoomMode });
    this.update();
  }

  zoomIn(step = 1.2): void {
    this.setZoom(this.scale * step);
  }

  zoomOut(step = 1.2): void {
    this.setZoom(this.scale / step);
  }

  private resolveScale(): number {
    if (!this.info || this.geometry.length === 0) return 1;
    if (this.zoomMode === 'custom' && typeof this.opt.zoom === 'number') return this.opt.zoom;
    const mode = this.zoomMode === 'custom' && typeof this.opt.zoom === 'string' ? this.opt.zoom : this.zoomMode;
    if (mode === 'custom' || mode === undefined) {
      return typeof this.opt.zoom === 'number' ? this.opt.zoom : 1;
    }
    return computeFitScale(this.geometry, this.scroller.clientWidth, this.scroller.clientHeight, this.layoutOptions(), mode);
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
    this.pagesEl.style.height = `${this.layout.height}px`;
    this.pagesEl.style.width = `${this.layout.width}px`;
  }

  /* ----------------------------------------------------------- navigation */

  goToPage(page: number): void {
    const index = Math.max(0, Math.min((this.info?.pageCount ?? 1) - 1, Math.round(page) - 1));
    this.scroller.scrollTop = this.layout.offsetOf(index);
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
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.tick();
    });
  };

  private onResize(): void {
    if (this.zoomMode === 'fit-width' || this.zoomMode === 'fit-page') {
      const next = this.resolveScale();
      if (Math.abs(next - this.scale) > 1e-4) {
        this.scale = next;
        this.rebuildLayout();
        this.emit({ type: 'zoom-change', scale: this.scale, mode: this.zoomMode });
      }
    }
    this.tick();
  }

  /** Synchronous entry point: recompute the window and refresh the DOM. */
  update(): void {
    this.tick();
  }

  private tick(): void {
    if (this.destroyed || !this.info) return;
    const scrollTop = this.scroller.scrollTop;
    const viewportHeight = this.scroller.clientHeight || 1;
    const visible = this.layout.visibleRange(scrollTop, viewportHeight, 0);
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

    const page = this.layout.currentPage(scrollTop, viewportHeight) + 1;
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

  private onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY / 320);
    this.setZoom(this.scale * factor);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const height = this.scroller.clientHeight;
    switch (event.key) {
      case 'PageDown':
        this.scroller.scrollTop += height * 0.9;
        break;
      case 'PageUp':
        this.scroller.scrollTop -= height * 0.9;
        break;
      case 'ArrowDown':
        this.scroller.scrollTop += 60;
        break;
      case 'ArrowUp':
        this.scroller.scrollTop -= 60;
        break;
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

  private emit(event: ViewerEvent): void {
    this.opt.onEvent?.(event);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.clearSlots();
    this.scroller.remove();
    this.fontStyleEl?.remove();
    if (this.fontSheet) {
      const doc = this.opt.container.ownerDocument;
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== this.fontSheet);
    }
    this.engine.close();
  }
}

const VIEWER_CSS = `
.wpdf-surface,.wpdf-scroller{width:100%;height:100%}
.wpdf-scroller{overflow:auto;position:relative;outline:none;background:var(--wpdf-bg,#f3f4f6)}
.wpdf-pages{position:relative;margin:0 auto}
.wpdf-page{position:absolute;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);overflow:hidden;contain:strict}
.wpdf-page-svg{display:block;width:100%;height:100%}
.wpdf-host.wpdf-drop-active::after{content:"";position:absolute;inset:6px;border:2px dashed #2563eb;border-radius:8px;pointer-events:none;z-index:5}
`;
