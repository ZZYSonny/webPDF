/**
 * The viewer with no network - and the engine it draws with.
 *
 *   node tests/browser/pwa.mjs [url]
 *
 * `url` is where the built demo is served (the suite's preview server). Two
 * scenarios are driven here, and they answer two different questions:
 *
 *  1. *The engine's address and its digest.* The core is built from this
 *     repository, so it is served from this site and nowhere else, and the page
 *     keeps a copy of it only after checking it against the digest the build was
 *     made with (`warmEngine` in `demo/sw.js`). What is checked is that the
 *     binary the viewer used is this site's own file, that it digests to exactly
 *     what `vite.demo.config.ts` wrote into the page, and that a page which has
 *     not opened a document yet has fetched no wasm at all (the engine is loaded
 *     when it is first needed, not when the page boots).
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
 *  3. *A redeploy, and what the page does about it.* A worker that never takes
 *     over on its own is a site that never updates for a reader who keeps the
 *     page open, so the page has to look for a new build and say what it found.
 *     The same throwaway server serves a copy of the build that is rewritten
 *     between visits - a different entry module under a different hash, which is
 *     what a build does - and the page is checked at each step: a plain reload is
 *     told a build is waiting and stays on the one it is reading; taking the
 *     offer lands on the new build; the build before it is still there to answer
 *     for the files it was made of; the one before *that* is dropped; and the
 *     whole thing still comes up offline afterwards.
 *
 * (2) is also the proof that an unreachable network does not take the viewer with
 * it: the engine there can only have come from this site, and the site is gone.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
 * The core's binary as *this* build knows it: the address the page resolves,
 * and the digest it was built against.
 *
 * Both are read the way `coreFacts()` in `vite.demo.config.ts` writes them -
 * the built file and its SHA-384 - because that is what the page checks a kept
 * copy against, and a test that computed its own answer could not tell a build
 * that wrote the wrong digest from one that wrote the right one.
 */
const coreWasm = fs.readFileSync(path.join(dist, 'engine', 'webpdf-core.wasm'));
const coreDigest = `sha384-${createHash('sha384').update(coreWasm).digest('base64')}`;
const coreName = 'webpdf-core.wasm';

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
      // A page is drawn in a frame of its own until the document's fonts are
      // planned, and in the slot itself after that (see RenderMode), so the
      // question "is this page drawn" is asked of whichever document holds it.
      .map((el) => (el.querySelector('iframe')?.contentDocument ?? el).querySelector('svg.wpdf-page-svg'))
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
 * The site, served the way GitHub Pages serves it: the build under test at the
 * root, and the test corpus at `/pdf/<name>` - which is what the demo's own
 * picker calls those documents, and what the page will therefore keep offline.
 *
 * A server of the test's own rather than the suite's, because the offline half
 * of the test has to be able to kill it, and because the redeploy half has to be
 * able to replace what it is serving.
 *
 * Every file gets GitHub Pages' own ten minutes, the page and the worker
 * included. That is not incidental: a build's shell has to be assembled from the
 * deploy that wrote the worker rather than from whatever the HTTP cache is still
 * holding, and a worker is the one file whose being stale hides every other
 * staleness behind it. A test server kinder than the real one would test
 * neither.
 */
function serve(root) {
  const server = http.createServer((req, res) => {
    const at = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
    const local = at.startsWith('pdf/') ? path.join(path.dirname(file), path.basename(at)) : path.join(root, at || 'index.html');
    if (!local.startsWith(at.startsWith('pdf/') ? path.dirname(file) : root) || !fs.existsSync(local) || !fs.statSync(local).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(local)] ?? 'application/octet-stream',
      'Content-Length': String(fs.statSync(local).size),
      'Cache-Control': 'public, max-age=600',
    });
    fs.createReadStream(local).pipe(res);
  });
  return server;
}

/**
 * The next deploy, in the only terms a test can see one: the entry module is
 * renamed to the hash a new build would give it, the page points at the new
 * name, the shell lists it instead of the old one, and the worker's build digest
 * changes so a browser sees a worker it does not have.
 *
 * The *page* is marked as well, because that is the question the rest of this
 * checks ask: which build is the reader looking at.
 */
function redeploy(dir, marker) {
  const index = path.join(dir, 'index.html');
  let html = fs.readFileSync(index, 'utf8');
  const entry = /src="\.\/(assets\/[^"]+\.js)"/.exec(html);
  if (!entry) throw new Error('no entry module in the built page');
  const was = entry[1];
  const now = `assets/index-${createHash('sha256').update(marker).digest('base64url').slice(0, 8)}.js`;
  if (now === was) throw new Error(`the entry name did not change: ${was}`);
  fs.renameSync(path.join(dir, was), path.join(dir, now));
  html = html
    .replace(was, now)
    .replace(/\s*<meta name="build"[^>]*>/, '')
    .replace('<head>', `<head>\n    <meta name="build" content="${marker}" />`);
  fs.writeFileSync(index, html);

  const worker = path.join(dir, 'sw.js');
  fs.writeFileSync(
    worker,
    fs
      .readFileSync(worker, 'utf8')
      .replace(was, now)
      .replace(/const BUILD = "[0-9a-f]+"/, `const BUILD = "${createHash('sha256').update(html).digest('hex').slice(0, 16)}"`),
  );
  return { was, now };
}

/** Which build the page on screen is, or null for the one that was there first. */
const buildOf = (page) => page.evaluate(`document.querySelector('meta[name="build"]')?.content ?? null`);

/** The shells that are kept, in order: the browser's own answer to "which builds". */
const shellsOf = (page) =>
  page.evaluate(`caches.keys().then((names) => names.filter((name) => name.startsWith('webpdf-shell-')).sort())`);

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
  // There is one source now and it is this site's own - the core is built from
  // this repository rather than installed from a registry - so the question is
  // not which source won but whether the file that was kept is the one the page
  // was built against.
  const local = new URL(`/engine/${coreName}`, url).href;
  check('the engine came from this site', engine === local, `${engine || 'nothing kept'}`);

  // The binary is the published one, byte for byte: the page digests what it is
  // handed and will not keep what it did not expect (see `warmEngine`), so a
  // service worker holding anything else is a service worker serving a stale
  // engine.
  const served = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(local)});
    if (!response.ok) return { ok: false, status: response.status };
    const bytes = await response.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-384', bytes);
    let binary = '';
    for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
    return { ok: true, size: bytes.byteLength, integrity: 'sha384-' + btoa(binary) };
  })()`);
  check(
    'the served binary is the one this build was compiled against',
    served.ok && served.integrity === coreDigest,
    served.ok
      ? `${Math.round(served.size / 1e6)} MB, ${served.integrity === coreDigest ? 'matching the digest in the build' : `digest ${served.integrity} is not ${coreDigest}`}`
      : `unreachable from the browser: HTTP ${served.status}`,
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

  const server = await listening(serve(dist));
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
    kept.engine.length === 1 && kept.engine[0].startsWith(server.origin) && kept.engine[0].endsWith(coreName),
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

/* --------------------------------------------------- a new build, waiting */

console.log('\n› a redeploy, and what the page does about it');
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport(1280, 900);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

  // A copy of the build this test is free to rewrite: a redeploy is nothing but
  // a different set of files at the same URLs, as far as a browser can tell.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpdf-redeploy-'));
  fs.cpSync(dist, dir, { recursive: true });
  const server = await listening(serve(dir));

  /**
   * Reload onto the build that is being served, and wait to be told a new one is
   * waiting. What the reader is on while the offer is up is the answer that
   * matters, so it is read before either button is pressed.
   */
  const toldAbout = async () => {
    await boot(page, server.origin);
    const said = await page.waitFor(
      () => {
        const toast = document.getElementById('toast');
        if (!toast || toast.hidden) return false;
        const text = document.getElementById('toast-text')?.textContent ?? '';
        // Anything else on this page - "Ready", an error - is a message that
        // leaves on its own; the one that stays is the one being waited for.
        return /newer version/i.test(text) ? text : false;
      },
      { label: 'the page to say a new build is waiting', timeout: 30000 },
    );
    const kept = await buildOf(page);
    const label = await page.evaluate(
      `document.getElementById('toast-action')?.hidden === false ? document.getElementById('toast-action').textContent : null`,
    );
    return { said, kept, label };
  };

  /** Press the offer's own button, and wait for the page to be the new build. */
  const takeTheOffer = async (marker) => {
    await page.evaluate(`document.getElementById('toast-action').click()`);
    return await untilBuild(marker);
  };

  /**
   * Wait for the page to *be* the named build.
   *
   * A wait for "some build" would be answered by the build already on screen -
   * the reload that follows the button is exactly what is being waited for, and
   * the page is one build until it happens. The navigation also throws away the
   * context an evaluation runs in, halfway through it.
   */
  const untilBuild = async (marker, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await buildOf(page);
      } catch {
        last = 'navigating';
      }
      if (last === marker) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`the page came back as ${JSON.stringify(last)}, not ${JSON.stringify(marker)}`);
  };

  /** Whether a file the page is made of is still answered for, from the page. */
  const stillServed = (file) =>
    page.evaluate(`fetch(${JSON.stringify('./' + file)}).then((response) => response.ok).catch(() => false)`);

  try {
    await boot(page, server.origin);
    await page.waitFor(() => navigator.serviceWorker.controller !== null, { label: 'the first worker to take the site over' });
    await page.waitFor(async () => (await window.__kept()).shell.length > 0, { label: 'the first shell to be precached' });
    const first = await shellsOf(page);
    const firstToast = await page.evaluate(`document.getElementById('toast-text')?.textContent ?? ''`);
    check(
      'a first visit installs one shell, and is not an update',
      first.length === 1 && (await buildOf(page)) === null && !/newer version/i.test(firstToast),
      `${first[0] ?? 'no shell'} is the only one, and nothing was offered`,
    );

    // The deploy. From here the server is a different build and the browser is
    // still running the one before it.
    const second = redeploy(dir, 'second');
    const gone = await fetch(`${server.origin}/${second.was}`);
    check(
      'the deploy replaces the entry module the old shell was made of',
      !fs.existsSync(path.join(dir, second.was)) && gone.status === 404,
      `${second.was} is gone from the server (HTTP ${gone.status}), ${second.now} is there`,
    );

    // A plain reload is all a reader does, and all it takes to be told.
    const offered = await toldAbout();
    check('a reload says a newer build is ready', /newer version/i.test(offered.said), JSON.stringify(offered.said));
    check(
      'and the reader stays on the build they were reading, with a way to take it',
      offered.kept === null && offered.label === 'Reload',
      `the page is ${offered.kept} and the offer is ${JSON.stringify(offered.label)}`,
    );

    // "Not now" is an answer too: the notice goes, the build stays, and the
    // next visit is told about it again rather than left to wonder.
    await page.evaluate(`document.getElementById('toast-dismiss').click()`);
    check(
      'putting the notice down does not put the update on',
      (await page.evaluate(`document.getElementById('toast').hidden`)) && (await buildOf(page)) === null,
      'the notice is gone and the page is still the old build',
    );
    const again = await toldAbout();
    check('and the visit after that is told again', /newer version/i.test(again.said), JSON.stringify(again.said));

    check('taking it lands on the new build', (await takeTheOffer('second')) === 'second', 'the page is second');

    const after = await shellsOf(page);
    check(
      'the build before it is kept, so the files it was made of still answer',
      after.length === 2 && after.includes(first[0]) && (await stillServed(second.was)),
      `${after.length} shells kept, and ${second.was} - which the server no longer has - is still served`,
    );

    // The one after that: the same again, and the shell before last dropped.
    redeploy(dir, 'third');
    const offeredAgain = await toldAbout();
    check(
      'a second deploy is offered the same way, to the reader who took the first',
      offeredAgain.kept === 'second' && (await takeTheOffer('third')) === 'third',
      `offered while on ${offeredAgain.kept}, landed on third`,
    );

    const now = await shellsOf(page);
    check(
      'the shell before last is dropped: two builds back is nobody to answer for',
      now.length === 2 && !now.includes(first[0]) && (await stillServed(second.now)),
      `${now.length} shells, the first build ${now.includes(first[0]) ? 'still kept' : 'gone'}, ${second.now} still served`,
    );

    // And none of it costs the offline claim: the last build is a build like any
    // other, and the storage behind it is the same storage.
    await server.stop();
    await boot(page, server.origin);
    check(
      'after two updates the page still comes up with nothing to fetch it from',
      (await page.evaluate(`!!window.webpdf?.open && !!navigator.serviceWorker.controller`)) && (await buildOf(page)) === 'third',
      `${server.origin} is not answering any more`,
    );
  } finally {
    await server.stop().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    await browser.close();
  }
}

console.log(failures ? `\nPWA CHECK FAILED (${failures})` : '\nPWA CHECK PASSED');
process.exit(failures ? 1 : 0);
