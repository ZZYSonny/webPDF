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
 *    is live immediately and requests simply queue behind the promise.
 *
 * The protocol is deliberately tiny - `{ id, method, args }` in, `{ id, ok,
 * result | error }` out - because the very same `PdfEngine` also runs inline;
 * there is no second implementation to keep in sync.
 */

import type { PdfEngineLike, PdfSource, RenderOptions } from '../core/engine.ts';

interface Request {
  id: number;
  method: 'probe' | 'open' | 'renderPage' | 'drainNewFonts' | 'trimCaches' | 'close';
  args: unknown[];
}

let engine: Promise<PdfEngineLike> | null = null;

function getEngine(): Promise<PdfEngineLike> {
  engine ??= import('../core/engine.ts').then((mod) => new mod.PdfEngine());
  return engine;
}

const handlers = {
  probe: () => true,
  open: (e: PdfEngineLike, args: unknown[]) => e.open(args[0] as PdfSource, args[1] as string | undefined),
  renderPage: (e: PdfEngineLike, args: unknown[]) =>
    e.renderPage(args[0] as number, args[1] as RenderOptions | undefined),
  drainNewFonts: (e: PdfEngineLike) => e.drainNewFonts(),
  trimCaches: (e: PdfEngineLike, args: unknown[]) => e.trimCaches?.(args[0] as number[]),
  close: (e: PdfEngineLike) => e.close(),
} satisfies Record<Request['method'], (engine: PdfEngineLike, args: unknown[]) => unknown>;

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, method, args } = event.data ?? ({} as Request);
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
