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
 *                     document is drawn and the position comes back
 *   an unknown host   a host the page cannot serve is told so, in the `error`
 *                     shape every revision understands, and is given no document
 *                     to draw either
 *
 * The bytes are injected by the test rather than fetched by the stub page: a host
 * is the side that has the document, and this one is handed the cached paper.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from './cdp.mjs';
import { PAPERS, cachedFile } from '../pdf-cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://127.0.0.1:5178/';

const paper = PAPERS[0];
const file = cachedFile(paper.url);
if (!file) {
  console.error(`FAIL: ${paper.url} is not in the cache — run \`npm run pdfs\` first`);
  process.exit(1);
}
const bytes = fs.readFileSync(file);

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
  window.handOver = (base64, name) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    frame.contentWindow.postMessage(
      { wpdf: 'host', kind: 'open', doc: { bytes: data.buffer, url: null, name, size: data.length, page: null, state: null } },
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
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
const hostOrigin = `http://127.0.0.1:${host.address().port}`;
const hostPage = (n) => `${hostOrigin}/host?case=${n}#${encodeURIComponent(url)}`;

const base64 = bytes.toString('base64');

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
  await page.evaluate(`window.handOver(${JSON.stringify(base64)}, ${JSON.stringify(path.basename(file))})`);
  const opened = await page
    .waitFor(() => window.__heard.find((message) => message.kind === 'opened') ?? null, { label: 'the document to be drawn', timeout: 60000 })
    .catch(() => null);
  check(
    'a host that never announces a revision is still served',
    (opened?.info?.pages ?? 0) > 1,
    JSON.stringify(opened?.info ?? opened),
  );

  const state = await page
    .waitFor(() => window.__heard.filter((message) => message.kind === 'state').pop() ?? null, { label: 'the reader\'s position', timeout: 30000 })
    .catch(() => null);
  check(
    'and it hears where the reader is',
    (state?.state?.pos?.page ?? 0) >= 1,
    JSON.stringify(state?.state?.pos ?? state),
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
  await page.evaluate(`window.handOver(${JSON.stringify(base64)}, ${JSON.stringify(path.basename(file))})`);
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
