/**
 * The extension, end to end: a real Chrome, the built extension loaded, and the
 * contract the extension exists for.
 *
 *   node tests/browser/extension.ts [url] [dir]
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
 *   the memory     where the reader was comes back after the document is opened
 *                  again - written by the viewer into its own storage, with the
 *                  extension holding none of it (the hundred-document cap is
 *                  `tests/memory.test.ts`, in Node)
 *   the keyboard   the frame is given the keys, so the viewer's own find and zoom
 *                  work with nothing relayed, and Ctrl+S writes the bytes the
 *                  viewer is holding
 *   a dead worker  the redirect is a rule in the profile, so it still takes the
 *                  tab over with the service worker *stopped* - which is what
 *                  Chrome does to it after half a minute of idleness
 *   the viewer     the document is drawn by the page the build points at, and
 *                  that page asks nobody but its own origin for anything
 *   CORS           a web page cannot fetch a PDF that sends no
 *                  `Access-Control-Allow-Origin`, and the extension can - which
 *                  is the whole reason the fetching happens where it does
 *   versions       an installed extension meets a redeployed viewer, so the
 *                  bridge is versioned: a viewer that still serves this
 *                  extension's revision draws the document, and one that does
 *                  not is reported to the reader rather than left blank
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
import type { AddressInfo } from 'node:net';

import { attach, launch } from './cdp.ts';
import { PAPERS, cachedFile } from '../pdf-cache.ts';
import { verifyCrx } from '../../scripts/crx.ts';
import type { Browser, Page } from './cdp.ts';
import type { PdfViewer } from '../../demo/viewer.ts';

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
const version: string = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

let failures = 0;
const started = Date.now();
const check = (label: string, ok: boolean, detail: string = ''): void => {
  const at = `${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${at} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* --------------------------------------------------------- the bare server */

/**
 * What the web serves: a PDF the way most of the web serves them - the right
 * content type, no CORS headers at all - and a stub viewer, which is what a
 * *future* published page looks like to *this* extension. Which of the two is
 * answered depends on the path.
 */
const bare = http.createServer((req, res) => {
  if (new URL(req.url ?? '/', 'http://x').pathname === '/viewer') {
    const body = Buffer.from(STUB_VIEWER);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(body.length) });
  res.end(body);
});
await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', () => resolve()));
const bareOrigin = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;

/**
 * A viewer from the future, as far as this extension is concerned.
 *
 * It speaks a later bridge revision, and it says which host revisions it serves -
 * whether it still serves revision 1 is the whole question this stub exists to
 * ask, and the answer is in its URL. It draws nothing: it reports what a viewer
 * with a document on screen reports, which is all the extension needs to know
 * that the handover arrived, and it records what the extension said about itself.
 */
const STUB_VIEWER = `<!doctype html>
<meta charset="utf-8">
<title>stub viewer</title>
<script>
  const query = new URLSearchParams(location.search);
  const bridge = Number(query.get('bridge') ?? 1);
  const accepts = (query.get('accepts') ?? '1').split(',').filter(Boolean).map(Number);
  window.__ready = null;
  window.__handed = 0;
  addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.wpdf !== 'host') return;
    if (message.kind === 'ready') window.__ready = message.bridge;
    if (message.kind === 'open') {
      const doc = message.doc ?? {};
      window.__handed = doc.bytes ? doc.bytes.byteLength : 0;
      parent.postMessage({ wpdf: 'host', kind: 'opened', info: { title: 'stub viewer', pages: 3, author: '' }, name: doc.name ?? 'document', size: doc.size ?? 0 }, '*');
    }
  });
  parent.postMessage({ wpdf: 'host', kind: 'hello', bridge, accepts }, '*');
</script>`;

/* ------------------------------------------------------------ the browser */

/** One row of Chromium's own `/json/list`: a tab, a frame, or a worker. */
interface TargetListItem {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Start a browser with the extension loaded, and find the extension's own id. */
async function withExtension(
  { where = extensionDir, expectApp = url }: { where?: string; expectApp?: string | null } = {},
): Promise<{ browser: Browser; id: string; workerId: string; viewer: string }> {
  if (!fs.existsSync(path.join(where, 'manifest.json'))) {
    throw new Error(`${where} is not built — run \`npm run build:extension\` first`);
  }
  // Which viewer this build frames is a build-time answer, and the only one the
  // test cannot choose for itself: the rest of the flow is the same either way.
  const staged = JSON.parse(fs.readFileSync(path.join(where, 'viewer.json'), 'utf8')) as { app: string };
  if (expectApp && !staged.app.startsWith(expectApp)) {
    throw new Error(
      `this build frames ${staged.app}, not this server — build it with \`node scripts/build-extension.ts --remote ${url}\``,
    );
  }
  const browser = await launch({
    extensions: [where],
    // Nothing is resolvable but the loopback address the test server is on: an
    // extension that reached for a CDN would fail here rather than quietly pass.
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  let id: string | null = null;
  for (let i = 0; i < 80 && !id; i++) {
    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as TargetListItem[];
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

/** A CDP reply, as far as this file reads one: the value `Runtime.evaluate` brought back. */
interface CdpReply {
  id?: number;
  result?: { result?: { value?: number } };
}

/** The worker's own rules: is the redirect in place yet? */
async function waitForRule(browser: Browser): Promise<string> {
  const list = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as TargetListItem[];
  const worker = list.find((target) => target.url.endsWith('/background.js'));
  if (!worker) throw new Error('no service worker to ask');
  const socket = new WebSocket(worker.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let next = 0;
  const pending = new Map<number, (reply: CdpReply) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data) as CdpReply;
    if (message.id && pending.has(message.id)) pending.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpReply> =>
    new Promise<CdpReply>((resolve) => {
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
async function frameTarget(browser: Browser, prefix: string = url): Promise<Page> {
  const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as TargetListItem[];
  const frames = targets.filter((target) => target.type === 'iframe' && target.url.startsWith(prefix));
  if (frames.length > 1) throw new Error(`${frames.length} frames at ${prefix} are open — close all but one before asking`);
  if (!frames.length) throw new Error(`no frame at ${prefix}`);
  return await attach(frames[0].webSocketDebuggerUrl);
}

/** How `inFrame` retries, and which frame it asks. */
interface InFrameOptions {
  tries?: number;
  prefix?: string;
}

/** Ask the viewer's frame something. The frame is recreated with every tab load. */
async function inFrame<T = unknown>(
  browser: Browser,
  expression: (() => T) | string,
  { tries = 4, prefix = url }: InFrameOptions = {},
): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    const frame = await frameTarget(browser, prefix).catch((error: unknown) => {
      last = error;
      return null;
    });
    if (frame) {
      try {
        return await frame.evaluate<T>(expression);
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

/** How `waitInFrame` waits, and which frame it asks. */
interface WaitInFrameOptions {
  label?: string;
  timeout?: number;
  prefix?: string;
}

/** The same, waiting for the frame to say something true. */
async function waitInFrame<T>(
  browser: Browser,
  predicate: () => T,
  { label, timeout = 60000, prefix = url }: WaitInFrameOptions = {},
): Promise<T> {
  const source = `(${predicate.toString()})()`;
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      last = await inFrame(browser, source, { tries: 1, prefix });
      if (last) return last as T;
    } catch (error) {
      last = `error: ${(error as Error).message}`;
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

/**
 * What the two scripts above put on the page's own `window`. None of it belongs
 * to the viewer: `STUB_VIEWER` reports the bridge it was handed, and `PROBE`
 * records the frames it sampled, so both are declared here rather than anywhere
 * the page could see them.
 */
declare global {
  interface Window {
    /** The bridge the stub viewer was handed by the host, or null before hello. */
    __ready: number | null;
    /** How many bytes the host handed over, as the stub viewer counted them. */
    __handed: number;
    /** What the probe sampled over the page's first animation frames. */
    __frames: FirstFrame[];
  }
}

/** One sample the probe took: what the host page looked like on one frame. */
interface FirstFrame {
  host: boolean;
  display: string;
  text: string;
}

/** The `Target.attachedToTarget` event, as far as this file reads it. */
interface AttachedToTarget {
  sessionId: string;
  targetInfo: { type: string };
  waitingForDebugger: boolean;
}

/**
 * The page's `send` with the session of an attached frame: `Target.setAutoAttach`
 * with `flatten` delivers frame traffic on a session id, which is the third
 * argument the `Page` type does not name.
 */
type SessionSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;

async function probeTheFrame(page: Page): Promise<void> {
  await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  page.on('Target.attachedToTarget', ({ sessionId, targetInfo, waitingForDebugger }: AttachedToTarget) => {
    void (async () => {
      if (targetInfo.type === 'iframe') {
        await (page.send as SessionSend)('Page.enable', {}, sessionId).catch(() => {});
        await (page.send as SessionSend)('Page.addScriptToEvaluateOnNewDocument', { source: PROBE }, sessionId).catch(() => {});
      }
      if (waitingForDebugger) await (page.send as SessionSend)('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
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
async function openPdf(browser: Browser, page: Page, target: string): Promise<boolean> {
  await page.goto(target);
  await page.waitFor(
    () =>
      location.protocol === 'chrome-extension:' &&
      ((document.getElementById('app') as HTMLIFrameElement | null)?.src ?? '').startsWith('http'),
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

/** The extension page's own answer to a key press: what it focused, and whether it has focus. */
interface KeyPressState {
  focused: string;
  hasFocus: boolean;
}

/**
 * Press Ctrl+<key> in the frame, through the browser's own input pipeline.
 *
 * That is the whole point of doing it this way: the key lands wherever the focus
 * is. If the extension page still had it, the viewer's handlers would never see
 * the key - so these presses are also what checks that the frame was given the
 * keyboard.
 */
async function pressInFrame<Probe extends object = object>(
  browser: Browser,
  key: string,
  probe: string | null = null,
): Promise<KeyPressState & Probe> {
  const frame = await frameTarget(browser);
  try {
    for (const type of ['keyDown', 'keyUp']) {
      await frame.send('Input.dispatchKeyEvent', {
        type,
        modifiers: 2, // ctrl
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
        nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      });
    }
    await sleep(300);
    const state = await frame.evaluate(() => ({ focused: document.activeElement?.id ?? '', hasFocus: document.hasFocus() }));
    // Whatever the key set in motion is read in the same frame, before the
    // target is closed: an expression string is evaluated as it is.
    return probe ? { ...state, ...(await frame.evaluate<Probe>(probe)) } : (state as KeyPressState & Probe);
  } finally {
    await frame.close();
  }
}

/** Wait for a download to land, and be the size it is going to be. */
async function waitForFile(dir: string, seconds: number): Promise<{ name: string; size: number } | null> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const name = fs.readdirSync(dir).find((each) => !each.endsWith('.crdownload'));
    if (name) {
      const full = path.join(dir, name);
      const size = fs.statSync(full).size;
      await sleep(200);
      if (size > 0 && fs.statSync(full).size === size) return { name, size };
    }
    await sleep(250);
  }
  return null;
}

/**
 * A copy of the staged extension pointed at `app` instead of the published
 * viewer.
 *
 * `viewer.json` is read at start-up, so one file is the whole difference between
 * this build and a build of a page that does not exist yet - which is how a
 * *future* viewer is put in front of *this* extension.
 */
function pointedAt(app: string, name: string): string {
  const into = path.join(here, 'out', `stub-${name}`);
  fs.rmSync(into, { recursive: true, force: true });
  fs.cpSync(extensionDir, into, { recursive: true });
  fs.writeFileSync(path.join(into, 'viewer.json'), `${JSON.stringify({ app, version }, null, 2)}\n`);
  return into;
}

fs.mkdirSync(path.join(here, 'out'), { recursive: true });

/** A remembered place, as the viewer wrote it into its own storage. */
interface RememberedPlace {
  key: string;
  pos: { page: number; y: number | null };
  settings: {
    zoom?: { level: number };
    bionic?: { on: boolean };
    crop?: { patterns: string[] };
  };
  keys: number;
}

/** What an ordinary web page's `fetch` of the PDF came back with. */
interface PageFetchResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/** What the print probe reports back: the blob the viewer handed the printer. */
interface PrintedDocument {
  printed: boolean;
  type: string | null;
  size: number;
  magic: string;
}

/** The frame's debug handle, as it exists once the demo page has booted there. */
type ViewerHandle = NonNullable<Window['webpdf']>;

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
    note: (document.getElementById('note') as HTMLElement).hidden,
    text: document.body.innerText.trim(),
    frame: (document.getElementById('app') as HTMLIFrameElement).src,
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
    const viewer = (window.webpdf as ViewerHandle).viewer() as PdfViewer;
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
      viewer.setCrop(['^[0-9]+$'], 6);
      viewer.goToDestination(5, 200);
    })()`,
  );
  await sleep(1200); // the page waits out the burst before it writes: 400 ms
  const remembered = await inFrame<RememberedPlace | null>(
    browser,
    `(() => {
      const memory = JSON.parse(localStorage.getItem('webpdf.memory') ?? '{}');
      const entry = Object.entries(memory).find(([key]) => key.includes('1706.03762v7'))?.[1] ?? null;
      return entry && { key: Object.keys(memory)[0], pos: entry.pos, settings: entry.settings, keys: Object.keys(memory).length };
    })()`,
  );
  check(
    'the viewer writes the reader\'s place into its own memory',
    remembered?.pos?.page === 5 && remembered?.settings?.zoom?.level === 1.5 && remembered?.settings?.bionic?.on === true && remembered?.settings?.crop?.patterns.join() === '^[0-9]+$',
    JSON.stringify(remembered),
  );

  // And the extension knows nothing about it: the whole point of the memory being
  // the viewer's is that the extension is a pipe. Two keys, both of them the
  // extension's own business - the handover token and the last URL for the button.
  const kept = await page.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).sort());
  check('and the extension stores no memory of the reader', kept.every((key) => key === 'token' || key === 'last'), JSON.stringify(kept));

  // Open it again, the way a reader would: same URL, new tab load.
  await openPdf(browser, page, pdfUrl);
  const restored = await inFrame(browser, () => {
    const viewer = (window.webpdf as ViewerHandle).viewer() as PdfViewer;
    return { page: viewer.place().page, y: viewer.place().y, zoom: viewer.zoom, bionic: viewer.bionic, dim: viewer.bionicDim, crop: [...viewer.crop], padding: viewer.cropPadding };
  });
  check('the position comes back', restored.page === 5 && Math.abs((restored.y ?? 0) - 200) < 6, JSON.stringify({ page: restored.page, y: restored.y }));
  check('so do the settings', restored.zoom === 1.5 && restored.bionic === true && restored.dim === 0.4 && restored.crop.join() === '^[0-9]+$' && restored.padding === 6, JSON.stringify(restored));

  /* ------------------------------------------------- the keys and the save */

  // The viewer owns the keyboard, and this page hands it over: the frame is
  // focused as soon as it is up, so Ctrl+F, Ctrl+O and the zoom keys are the
  // viewer's own handlers with no relay in between - and Ctrl+S writes the bytes
  // the frame is holding, rather than a second request for a file the reader
  // already has.
  // The extension page hands the keyboard over rather than relaying it: the frame
  // element is what it has focused, and the presses below are what proves the keys
  // land in the viewer. (`document.hasFocus()` in the frame is not usable here: a
  // headless browser window is never "active", whatever a frame believes.)
  const shellFocus = await page.evaluate(() => document.activeElement?.id ?? '');
  check('the extension page hands the keyboard to the frame', shellFocus === 'app', `extension page focused on: ${shellFocus || 'nothing'}`);

  const search = await pressInFrame(browser, 'f');
  check("Ctrl+F reaches the viewer's own find, not the browser's", search?.focused === 'search', JSON.stringify(search));

  // A real download, into a directory this test owns: the name it is written
  // under is the document's own, and its size is the size of the paper.
  const downloads = path.join(here, 'out', 'downloads');
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.mkdirSync(downloads, { recursive: true });
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await pressInFrame(browser, 's');
  const saved = await waitForFile(downloads, 20);
  check(
    'Ctrl+S saves the document the viewer was handed',
    saved?.name === path.basename(file) && saved?.size === fs.statSync(file).size,
    JSON.stringify(saved),
  );

  // Ctrl+P is the same document, handed to the printer rather than to the disk.
  // What is in the print frame has to be the bytes this page was handed, to the
  // byte - not the SVG pages the viewer drew from them, which is what the
  // browser would print if the page let the key through.
  const printed = await pressInFrame<PrintedDocument>(
    browser,
    'p',
    `(async () => {
      const deadline = Date.now() + 20000;
      let frame = null;
      while (Date.now() < deadline) {
        frame = document.getElementById('print');
        if (frame && frame.src.startsWith('blob:')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!frame || !frame.src.startsWith('blob:')) return { printed: false };
      const res = await fetch(frame.src);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        printed: true,
        type: res.headers.get('content-type'),
        size: bytes.length,
        magic: String.fromCharCode(...bytes.slice(0, 5)),
      };
    })()`,
  );
  check(
    'Ctrl+P hands the printer the document, not the drawing of it',
    printed?.printed === true &&
      printed.type === 'application/pdf' &&
      printed.magic === '%PDF-' &&
      printed.size === fs.statSync(file).size,
    JSON.stringify(printed),
  );

  /* ------------------------------------------------- a worker that is gone */

  // Chrome stops an idle service worker; the redirect has to be a rule the
  // browser keeps, not something the worker holds. Stopping it here is the same
  // thing made deterministic - a page that is still reading keeps sending its
  // position, though, and every one of those messages wakes the worker again,
  // so the pages are quietened first.
  await page.goto('about:blank');
  const workers = async () =>
    ((await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as TargetListItem[]).filter((target) =>
      target.url.endsWith('/background.js'),
    );
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
  const pageFetch = await web.evaluate<PageFetchResult>(`(async () => {
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
    const viewer = (window.webpdf as ViewerHandle).viewer() as PdfViewer;
    return { pages: viewer.pageCount, text: (viewer.pageElement(1) as Element).querySelectorAll('text').length };
  });
  check('the extension opens it anyway, recognised by content type', throughType.pages > 1 && throughType.text > 0, JSON.stringify(throughType));

  await intercepted.screenshot(path.join(here, 'out', 'extension.png'));
  await browser.close();

  /* ------------------------------------------- a viewer that moved on */

  // The extension is installed once and the viewer is redeployed whenever the
  // repository is, so "old extension, new viewer" is the ordinary case rather
  // than an edge one - and the promise that makes it safe is the bridge revision
  // in `hello`. Two stub viewers stand in for a future published page: one that
  // has moved on but still serves revision 1, and one that no longer does. What
  // this extension must do is draw the document for the first and say it is out
  // of date for the second - never sit on a tab that draws nothing.
  const compatible = `${bareOrigin}/viewer?bridge=9&accepts=1`;
  const abandoned = `${bareOrigin}/viewer?bridge=9&accepts=9`;

  const moved = await withExtension({ where: pointedAt(compatible, 'compatible'), expectApp: null });
  const movedPage = await moved.browser.newPage();
  await movedPage.setViewport(1280, 900);
  await movedPage.goto(pdfUrl);
  const openedThere = await movedPage
    .waitFor(() => (document.title === 'stub viewer' ? document.title : ''), { label: 'the newer viewer to report the document', timeout: 30000 })
    .catch(async () => await movedPage.evaluate(() => document.getElementById('note-title')?.textContent ?? ''));
  check('a newer viewer that still serves revision 1 draws the document', openedThere === 'stub viewer', openedThere);
  const said = await inFrame(moved.browser, () => ({ ready: window.__ready ?? null, handed: window.__handed ?? 0 }), { prefix: bareOrigin }).catch(() => null);
  check(
    'and the bytes arrive, with the revision this extension speaks',
    said?.ready === 1 && said?.handed === fs.statSync(file).size,
    JSON.stringify(said),
  );
  await moved.browser.close();

  const gone = await withExtension({ where: pointedAt(abandoned, 'abandoned'), expectApp: null });
  const gonePage = await gone.browser.newPage();
  await gonePage.setViewport(1280, 900);
  await gonePage.goto(pdfUrl);
  const card = await gonePage
    .waitFor(() => (document.getElementById('note')?.hidden === false ? ((document.getElementById('note-title') as HTMLElement).textContent ?? '') : ''), {
      label: 'the extension to admit it is out of date',
      timeout: 30000,
    })
    .catch(async () => await gonePage.evaluate(() => document.getElementById('note-title')?.textContent ?? ''));
  check('a viewer that no longer serves it is reported, not left blank', /out of date/i.test(card), card);
  const nothing = await inFrame(gone.browser, () => window.__handed ?? 0, { prefix: bareOrigin, tries: 2 }).catch(() => null);
  check('and no document is handed to a viewer that would not draw it', nothing === 0, String(nothing));
  await gone.browser.close();

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
      check('Chromium could pack the same directory', false, String((error as Error).message).slice(0, 120));
    }
  }
} catch (error) {
  failures++;
  console.error(`FAIL: ${String((error as Error)?.stack ?? error)}`);
} finally {
  bare.close();
}

console.log(failures ? `\nEXTENSION CHECK FAILED (${failures})` : '\nEXTENSION CHECK PASSED');
process.exit(failures ? 1 : 0);
