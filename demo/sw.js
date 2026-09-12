/**
 * The service worker: the viewer with no network.
 *
 * The published site is a page and a handful of assets, and every one of them is
 * listed below by the build that made it. That list is the shell, and the shell
 * is what this worker serves: the page comes up from the cache whether the
 * network is there or not, which is the whole of "works offline" for a reader who
 * has visited once. Three things are cached, and they are cached differently on
 * purpose:
 *
 *   - the *shell* (the page, its scripts, its styles, its manifest and icons) is
 *     precached on install, in a cache named after a digest of the files
 *     themselves. A new build is a new name, so the old one is dropped whole on
 *     activation and nothing from two builds is ever served together;
 *   - the *engine* (MuPDF's 10 MB wasm) is not precached - downloading ten
 *     megabytes on install, for a reader who may never open a document, is not a
 *     promise a site should make. It is kept the first time it is actually
 *     fetched (`warm-engine`), together with the digest it was verified against,
 *     and served from there afterwards;
 *   - *documents* are not this worker's decision at all. The page keeps the ones
 *     it decides are worth keeping in a cache of its own
 *     (`demo/offline.ts` - the name is spelled there too), and all this worker
 *     does is look in it before going to the network. A PDF is immutable at its
 *     URL: a cached one is never stale, so it is never revalidated.
 *
 * There is no `skipWaiting`, and that is the interesting decision. A new worker
 * takes over when the pages of the old one are gone, not in the middle of a
 * reader's session: this page fetches parts of itself lazily (the engine's own
 * chunk is fetched when the first document is opened), and a worker that swapped
 * the shell out from under a page that was still loading it would be answering
 * those fetches with a build that no longer has those files. So an update waits
 * for the next visit, which for a document viewer is a reload away - and a reader
 * reading is never interrupted by one.
 *
 * What is *not* here matters as much: no push, no sync, no background anything.
 * This worker exists to serve bytes that are already on the disk.
 */

/* eslint-env serviceworker */

// A digest of every file in the shell: the same build, the same name.
const BUILD = __BUILD__;

// The shell, as relative URLs. Filled in by `pwa()` in `vite.demo.config.ts`.
const PRECACHE = __PRECACHE__;

/** The shell's cache, named after the build so a new one cannot mix with it. */
const SHELL = `webpdf-shell-${BUILD}`;

/** The engine's cache, and the page's document cache, which is not ours to trim. */
const ENGINE = 'webpdf-engine';
const DOCS = 'webpdf-docs';

/** The page, for a navigation that is not about a particular file. */
const INDEX = new URL('./index.html', self.location.href).href;

/**
 * The site's own entry - `/`, or `/webPDF/` where it is published - which is the
 * URL a reader navigates to, and not the same key as `index.html` that answers
 * it. Kept as well as the file, because what a server sends for the two is not
 * always identical: the dev and preview servers, for instance, put the list of
 * locally cached papers into the page on its way out, and a navigation that
 * skipped that would come up without them.
 */
const ENTRY = new URL('./', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // All or nothing: a shell missing one of its files is not a shell, and
      // an install that fails is retried on the next visit.
      await cache.addAll(PRECACHE);
      // The entry alone is allowed to fail - `index.html` is already in the list
      // and is matched in its place - so a server that answers it with a
      // redirect, or not at all, cannot take the whole install down with it.
      await cache.add(ENTRY).catch(() => undefined);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        // Only the shells: the engine and the reader's documents outlive a
        // deploy, and the engine cache is trimmed by URL in `warmEngine`.
        if (name.startsWith('webpdf-shell-') && name !== SHELL) await caches.delete(name);
      }
      // A first visit installed this worker *after* the page it belongs to was
      // already loading; claiming it is what makes that page's later fetches -
      // the engine, a document - go through here.
      await self.clients.claim();
    })(),
  );
});

/** The page itself: the cached shell, by URL or as the site's one page. */
async function shell(request) {
  const cache = await caches.open(SHELL);
  return (
    (await cache.match(request, { ignoreSearch: true })) ??
    (await cache.match(INDEX)) ??
    (await fetch(request))
  );
}

/**
 * The engine: what is already kept, otherwise the network.
 *
 * Nothing is *stored* here. This cache is written in one place only - `warmEngine`
 * below, which checks the digest of what it is about to keep - so that everything
 * in it is bytes the page verified. A response served through here has been
 * checked by the page anyway (it digests whatever it is handed and falls back to
 * the next source on a mismatch), but a response that is merely *served* is not
 * necessarily the engine, and this is one cache that must not fill up with
 * things that are not.
 */
async function engine(request) {
  const cache = await caches.open(ENGINE);
  const kept = await cache.match(request, { ignoreVary: true });
  return kept ?? (await fetch(request));
}

/** A document the page kept, or the network. */
async function kept(request) {
  const cached = await caches.match(request, { cacheName: DOCS, ignoreVary: true });
  if (cached) return cached;
  const shelled = await caches.match(request, { cacheName: SHELL, ignoreSearch: true });
  return shelled ?? (await fetch(request));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Nothing but the two schemes this cache is keyed on reaches the network
  // through here; a blob: URL (the printer's copy of a document) never arrives.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (request.mode === 'navigate') event.respondWith(shell(request));
  else if (url.pathname.endsWith('.wasm')) event.respondWith(engine(request));
  else event.respondWith(kept(request));
});

/** `sha384-<base64>` of some bytes, or null where there is nothing to check with. */
async function digestOf(bytes) {
  const subtle = self.crypto?.subtle;
  if (!subtle) return null;
  const hash = await subtle.digest('SHA-384', bytes);
  let binary = '';
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  return `sha384-${btoa(binary)}`;
}

/**
 * Keep the engine, once the reader has actually used it.
 *
 * The page sends the sources it was built with, in order, each with the digest
 * of the bytes it expects - so what goes into this cache is what the page
 * verified, not whatever a URL answered at some point. The first source that
 * answers and matches wins, exactly as it does for the page; a source that is
 * already kept ends it, since the point is to have *an* engine offline, not all
 * of them.
 */
async function warmEngine(sources) {
  const cache = await caches.open(ENGINE);
  for (const source of sources ?? []) {
    try {
      const url = new URL(source.url, self.location.href).href;
      if (await cache.match(url, { ignoreVary: true })) return;
      const response = await fetch(url);
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      const digest = source.integrity ? await digestOf(bytes) : null;
      if (source.integrity && digest && digest !== source.integrity) continue;
      await cache.put(
        url,
        new Response(bytes, {
          headers: { 'content-type': 'application/wasm', 'content-length': String(bytes.byteLength) },
        }),
      );
      return;
    } catch {
      // The next source, or none: the page fetches the engine for itself
      // either way, and a worker that cannot keep it is not a failure.
    }
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.wpdf !== 'warm-engine') return;
  event.waitUntil(warmEngine(message.sources));
});
