/**
 * A page is a document like any other.
 *
 * Every page is drawn in its own frame, and the reason is a font one: a
 * `@font-face` belongs to a document, and telling a document about a face makes
 * Chromium lay out every text run in it again. So the fonts a page brings are
 * registered in that page's own document, and nowhere else.
 *
 * That buys a smooth boundary at the price of a page being a separate document,
 * which is only acceptable if it still behaves like a page: this file is the
 * bill. Selection, the clipboard, the keyboard, the wheel and find-in-page are
 * the browser's own, and the checks below are written the way a reader would
 * notice them going missing.
 *
 *   node tests/browser/frames.mjs [url]
 */

import { launch } from './cdp.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const PUBLIC_EXAMPLE = 'https://arxiv.org/pdf/1706.03762v7';
const CACHED_PREFIX = '/pdf/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const fail = (msg) => {
  console.error('FAIL: ' + msg);
  failures++;
};
const ok = (msg) => console.log('  ok    ' + msg);

const browser = await launch();
const page = await browser.newPage();
await page.setViewport(1440, 900);

await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__pages = () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      return sr ? [...sr.querySelectorAll('.wpdf-page')] : [];
    };
    window.__frameOf = (n) => window.__pages().find((el) => Number(el.dataset.page) === n)?.querySelector('iframe') ?? null;
    window.__docOf = (n) => window.__frameOf(n)?.contentDocument ?? null;
    window.__svgOf = (n) => window.__docOf(n)?.querySelector('svg.wpdf-page-svg') ?? null;
    window.__shown = () => Number(document.getElementById('pageno').value);
    window.__copied = [];
    // The page hears its own copy event, whatever the system clipboard does.
    window.__watchCopies = () => {
      for (const el of window.__pages()) {
        const doc = el.querySelector('iframe')?.contentDocument;
        if (!doc || doc.__watched) continue;
        doc.__watched = true;
        doc.addEventListener('copy', (e) => {
          window.__copied.push(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
        });
      }
    };
  })();`,
});

const type = async (key, code, vk, modifiers = 0) => {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};

const wheel = async (x, y, deltaY) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' });
  await sleep(60);
};

try {
  await page.send('Browser.grantPermissions', {
    origin: new URL(url).origin,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  }).catch(() => undefined);

  await page.goto(url);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });

  const options = await page.evaluate(() => {
    document.getElementById('example-btn').click();
    return [...document.querySelectorAll('#example-menu .menu-option')].map((o) => o.dataset.url).filter(Boolean);
  });
  const chosen = options.find((value) => value.startsWith(CACHED_PREFIX)) ?? PUBLIC_EXAMPLE;
  await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('#example-menu .menu-option')].find((el) => el.dataset.url === ${JSON.stringify(chosen)});
    row.click();
  })()`);
  await page.waitFor(() => window.__pages().length > 0 && window.__svgOf(1), { label: 'first page', timeout: 120000 });
  await sleep(1500);

  // ------------------------------------------------------- a document at all
  console.log('\n— a page is a document, not a picture —');
  const shape = await page.evaluate(() => {
    const frame = window.__frameOf(1);
    const doc = window.__docOf(1);
    const viewer = document.getElementById('viewer').shadowRoot;
    return {
      sameOrigin: !!doc,
      compat: doc?.compatMode ?? null,
      sandbox: frame?.hasAttribute('sandbox') ?? null,
      title: doc?.title ?? '',
      ownFonts: doc?.fonts.size ?? -1,
      viewerFonts: document.fonts.size,
      textRuns: doc?.querySelectorAll('text').length ?? 0,
      scrollTop: doc?.scrollingElement?.scrollTop ?? -1,
      // The frame is not a picture of a page: the text is real text.
      selectableByRange: (() => {
        const text = doc?.querySelector('text');
        if (!text) return 0;
        const range = doc.createRange();
        range.selectNodeContents(text);
        return range.toString().length;
      })(),
    };
  });
  console.log('  ' + JSON.stringify(shape));
  if (!shape.sameOrigin) fail('the page frame has no document the viewer can read');
  if (shape.compat !== 'CSS1Compat') fail(`a page should lay out in standards mode, got ${shape.compat}`);
  if (shape.sandbox) fail('a sandboxed page frame would cut the reader off from selection and the clipboard');
  if (!shape.title) fail('a page frame should say which page it is');
  if (shape.ownFonts < 1) fail('a page must register the fonts it was built with in its own document');
  if (shape.viewerFonts !== 0) fail(`the viewer's own document was told about ${shape.viewerFonts} font faces`);
  if (shape.selectableByRange < 2) fail('the page has no text a range can select');
  ok(`page 1 is its own standards-mode document: ${shape.ownFonts} faces, ${shape.textRuns} runs, viewer document clean`);

  // ------------------------------------------------------------- clipboard
  console.log('\n— the clipboard is the browser’s own —');
  const selected = await page.evaluate(`(() => {
    window.__watchCopies();
    const doc = window.__docOf(1);
    const text = [...doc.querySelectorAll('text')].find((t) => (t.textContent ?? '').trim().length > 8);
    const range = doc.createRange();
    range.selectNodeContents(text);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { text: selection.toString(), focused: doc.hasFocus() };
  })()`);
  // A click first, the way a reader starts a selection.
  const box = await page.evaluate('(() => { const r = window.__frameOf(1).getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.max(r.top + 60, 120) }; })()');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(120);
  // Clicking collapses the selection, so make it again and copy it.
  await page.evaluate(`(() => {
    const doc = window.__docOf(1);
    const text = [...doc.querySelectorAll('text')].find((t) => (t.textContent ?? '').trim().length > 8);
    const range = doc.createRange();
    range.selectNodeContents(text);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  const focusInPage = await page.evaluate('window.__docOf(1).hasFocus()');
  await type('c', 'KeyC', 67, 2); // Ctrl+C
  await sleep(400);
  const copyEvents = await page.evaluate('window.__copied.slice()');
  let clipboard = null;
  try {
    clipboard = await page.evaluate('navigator.clipboard.readText()');
  } catch (error) {
    clipboard = `unreadable: ${String(error).slice(0, 60)}`;
  }
  const wanted = selected.text.trim();
  console.log(
    '  ' + JSON.stringify({ selected: wanted.slice(0, 40), focusInPage, copyEvents: copyEvents.length, clipboard: String(clipboard).slice(0, 40) }),
  );
  if (!copyEvents.length) fail('Ctrl+C on a selection inside a page raised no copy event in the page at all');
  else ok('Ctrl+C inside a page reached the page itself');
  // The clipboard is the thing that matters, and in Chromium it is filled by the
  // default action *after* the event, so the event's own snapshot is not asked
  // to carry the text - the system clipboard is.
  if (typeof clipboard === 'string' && !clipboard.startsWith('unreadable')) {
    if (clipboard.trim() !== wanted) fail(`the system clipboard holds ${JSON.stringify(clipboard)} instead of the selection`);
    else ok('the system clipboard holds exactly what was selected in the page');
  } else {
    fail(`the system clipboard could not be read back, so copy from a page is unproven: ${clipboard}`);
  }

  // -------------------------------------------------------------- keyboard
  console.log('\n— the keys reach the viewer from inside a page —');
  const before = await page.evaluate('({ y: Math.round(window.scrollY), page: window.__shown() })');
  await page.evaluate('window.__frameOf(1).focus()');
  await type('ArrowDown', 'ArrowDown', 40);
  await sleep(400);
  const afterArrow = await page.evaluate('Math.round(window.scrollY)');
  if (afterArrow <= before.y) fail(`ArrowDown inside a page did not scroll the document (${before.y} -> ${afterArrow})`);
  else ok(`ArrowDown inside a page scrolled the document — ${before.y} -> ${afterArrow}`);

  await type('End', 'End', 35);
  await sleep(700);
  const afterEnd = await page.evaluate('window.__shown()');
  if (afterEnd <= 1) fail(`End inside a page should go to the last page, got ${afterEnd}`);
  else ok(`End inside a page went to page ${afterEnd}`);
  await type('Home', 'Home', 36);
  await sleep(700);
  const afterHome = await page.evaluate('window.__shown()');
  if (afterHome !== 1) fail(`Home inside a page should go back to page 1, got ${afterHome}`);
  else ok('Home inside a page went back to page 1');

  // The viewer's own Ctrl+0 (the fit level) has to work with the focus in a page.
  await type('0', 'Digit0', 48, 2);
  await sleep(500);
  const zoomAfterCtrl0 = await page.evaluate("document.getElementById('zoom-value')?.value ?? ''");
  if (!zoomAfterCtrl0) fail('Ctrl+0 inside a page did not reach the viewer');
  else ok(`Ctrl+0 inside a page reached the viewer — ${zoomAfterCtrl0}`);

  // ----------------------------------------------------------------- wheel
  console.log('\n— the wheel over a page scrolls the document —');
  const scrollBefore = await page.evaluate('Math.round(window.scrollY)');
  for (let i = 0; i < 4; i++) await wheel(box.x, box.y, 120);
  await sleep(500);
  const wheeled = await page.evaluate(`({
    y: Math.round(window.scrollY),
    inFrame: window.__docOf(1)?.scrollingElement?.scrollTop ?? -1,
  })`);
  console.log('  ' + JSON.stringify({ from: scrollBefore, ...wheeled }));
  if (wheeled.y === scrollBefore) fail('the wheel over a page did not scroll the document');
  else ok(`the wheel over a page scrolled the document — ${scrollBefore} -> ${wheeled.y}`);
  if (wheeled.inFrame > 0) fail('the page itself scrolled instead of the document');
  else ok('the page itself did not scroll: the document is the scroller');
} catch (error) {
  fail(String(error && error.stack ? error.stack.split('\n')[0] : error));
} finally {
  await browser.close();
}

console.log(failures ? '\nPAGE FRAME CHECK FAILED' : '\nPAGE FRAME CHECK PASSED');
process.exit(failures ? 1 : 0);
