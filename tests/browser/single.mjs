/**
 * One document, and the browser's own text behaviour over it.
 *
 * A page used to be drawn in a same-origin frame, because a `@font-face` belongs
 * to a document and registering one re-lays-out every text run in it. The engine
 * now plans the document's fonts before the first page is laid out - one face per
 * *font* - so the pages are one document and nothing registers while the reader
 * scrolls. What that buys, beyond a smooth boundary, is a page behaving like
 * text: selection, the clipboard, find-in-page and a caret are the browser's own
 * over the whole document, and a selection can cross a page boundary, which it
 * could not between frames.
 *
 * This file is the bill for that. The checks are written the way a reader would
 * notice them going missing.
 *
 *   node tests/browser/single.mjs [url]
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
    window.__svgOf = (n) => {
      const el = window.__pages().find((p) => Number(p.dataset.page) === Number(n));
      return el?.querySelector('svg.wpdf-page-svg') ?? null;
    };
    window.__shown = () => Number(document.getElementById('pageno').value);
    window.__frames = () =>
      [...(document.getElementById('viewer')?.shadowRoot?.querySelectorAll('iframe') ?? [])].length;
    /**
     * Every @font-face the document is told about, from before it boots.
     *
     * Registering a face is not a no-op: the font set of the document changes
     * and the browser lays out every text run in it again. Counting the rules
     * as they go in is the only way to see that from here.
     */
    window.__registered = [];
    const insertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      const m = /@font-face\s*\{[^}]*font-family:\s*'([^']+)'/.exec(String(rule));
      if (m) window.__registered.push(m[1]);
      return insertRule.call(this, rule, index);
    };
    window.__copied = [];
    // The document hears its own copy event, whatever the system clipboard does.
    window.__watchCopies = () => {
      if (window.__watching) return;
      window.__watching = true;
      document.addEventListener('copy', (e) => {
        window.__copied.push(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
      });
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

const click = async (x, y) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};

try {
  await page
    .send('Browser.grantPermissions', {
      origin: new URL(url).origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    })
    .catch(() => undefined);

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
  console.log('\n— the pages are one document, not one each —');
  const shape = await page.evaluate(() => {
    const svg = window.__svgOf(1);
    const sr = document.getElementById('viewer').shadowRoot;
    return {
      frames: window.__frames(),
      compat: document.compatMode,
      ownFonts: window.__registered.length,
      inViewerDocument: sr.contains(svg),
      textRuns: svg?.querySelectorAll('text').length ?? 0,
      scrollers: [document.scrollingElement?.scrollTop ?? -1, ...window.__pages().map((el) => el.scrollTop)],
      // The page is not a picture: the text is real text the document can select.
      selectableByRange: (() => {
        const text = svg?.querySelector('text');
        if (!text) return 0;
        const range = document.createRange();
        range.selectNodeContents(text);
        return range.toString().length;
      })(),
    };
  });
  console.log('  ' + JSON.stringify(shape));
  const facesAtOpen = shape.ownFonts;
  if (shape.frames !== 0) fail(`${shape.frames} page frame(s) are open; the pages should be in the viewer's own document`);
  if (shape.compat !== 'CSS1Compat') fail(`the page should lay out in standards mode, got ${shape.compat}`);
  if (!shape.inViewerDocument) fail('the page SVG is not in the viewer document');
  if (shape.ownFonts < 1) fail('the document was told about no font faces at all, so the pages cannot be drawn with their own fonts');
  if (shape.selectableByRange < 2) fail('the page has no text a range can select');
  if (shape.scrollers.some((top) => top > 0)) fail(`something other than the document is scrolling: ${JSON.stringify(shape.scrollers)}`);
  ok(`one document: ${shape.ownFonts} faces, ${shape.textRuns} text runs, no frame`);

  // ------------------------------------------------------------- clipboard
  console.log('\n— the clipboard is the browser’s own —');
  const selected = await page.evaluate(`(() => {
    window.__watchCopies();
    const svg = window.__svgOf(1);
    const text = [...svg.querySelectorAll('text')].find((t) => (t.textContent ?? '').trim().length > 8);
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { text: selection.toString() };
  })()`);
  // A click first, the way a reader starts a selection.
  const box = await page.evaluate(
    '(() => { const r = window.__svgOf(1).getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.max(r.top + 60, 120) }; })()',
  );
  await click(box.x, box.y);
  await sleep(120);
  // Clicking collapses the selection, so make it again and copy it.
  await page.evaluate(`(() => {
    const svg = window.__svgOf(1);
    const text = [...svg.querySelectorAll('text')].find((t) => (t.textContent ?? '').trim().length > 8);
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
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
    '  ' + JSON.stringify({ selected: wanted.slice(0, 40), copyEvents: copyEvents.length, clipboard: String(clipboard).slice(0, 40) }),
  );
  if (!copyEvents.length) fail('Ctrl+C on a selection in a page raised no copy event in the document');
  else ok('Ctrl+C on a selection in a page reached the document');
  // The clipboard is the thing that matters, and in Chromium it is filled by the
  // default action *after* the event, so the event's own snapshot is not asked
  // to carry the text - the system clipboard is.
  if (typeof clipboard === 'string' && !clipboard.startsWith('unreadable')) {
    if (clipboard.trim() !== wanted) fail(`the system clipboard holds ${JSON.stringify(clipboard)} instead of the selection`);
    else ok('the system clipboard holds exactly what was selected in the page');
  } else {
    fail(`the system clipboard could not be read back, so copy from a page is unproven: ${clipboard}`);
  }

  // ------------------------------------------------- a selection over two pages
  console.log('\n— one selection can cross a page boundary —');
  const across = await page.evaluate(`(() => {
    const one = window.__svgOf(1)?.querySelector('text');
    const two = window.__svgOf(2)?.querySelector('text');
    if (!one || !two) return null;
    const range = document.createRange();
    range.setStartBefore(one);
    range.setEndAfter(two);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const rects = range.getClientRects().length;
    const text = selection.toString();
    return { length: text.length, rects, one: text.slice(0, 20), two: text.slice(-20) };
  })()`);
  console.log('  ' + JSON.stringify(across));
  if (!across || across.length < 10) fail('a range could not select text across two pages');
  else if (across.rects < 2) fail('a selection across two pages reported only one rectangle');
  else ok(`a range selected ${across.length} characters over two pages (${across.rects} rectangles)`);

  // The characters, not just their number: a ligature is one glyph the page
  // drew and two letters the text says (`src/core/svg/ligatures.ts`), so what
  // comes back has to be the letters - not the ligature's own character, which
  // is what a reader saw pasted into a word containing an `f`, and not a
  // private-use stand-in for a glyph nothing could name.
  await type('c', 'KeyC', 67, 2); // Ctrl+C
  await sleep(400);
  const acrossClipboard = String(await page.evaluate('navigator.clipboard.readText()').catch(() => ''));
  const invented = [...acrossClipboard].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (code >= 0xe000 && code <= 0xf8ff) || (code >= 0xfb00 && code <= 0xfb06) || code === 0xfffd;
  });
  if (acrossClipboard.length < 10) fail(`the cross-page selection copied nothing to the clipboard: ${JSON.stringify(acrossClipboard)}`);
  else if (invented.length)
    fail(`the clipboard holds ${invented.length} characters the page never wrote: ${JSON.stringify(invented.slice(0, 8))}`);
  else ok(`the clipboard from two pages holds only the page's own characters (${acrossClipboard.length} of them)`);

  // -------------------------------------------------------------- keyboard
  console.log('\n— the keys reach the viewer over a page —');
  const before = await page.evaluate('({ y: Math.round(window.scrollY), page: window.__shown() })');
  await click(box.x, box.y);
  await type('ArrowDown', 'ArrowDown', 40);
  await sleep(400);
  const afterArrow = await page.evaluate('Math.round(window.scrollY)');
  if (afterArrow <= before.y) fail(`ArrowDown over a page did not scroll the document (${before.y} -> ${afterArrow})`);
  else ok(`ArrowDown over a page scrolled the document — ${before.y} -> ${afterArrow}`);

  await type('End', 'End', 35);
  await sleep(700);
  const afterEnd = await page.evaluate('window.__shown()');
  if (afterEnd <= 1) fail(`End over a page should go to the last page, got ${afterEnd}`);
  else ok(`End over a page went to page ${afterEnd}`);
  await type('Home', 'Home', 36);
  await sleep(700);
  const afterHome = await page.evaluate('window.__shown()');
  if (afterHome !== 1) fail(`Home over a page should go back to page 1, got ${afterHome}`);
  else ok('Home over a page went back to page 1');

  // The viewer's own Ctrl+0 (the fit level) has to work with the focus in a page.
  await type('0', 'Digit0', 48, 2);
  await sleep(500);
  const zoomAfterCtrl0 = await page.evaluate("document.getElementById('zoom-value')?.value ?? ''");
  if (!zoomAfterCtrl0) fail('Ctrl+0 over a page did not reach the viewer');
  else ok(`Ctrl+0 over a page reached the viewer — ${zoomAfterCtrl0}`);

  // ----------------------------------------------------------------- wheel
  console.log('\n— the wheel over a page scrolls the document —');
  const scrollBefore = await page.evaluate('Math.round(window.scrollY)');
  for (let i = 0; i < 4; i++) await wheel(box.x, box.y, 120);
  await sleep(500);
  const wheeled = await page.evaluate(`({
    y: Math.round(window.scrollY),
    inPage: Math.max(0, ...window.__pages().map((el) => el.scrollTop)),
  })`);
  console.log('  ' + JSON.stringify({ from: scrollBefore, ...wheeled }));
  if (wheeled.y === scrollBefore) fail('the wheel over a page did not scroll the document');
  else ok(`the wheel over a page scrolled the document — ${scrollBefore} -> ${wheeled.y}`);
  if (wheeled.inPage > 0) fail('a page itself scrolled instead of the document');
  else ok('no page scrolled: the document is the scroller');

  // ----------------------------------------------------------------- fonts
  // Every page of the document has now been past the reader (End, Home, a jump
  // and a wheel), and the document's font set has not changed: a planned
  // document is told about every face it will ever need before the first page is
  // laid out, and about nothing after that.
  console.log('\n— moving through the document registers no font —');
  const facesNow = await page.evaluate('window.__registered.length');
  console.log('  ' + JSON.stringify({ atOpen: facesAtOpen, afterReading: facesNow }));
  if (facesAtOpen < 1) fail('no face was registered at all');
  if (facesNow !== facesAtOpen) fail(`${facesNow - facesAtOpen} face(s) were registered while reading the document`);
} catch (error) {
  fail(String(error && error.stack ? error.stack.split('\n')[0] : error));
} finally {
  await browser.close();
}

console.log(failures ? '\nSINGLE DOCUMENT CHECK FAILED' : '\nSINGLE DOCUMENT CHECK PASSED');
process.exit(failures ? 1 : 0);
