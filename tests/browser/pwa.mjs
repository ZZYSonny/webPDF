/**
 * The viewer with no network - and the engine it draws with.
 *
 *   node tests/browser/pwa.mjs [url]
 *
 * `url` is where the built demo is served (the suite's preview server). Two
 * scenarios are driven here, and they answer two different questions:
 *
 *  1. *The engine's address.* A page served from the machine it is running on -
 *     which is this one, and every dev server and test browser - asks for the
 *     engine next to it first and for the pinned CDN copy second, so that a
 *     browser with no cache to amortize a download against does not pull ten
 *     megabytes per launch (`engineSources` in `demo/main.ts`). What is checked
 *     is that the engine the viewer used is this machine's copy, that the pinned
 *     CDN address in the build still answers with an engine of the right size,
 *     and that a page which has not opened a document yet has fetched no wasm at
 *     all (the engine is imported when it is first needed, not when the page
 *     boots).
 *
 *  2. *Nothing but what the browser kept.* A second browser is launched with
 *     every name but `127.0.0.1` unresolvable (`--host-resolver-rules`), which is
 *     what a reader on a train has: no CDN, no arXiv, nothing but this machine.
 *     The viewer is opened from a throwaway server of this file's own, a document
 *     is read, and then *the server is killed* and the page is loaded again. It
 *     has to come up, and it has to open the same document and draw it - from the
 *     service worker's copy of the shell and the engine, and from the page's own
 *     copy of the document. That is the whole offline claim, and there is no way
 *     to check it other than by taking the network away.
 *
 * The fallback in (2) is also the proof that a CDN which is unreachable does not
 * take the viewer with it: the engine there can only have come from this site.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { launch } from './cdp.mjs';
import { PAPERS, cachedFile } from '../pdf-cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const dist = path.join(root, 'dist', 'demo');
const url = process.argv[2] ?? 'http://127.0.0.1:5178/';

/** The paper the offline half is written against, from the suite's cache. */
const paper = PAPERS[0];
const file = cachedFile(paper.url);
if (!file) {
  console.error(`FAIL: ${paper.url} is not in the cache — run \`npm run pdfs\` first`);
  process.exit(1);
}
const pdf = `/pdf/${path.basename(file)}`;

/**
 * The CDN copy of the engine, which is what a *published* page asks for first,
 * pinned to the installed MuPDF exactly as `engineFacts()` writes it.
 */
const mupdf = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/mupdf/package.json'), 'utf8')).version;
const cdn = `https://cdn.jsdelivr.net/npm/mupdf@${mupdf}/dist/mupdf-wasm.wasm`;

let failures = 0;
const started = Date.now();
const check = (label, ok, detail = '') => {
  const at = `${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${at} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/**
 * The probes the demo test installs, in miniature: a page is drawn inside the
 * viewer's shadow root and, by default, inside a frame of its own, so "is it
 * drawn" is a question about a tree of documents rather than one.
 */
const PROBE = `(() => {
  window.__svgs = () => {
    const sr = document.getElementById('viewer')?.shadowRoot;
    if (!sr) return [];
    return [...sr.querySelectorAll('.wpdf-page')]
      .map((el) => el.querySelector('svg.wpdf-page-svg'))
      .filter(Boolean);
  };
  window.__kept = async () => {
    const keysOf = async (name) => {
      if (!name) return [];
      const cache = await caches.open(name);
      return (await cache.keys()).map((key) => key.url);
    };
    const names = await caches.keys();
    return {
      shell: await keysOf(names.find((name) => name.startsWith('webpdf-shell-'))),
      engine: await keysOf('webpdf-engine'),
      docs: await keysOf('webpdf-docs'),
    };
  };
})()`;

/** What a file is, by its extension: only the types the site is made of. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
};

/**
 * The site, served the way the preview server serves it: the built demo at the
 * root, and the test corpus at `/pdf/<name>` - which is what the demo's own
 * picker calls those documents, and what the page will therefore keep offline.
 *
 * A server of the test's own rather than the suite's, because the offline half of
 * the test has to be able to kill it.
 */
function serve() {
  const server = http.createServer((req, res) => {
    const at = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
    const local = at.startsWith('pdf/') ? path.join(path.dirname(file), path.basename(at)) : path.join(dist, at || 'index.html');
    if (!local.startsWith(at.startsWith('pdf/') ? path.dirname(file) : dist) || !fs.existsSync(local) || !fs.statSync(local).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(local)] ?? 'application/octet-stream',
      'Content-Length': String(fs.statSync(local).size),
      // The page is read fresh; everything else it loads carries a content hash
      // and may be kept.
      'Cache-Control': path.extname(local) === '.html' ? 'no-cache' : 'public, max-age=600',
    });
    fs.createReadStream(local).pipe(res);
  });
  return server;
}

/** Start a server on a port of the system's choosing, and how to stop it. */
async function listening(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    /** Stop answering, and drop the connections a browser keeps open. */
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Load the page and wait until the demo's own handle says it is wired up. */
async function boot(page, at) {
  await page.goto(at, { timeout: 20000 });
  await page.waitFor(() => !!window.webpdf?.open, { label: 'the demo to come up' });
}

/** Open a document through the page's own path, and wait for it to be drawn. */
async function open(page, document_) {
  await page.evaluate(`window.webpdf.open(${JSON.stringify(document_)})`);
  await page.waitFor(() => window.__svgs().length > 0, { label: 'the first page to be drawn' });
}

/* ------------------------------------------------- the engine's own address */

console.log('› the engine, and where the page was told to find it');
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport(1280, 900);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await boot(page, url);

  const booted = await page.evaluate(`performance.getEntriesByType('resource').map((entry) => entry.name)`);
  check(
    'nothing fetches the engine until a document needs it',
    !booted.some((name) => name.endsWith('.wasm')),
    `${booted.length} resources at start-up, none of them wasm`,
  );

  const manifest = await page.evaluate(`fetch('./manifest.webmanifest').then((r) => r.json())`);
  const icons = await page.evaluate(
    `Promise.all(${JSON.stringify(manifest.icons.map((icon) => icon.src))}.map(async (src) => (await fetch(src, { method: 'HEAD' })).ok))`,
  );
  check(
    'the manifest is installable, and its icons are real files',
    manifest.display === 'standalone' && manifest.start_url && manifest.icons.length >= 2 && icons.every(Boolean),
    `${manifest.icons.length} icons (${manifest.icons.map((icon) => icon.sizes).join(', ')}), start_url ${manifest.start_url}`,
  );

  const worker = await page.evaluate(
    `(async () => { const registration = await navigator.serviceWorker.ready; return { scope: registration.scope, state: registration.active?.state ?? null }; })()`,
  );
  // `ready` resolves as soon as there is an active worker, which it can be while
  // it is still activating: what the site needs is the finished one.
  const activated = await page.waitFor(async () => (await navigator.serviceWorker.ready).active?.state === 'activated', {
    label: 'the worker to finish activating',
  });
  check(
    'a service worker takes the whole site over',
    activated && worker.scope.endsWith('/'),
    `${worker.scope}, ${worker.state} when it first answered`,
  );

  await page.waitFor(async () => {
    const kept = await window.__kept();
    return kept.shell.length > 0;
  }, { label: 'the shell to be precached' });

  const shell = await page.evaluate(`window.__kept()`);
  check(
    'the shell is cached whole, page and manifest included',
    shell.shell.some((name) => name.endsWith('/index.html')) &&
      shell.shell.some((name) => name.endsWith('.js')) &&
      shell.shell.some((name) => name.endsWith('manifest.webmanifest')),
    `${shell.shell.length} files, none of them the engine`,
  );

  await open(page, pdf);
  await page.waitFor(async () => (await window.__kept()).engine.length > 0, {
    label: 'the engine to be kept for offline',
    timeout: 90000,
  });
  const kept = await page.evaluate(`window.__kept()`);
  const engine = kept.engine[0] ?? '';
  // A page served from this machine reads the engine from this machine: that is
  // the whole reason a test browser - which starts with an empty cache every
  // launch - does not fetch ten megabytes from a CDN on every run.
  const local = new URL(`/engine/mupdf-${mupdf}.wasm`, url).href;
  check('the engine came from this machine, not from a CDN', engine === local, `${engine}`);

  // The other source is the one a *published* page asks for first, and this page
  // never touches it, so it is checked directly: the address has to answer, in the
  // browser, and with the exact bytes this build was compiled against - which is
  // what the page's own digest check would demand of it anyway. One download per
  // suite run, against ten megabytes per *launch* if the order above were the
  // other way round.
  const cdnDigest = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(cdn)});
    if (!response.ok) return { ok: false, status: response.status };
    const bytes = await response.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-384', bytes);
    let binary = '';
    for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
    return { ok: true, size: bytes.byteLength, integrity: 'sha384-' + btoa(binary) };
  })()`);
  const expected = `sha384-${createHash('sha384').update(fs.readFileSync(path.join(root, 'node_modules/mupdf/dist/mupdf-wasm.wasm'))).digest('base64')}`;
  check(
    "the pinned CDN address still serves this build's engine",
    cdnDigest.ok && cdnDigest.integrity === expected,
    cdnDigest.ok
      ? `${Math.round(cdnDigest.size / 1e6)} MB, ${cdnDigest.integrity === expected ? 'matching the digest in the build' : `digest ${cdnDigest.integrity} is not ${expected}`}`
      : `unreachable from the browser: HTTP ${cdnDigest.status}`,
  );

  check(
    'the document was kept, whole, under the URL it came from',
    kept.docs.some((name) => name.endsWith(pdf)),
    `${kept.docs.length} document(s) kept`,
  );

  await browser.close();
}

/* ------------------------------------------------------- nothing but the disk */

console.log('\n› the same viewer with no network at all');
{
  // Everything but this machine is unresolvable: the CDN is as far away as arXiv
  // is, which is what makes the fallback and the caches the only way through.
  const browser = await launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const page = await browser.newPage();
  await page.setViewport(1280, 900);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

  const server = await listening(serve());
  await boot(page, server.origin);
  await page.evaluate(
    `(async () => { await navigator.serviceWorker.ready; })()`,
  );
  await open(page, pdf);
  await page.waitFor(async () => (await window.__kept()).engine.length > 0, {
    label: 'the engine to be kept for offline',
    timeout: 90000,
  });

  const kept = await page.evaluate(`window.__kept()`);
  check(
    'and the engine is kept from this site, with no name resolving at all',
    kept.engine.length === 1 && kept.engine[0].startsWith(server.origin) && kept.engine[0].endsWith(`mupdf-${mupdf}.wasm`),
    kept.engine.join(', ') || 'nothing kept',
  );

  // Now take the only server away. What is left is the browser's own storage:
  // the worker has the shell and the engine, the page has the document.
  const before = await page.evaluate(`window.webpdf.info()?.pageCount ?? 0`);
  await server.stop();
  await boot(page, server.origin);

  const up = await page.evaluate(`!!window.webpdf?.open && !!navigator.serviceWorker.controller`);
  check('the page comes up with nothing to fetch it from', up, `${server.origin} is not answering any more`);

  await open(page, pdf);
  const again = await page.evaluate(`window.webpdf.info()?.pageCount ?? 0`);
  const onScreen = await page.evaluate(`window.__svgs().length`);
  check(
    'and the same document still opens, and is still drawn',
    again === before && again > 1 && onScreen > 0,
    `${again} pages, ${onScreen} of them on screen, from the copy the browser kept`,
  );

  await browser.close();
}

console.log(failures ? `\nPWA CHECK FAILED (${failures})` : '\nPWA CHECK PASSED');
process.exit(failures ? 1 : 0);
