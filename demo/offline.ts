/**
 * Offline: what this page keeps, and the worker that serves it.
 *
 * A reader who has opened the viewer once should be able to open it again on a
 * train. That takes two different kinds of keeping, and they are kept in
 * different places on purpose:
 *
 *   - the *shell* - this page and the files it is made of - is the service
 *     worker's (`demo/sw.js`), because it is the same for everyone and belongs to
 *     the build rather than to the reader. This module's job there is to register
 *     it, and to tell it once, after the engine has actually been used, which
 *     URLs the engine came from so it can keep a copy of the same bytes;
 *   - the *documents* are this module's, because which documents matter is a
 *     reader's business and nobody else's. The page writes them into a cache of
 *     its own as they are opened, and the worker serves them from there (see
 *     `kept` in `sw.js`) - so the rule for what is available offline is exactly
 *     "what has been read here", with nothing cached behind the reader's back.
 *
 * The list is capped and it is ordered by when a document was kept, which is the
 * honest half of "recent": the reader's *own* recency - where they were, which
 * was the last one they read - is the memory in `memory.ts`, and it is trimmed to
 * a hundred. The cap here is eight documents, and it exists for two reasons: a
 * cache with no ceiling grows until the browser evicts *everything* of this
 * origin, and a reader who cannot tell what is in there has no way to make room.
 * Eight is what fits under a browser's patience and over a reader's "the last few
 * papers I was working through", and anything older is a download away.
 *
 * `navigator.storage.persist()` is asked for once, when the first document is
 * kept. It is not a permission prompt - the browser decides for itself, from how
 * much this site is used - and it is the difference between "kept" and "kept
 * until the disk is needed for something else".
 *
 * None of it is allowed to fail loudly or to slow the reader down: no service
 * worker (an old browser, a page opened from `file:`), no Cache Storage, a quota
 * that says no - the viewer is the same viewer, and the reader finds out only if
 * they try to open something while offline.
 */

import type { EngineWasmSource } from '../src/core/engine-wasm.ts';

/** The documents this page has kept. Spelled in `demo/sw.js` too: it reads this one. */
const DOCS = 'webpdf-docs';

/** How many documents are worth keeping - see the note above. */
const KEEP = 8;

/** When a document was kept, so the cap can drop the oldest rather than the first. */
const KEPT_AT = 'x-webpdf-kept';

export interface OfflineOptions {
  /** The engine's sources, in the order the page tries them. */
  sources: readonly EngineWasmSource[];
  /**
   * Whether this page is being driven inside a frame that is not its own - the
   * extension's viewer, or any other host. A frame's storage belongs to whoever
   * framed it rather than to the reader, so there is nothing worth keeping and no
   * worker is registered. The bytes a host brings come from the host.
   */
  hosted: boolean;
  /** Where a failure that the reader should not be interrupted by is reported. */
  onWarn?: (message: string) => void;
}

export interface Offline {
  /**
   * The engine has just been fetched for a document: keep the same bytes for the
   * next visit. Called once; later calls do nothing.
   */
  used(): void;
  /**
   * Keep a document's bytes under the URL they came from, so that opening it
   * again needs no network. Stored under the URL without its fragment, which is
   * the URL that was fetched.
   */
  keep(url: string, bytes: Blob): void;
}

/**
 * Register the worker, and hand back the two things the page does about being
 * offline. Safe to call in a browser that can do none of it.
 */
export function createOffline({ sources, hosted, onWarn }: OfflineOptions): Offline {
  const worker = register(hosted, onWarn);
  let warmed = false;

  return {
    used() {
      if (warmed) return;
      warmed = true;
      void warmEngine(worker, sources, onWarn);
    },
    keep(url, bytes) {
      void keepDocument(url, bytes, onWarn);
    },
  };
}

/** The URL a document is filed under: where it came from, without the fragment. */
function keyOf(url: string): string | null {
  try {
    const target = new URL(url);
    target.hash = '';
    return target.href;
  } catch {
    return null;
  }
}

/**
 * The service worker, where there is one to register.
 *
 * Not in development: a worker serving yesterday's modules from its cache turns
 * every edit into a mystery, and a reload that does not reload is worse than no
 * offline at all.
 */
function register(hosted: boolean, onWarn?: (message: string) => void): ServiceWorkerContainer | null {
  if (!import.meta.env.PROD || hosted) return null;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  // Relative to this page, so the site's path on GitHub Pages never has to be
  // known here; the scope is the worker's own directory, which is the whole site.
  void navigator.serviceWorker.register('./sw.js').catch((error: unknown) => {
    onWarn?.(`no offline copy of the viewer: ${String((error as Error)?.message ?? error)}`);
  });
  return navigator.serviceWorker;
}

/** Tell the worker to keep the engine, once a document has needed it. */
async function warmEngine(
  worker: ServiceWorkerContainer | null,
  sources: readonly EngineWasmSource[],
  onWarn?: (message: string) => void,
): Promise<void> {
  if (!worker || !sources.length) return;
  try {
    // `ready` rather than `controller`: on a first visit the worker is still
    // installing when the first document opens, and this is exactly the visit
    // whose engine would otherwise not be kept.
    const registration = await worker.ready;
    registration.active?.postMessage({ wpdf: 'warm-engine', sources });
  } catch (error) {
    onWarn?.(`the engine was not kept for offline: ${String((error as Error)?.message ?? error)}`);
  }
}

/**
 * Keep one document, and drop the ones past the cap.
 *
 * The entry carries its own size and the moment it was kept, so trimming never
 * has to read a document back out of storage to make a decision about it. A
 * document that is already kept is written again rather than left alone: opening
 * it is what makes it recent, and "the last eight" has to mean the last eight
 * *opened* or the cap would evict the paper a reader keeps coming back to. It is
 * a write of bytes this page is holding already, behind a document that is on
 * screen by then.
 */
async function keepDocument(url: string, bytes: Blob, onWarn?: (message: string) => void): Promise<void> {
  const key = keyOf(url);
  if (!key || typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(DOCS);

    // Growth past what this origin is allowed is a promise the browser will
    // break by evicting the whole origin, so it is not made in the first place.
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && (estimate.usage ?? 0) + bytes.size > estimate.quota) {
      onWarn?.(`${url} was not kept for offline reading: no room left in this browser's storage`);
      return;
    }

    // Delete first: the stored response is the one thing that must not be
    // half-written, and a document that is kept again goes to the end of the list.
    await cache.delete(key);
    await cache.put(
      key,
      new Response(bytes, {
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(bytes.size),
          [KEPT_AT]: String(Date.now()),
        },
      }),
    );
    // Asked for once per visit rather than once per document: the browser's
    // answer does not change while the reader is reading.
    void navigator.storage?.persist?.().catch(() => undefined);
    await trim(cache);
  } catch (error) {
    onWarn?.(`${url} was not kept for offline reading: ${String((error as Error)?.message ?? error)}`);
  }
}

/** Drop everything past the cap, oldest first. */
async function trim(cache: Cache): Promise<void> {
  const kept = await Promise.all(
    (await cache.keys()).map(async (request) => {
      const response = await cache.match(request, { ignoreVary: true });
      return { request, at: Number(response?.headers.get(KEPT_AT) ?? 0) };
    }),
  );
  if (kept.length <= KEEP) return;
  kept.sort((a, b) => b.at - a.at);
  for (const { request } of kept.slice(KEEP)) await cache.delete(request);
}
