/**
 * The document engine: the Rust core, as `PdfEngineLike`.
 *
 * There is no MuPDF here and no SVG rewriting - the core interprets the page and
 * writes the final SVG itself. What is left is the part that is genuinely the
 * host's: turning a `PdfSource` into bytes, keeping the crop boxes a viewer asks
 * for twice, and walking the document's font plan in slices so a browser is not
 * blocked while it runs.
 *
 * # The font plan
 *
 * The core compiles one face per *font* for the whole document - the global
 * path - and the plan is a walk of every page, so it is started when the
 * document opens and advanced a slice at a time. `planProgress`, `onPlanReady`
 * and `plannedFonts` are how a viewer watches it; a page drawn before it is
 * ready carries its own faces (`embedFonts`), which is correct and briefly
 * larger, and from then on every page names the document's.
 *
 * The per-page font plan the TypeScript pipeline also had is deliberately gone:
 * it existed to make a long plan bearable, and this one walks a 756-page
 * specification in about a second.
 *
 * The faces themselves come back as bytes with a URI each, and this is where
 * they become URLs: `serveFonts` mints one `blob:` per face and puts it in the
 * rule, so what the viewer writes into the document is a rule about a URL rather
 * than a font spelled out in base64.
 */

import { Core, loadCore, type CoreFace } from './bridge.ts';
import { cropBox, padBox } from './crop.ts';
import {
  DocumentNotOpenError,
  PasswordRequiredError,
  type CropPattern,
  type CropRect,
  type DocumentInfo,
  type EngineOptions,
  type FontAsset,
  type FontPlanProgress,
  type OutlineNode,
  type PdfEngineLike,
  type PdfSource,
  type RenderOptions,
  type RenderedPage,
  type RenderStats,
} from './types.ts';

/**
 * How many pages of the font walk to do per turn.
 *
 * The walk is a page load and a display-list run each, a millisecond or two,
 * and a slice has to be short enough that the browser gets a turn between them -
 * the page asking for a progress bar, and the render the reader is waiting for,
 * both live in those turns.
 */
const PLAN_SLICE = 8;

/**
 * One turn of the event loop, as a *macrotask*.
 *
 * The walk's slices are continuations of one another in the microtask queue, so
 * a boundary that awaited an already-resolved promise would go straight on to
 * the next page and nothing else would run until the walk was over. A message
 * channel rather than `setTimeout(0)`: the same turn of the event loop, without
 * the clamp a nested timer picks up.
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

/** Read whatever a host handed over into bytes. */
export async function readSource(source: PdfSource): Promise<Uint8Array> {
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

/** What the core's `info` looks like on the wire. */
interface RawInfo {
  pageCount: number;
  title: string;
  author: string;
  subject: string;
  producer: string;
  encrypted: boolean;
  pages: { width: number; height: number }[];
  labels: string[];
  outline: RawOutline[];
}

interface RawOutline {
  title: string;
  page: number;
  uri: string | null;
  children: RawOutline[];
}

function toOutline(items: RawOutline[]): OutlineNode[] {
  return items.map((it) => ({
    title: it.title,
    page: it.page,
    ...(it.uri ? { uri: it.uri } : {}),
    // The core does not report whether a bookmark was open in the document; a
    // viewer that shows an outline closed is the one a reader expects.
    open: false,
    children: toOutline(it.children),
  }));
}

function toInfo(raw: RawInfo): DocumentInfo {
  return {
    pageCount: raw.pageCount,
    title: raw.title,
    author: raw.author,
    subject: raw.subject,
    producer: raw.producer,
    outline: toOutline(raw.outline),
    pages: raw.pages,
    labels: raw.labels,
    encrypted: raw.encrypted,
  };
}

/** One `@font-face` rule's family, as the core spells it in the rule itself. */
function familyOf(css: string): string {
  return /font-family:\s*'([^']+)'/.exec(css)?.[1] ?? css;
}

/**
 * Split a document stylesheet into one asset per rule.
 *
 * The core joins its rules with a newline and a rule never contains one, so the
 * split is exact. One asset per rule rather than one blob matters: a viewer
 * writes each into a stylesheet with `insertRule`, which takes a rule and not a
 * document.
 *
 * A rule comes out naming its face by URI, which is not yet something a browser
 * can fetch - `PdfEngine.serveFonts` is what puts a URL this host owns in its
 * place.
 */
export function stylesheetAssets(css: string): FontAsset[] {
  return css
    .split('\n')
    .filter((rule) => rule.trim() !== '')
    .map((rule) => ({
      family: familyOf(rule),
      css: rule,
      format: 'woff' as const,
      bytes: 0,
      glyphCount: 0,
    }));
}

export class PdfEngine implements PdfEngineLike {
  private core: Core;
  private id: number | null = null;
  private info: DocumentInfo | null = null;
  private readonly opts: EngineOptions;

  /** Measured crop boxes, keyed by rule set and page. Small: four numbers each. */
  private boxCache = new Map<string, CropRect | null>();
  /** The document's faces, once the plan has built them. */
  private faces: FontAsset[] | null = null;
  /** The `blob:` URLs those faces are served from, to revoke with the document. */
  private objectUrls: string[] = [];
  /** The walk itself, so a caller can wait for the planned document. */
  private planning: Promise<void> | null = null;
  private progress: FontPlanProgress | null = null;
  private readonly planListeners = new Set<() => void>();
  /** Bumped by `close`, so a walk belonging to a document that is gone stops. */
  private generation = 0;

  private constructor(core: Core, opts: EngineOptions) {
    this.core = core;
    this.opts = opts;
  }

  /**
   * Load the core's wasm and build an engine over it.
   *
   * Asynchronous because the module is fetched and instantiated; everything
   * after it is synchronous, which is what lets one `Core` be shared by every
   * document an engine opens and by a worker that owns it.
   */
  static async create(opts: EngineOptions = {}): Promise<PdfEngine> {
    const coreUrl = opts.coreUrl;
    if (!coreUrl) throw new Error('PdfEngine.create needs a coreUrl: where the core was built to');
    const core = new Core(await loadCore(coreUrl, opts.wasmUrl));
    return new PdfEngine(core, opts);
  }

  /** The faces the document's plan has built, for a host that wants them all. */
  plannedFonts(): FontAsset[] {
    return this.faces ?? [];
  }

  planProgress(): FontPlanProgress | null {
    return this.progress;
  }

  onPlanReady(cb: () => void): () => void {
    this.planListeners.add(cb);
    // A plan that is already ready is not going to say so again, and a host that
    // registers late still has to hear it.
    if (this.progress?.ready) setTimeout(cb, 0);
    return () => this.planListeners.delete(cb);
  }

  planDone(): Promise<void> {
    return this.planning ?? Promise.resolve();
  }

  /** No per-page faces exist to drain: every page uses the document's. */
  drainNewFonts(): FontAsset[] {
    return [];
  }

  get documentInfo(): DocumentInfo {
    if (!this.info) throw new DocumentNotOpenError();
    return this.info;
  }

  async open(source: PdfSource, password?: string): Promise<DocumentInfo> {
    this.close();
    const bytes = await readSource(source);
    const { id, info } = this.core.open(bytes);
    this.id = id;
    let raw = info as RawInfo;

    if (raw.encrypted) {
      if (!password) {
        this.core.close(id);
        this.id = null;
        throw new PasswordRequiredError();
      }
      const unlocked = this.core.password(id, password);
      if (!unlocked.ok) {
        this.core.close(id);
        this.id = null;
        throw new PasswordRequiredError();
      }
      raw = unlocked.info as RawInfo;
    }

    this.info = toInfo(raw);
    this.progress = { done: 0, total: raw.pageCount, ready: false };
    // The document's fonts are planned from here, in the background: a page is
    // drawn with its own faces until the plan is ready, and `planProgress` /
    // `onPlanReady` say when the pages can become one document. Nothing below
    // waits for it - which is the whole point.
    if (this.opts.planFonts !== false) this.planning = this.walk();
    return this.info;
  }

  /** Walk the whole document, a slice per turn, and publish the faces at the end. */
  private async walk(): Promise<void> {
    const id = this.id;
    if (id === null) return;
    const generation = this.generation;
    try {
      for (;;) {
        const step = this.core.plan(id, PLAN_SLICE);
        if (generation !== this.generation) return;
        this.progress = { done: step.walked, total: step.total, ready: step.done };
        this.opts.onPlanProgress?.(this.progress);
        if (step.done) break;
        await turn();
      }
      this.faces = this.serveFonts(id, this.core.stylesheet(id));
    } catch (error) {
      this.opts.onWarn?.(`the document's fonts could not be planned: ${String(error)}`);
      this.progress = this.progress ? { ...this.progress, ready: true } : null;
    }
    if (generation !== this.generation) return;
    for (const cb of [...this.planListeners]) {
      try {
        cb();
      } catch (error) {
        this.opts.onWarn?.(`a plan-ready listener failed: ${String(error)}`);
      }
    }
  }

  /**
   * The document's faces, each served from a URL of this host's own.
   *
   * The core wrote a rule per face that *names* it by URI and handed the bytes
   * behind every one of those URIs over separately; this is the other half of
   * that exchange - one `blob:` per face, put in the rule where the URI was. So
   * a font crosses the core-to-host boundary as bytes rather than as base64, and
   * the rule the browser parses is a filename rather than the font written out
   * again, 4/3 of it, as text.
   *
   * The URLs are the engine's to revoke and [`close`](PdfEngine.close) does,
   * since the bytes they point at belong to a document that is gone.
   */
  private serveFonts(id: number, css: string): FontAsset[] {
    const { faces, bytes } = this.core.fonts(id);
    const byFamily = new Map<string, CoreFace>(faces.map((face) => [face.family, face]));
    return stylesheetAssets(css).map((asset) => {
      const face = byFamily.get(asset.family);
      // A rule the core did not list bytes for is left as it is: it names a URI
      // nothing serves, which costs a page its font and not its layout.
      if (!face) return asset;
      const url = URL.createObjectURL(
        new Blob([bytes.subarray(face.offset, face.offset + face.bytes)], { type: face.mime }),
      );
      this.objectUrls.push(url);
      return {
        family: asset.family,
        css: asset.css.replace(`"${face.uri}"`, `"${url}"`),
        format: face.format,
        bytes: face.bytes,
        glyphCount: face.glyphs,
      };
    });
  }

  /** Let go of the served faces: nothing draws them once their document is gone. */
  private unserveFonts(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  /**
   * The box this page's content occupies under `patterns` - before any padding,
   * which is a render-time matter and costs nothing to change.
   *
   * The core keeps its own answer per page and pattern set; this layer keeps the
   * promise in the cache so two callers in the same turn do not cross the
   * boundary twice.
   */
  async measureCrop(index: number, patterns: readonly CropPattern[]): Promise<CropRect | null> {
    if (this.id === null) throw new DocumentNotOpenError();
    const wanted = [...patterns].sort();
    if (wanted.length === 0) return null;
    const key = `${wanted.join('\n')}|${index}`;
    const cached = this.boxCache.get(key);
    if (cached !== undefined) return cached;
    const box = cropBox(this.core.measureCrop(this.id, index, wanted));
    this.boxCache.set(key, box);
    return box;
  }

  /** Whether one expression compiles, as an error message or null. */
  async checkCropPattern(pattern: string): Promise<string | null> {
    return this.core.checkCropPattern(pattern);
  }

  /** The page's box, for a host that wants to crop it itself. */
  pageGeometry(index: number): { width: number; height: number } | null {
    return this.info?.pages[index] ?? null;
  }

  async renderPage(index: number, opts: RenderOptions = {}): Promise<RenderedPage> {
    if (this.id === null) throw new DocumentNotOpenError();
    const started = Date.now();

    // The crop is the rules' box, grown by the padding, stopped by the page -
    // and it is a `viewBox`, so the page keeps every element it had and the
    // reader sees a window onto it.
    const content = await this.measureCrop(index, opts.crop ?? []);
    const page = this.pageGeometry(index);
    const crop =
      content && page
        ? padBox(content, opts.cropPadding ?? 0, { x: 0, y: 0, width: page.width, height: page.height })
        : null;

    const ready = this.faces !== null;
    const rendered = this.core.render(this.id, index, {
      idPrefix: opts.idPrefix,
      className: opts.className,
      responsive: opts.responsive ?? false,
      // Before the plan is ready a page carries its own faces, which is correct
      // and briefly larger; afterwards every page names the document's, which is
      // what makes the pages one document.
      embedFonts: opts.embedFonts ?? !ready,
      bionic: opts.bionic,
      bionicDim: opts.bionicDim ?? null,
      links: opts.links ?? true,
      crop,
    });

    const stats = rendered.stats as Partial<Record<string, number>> | undefined;
    return {
      index,
      svg: rendered.svg,
      width: rendered.width,
      height: rendered.height,
      crop,
      // The page's faces are the document's: a page drawn before the plan is
      // ready embeds them, and one drawn after names them, so there is nothing
      // per-page to register.
      fonts: [],
      links: rendered.links as RenderedPage['links'],
      stats: {
        glyphsDrawn: stats?.glyphs ?? 0,
        glyphsAsText: stats?.asText ?? 0,
        glyphsAsOutlines: stats?.asOutlines ?? 0,
        textRuns: stats?.runs ?? 0,
        spaces: stats?.spaces ?? 0,
        faded: stats?.faded ?? 0,
        fontsBuilt: stats?.fonts ?? 0,
        fontsReused: 0,
        ms: Date.now() - started,
      } as RenderStats,
    };
  }

  /** Write the open document out again: MuPDF's own copy, with no encryption. */
  async save(): Promise<Uint8Array> {
    if (this.id === null) throw new DocumentNotOpenError();
    return this.core.save(this.id);
  }

  /**
   * Drop the crop answers for pages outside `keep`.
   *
   * The core holds its own cache and has no way to be told; this is the half a
   * long scroll can actually free, and it is four numbers a page either way.
   */
  trimCaches(keep: readonly number[]): void {
    if (this.boxCache.size === 0) return;
    const wanted = new Set(keep);
    for (const key of [...this.boxCache.keys()]) {
      const page = Number(key.slice(key.lastIndexOf('|') + 1));
      if (!wanted.has(page)) this.boxCache.delete(key);
    }
  }

  close(): void {
    this.generation++;
    if (this.id !== null) {
      try {
        this.core.close(this.id);
      } catch {
        /* a document the core has already let go of */
      }
      this.id = null;
    }
    this.info = null;
    this.faces = null;
    this.unserveFonts();
    this.progress = null;
    this.planning = null;
    this.boxCache.clear();
    this.planListeners.clear();
  }
}
