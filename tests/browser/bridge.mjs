/**
 * The host bridge, from the page's side: what happens when the host is older.
 *
 *   node tests/browser/bridge.mjs [url]
 *
 * The viewer is redeployed whenever this repository is; the extension that frames
 * it is updated when its reader gets round to it. So the ordinary arrangement is
 * a *new* page driven by an *old* host, and that is what this file builds without
 * an extension in it: a stub host page, speaking the protocol the way it was
 * before revisions existed, frames the built viewer with `?host=1`, hands it the
 * document, and asks where the reader is.
 *
 * What is checked here is the promise an installed extension depends on:
 *
 *   the announcement  `hello` says which bridge revision the page speaks and
 *                     which host revisions it still serves
 *   an old host       a host that never announces a revision is served: the
 *                     document is drawn, and the host is told what opened and
 *                     nothing else - no positions, no settings, no state
 *   the memory        the page keeps the reader's place itself, in its own
 *                     storage, where a host cannot see it
 *   the password      an encrypted document is asked for in the page's own card:
 *                     a cross-origin frame cannot raise a `window.prompt`, but it
 *                     can draw a field, and the host is not asked at all
 *   an unknown host   a host the page cannot serve is told so, in the `error`
 *                     shape every revision understands, and is given no document
 *                     to draw either
 *
 * The bytes are injected by the test rather than fetched by the stub page: a host
 * is the side that has the document, and this one is handed the cached paper.
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, launch } from './cdp.mjs';
import { PAPERS, cachedFile } from '../pdf-cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const url = process.argv[2] ?? 'http://127.0.0.1:5178/';

const paper = PAPERS[0];
const file = cachedFile(paper.url);
if (!file) {
  console.error(`FAIL: ${paper.url} is not in the cache — run \`npm run pdfs\` first`);
  process.exit(1);
}
const bytes = fs.readFileSync(file);
const pdfUrl = new URL(`/pdf/${path.basename(file)}`, url).href;

/** The password the encrypted copy is made with, and the one that is typed. */
const PASSWORD = 'hunter2';

/**
 * The same paper, encrypted, for the one question the page has to ask.
 *
 * Made here rather than kept in the repository - nothing in this repository is a
 * PDF, and a document a host hands over does not need a file to begin with - and
 * made by the core's own `encrypt` binary, which is the same MuPDF the viewer
 * reads with. Nothing in the JavaScript here touches a PDF: the package that used
 * to is gone with the pipeline it belonged to.
 *
 * The binary is a build artifact of `core/`, so a suite that has not built it
 * skips this section rather than failing on a missing file: what is under test is
 * the page's password card, not cargo.
 */
const encryptBin = path.join(root, 'core', 'target', 'release', 'encrypt');

function encrypted(source, password) {
  const scratch = path.join(os.tmpdir(), `webpdf-bridge-${process.pid}.pdf`);
  fs.writeFileSync(scratch, source);
  try {
    execFileSync(encryptBin, [scratch, `${scratch}.locked`, password], { stdio: ['ignore', 'ignore', 'inherit'] });
    return fs.readFileSync(`${scratch}.locked`);
  } finally {
    for (const file of [scratch, `${scratch}.locked`]) fs.rmSync(file, { force: true });
  }
}

let failures = 0;
const started = Date.now();
const check = (label, ok, detail = '') => {
  const at = `${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${at} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the stub host */

/**
 * A host: a page that frames the viewer and talks to it.
 *
 * It is deliberately the *old* shape of host - it says nothing about itself, and
 * only ever hands over a document - because that is exactly what an extension
 * installed before the bridge had revisions looks like from the page's side. The
 * viewer's URL arrives in the fragment, which is not sent to any server.
 */
const HOST_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>stub host</title>
<body>
<script>
  const viewer = decodeURIComponent(location.hash.slice(1));
  const frame = document.createElement('iframe');
  frame.id = 'app';
  frame.src = viewer + '?host=1';
  document.body.append(frame);

  window.__heard = [];
  addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.wpdf === 'host') window.__heard.push(message);
  });

  // What a host with a document does: hand it over, transferred, not copied.
  window.handOver = (base64, name, source) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    frame.contentWindow.postMessage(
      { wpdf: 'host', kind: 'open', doc: { bytes: data.buffer, url: source, name, size: data.length, page: null } },
      viewer,
      [data.buffer],
    );
  };

  // And what a host that knows about revisions says. A host that has never heard
  // of them - every extension released before they existed - never calls this.
  window.announce = (bridge) => frame.contentWindow.postMessage({ wpdf: 'host', kind: 'ready', bridge }, viewer);
</script>
</body>`;

const host = http.createServer((req, res) => {
  const body = Buffer.from(HOST_PAGE);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length) });
  res.end(body);
});
// A *different* loopback address, so the stub host and the viewer are not just
// different origins but different sites: the frame is then a target of its own,
// which is how this test reads the memory the page keeps for itself.
await new Promise((resolve) => host.listen(0, '127.0.0.2', resolve));
const hostOrigin = `http://127.0.0.2:${host.address().port}`;
const hostPage = (n) => `${hostOrigin}/host?case=${n}#${encodeURIComponent(url)}`;

const base64 = bytes.toString('base64');

/**
 * Ask the viewer's own document something.
 *
 * The stub host and the viewer are different sites, so the frame is a target of
 * its own; this is the only way to look inside it, and it is exactly what the
 * host cannot do.
 */
async function frameState(browser, prefix, expression) {
  for (let i = 0; i < 20; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    const frame = targets.find((target) => target.type === 'iframe' && target.url.startsWith(prefix));
    if (frame) {
      const attached = await attach(frame.webSocketDebuggerUrl);
      try {
        return await attached.evaluate(expression);
      } finally {
        await attached.close();
      }
    }
    await sleep(250);
  }
  return null;
}

/* ---------------------------------------------------------------- the checks */

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport(1280, 900);

  /* ------------------------------------- an old host, and a new page */

  await page.goto(hostPage(1));
  const hello = await page
    .waitFor(() => window.__heard.find((message) => message.kind === 'hello') ?? null, { label: 'the page to say hello', timeout: 30000 })
    .catch(() => null);
  check(
    'the page says which bridge it speaks, and which hosts it serves',
    hello?.bridge === 1 && Array.isArray(hello.accepts) && hello.accepts.includes(1),
    JSON.stringify(hello),
  );

  // The old host hands over the document without ever saying what revision it is.
  await page.evaluate(
    `window.handOver(${JSON.stringify(base64)}, ${JSON.stringify(path.basename(file))}, ${JSON.stringify(pdfUrl)})`,
  );
  const opened = await page
    .waitFor(() => window.__heard.find((message) => message.kind === 'opened') ?? null, { label: 'the document to be drawn', timeout: 60000 })
    .catch(() => null);
  check(
    'a host that never announces a revision is still served',
    (opened?.info?.pages ?? 0) > 1,
    JSON.stringify(opened?.info ?? opened),
  );

  // What it hears is what opened, and nothing else: no positions, no settings,
  // nothing that would make a host a second place the reader's memory lives.
  const kinds = [...new Set(await page.evaluate(() => window.__heard.map((message) => message.kind)))].sort();
  check('and is told what opened, and nothing else', kinds.join() === 'hello,opened', kinds.join());

  // The memory is the page's own, in the page's own storage. It is read here the
  // way a reader's browser would: from the frame's document, which the host
  // cannot reach at all.
  const memory = await frameState(browser, url, `(() => {
    const stored = JSON.parse(localStorage.getItem('webpdf.memory') ?? '{}');
    const entry = stored[${JSON.stringify('url:' + pdfUrl)}] ?? null;
    return entry && { pos: entry.pos, settings: entry.settings, keys: Object.keys(stored).length };
  })()`);
  check(
    'the page remembers the reader\'s place itself',
    memory?.pos?.page === 1 && memory?.keys === 1,
    JSON.stringify(memory),
  );

  /* ------------------------------------ a document with a password */

  if (!fs.existsSync(encryptBin)) {
    console.log('\n› a document with a password');
    console.log(`  (skipped: ${path.relative(root, encryptBin)} is not built - run \`cargo build --release --manifest-path core/Cargo.toml\`)`);
    await browser.close();
    process.exit(failures ? 1 : 0);
  }

  // A host hands over an encrypted document and says nothing about it - it has no
  // business knowing the password. The page asks in its own card, and the host
  // hears nothing at all until the document is on screen.
  const locked = encrypted(bytes, PASSWORD).toString('base64');
  await page.goto(hostPage(3));
  await page.waitFor(() => window.__heard.some((message) => message.kind === 'hello'), { label: 'the page to say hello', timeout: 30000 });
  await page.evaluate(`window.handOver(${JSON.stringify(locked)}, 'locked.pdf', ${JSON.stringify(pdfUrl + '#locked')})`);

  const asked = await frameState(browser, url, `(async () => {
    for (let i = 0; i < 60 && document.getElementById('password').hidden; i++) await new Promise((r) => setTimeout(r, 100));
    return { card: !document.getElementById('password').hidden, focused: document.activeElement?.id ?? '' };
  })()`);
  check('an encrypted document is asked for in the page itself', asked?.card === true && asked?.focused === 'password-input', JSON.stringify(asked));
  // Nothing at all goes to the host while the page waits for the reader: not a
  // question, not an error, not a "waiting" - the page has its own reader to ask.
  const quiet = await page.evaluate(() => window.__heard.map((message) => message.kind));
  check('and the host is not asked about it', quiet.join() === 'hello', quiet.join() || 'nothing');

  const unlocked = await frameState(browser, url, `(async () => {
    const input = document.getElementById('password-input');
    input.value = ${JSON.stringify(PASSWORD)};
    document.getElementById('password-form').requestSubmit();
    for (let i = 0; i < 200; i++) {
      const viewer = window.webpdf?.viewer?.();
      if (viewer && viewer.pageCount > 1 && viewer.pageElement(1)) return { pages: viewer.pageCount, card: !document.getElementById('password').hidden };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { pages: 0, card: !document.getElementById('password').hidden };
  })()`);
  check('and the password it is given opens the document', unlocked?.pages > 1 && unlocked?.card === false, JSON.stringify(unlocked));
  const told = await page
    .waitFor(() => window.__heard.find((message) => message.kind === 'opened') ?? null, { label: 'the host to hear what opened', timeout: 30000 })
    .catch(() => null);
  check('and only then does the host hear what opened', (told?.info?.pages ?? 0) > 1, JSON.stringify(told?.info ?? told));

  // Printing an encrypted document: what goes to the printer is the document as
  // the page has it, not the file the host handed over. That file still carries
  // the password, and the browser's own viewer - the thing a printer is given -
  // would ask for it in a frame nobody can see, so the page prints the copy
  // MuPDF writes. Opening that copy is the proof: it needs no password, and the
  // locked bytes would have thrown `PasswordRequiredError` here.
  await frameState(
    browser,
    url,
    `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
  const printed = await frameState(browser, url, `(async () => {
    const deadline = Date.now() + 20000;
    let frame = null;
    while (Date.now() < deadline) {
      frame = document.getElementById('print');
      if (frame && frame.src.startsWith('blob:')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!frame || !frame.src.startsWith('blob:')) return { printed: false };
    const bytes = await (await fetch(frame.src)).arrayBuffer();
    try {
      const info = await window.webpdf.viewer().load(new Blob([bytes], { type: 'application/pdf' }));
      return { printed: true, size: bytes.byteLength, pages: info.pageCount, encrypted: info.encrypted };
    } catch (error) {
      return { printed: true, size: bytes.byteLength, error: String(error?.name ?? error) };
    }
  })()`);
  check(
    'Ctrl+P prints it without the password',
    printed?.printed === true && printed.pages > 1 && printed.encrypted === false,
    JSON.stringify(printed),
  );

  /* ---------------------------------- a host the page cannot serve */

  // A second load, so the two cases do not share a page: this host says it is
  // revision 99, which this viewer does not serve.
  await page.goto(hostPage(2));
  await page.waitFor(() => window.__heard.some((message) => message.kind === 'hello'), { label: 'the page to say hello', timeout: 30000 });
  await page.evaluate('window.announce(99)');
  const refused = await page
    .waitFor(() => window.__heard.find((message) => message.kind === 'error') ?? null, { label: 'the page to refuse the host', timeout: 30000 })
    .catch(() => null);
  check('a host the page cannot serve is told why', /revision 99/.test(String(refused?.message ?? '')), String(refused?.message ?? ''));

  // And it is not given a document it would never draw.
  await page.evaluate(
    `window.handOver(${JSON.stringify(base64)}, ${JSON.stringify(path.basename(file))}, ${JSON.stringify(pdfUrl)})`,
  );
  await sleep(2500);
  const drew = await page.evaluate(() => window.__heard.some((message) => message.kind === 'opened'));
  check('and is given no document to draw', drew === false, `${await page.evaluate(() => window.__heard.length)} messages heard`);

  await page.close();
} catch (error) {
  failures++;
  console.error(`FAIL: ${String(error?.stack ?? error)}`);
} finally {
  await browser.close();
  host.close();
}

console.log(failures ? `\nBRIDGE CHECK FAILED (${failures})` : '\nBRIDGE CHECK PASSED');
process.exit(failures ? 1 : 0);
