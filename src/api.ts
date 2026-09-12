/**
 * Public entry points.
 *
 * Three levels of integration, from "one line" to "I drive everything":
 *
 *   createViewer({ container, source })      - ready-made scrolling viewer
 *   new PdfEngine()                          - headless render, no DOM
 *   renderDocument(source, { onPage })       - batch export to SVG
 *
 * Nothing here touches globals, assumes a document structure, or requires a
 * particular bundler, which is what makes the library usable from a content
 * script, an extension page or an embedded widget.
 *
 * The engine module - and with it the 10 MB MuPDF wasm - is imported *inside*
 * the calls that need it rather than at the top of this file, for two reasons:
 * a page that only draws with a worker should not also build an engine on the
 * main thread, and whatever the host said about where the wasm comes from has to
 * be in place before the module that reads it is evaluated (see `engine-wasm.ts`).
 */

import type {
  DocumentInfo,
  PdfEngineLike,
  PdfSource,
  RenderedPage,
  EngineOptions,
} from './core/engine.ts';
import {
  DEFAULT_ZOOM_STEPS,
  PdfViewer,
  type PageMode,
  type PdfViewerOptions,
  type RenderMode,
  type ViewerEvent,
} from './viewer/viewer.ts';
import type { CropRuleId } from './core/crop.ts';
import { createWorkerEngine } from './worker/client.ts';
import { loadEngine } from './core/engine-wasm.ts';

export interface CreateViewerOptions extends Omit<PdfViewerOptions, 'container' | 'engine'> {
  /** A container element or a CSS selector to resolve against `document`. */
  container: HTMLElement | string;
  /** Open this document immediately. */
  source?: PdfSource;
  /** Share an engine between viewers, or supply your own (e.g. a worker proxy). */
  engine?: PdfEngineLike;
  /**
   * Render off the main thread. Defaults to true, and silently falls back to
   * inline rendering when workers are unavailable or fail to boot.
   */
  worker?: boolean;
  /** Override the worker module URL, for extensions that vendor their assets. */
  workerUrl?: string | URL;
  /** Forwarded to a freshly created engine. */
  disableCompression?: boolean;
  onWarn?: (message: string) => void;
  /**
   * Forwarded to a freshly created engine: whether the document's fonts are
   * planned as one face per *font*, in the background (see `EngineOptions`).
   * `false` gives every page its own faces, which is what a viewer that draws
   * each page in its own frame wants.
   */
  planFonts?: boolean;
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== 'string') return container;
  const el = document.querySelector(container);
  if (!(el instanceof HTMLElement)) throw new Error(`Container "${container}" not found`);
  return el;
}

/** Create a viewer, optionally opening a document straight away. */
export async function createViewer(opts: CreateViewerOptions): Promise<PdfViewer> {
  const { source, engine, worker, workerUrl, disableCompression, onWarn, planFonts, ...viewerOpts } = opts;

  const engineOpts = { disableCompression, onWarn, planFonts };
  let backend: PdfEngineLike | undefined = engine;
  if (!backend && (worker ?? true)) {
    backend = (await createWorkerEngine(workerUrl, engineOpts)) ?? undefined;
  }
  if (!backend) {
    // Only now, and only when there is no worker to draw in: the engine brings
    // the wasm with it.
    const { PdfEngine } = await loadEngine();
    backend = new PdfEngine(engineOpts);
  }

  const viewer = PdfViewer.create({ ...viewerOpts, container: resolveContainer(opts.container), engine: backend });
  if (source !== undefined) await viewer.load(source);
  return viewer;
}

export interface RenderDocumentOptions extends EngineOptions {
  /** Restrict to a page range (0-based, inclusive). */
  from?: number;
  to?: number;
  /** Add the page's `@font-face` rules to each SVG so it stands alone. */
  embedFonts?: boolean;
  /** Add a clickable hit area for every link annotation. Default true. */
  links?: boolean;
  /**
   * Crop each page to its content, minus the marks these rules name - the
   * batch-export half of `PdfViewer.setCrop`, for building a trimmed set of
   * SVGs without a viewer.
   */
  crop?: readonly CropRuleId[] | null;
  /** Bold the first letters of every word, the way bionic reading does. */
  bionic?: boolean;
  /**
   * How much strength the faded part of each word keeps, 0..1. Defaults to
   * `BIONIC_DIM` (a half).
   */
  bionicDim?: number;
  onPage?: (page: RenderedPage, index: number) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Render a whole document to standalone SVG strings.
 *
 * Useful for build steps, server-side conversion and tests - the same code path
 * the viewer uses, minus the DOM.
 */
export async function* renderDocument(
  source: PdfSource,
  opts: RenderDocumentOptions = {},
): AsyncGenerator<RenderedPage, void, void> {
  const { PdfEngine } = await loadEngine();
  // Standalone SVGs, so the page's own glyph set is the right one to embed: a
  // document-wide face would put every glyph the document drew into every page
  // that uses the font. The plan exists for a viewer, where a face is registered
  // once and shared; here it is a bigger file for no one's benefit.
  const engine = new PdfEngine({ ...opts, planFonts: false });
  try {
    await engine.open(source);
    const count = engine.documentInfo.pageCount;
    const from = Math.max(0, opts.from ?? 0);
    const to = Math.min(count - 1, opts.to ?? count - 1);
    for (let i = from; i <= to; i++) {
      if (opts.signal?.aborted) return;
      const page = await engine.renderPage(i, {
        textMode: 'auto',
        embedFonts: opts.embedFonts ?? true,
        links: opts.links ?? true,
        responsive: false,
        idPrefix: `p${i}-`,
        crop: opts.crop,
        bionic: opts.bionic,
        bionicDim: opts.bionicDim,
      });
      await opts.onPage?.(page, i);
      yield page;
    }
  } finally {
    engine.close();
  }
}

export type { DocumentInfo, PdfSource, RenderedPage, ViewerEvent, RenderMode, PageMode };
export { PdfViewer, DEFAULT_ZOOM_STEPS };
export { WorkerEngine, createWorkerEngine } from './worker/client.ts';
export type { PdfEngineLike, RenderOptions, RenderStats, OutlineNode, PageGeometry, TextMode } from './core/engine.ts';
export { CROP_RULES, MIN_DRAWING_HEIGHT, contentBox, cropRule, cropViewBox, normaliseRules } from './core/crop.ts';
export type { CropRect, CropRule, CropRuleId, CropSpan } from './core/crop.ts';
export { isOpenableUri } from './core/links.ts';
export type { PageLink, InternalLink, ExternalLink, LinkRect, LinkTarget } from './core/links.ts';
export type { PdfViewerOptions };
export type { FontAsset } from './core/font/registry.ts';
export { FontRegistry } from './core/font/registry.ts';
export { buildFontFromOutlines } from './core/font/build.ts';
export { upgradeGlyphsToText } from './core/svg/text-upgrade.ts';
export { BIONIC_DIM } from './core/svg/bionic.ts';
export { scanGlyphOutlines, scanGlyphPlacements } from './core/svg/glyphs.ts';
export { PageLayout, computeFitScale } from './viewer/layout.ts';
export type { ZoomMode } from './viewer/layout.ts';
