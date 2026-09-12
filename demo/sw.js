/**
 * The service worker: the viewer with no network, and the way a new build of it
 * gets in.
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
 *     themselves. A new build is a new name, so the build before it is kept
 *     whole - for exactly one generation, see `install` and `activate` - and
 *     nothing from two builds is ever served to the same request: a navigation
 *     is answered from this build's shell and from nowhere else;
 *   - the *engine* (the Rust core's wasm, nine megabytes of it) is not precached
 *     - downloading nine megabytes on install, for a reader who may never open a
 *     document, is not a promise a site should make. It is kept the first time it
 *     is actually fetched (`warm-engine`), together with the digest it was
 *     verified against, and served from there afterwards;
 *   - *documents* are not this worker's decision at all. The page keeps the ones
 *     it decides are worth keeping in a cache of its own
 *     (`demo/offline.ts` - the name is spelled there too), and all this worker
 *     does is look in it before going to the network. A PDF is immutable at its
 *     URL: a cached one is never stale, so it is never revalidated.
 *
 * There is still no `skipWaiting` on install, and that is the interesting
 * decision. A worker that took over the moment it was installed would be
 * answering the lazy fetches of a page that was built for the shell before it -
 * this page fetches parts of itself when the first document is opened - and a
 * reader reading is never interrupted by a deploy. What there is instead is a
 * way for the *page* to ask: `apply-update` below, sent by a page that has been
 * told a new build is waiting and has a reader willing to reload for it. The
 * shell before this one is kept for exactly that reason: the moment of the swap
 * is a moment in which some page is still the build before it.
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

/** Every shell is named with this; the order below deliberately is not. */
const SHELL_PREFIX = 'webpdf-shell-';

/**
 * Which shells are kept, newest first, in a cache of its own.
 *
 * Nothing about a cache name says when it was made, and a worker can be
 * terminated between its install and its activation, so "the build before this
 * one" has to be written down rather than worked out. One entry, one list, and
 * the two names at the front of it are what survives; the cache itself is not a
 * shell and is never trimmed.
 */
const ORDER = 'webpdf-shells';
const ORDER_KEY = new URL('./shells.json', self.location.href).href;

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

/**
 * The shell this build replaced, once one is known to be kept.
 *
 * Read from the order below, and remembered here because it is asked for on
 * every request that is not a navigation. A worker that was terminated reads it
 * again on the first such request; that is what `read` is for.
 */
let older = null;
let read = false;

/** The shells that are kept, newest first. */
async function order() {
  const cache = await caches.open(ORDER);
  const kept = await cache.match(ORDER_KEY);
  if (!kept) return [];
  try {
    const names = JSON.parse(await kept.text());
    return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/** Put a shell at the front of the order, where it stays until it is dropped. */
async function remember(name) {
  const cache = await caches.open(ORDER);
  const names = [name, ...(await order()).filter((other) => other !== name)];
  await cache.put(ORDER_KEY, new Response(JSON.stringify(names)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // All or nothing: a shell missing one of its files is not a shell, and
      // an install that fails is retried on the next visit.
      //
      // Fetched with `cache: 'reload'`, because what a shell is made of is
      // decided by the deploy that wrote this worker and not by whatever the
      // HTTP cache is still holding. GitHub Pages hands every file a ten-minute
      // lifetime, and a shell assembled from that would be a page pointing at
      // files the deploy has already replaced - which is a broken build, cached
      // until the *next* one.
      await cache.addAll(PRECACHE.map((file) => new Request(file, { cache: 'reload' })));
      // The entry alone is allowed to fail - `index.html` is already in the list
      // and is matched in its place - so a server that answers it with a
      // redirect, or not at all, cannot take the whole install down with it.
      await cache.add(new Request(ENTRY, { cache: 'reload' })).catch(() => undefined);
      // Only once the shell is really there: a name at the front of the order is
      // a promise that the cache behind it is whole.
      await remember(SHELL);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // This build's shell, and the one before it. The second is not nostalgia:
      // between a reader asking for the update and the page they asked from
      // reloading into it, that page is still the old one, and so is any other
      // tab left open on it - and both fetch parts of themselves lazily. A
      // build older than that has nobody to answer for, so it goes.
      const keep = [SHELL, ...(await order()).filter((name) => name !== SHELL)].slice(0, 2);
      for (const name of await caches.keys()) {
        if (name.startsWith(SHELL_PREFIX) && !keep.includes(name)) await caches.delete(name);
      }
      older = keep[1] ?? null;
      read = true;
      const cache = await caches.open(ORDER);
      await cache.put(ORDER_KEY, new Response(JSON.stringify(keep)));
      // A first visit installed this worker *after* the page it belongs to was
      // already loading; claiming it is what makes that page's later fetches -
      // the engine, a document - go through here.
      await self.clients.claim();
    })(),
  );
});

/** The shell this build replaced, if it is still kept. */
async function previous() {
  if (!read) {
    read = true;
    older = (await order()).find((name) => name !== SHELL) ?? null;
  }
  return older;
}

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
 * What is already kept of a file the page is made of: this build's shell first,
 * then the one before it.
 *
 * The second lookup is what keeps a deploy invisible to a page that is still
 * loading. A file whose name carries a content hash is not in the new shell at
 * all, so without it the fetch would go to the network and find a 404 where the
 * deploy used to be - a viewer that cannot load its own engine until someone
 * reloads it.
 */
async function shelled(request) {
  for (const name of [SHELL, await previous()]) {
    if (!name || !(await caches.has(name))) continue;
    const hit = await (await caches.open(name)).match(request, { ignoreSearch: true });
    if (hit) return hit;
  }
  return null;
}

/**
 * The engine: what is already kept, otherwise the network.
 *
 * Nothing is *stored* here. This cache is written in one place only - `warmEngine`
 * below, which checks the digest of what it is about to keep - so that everything
 * in it is bytes the page verified. A response that is merely *served* is not
 * necessarily the engine, and this is one cache that must not fill up with things
 * that are not.
 */
async function engine(request) {
  const cache = await caches.open(ENGINE);
  const kept = await cache.match(request, { ignoreVary: true });
  return kept ?? (await fetch(request));
}

/** A document the page kept, a file the shell kept, or the network. */
async function kept(request) {
  const cached = await caches.match(request, { cacheName: DOCS, ignoreVary: true });
  if (cached) return cached;
  return (await shelled(request)) ?? (await fetch(request));
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
 * The page sends the one file its build was made against, with the digest of the
 * bytes it expects - so what goes into this cache is what the page verified, not
 * whatever a URL answered at some point. A digest that does not match is not
 * kept: a wasm binary that is not the one the page was built with cannot be
 * allowed to answer for it later. Nothing is kept at all until the reader has
 * opened a document, which is the moment the engine is worth nine megabytes.
 *
 * The binary's name does not change when it is rebuilt, which is exactly why the
 * digest is here: the build id covers the page's own files, and this one is
 * fetched rather than bundled, so the two have to be tied together some other
 * way.
 */
async function warmEngine(source) {
  if (!source?.url || !source.integrity) return;
  try {
    const cache = await caches.open(ENGINE);
    const url = new URL(source.url, self.location.href).href;
    if (await cache.match(url, { ignoreVary: true })) return;
    const response = await fetch(url);
    if (!response.ok) return;
    const bytes = await response.arrayBuffer();
    // No `crypto.subtle` (a page that is not on a secure origin) means no way to
    // check, and an unchecked binary is worse than a network fetch.
    if ((await digestOf(bytes)) !== source.integrity) return;
    await cache.put(
      url,
      new Response(bytes, {
        headers: { 'content-type': 'application/wasm', 'content-length': String(bytes.byteLength) },
      }),
    );
  } catch {
    // A worker that cannot keep the engine is not a failure: the page fetches it
    // for itself either way.
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message) return;
  if (message.wpdf === 'warm-engine') {
    event.waitUntil(warmEngine(message.engine));
    return;
  }
  // A page has found this build waiting and a reader has said yes: take over
  // now, rather than when every tab of the build before it happens to close.
  // The page reloads itself on `controllerchange`, so the shell is not swapped
  // out from under a page that is staying - and the shell it came from is still
  // kept until the next build, for whatever it had already started to fetch.
  if (message.wpdf === 'apply-update') event.waitUntil(self.skipWaiting());
});
