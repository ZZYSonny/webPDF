/**
 * A `PdfEngineLike` that proxies to the rendering worker.
 *
 * `PdfViewer` cannot tell the difference between this and an inline
 * `PdfEngine`, which is the whole point: moving rendering off the main thread is
 * a one-line change at the call site.
 */

import type { DocumentInfo, EngineOptions, PdfEngineLike, PdfSource, RenderOptions, RenderedPage } from '../core/engine.ts';
import type { CropRect, CropRuleId } from '../core/crop.ts';
import type { FontAsset } from '../core/font/registry.ts';
import { engineWasmSources } from '../core/engine-wasm.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function reviveError(raw: { name?: string; message?: string } | undefined): Error {
  const error = new Error(raw?.message ?? 'Worker request failed');
  if (raw?.name) error.name = raw.name;
  return error;
}

export class WorkerEngine implements PdfEngineLike {
  readonly isWorkerBacked = true;
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Faces built but not yet handed out. */
  private fonts: FontAsset[] = [];
  private readonly staged = new Set<string>();
  /** Faces the host has already been given, so it never registers one twice. */
  private readonly delivered = new Set<string>();

  constructor(worker: Worker, options?: EngineOptions) {
    this.worker = worker;
    // Where the engine may come from is a decision made in *this* realm, and the
    // worker cannot see it: tell it before anything is asked of it, so that the
    // request which starts the engine - the probe `createWorkerEngine` sends, or
    // the first `open` - finds the sources already there. Sent only when there is
    // something to say, so a worker whose host configured nothing keeps MuPDF's
    // own resolution.
    const sources = engineWasmSources();
    // The same message carries how the engine is to be built: a worker cannot see
    // the host's options any more than it can see its modules, and the options are
    // read once, when the engine is. Only the ones that survive a structured
    // clone go: `onWarn` is a function, and a function cannot be posted - posting
    // one throws, and a viewer that quietly fell back to the main thread because
    // a host passed a warning sink would be a trap.
    const sent = options
      ? { disableCompression: options.disableCompression, preplanPages: options.preplanPages }
      : undefined;
    if (sources.length || sent) this.worker.postMessage({ wpdf: 'engine', sources, options: sent });
    this.worker.addEventListener('message', (event: MessageEvent) => {
      const { id, ok, result, error } = event.data as {
        id: number;
        ok: boolean;
        result?: unknown;
        error?: { name?: string; message?: string };
      };
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(reviveError(error));
    });
    this.worker.addEventListener('error', (event) => {
      const error = new Error(`Rendering worker failed: ${event.message}`);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  private call<T>(method: string, args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  async open(source: PdfSource, password?: string): Promise<DocumentInfo> {
    this.fonts = [];
    this.staged.clear();
    this.delivered.clear();
    const info = await this.call<DocumentInfo>('open', [source, password]);
    // A planned document built every face it will ever need while it was being
    // opened, and they are part of opening it: handing them over here is what
    // lets the viewer write them all in before the first page is laid out, and
    // never touch the document's fonts again.
    for (const asset of await this.call<FontAsset[]>('drainNewFonts', [])) {
      this.staged.add(asset.family);
      this.fonts.push(asset);
    }
    return info;
  }

  async renderPage(index: number, opts?: RenderOptions): Promise<RenderedPage> {
    const page = await this.call<RenderedPage>('renderPage', [index, opts]);
    // A page carries every face it needs, reused or new. Only the new ones are
    // worth handing on: registering a face the document already has costs the
    // same as registering a brand new one - the browser throws away the layout
    // of every text run in the document - and buys nothing at all.
    for (const asset of page.fonts) {
      if (this.delivered.has(asset.family) || this.staged.has(asset.family)) continue;
      this.staged.add(asset.family);
      this.fonts.push(asset);
    }
    return page;
  }

  async measureCrop(index: number, rules: readonly CropRuleId[]): Promise<CropRect | null> {
    return this.call<CropRect | null>('measureCrop', [index, rules]);
  }

  /** The open document, written out again by the engine that is holding it. */
  async save(): Promise<Uint8Array> {
    return this.call<Uint8Array>('save', []);
  }

  /**
   * Fonts built since the last call, and never seen before that: the contract
   * `FontRegistry` keeps on the main thread too. A host that inserts these into
   * a stylesheet is adding each face once and only once.
   */
  drainNewFonts(): FontAsset[] {
    const out = this.fonts;
    this.fonts = [];
    this.staged.clear();
    for (const asset of out) this.delivered.add(asset.family);
    return out;
  }

  /**
   * Round-trip a trivial call to prove the worker booted *and* that its module
   * graph (which pulls in the MuPDF wasm) evaluated. Without a deadline a
   * worker that dies during startup leaves the caller waiting forever.
   */
  async probe(timeoutMs = 15000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.call('probe', []),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`rendering worker did not respond within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  trimCaches(keep: readonly number[]): void {
    void this.call('trimCaches', [keep]).catch(() => undefined);
  }

  close(): void {
    void this.call('close', []).catch(() => undefined);
    this.worker.terminate();
    this.pending.clear();
  }
}

/**
 * Create a worker-backed engine.
 *
 * `url` defaults to the worker built next to this module, which is what both
 * Vite and the standard bundlers emit for `new URL(..., import.meta.url)`.
 * Resolves to `null` when workers are unavailable, so callers can fall back to
 * rendering inline instead of failing.
 */
export async function createWorkerEngine(url?: string | URL, options?: EngineOptions): Promise<WorkerEngine | null> {
  if (typeof Worker === 'undefined') return null;
  try {
    // The `new Worker(new URL(...))` form must stay syntactically literal:
    // bundlers detect the worker by that pattern and will otherwise copy the
    // TypeScript source verbatim, which the browser cannot execute.
    const worker = url
      ? new Worker(url, { type: 'module', name: 'webpdf' })
      : new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module', name: 'webpdf' });
    // A worker that fails to load only reports it asynchronously; probe it so
    // the caller gets a definite answer instead of a viewer that never renders.
    const engine = new WorkerEngine(worker, options);
    await engine.probe();
    return engine;
  } catch (error) {
    // Not fatal: the caller falls back to rendering on the main thread.
    if (typeof console !== 'undefined') {
      console.warn(`[webpdf] worker rendering unavailable, using the main thread: ${String(error)}`);
    }
    return null;
  }
}
