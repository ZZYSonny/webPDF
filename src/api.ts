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
 */

import {
  PdfEngine,
  type DocumentInfo,
  type PdfEngineLike,
  type PdfSource,
  type RenderedPage,
  type EngineOptions,
} from './core/engine.ts';
import { DEFAULT_ZOOM_STEPS, PdfViewer, type PdfViewerOptions, type ViewerEvent } from './viewer/viewer.ts';
import type { CropRuleId } from './core/crop.ts';
import { createWorkerEngine } from './worker/client.ts';

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
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== 'string') return container;
  const el = document.querySelector(container);
  if (!(el instanceof HTMLElement)) throw new Error(`Container "${container}" not found`);
  return el;
}

/** Create a viewer, optionally opening a document straight away. */
export async function createViewer(opts: CreateViewerOptions): Promise<PdfViewer> {
  const { source, engine, worker, workerUrl, disableCompression, onWarn, ...viewerOpts } = opts;

  let backend: PdfEngineLike | undefined = engine;
  if (!backend && (worker ?? true)) {
    backend = (await createWorkerEngine(workerUrl)) ?? undefined;
  }
  backend ??= new PdfEngine({ disableCompression, onWarn });

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
  const engine = new PdfEngine(opts);
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
      });
      await opts.onPage?.(page, i);
      yield page;
    }
  } finally {
    engine.close();
  }
}

export type { DocumentInfo, PdfSource, RenderedPage, ViewerEvent };
export { PdfEngine, PdfViewer, DEFAULT_ZOOM_STEPS };
export { WorkerEngine, createWorkerEngine } from './worker/client.ts';
export { DocumentNotOpenError, PasswordRequiredError } from './core/engine.ts';
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
export { scanGlyphOutlines, scanGlyphPlacements } from './core/svg/glyphs.ts';
export { PageLayout, computeFitScale } from './viewer/layout.ts';
export type { ZoomMode } from './viewer/layout.ts';
