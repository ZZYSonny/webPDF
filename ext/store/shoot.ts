/**
 * The Chrome Web Store screenshots, taken from the real demo at 1280x800.
 *
 *   node ext/store/shoot.ts [url] [outDir]
 *
 * `url` is a running demo (`npm run preview -- --port 5190`), ideally with the
 * test PDF cache mounted at `/pdf` so the shots are of the exact bytes the
 * tests verify. Every image is written at the size the store asks for; run
 * `ext/store/assets.ts` afterwards to flatten them to 24-bit PNG and to build the
 * icon and the two promo tiles.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from '../../tests/browser/cdp.ts';
import { PAPERS, pdfName } from '../../demo/papers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://127.0.0.1:5190/';
const out = path.resolve(process.argv[3] ?? path.join(here, '..', '..', '.scratch', 'store-raw'));
fs.mkdirSync(out, { recursive: true });

const paper = PAPERS[1];
const local = `/pdf/${pdfName(paper.url)}`;

const browser = await launch();
const page = await browser.newPage();
await page.setViewport(1280, 800);
await page.goto(url);
await page.waitFor(() => !!window.webpdf?.info, { label: 'the demo to boot' });

/** Open the cached copy of the paper from the picker, and wait for its pages. */
await page.evaluate(`(() => {
  document.getElementById('example-btn').click();
  const row = [...document.querySelectorAll('#example-menu .menu-option')]
    .find((el) => el.dataset.url === ${JSON.stringify(local)});
  if (!row) throw new Error('the picker has no cached row for ${local}');
  row.click();
})()`);

await page.waitFor(
  () => {
    if (window.webpdf!.plan()?.ready !== true) return false;
    const sr = document.getElementById('viewer')?.shadowRoot;
    const pages = [...(sr?.querySelectorAll('.wpdf-page') ?? [])];
    return pages.length > 0 && pages.every((el) => el.querySelectorAll('svg.wpdf-page-svg').length === 1);
  },
  { label: 'the planned document', timeout: 120000 },
);

/** Nothing transient over the page: no toast, no open menu, no progress. */
const settle = async () => {
  try {
    await page.waitFor(
      () =>
        document.getElementById('toast')?.hidden !== false &&
        document.getElementById('progress')?.hidden !== false &&
        document.getElementById('toc')?.hidden !== false,
      { label: 'the page to settle', timeout: 3000 },
    );
  } catch {
    console.log(
      '  settle: ' +
        JSON.stringify(
          await page.evaluate(() => ({
            toast: document.getElementById('toast')?.hidden,
            text: document.getElementById('toast-text')?.textContent,
            progress: document.getElementById('progress')?.hidden,
            toc: document.getElementById('toc')?.hidden,
          })),
        ),
    );
  }
};

/** Type into the viewer's own find box, as a reader would. */
const find = async (text: string) => {
  await page.evaluate(`(() => {
    const input = document.getElementById('search');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(
    () => {
      const count = document.getElementById('search-count')?.textContent ?? '';
      return /\d/.test(count) && !/0\/0/.test(count);
    },
    { label: `a match count for ${text}` },
  );
};

const shoot = async (name: string) => {
  const file = path.join(out, name);
  await page.screenshot(file);
  console.log('shot: ' + file);
};

// 1. The document and the find box: real text, every match boxed.
await find('residual');
await settle();
await shoot('screenshot-reading.png');

// 2. A page at fit-width, with a line selected: the text is the document's
//    own text, not a picture of it.
await page.evaluate(`(() => {
  const toc = document.getElementById('toc');
  if (toc && !toc.hidden) document.getElementById('toc-toggle').click();
  const input = document.getElementById('search');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await page.evaluate(`window.webpdf.viewer().setZoom('fit-width')`);
await page.evaluate(`window.webpdf.viewer().goToPage(4)`);
await page.waitFor(
  () => {
    const sr = document.getElementById('viewer')?.shadowRoot;
    const page = sr?.querySelector('.wpdf-page[data-page="4"]');
    return !!page?.querySelector('svg.wpdf-page-svg text');
  },
  { label: 'page 4 to draw', timeout: 60000 },
);

const target = await page.evaluate<{ x1: number; x2: number; y: number }>(`(() => {
  const sr = document.getElementById('viewer').shadowRoot;
  const page = sr.querySelector('.wpdf-page[data-page="4"]');
  const line = [...page.querySelectorAll('svg.wpdf-page-svg text')]
    .map((el) => ({ el, box: el.getBoundingClientRect() }))
    .filter(({ el, box }) => (el.textContent ?? '').trim().length > 30 && box.top > 110 && box.bottom < innerHeight - 30)
    .sort((a, b) => a.box.top - b.box.top)[0];
  if (!line) throw new Error('no text line on page 4');
  const { box } = line;
  return { x1: box.left + 2, x2: box.left + box.width * 0.8, y: box.top + box.height / 2 };
})()`);
await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x1, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x2, y: target.y, button: 'left', buttons: 1 });
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x2, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
await page.evaluate('new Promise((r) => setTimeout(r, 250))', { awaitPromise: true });
await settle();
await shoot('screenshot-select.png');

// 3. A results page: the tables are the document's, drawn as text.
await page.evaluate(`getSelection().removeAllRanges()`);
await page.evaluate(`window.webpdf.viewer().goToPage(7)`);
await page.waitFor(
  () => {
    const sr = document.getElementById('viewer')?.shadowRoot;
    const page = sr?.querySelector('.wpdf-page[data-page="7"]');
    return !!page?.querySelector('svg.wpdf-page-svg text');
  },
  { label: 'page 7 to draw', timeout: 60000 },
);
await page.evaluate('new Promise((r) => setTimeout(r, 400))', { awaitPromise: true });
await settle();
await shoot('screenshot-table.png');

await browser.close();
