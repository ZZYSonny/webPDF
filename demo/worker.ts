/// <reference lib="webworker" />
/**
 * The rendering worker: the core, on a thread of its own.
 *
 * A PDF is interpreted and a page is written as SVG by one synchronous wasm
 * module, and none of that can be interrupted once it has started - so it runs
 * here, where a page drawn for a reader costs the main thread nothing and the
 * document's font plan can walk 756 pages without the page going unresponsive.
 *
 * The module it needs is named by the host, not by this file: where the core's
 * glue was built to is a fact about the build, which only the page knows. The
 * first message says where, and every call after it is a method name and its
 * arguments; the answer goes back the same way, with an error copied into plain
 * fields so that it survives a structured clone.
 *
 * Nothing is imported eagerly, so a message that arrives before the wasm is
 * fetched is answered as soon as it is - which is why the message listener is
 * installed at the top of the module rather than after an `await`.
 */

import { PdfEngine } from './core/engine.ts';
import type { EngineOptions } from './core/types.ts';

let coreUrl: string | null = null;
let wasmUrl: string | null = null;
let planFonts: boolean | undefined;
let engine: Promise<PdfEngine> | null = null;

function engineOf(): Promise<PdfEngine> {
  if (!engine) {
    if (!coreUrl) return Promise.reject(new Error('the rendering worker was not told where the core is'));
    engine = PdfEngine.create({
      coreUrl,
      wasmUrl: wasmUrl ?? undefined,
      planFonts,
      // The plan arrives on its own rather than as the answer to anything: a
      // viewer watches for it while it is doing something else. Every slice is
      // sent, not only the last one, so that `planProgress()` on the page is the
      // walk's progress rather than whatever it was when the document opened.
      onPlanProgress: (progress) => post({ wpdf: 'plan', progress }),
    });
  }
  return engine;
}

function post(message: unknown): void {
  (self as unknown as Worker).postMessage(message);
}

const METHODS = [
  'open',
  'renderPage',
  'measureCrop',
  'checkCropPattern',
  'save',
  'drainNewFonts',
  'planProgress',
  'plannedFonts',
  'planDone',
  'trimCaches',
] as const;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {
    wpdf?: string;
    coreUrl?: string;
    wasmUrl?: string;
    options?: { planFonts?: boolean };
    id?: number;
    method?: string;
    args?: unknown[];
  };

  if (data?.wpdf === 'engine') {
    coreUrl = data.coreUrl ?? null;
    wasmUrl = data.wasmUrl ?? null;
    planFonts = data.options?.planFonts;
    return;
  }

  const { id, method, args = [] } = data;
  if (typeof id !== 'number' || typeof method !== 'string') return;

  void (async () => {
    try {
      if (method === 'probe') {
        // Prove the wasm is up, not merely that the file parsed.
        await engineOf();
        post({ id, ok: true, result: true });
        return;
      }
      const instance = await engineOf();
      if (method === 'close') {
        instance.close();
        engine = null;
        post({ id, ok: true, result: null });
        return;
      }
      if (!METHODS.includes(method as (typeof METHODS)[number])) {
        throw new Error(`the rendering worker has no method "${method}"`);
      }
      const fn = instance[method as keyof PdfEngine] as unknown as (...a: unknown[]) => unknown;
      const result = await fn.apply(instance, args);
      post({ id, ok: true, result });
    } catch (error) {
      const e = error as Error;
      post({ id, ok: false, error: { name: e?.name, message: e?.message ?? String(error) } });
    }
  })();
});
