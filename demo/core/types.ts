/**
 * The shapes that cross between the viewer, the engine and the worker.
 *
 * These are the *host's* types, not the core's: they are what a page needs to
 * know about a document, and they are deliberately plain data - no MuPDF handle,
 * no wasm pointer, nothing that cannot be structured-cloned into a worker. The
 * core speaks the same vocabulary in JSON (`core/src/wasm.rs`); `bridge.ts` is
 * the one place that reads it.
 */

/** Everything a document can be handed to a viewer as. */
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
  /** 1-based, or -1 when the destination is not a page. */
  page: number;
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

/**
 * A crop rule as the viewer, the engine and the core see it: a regular
 * expression, matched anywhere in a text run. The names, the descriptions and
 * the reader's own rules are the host's (`demo/core/rules.ts`); what crosses the
 * worker boundary is the expression alone.
 */
export type CropPattern = string;

/** A rectangle in page units, with the page's own origin (points, y down). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in page coordinates: `[x0, y0, x1, y1]`. */
export type LinkRect = [number, number, number, number];

export type PageLink =
  | { kind: 'internal'; rect: LinkRect; page: number; x: number | null; y: number | null }
  | { kind: 'external'; rect: LinkRect; uri: string };

/** The target of a hit area, as read back out of the DOM. */
export type LinkTarget =
  | { kind: 'internal'; page: number; y: number | null }
  | { kind: 'external'; uri: string; openable: boolean };

export type TextMode = 'auto' | 'paths';

export interface RenderOptions {
  textMode?: TextMode;
  /** Unique per page; used to keep `url(#...)` references apart in one document. */
  idPrefix?: string;
  /** Rewrite the root `<svg>` to fill its container. Default false. */
  responsive?: boolean;
  className?: string;
  /** Embed the page's `@font-face` rules inside the SVG. */
  embedFonts?: boolean;
  /** Add a clickable hit area for every link annotation. */
  links?: boolean;
  /** Crop the page to its content, minus the runs these expressions match. */
  crop?: readonly CropPattern[] | null;
  /** Page units to grow the crop by, on every side. */
  cropPadding?: number;
  /** Bionic reading: fade every word's tail back. */
  bionic?: boolean;
  /** How much strength the faded part keeps, 0..1. */
  bionicDim?: number;
}

export interface RenderStats {
  glyphsDrawn: number;
  glyphsAsText: number;
  glyphsAsOutlines: number;
  textRuns: number;
  /** Space characters put back into the text: what makes words out of glyphs. */
  spaces: number;
  /** Glyphs written at bionic reading's reduced strength. */
  faded: number;
  /** Faces the page drew text with, whether it carried them or named them. */
  fontsBuilt: number;
  fontsReused: number;
  ms: number;
}

/** One `@font-face` rule, ready to be written into a document. */
export interface FontAsset {
  family: string;
  /** A complete `@font-face` rule, sans the surrounding `<style>` element. */
  css: string;
  /** Container the bytes are in: `woff`, or the raw OpenType/CFF font. */
  format: 'woff' | 'opentype';
  /** Size of the encoded font in bytes. */
  bytes: number;
  glyphCount: number;
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

/** How far the document's font plan has got. */
export interface FontPlanProgress {
  /** Pages walked. */
  done: number;
  /** Pages in all. */
  total: number;
  /** True once every page has been walked, so no font can appear later. */
  ready: boolean;
}

export interface EngineOptions {
  onWarn?: (message: string) => void;
  /**
   * Where the core's ESM glue is, as an absolute URL.
   *
   * Passed in rather than derived, because the three places that need it - the
   * page, a worker, and a worker's worker - do not share a base URL, and the
   * build is the only thing that knows where it put the file.
   */
  coreUrl?: URL | string;
  /** Forwarded from a host that wants the plan before the first page. */
  planFonts?: boolean;
  /**
   * Every slice of the walk, as it happens.
   *
   * `planProgress()` is a question, and only a host that keeps asking it sees
   * anything move; this is the same fact told rather than asked. A worker-backed
   * engine needs it more than an inline one: the walk happens on the other side
   * of a message port, so without it the only news a page gets is that the plan
   * is *ready*, and a progress bar would sit at zero for the whole walk.
   */
  onPlanProgress?: (progress: FontPlanProgress) => void;
}

/**
 * The surface the viewer needs from a rendering backend.
 *
 * `PdfEngine` implements it directly; `WorkerEngine` implements the same shape
 * over `postMessage`, which is what lets the viewer move off the main thread
 * without any change to its own code.
 *
 * There is one font plan and it is the document's: the core compiles a face per
 * *font* for the whole document, and a page either uses those faces or carries
 * its own (`embedFonts`). The per-page plan the TypeScript pipeline also had is
 * gone with it - see `planProgress`.
 */
export interface PdfEngineLike {
  open(source: PdfSource, password?: string): Promise<DocumentInfo>;
  renderPage(index: number, opts?: RenderOptions): Promise<RenderedPage>;
  /**
   * The box a page would be cropped to under these patterns, without rendering
   * it. A viewer needs this ahead of the render, because the cropped size of
   * every page is what its scroll layout is built from.
   */
  measureCrop?(index: number, patterns: readonly CropPattern[]): Promise<CropRect | null>;
  /**
   * Whether one regular expression compiles, as an error message or null.
   *
   * The host asks before it lets a reader keep a rule they typed: the core's
   * engine is the authority on what an expression means, so a pattern the core
   * refuses is refused here too, with the core's own reason.
   */
  checkCropPattern?(pattern: string): Promise<string | null>;
  /** Write the open document out again, as a fresh PDF. */
  save?(): Promise<Uint8Array>;
  drainNewFonts(): FontAsset[];
  /** How far the document's font plan has got, or null when it has not started. */
  planProgress?(): FontPlanProgress | null;
  /** Called when the plan is ready, and immediately when it already is. */
  onPlanReady?(cb: () => void): () => void;
  /**
   * Every face the plan built. A host that is about to draw the document as one
   * document wants them all at once: registering a face re-lays-out every text
   * run in the document however many rules arrive with it.
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

export class DocumentNotOpenError extends Error {
  constructor() {
    super('No document is open');
    this.name = 'DocumentNotOpenError';
  }
}
