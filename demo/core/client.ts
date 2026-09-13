/**
 * A `PdfEngineLike` that proxies to the rendering worker.
 *
 * `PdfViewer` cannot tell the difference between this and an inline `PdfEngine`,
 * which is the whole point: moving rendering off the main thread is a one-line
 * change at the call site.
 *
 * Two things are answered here rather than asked for - the plan's progress and
 * the faces it built - because a viewer asks for them the moment a document is
 * loaded and cannot wait a round trip to be told.
 */

import type {
  CropPattern,
  CropRect,
  DocumentInfo,
  EngineOptions,
  FontAsset,
  FontPlanProgress,
  PdfEngineLike,
  PdfSource,
  RenderOptions,
  RenderedPage,
} from './types.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** An unsolicited message from the worker, as opposed to a reply to a call. */
interface PlanMessage {
  wpdf: 'plan';
  progress: FontPlanProgress | null;
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
  /**
   * The plan's state, as last reported.
   *
   * Kept here rather than asked for, so that `planProgress` - the question a
   * viewer asks the moment a document is loaded - is answered without a round
   * trip, and answered about the *same* moment as the page it is about to draw.
   */
  private planState: FontPlanProgress | null = null;
  private readonly planReady = new Set<() => void>();

  constructor(worker: Worker, options?: EngineOptions) {
    this.worker = worker;
    // Where the core was built to, and how the engine is to be built, are
    // decisions made in *this* realm: a worker cannot see the host's modules or
    // its options. `coreUrl` is an absolute URL, because the worker's own base
    // URL is its bundle and not the page. Only what survives a structured clone
    // goes: `onWarn` is a function, and a function cannot be posted.
    const coreUrl = options?.coreUrl ? String(options.coreUrl) : undefined;
    this.worker.postMessage({
      wpdf: 'engine',
      coreUrl,
      options: options ? { planFonts: options.planFonts } : undefined,
    });
    this.worker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as {
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: { name?: string; message?: string };
        wpdf?: string;
        progress?: FontPlanProgress | null;
      };
      // The document's plan is walked on the other side, so its end arrives on
      // its own rather than as the answer to anything.
      if (data?.wpdf === 'plan') {
        this.planState = data.progress ?? null;
        if (this.planState?.ready) for (const cb of [...this.planReady]) cb();
        return;
      }
      const { id, ok, result, error } = data;
      const entry = this.pending.get(id as number);
      if (!entry) return;
      this.pending.delete(id as number);
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
    this.planState = null;
    const info = await this.call<DocumentInfo>('open', [source, password]);
    // How far the plan had got by the time the document was open. Asked for here
    // rather than pushed later, so that a host that looks at `planProgress()` the
    // moment `open` resolves sees an answer about this document and not the one
    // before it.
    this.planState = await this.call<FontPlanProgress | null>('planProgress', []);
    return info;
  }

  async renderPage(index: number, opts?: RenderOptions): Promise<RenderedPage> {
    return this.call<RenderedPage>('renderPage', [index, opts]);
  }

  async measureCrop(index: number, patterns: readonly CropPattern[]): Promise<CropRect | null> {
    return this.call<CropRect | null>('measureCrop', [index, patterns]);
  }

  /** The open document, written out again by the engine that is holding it. */
  async save(): Promise<Uint8Array> {
    return this.call<Uint8Array>('save', []);
  }

  /** Whether one expression compiles, as an error message or null. */
  async checkCropPattern(pattern: string): Promise<string | null> {
    return this.call<string | null>('checkCropPattern', [pattern]);
  }

  /** Nothing per-page: every page uses the document's plan. */
  drainNewFonts(): FontAsset[] {
    return [];
  }

  /** The plan's state, as the worker last reported it. */
  planProgress(): FontPlanProgress | null {
    return this.planState;
  }

  onPlanReady(cb: () => void): () => void {
    this.planReady.add(cb);
    if (this.planState?.ready) setTimeout(cb, 0);
    return () => this.planReady.delete(cb);
  }

  /** Every face the plan built, for a host that is about to draw one document. */
  plannedFonts(): Promise<FontAsset[]> {
    return this.call<FontAsset[]>('plannedFonts', []);
  }

  planDone(): Promise<void> {
    return this.call('planDone', []).then(() => undefined);
  }

  /**
   * Round-trip a trivial call to prove the worker booted *and* that the core's
   * wasm instantiated. Without a deadline a worker that dies during startup
   * leaves the caller waiting forever.
   */
  async probe(timeoutMs = 30000): Promise<void> {
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
 * Resolves to `null` when workers are unavailable or fail to boot, so callers
 * can fall back to rendering inline instead of failing.
 */
export async function createWorkerEngine(options: EngineOptions & { workerUrl?: string | URL } = {}): Promise<WorkerEngine | null> {
  if (typeof Worker === 'undefined') return null;
  try {
    // The `new Worker(new URL(...))` form must stay syntactically literal:
    // bundlers detect the worker by that pattern and will otherwise copy the
    // TypeScript source verbatim, which the browser cannot execute.
    const worker = options.workerUrl
      ? new Worker(options.workerUrl, { type: 'module', name: 'webpdf' })
      : new Worker(new URL('../worker.ts', import.meta.url), { type: 'module', name: 'webpdf' });
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
