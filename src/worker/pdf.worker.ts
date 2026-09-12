/**
 * Rendering worker.
 *
 * Page rendering is CPU bound (MuPDF interpretation plus font compilation) and
 * takes 100-250 ms per page, so the viewer prefers to run the engine here rather
 * than hitching the main thread every time a page scrolls into range.
 *
 * Two details matter:
 *
 * 1. `self.onmessage` is installed *synchronously*, before anything is awaited.
 *    The MuPDF module resolves its wasm with a top-level await, and a request
 *    that arrives while the module graph is still evaluating is dispatched (and
 *    lost) if no handler exists yet.
 * 2. The engine is therefore pulled in with a dynamic `import()`, so the handler
 *    is live immediately and requests simply queue behind the promise. That
 *    import goes through `loadEngine`, which fetches the wasm from the first
 *    source the page configured before the module is evaluated.
 *
 * The protocol is deliberately tiny - `{ id, method, args }` in, `{ id, ok,
 * result | error }` out - because the very same `PdfEngine` also runs inline;
 * there is no second implementation to keep in sync. One message is not part of
 * it: `{ wpdf: 'engine', sources, options }`, which this worker's realm needs
 * because it cannot see the page's modules - not where the wasm is, and not how
 * the engine is to be built.
 */

import type { EngineOptions, PdfEngineLike, PdfSource, RenderOptions } from '../core/engine.ts';
import type { CropRuleId } from '../core/crop.ts';
import { configureEngineWasm, loadEngine, type EngineWasmConfig } from '../core/engine-wasm.ts';

interface Request {
  id: number;
  method: 'probe' | 'open' | 'renderPage' | 'measureCrop' | 'save' | 'drainNewFonts' | 'trimCaches' | 'close';
  args: unknown[];
}

/** Where to get the engine, and how to build it, sent by whoever created this worker. */
interface EngineMessage extends EngineWasmConfig {
  wpdf: 'engine';
  options?: EngineOptions;
}

function isEngineMessage(data: unknown): data is EngineMessage {
  return (data as EngineMessage | null)?.wpdf === 'engine';
}

let engine: Promise<PdfEngineLike> | null = null;
/** How the host asked for the engine to be built, before it is built. */
let engineOptions: EngineOptions | undefined;

function getEngine(): Promise<PdfEngineLike> {
  engine ??= loadEngine().then((mod) => new mod.PdfEngine(engineOptions));
  return engine;
}

const handlers = {
  probe: () => true,
  open: (e: PdfEngineLike, args: unknown[]) => e.open(args[0] as PdfSource, args[1] as string | undefined),
  renderPage: (e: PdfEngineLike, args: unknown[]) =>
    e.renderPage(args[0] as number, args[1] as RenderOptions | undefined),
  measureCrop: (e: PdfEngineLike, args: unknown[]) =>
    e.measureCrop?.(args[0] as number, args[1] as CropRuleId[]) ?? null,
  save: (e: PdfEngineLike) => e.save?.() ?? null,
  drainNewFonts: (e: PdfEngineLike) => e.drainNewFonts(),
  trimCaches: (e: PdfEngineLike, args: unknown[]) => e.trimCaches?.(args[0] as number[]),
  close: (e: PdfEngineLike) => e.close(),
} satisfies Record<Request['method'], (engine: PdfEngineLike, args: unknown[]) => unknown>;

self.onmessage = async (event: MessageEvent<Request | EngineMessage>) => {
  const data = event.data;
  // Before anything is awaited: the next message may be the request that starts
  // the engine, and it has to find the sources already in place.
  if (isEngineMessage(data)) {
    configureEngineWasm(data);
    // Only before the engine exists: the options are read once, when it is built.
    if (!engine && data.options) engineOptions = data.options;
    return;
  }
  const { id, method, args } = data ?? ({} as Request);
  const reply = (payload: Record<string, unknown>) => (self as unknown as Worker).postMessage({ id, ...payload });
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown engine method "${method}"`);
    const instance = await getEngine();
    reply({ ok: true, result: await handler(instance, args) });
  } catch (error) {
    const err = error as Error;
    reply({ ok: false, error: { name: err?.name ?? 'Error', message: err?.message ?? String(error) } });
  }
};
