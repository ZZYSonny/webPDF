/**
 * The extension, end to end: a real Chrome, the built extension loaded, and the
 * contract the extension exists for.
 *
 *   node tests/browser/extension.mjs [url] [dir]
 *
 * `url` is the server the published viewer is served from. The build is pointed
 * at it with `--remote` instead of at github.io, so what runs here is the
 * published arrangement - a viewer fetched over the network, framed cross-origin
 * by an extension page - with nothing about the network in the way. `dir` is the
 * build output the extension was staged into (`dist/ext` by default):
 * `dir/webpdf` is the extension and `dir/webpdf-<version>.crx` the artifact CI
 * uploads.
 *
 * The frame is a different site from the extension page, so under site isolation
 * it is a target of its own: everything asked of the viewer goes over CDP rather
 * than through a `contentDocument` that is not there.
 *
 * What is checked here is what cannot be checked anywhere else:
 *
 *   interception   a PDF at a URL becomes the viewer, before the reader sees
 *                  anything else - and a PDF whose URL does not end in `.pdf` is
 *                  recognised by its content type instead
 *   no welcome     the hosted page never lays out the card that offers a
 *                  document: a probe is installed in the frame *before* its first
 *                  statement and samples its first frames
 *   the memory     the position and the settings come back after the document is
 *                  opened again, and the list of remembered documents is the
 *                  hundred most recent, oldest evicted
 *   a dead worker  the redirect is a rule in the profile, so it still takes the
 *                  tab over with the service worker *stopped* - which is what
 *                  Chrome does to it after half a minute of idleness
 *   the viewer     the document is drawn by the page the build points at, and
 *                  that page asks nobody but its own origin for anything
 *   CORS           a web page cannot fetch a PDF that sends no
 *                  `Access-Control-Allow-Origin`, and the extension can - which
 *                  is the whole reason the fetching happens where it does
 *   the artifact   the crx CI uploads is signed the way Chrome signs one: this
 *                  file packs the same directory with Chromium's own
 *                  `--pack-extension` and checks that the reader here accepts it,
 *                  and that both name the same extension id
 */

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, launch } from './cdp.mjs';
import { PAPERS, cachedFile } from '../pdf-cache.mjs';
import { verifyCrx } from '../../scripts/crx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const dir = path.resolve(process.argv[3] ?? path.join(here, '..', '..', 'dist/ext'));
const extensionDir = path.join(dir, 'webpdf');

/** The paper every part of this file is written against, from the cache. */
const paper = PAPERS[0];
const file = cachedFile(paper.url);
if (!file) {
  console.error(`FAIL: ${paper.url} is not in the cache — run \`npm run pdfs\` first`);
  process.exit(1);
}
const pdfUrl = new URL(`/pdf/${path.basename(file)}`, url).href;

/** The repository, and the version the build puts in the artifact names. */
const repo = path.join(here, '..', '..');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

let failures = 0;
const started = Date.now();
const check = (label, ok, detail = '') => {
  const at = `${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${at} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------- the bare server */

/**
 * A PDF served the way most of the web serves them: the right content type, no
 * CORS headers at all. This is the server the CORS question is asked of.
 */
const bare = http.createServer((req, res) => {
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(body.length) });
  res.end(body);
});
await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
const bareOrigin = `http://127.0.0.1:${bare.address().port}`;

/* ------------------------------------------------------------ the browser */

/** Start a browser with the extension loaded, and find the extension's own id. */
async function withExtension() {
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(`${extensionDir} is not built — run \`npm run build:extension\` first`);
  }
  // Which viewer this build frames is a build-time answer, and the only one the
  // test cannot choose for itself: the rest of the flow is the same either way.
  const staged = JSON.parse(fs.readFileSync(path.join(extensionDir, 'viewer.json'), 'utf8'));
  if (!staged.app.startsWith(url)) {
    throw new Error(
      `this build frames ${staged.app}, not this server — build it with \`node scripts/build-extension.mjs --remote ${url}\``,
    );
  }
  const browser = await launch({
    extensions: [extensionDir],
    // Nothing is resolvable but the loopback address the test server is on: an
    // extension that reached for a CDN would fail here rather than quietly pass.
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  let id = null;
  for (let i = 0; i < 80 && !id; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    const worker = targets.find((target) => /^service_worker chrome-extension:\/\/[a-p]+\/background\.js$/.test(`${target.type} ${target.url}`));
    if (worker) id = new URL(worker.url).host;
    else await sleep(150);
  }
  if (!id) {
    await browser.close();
    throw new Error('the extension never started its worker');
  }
  // The rule that redirects `.pdf` navigations is written by the worker, a moment
  // after it comes up. A real reader cannot open a PDF in that moment; the test
  // asks the worker whether it is done rather than pretending it cannot happen.
  const workerId = await waitForRule(browser);
  return { browser, id, workerId, viewer: staged.app };
}

/** The worker's own rules: is the redirect in place yet? */
async function waitForRule(browser) {
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const worker = list.find((target) => target.url.endsWith('/background.js'));
  if (!worker) throw new Error('no service worker to ask');
  const socket = new WebSocket(worker.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  for (let i = 0; i < 60; i++) {
    const answer = await send('Runtime.evaluate', {
      expression: 'chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.length)',
      awaitPromise: true,
      returnByValue: true,
    });
    if ((answer.result?.result?.value ?? 0) > 0) {
      socket.close();
      return worker.id;
    }
    await sleep(100);
  }
  throw new Error('the redirect rule was never installed');
}

/**
 * The frame the viewer runs in.
 *
 * The extension page and the published viewer are different sites, so the frame
 * is its own target and this is the only way to ask it anything. Callers keep one
 * viewer tab alive at a time, because every frame on this server has the same URL
 * - the document travels to the frame as a message, not as a location.
 */
async function frameTarget(browser) {
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const frames = targets.filter((target) => target.type === 'iframe' && target.url.startsWith(url));
  if (frames.length > 1) throw new Error(`${frames.length} viewer frames are open — close all but one before asking`);
  if (!frames.length) throw new Error(`no frame at ${url}`);
  return await attach(frames[0].webSocketDebuggerUrl);
}

/** Ask the viewer's frame something. The frame is recreated with every tab load. */
async function inFrame(browser, expression, { tries = 4 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const frame = await frameTarget(browser).catch((error) => {
      last = error;
      return null;
    });
    if (frame) {
      try {
        return await frame.evaluate(expression);
      } catch (error) {
        last = error;
      } finally {
        await frame.close();
      }
    }
    await sleep(250);
  }
  throw last ?? new Error('the viewer frame never answered');
}

/** The same, waiting for the frame to say something true. */
async function waitInFrame(browser, predicate, { label, timeout = 60000 } = {}) {
  const source = `(${predicate.toString()})()`;
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await inFrame(browser, source, { tries: 1 });
      if (last) return last;
    } catch (error) {
      last = `error: ${error.message}`;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

/**
 * The probe, and how it gets in before the page does.
 *
 * `Page.addScriptToEvaluateOnNewDocument` on the extension page does not reach a
 * cross-origin frame, so the frame is caught as it is created:
 * `Target.setAutoAttach` with `waitForDebuggerOnStart` pauses every new target at
 * its first statement, which is where the probe is added and the target let go.
 * The frame arrives with no URL yet - it is attached before its navigation starts
 * - so the type is the only thing to go on. Workers are let go without a probe:
 * the viewer runs its engine in one.
 */
const PROBE = `(() => {
  window.__frames = [];
  const tick = () => {
    const card = document.querySelector('#empty');
    window.__frames.push({
      host: document.documentElement.classList.contains('wpdf-host'),
      display: card ? getComputedStyle(card).display : 'absent',
      text: (document.body?.innerText ?? '').trim().slice(0, 20),
    });
    if (window.__frames.length < 3) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function probeTheFrame(page) {
  await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  page.on('Target.attachedToTarget', ({ sessionId, targetInfo, waitingForDebugger }) => {
    void (async () => {
      if (targetInfo.type === 'iframe') {
        await page.send('Page.enable', {}, sessionId).catch(() => {});
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE }, sessionId).catch(() => {});
      }
      if (waitingForDebugger) await page.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    })();
  });
}

/**
 * Open a URL and wait until the viewer has a page on screen.
 *
 * "A page is on screen" is the viewer's own answer to it - and deliberately not
 * "page one is on screen", because a document that was read before opens
 * somewhere in the middle.
 */
async function openPdf(browser, page, target) {
  await page.goto(target);
  await page.waitFor(
    () => location.protocol === 'chrome-extension:' && (document.getElementById('app')?.src ?? '').startsWith('http'),
    { label: 'the viewer tab', timeout: 60000 },
  );
  return await waitInFrame(
    browser,
    () => {
      const viewer = window.webpdf?.viewer?.();
      return (viewer?.preparedPages.length ?? 0) > 0 && !!viewer?.pageElement(viewer.preparedPages[0]);
    },
    { label: 'the viewer to draw a page' },
  );
}

fs.mkdirSync(path.join(here, 'out'), { recursive: true });

try {
  /* ---------------------------------------------------------- the extension */

  const { browser, id, workerId, viewer } = await withExtension();
  console.log(`\n› extension ${id} — the viewer is ${viewer}`);
  const page = await browser.newPage();
  await page.setViewport(1280, 900);
  await probeTheFrame(page);

  await openPdf(browser, page, pdfUrl);
  const shell = await page.evaluate(() => ({
    href: location.href,
    note: document.getElementById('note').hidden,
    text: document.body.innerText.trim(),
    frame: document.getElementById('app').src,
  }));
  check('a PDF URL opens the viewer', shell.href.startsWith(`chrome-extension://${id}/viewer.html`), shell.href.slice(0, 60));
  check('the viewer is framed as a hosted page', shell.frame.startsWith(viewer) && shell.frame.includes('host=1'), shell.frame);
  check('the extension page itself shows nothing', shell.text === '' && shell.note === true, JSON.stringify(shell.text.slice(0, 40)));

  /**
   * What the hosted page looked like while it was still being parsed: the card
   * that offers a document must never have been laid out, and the body must not
   * have carried its text even for one frame.
   */
  const firstFrames = await inFrame(browser, () => window.__frames ?? null);
  check(
    'no welcome card at the first frame',
    Array.isArray(firstFrames) && firstFrames.length >= 2 && firstFrames.every((f) => f.host && f.display === 'none' && f.text === ''),
    JSON.stringify(firstFrames),
  );

  const drawn = await inFrame(browser, () => {
    const viewer = window.webpdf.viewer();
    const svg = viewer.pageElement(1);
    return { pages: viewer.pageCount, text: svg ? svg.querySelectorAll('text').length : 0, place: viewer.place() };
  });
  check('the document is rendered with real text', drawn.pages > 1 && drawn.text > 0, `${drawn.pages} pages, ${drawn.text} text runs on page 1`);
  check('it opens at the first page', drawn.place.page === 1 && drawn.place.y === null, JSON.stringify(drawn.place));

  /* ------------------------------------------------- where the viewer came from */

  // It is the page the build points at that draws the document - not a second
  // copy inside the extension - and that page asks nobody but its own origin for
  // anything: the document is handed to it as bytes, so it never fetches the PDF
  // itself and there is no CDN, no font host and no analytics in the path.
  check('the viewer really is the page the build points at', (await inFrame(browser, () => location.origin)) === new URL(viewer).origin, viewer);
  const fetched = await inFrame(browser, () => performance.getEntriesByType('resource').map((entry) => entry.name));
  const elsewhere = fetched.filter((name) => !name.startsWith(viewer) && !/^(data|blob):/.test(name));
  check(
    'and it asks nobody else for anything',
    elsewhere.length === 0,
    `${fetched.length} resources, ${elsewhere.length} elsewhere${elsewhere.length ? `: ${elsewhere.slice(0, 3)}` : ''}`,
  );

  /* ---------------------------------------------------------- the memory */

  // Somewhere in the middle of page 5, at 150% and with bionic reading on: three
  // settings and a position, all of which have to survive.
  await inFrame(
    browser,
    `(() => {
      const viewer = window.webpdf.viewer();
      viewer.setZoom(1.5);
      viewer.setBionic(true, 0.4);
      viewer.setCrop(['page-number'], 6);
      viewer.goToDestination(5, 200);
    })()`,
  );
  await sleep(1600); // the frame reports in 400 ms, the page writes it 700 ms later
  const remembered = await page.evaluate(async () => {
    const stored = await chrome.storage.local.get(null);
    const entry = (stored.history ?? [])[0];
    return entry ? { key: entry.key, name: entry.name, pages: entry.pages, pos: entry.pos, settings: entry.settings, opens: entry.opens } : null;
  });
  check(
    'what the reader did is written down',
    remembered?.pos?.page === 5 && remembered.settings?.zoom?.level === 1.5 && remembered.settings?.bionic?.on === true && remembered.settings?.crop?.rules.join() === 'page-number',
    JSON.stringify(remembered),
  );

  // Open it again, the way a reader would: same URL, new tab load.
  await openPdf(browser, page, pdfUrl);
  const restored = await inFrame(browser, () => {
    const viewer = window.webpdf.viewer();
    return { page: viewer.place().page, y: viewer.place().y, zoom: viewer.zoom, bionic: viewer.bionic, dim: viewer.bionicDim, crop: [...viewer.crop], padding: viewer.cropPadding };
  });
  check('the position comes back', restored.page === 5 && Math.abs((restored.y ?? 0) - 200) < 6, JSON.stringify({ page: restored.page, y: restored.y }));
  check('so do the settings', restored.zoom === 1.5 && restored.bionic === true && restored.dim === 0.4 && restored.crop.join() === 'page-number' && restored.padding === 6, JSON.stringify(restored));

  /* ------------------------------------------------------- the hundred */

  // Last, and after a pause: a page that has just been read is still reporting
  // where it is, and a report landing in the middle of this would be a document
  // touched more recently than the hundred below.
  await sleep(2000);
  const hundred = await page.evaluate(async () => {
    const url = (i) => `https://example.invalid/paper-${i}.pdf`;
    for (let i = 0; i < 105; i++) {
      await chrome.runtime.sendMessage({ type: 'remember', key: `url:${url(i)}`, url: url(i), name: `paper-${i}.pdf`, title: `Paper ${i}`, pages: 12 });
    }
    const listed = await chrome.runtime.sendMessage({ type: 'list' });
    const before = listed.entries.length;
    // Moving inside a document must not look like opening it again, and must not
    // throw away what the open said.
    await chrome.runtime.sendMessage({ type: 'state', key: `url:${url(50)}`, state: { pos: { page: 7, y: 42 }, settings: { zoom: { level: 2, mode: 'custom' } } } });
    const after = await chrome.runtime.sendMessage({ type: 'list' });
    const moved = after.entries[0];
    return {
      before,
      after: after.entries.length,
      first: after.entries[0].key,
      last: after.entries[after.entries.length - 1].key,
      hasOldest: after.entries.some((e) => e.key === `url:${url(0)}`),
      moved: { key: moved.key, title: moved.title, opens: moved.opens, pos: moved.pos },
    };
  });
  check('exactly a hundred documents are remembered', hundred.before === 100 && hundred.after === 100, `${hundred.before} → ${hundred.after}`);
  check('the oldest fall off the end', hundred.hasOldest === false && hundred.last === 'url:https://example.invalid/paper-5.pdf', hundred.last);
  check('remembering one again moves it to the front', hundred.first === 'url:https://example.invalid/paper-50.pdf', hundred.first);
  check('and a move is not an open', hundred.moved.title === 'Paper 50' && hundred.moved.opens === 1 && hundred.moved.pos.page === 7, JSON.stringify(hundred.moved));

  /* ------------------------------------------------- a worker that is gone */

  // Chrome stops an idle service worker; the redirect has to be a rule the
  // browser keeps, not something the worker holds. Stopping it here is the same
  // thing made deterministic - a page that is still reading keeps sending its
  // position, though, and every one of those messages wakes the worker again,
  // so the pages are quietened first.
  await page.goto('about:blank');
  const workers = async () => (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()).filter((target) => target.url.endsWith('/background.js'));
  for (let i = 0; i < 6 && (await workers()).length > 0; i++) {
    for (const running of await workers()) await fetch(`http://127.0.0.1:${browser.port}/json/close/${running.id}`);
    await sleep(600);
  }
  check('the worker can be stopped', (await workers()).length === 0, `${(await workers()).length} workers running`);

  const cold = await browser.newPage();
  await cold.setViewport(1280, 900);
  await cold.goto(pdfUrl);
  const coldState = await cold
    .waitFor(() => (location.protocol === 'chrome-extension:' ? location.href : ''), { label: 'the redirect with no worker', timeout: 20000 })
    .then((href) => ({ href }))
    .catch((error) => ({ href: '', error: String(error.message) }));
  check('a PDF opened with no worker still becomes the viewer', coldState.href.startsWith(`chrome-extension://${id}/viewer.html`), coldState.href.slice(0, 50));
  const coldDrawn = await waitInFrame(
    browser,
    () => window.webpdf?.viewer?.()?.pageCount ?? 0,
    { label: 'the document, drawn by a worker that had to be woken' },
  ).catch(async () => await cold.evaluate(() => document.getElementById('note-text')?.textContent ?? ''));
  check('and the worker comes back to fetch it', typeof coldDrawn === 'number' && coldDrawn > 1, String(coldDrawn));
  await cold.close();

  /* ------------------------------------------------------------- CORS */

  // The page the extension is *not*: an ordinary web page on the same server the
  // viewer came from, asking for the same PDF.
  const plain = `${bareOrigin}/plain`;
  const web = await browser.newPage();
  await web.goto(url);
  const pageFetch = await web.evaluate(`(async () => {
    try {
      const res = await fetch(${JSON.stringify(plain)});
      return { ok: true, status: res.status };
    } catch (error) {
      return { ok: false, message: String(error.message) };
    }
  })()`);
  check('a web page cannot fetch a PDF that sends no CORS headers', pageFetch.ok === false, String(pageFetch.message ?? pageFetch.status));
  await web.close();

  // And the extension, on the same URL, with no `.pdf` in it anywhere: the
  // content type is what says it is a document.
  const intercepted = await browser.newPage();
  await intercepted.setViewport(1280, 900);
  await openPdf(browser, intercepted, plain);
  const throughType = await inFrame(browser, () => {
    const viewer = window.webpdf.viewer();
    return { pages: viewer.pageCount, text: viewer.pageElement(1).querySelectorAll('text').length };
  });
  check('the extension opens it anyway, recognised by content type', throughType.pages > 1 && throughType.text > 0, JSON.stringify(throughType));

  await intercepted.screenshot(path.join(here, 'out', 'extension.png'));
  await browser.close();

  /* ------------------------------------------------------- the artifact */

  // What CI uploads: the crx has to be signed the way Chrome signs one. The
  // strongest check available is Chromium's own packer - if the reader here
  // accepts the file Chrome wrote, then the file this repository writes is in
  // Chrome's format and not merely in its own.
  const crxFile = path.join(dir, `webpdf-${version}.crx`);
  if (!fs.existsSync(crxFile)) {
    check('the crx CI uploads exists', false, crxFile);
  } else {
    const ours = verifyCrx(fs.readFileSync(crxFile));
    check('the crx is signed over its own contents', ours.ok === true, crxFile);
    check('and names the extension it was built from', ours.extensionId === id, `${ours.extensionId} vs ${id} loaded`);

    // What that archive is, is the zip the build wrote, byte for byte: the crx
    // is the staged directory and not a re-packed copy of it.
    check('the crx carries the archive the build wrote', ours.zip.equals(fs.readFileSync(crxFile.replace(/\.crx$/, '.zip'))), `${ours.zip.length} bytes`);

    // And the format itself, checked against the one program that decides it:
    // Chromium's own packer writes its own archive, so what is compared here is
    // the header and the signature over it - if the reader understands the file
    // Chrome wrote, then Chrome's format is what this file is in.
    const packedDir = path.join(here, 'out', 'packed');
    fs.rmSync(packedDir, { recursive: true, force: true });
    fs.rmSync(`${packedDir}.crx`, { force: true });
    fs.rmSync(`${packedDir}.pem`, { force: true });
    fs.mkdirSync(path.dirname(packedDir), { recursive: true });
    fs.cpSync(extensionDir, packedDir, { recursive: true });
    const chromium = process.env.CHROMIUM || '/usr/bin/chromium';
    try {
      execFileSync(chromium, [`--pack-extension=${packedDir}`, '--no-message-box'], { stdio: 'ignore' });
      const theirs = verifyCrx(fs.readFileSync(`${packedDir}.crx`));
      check('the reader here understands Chromium\'s own crx', theirs.ok === true, `id ${theirs.extensionId}, version ${theirs.version}`);
    } catch (error) {
      check('Chromium could pack the same directory', false, String(error.message).slice(0, 120));
    }
  }
} catch (error) {
  failures++;
  console.error(`FAIL: ${String(error?.stack ?? error)}`);
} finally {
  bare.close();
}

console.log(failures ? `\nEXTENSION CHECK FAILED (${failures})` : '\nEXTENSION CHECK PASSED');
process.exit(failures ? 1 : 0);
