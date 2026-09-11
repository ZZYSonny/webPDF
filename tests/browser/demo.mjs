/**
 * End-to-end check of the built demo page.
 *
 * Drives the real UI (the sample picker) in a real browser and waits for the
 * render to actually complete, then reports what is in the DOM.
 *
 *   node tests/browser/demo.mjs [url] [outPng]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://127.0.0.1:5175/';
const out = process.argv[3] ?? path.join(here, 'out', 'demo.png');
fs.mkdirSync(path.dirname(out), { recursive: true });

/**
 * The published demo ships no documents: every entry in its picker is a public
 * URL. A local dev or preview server additionally mounts the test cache at
 * `/pdf`, and this test prefers such a copy so the numbers below are about this
 * renderer rather than about whichever bytes arXiv is serving today. Where the
 * cache is empty the public URL is used instead, and the document-specific
 * checks are skipped.
 */
const PUBLIC_EXAMPLE = 'https://arxiv.org/pdf/1706.03762v7';
const CACHED_PREFIX = '/pdf/';

const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exitCode = 1;
};

const browser = await launch();
const page = await browser.newPage();
await page.setViewport(1440, 900);

/**
 * Pick a document from the picker. The value is embedded in the expression
 * because `page.evaluate(fn, args)` takes evaluation options as its second
 * argument, not arguments for the function.
 */
const open = (value) =>
  page.evaluate(`(() => {
    const sel = document.getElementById('sample');
    sel.value = ${JSON.stringify(value)};
    sel.dispatchEvent(new Event('change'));
  })()`);

/**
 * The screenshot is a deliverable: `docs/demo.png` is the README's picture of
 * the app, so it is taken on the public example with a match boxed - the same
 * view a reader gets when they open the published demo.
 */
const shot = async (file) => {
  await page.screenshot(file);
  fs.copyFileSync(file, path.join(here, '..', '..', 'docs', 'demo.png'));
  console.log('screenshot: ' + file + ' (+ docs/demo.png)');
};

/** What the find bar says, and how much of it is boxed on the visible page. */
const searchState = () =>
  page.evaluate(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    const page = document.getElementById('pageno').value;
    const box = sr.querySelector(`.wpdf-page[data-page="${page}"]`);
    return {
      count: document.getElementById('search-count')?.textContent ?? '',
      pageno: page,
      highlights: sr.querySelectorAll('rect[data-wpdf-search]').length,
      activeHighlights: sr.querySelectorAll('rect[data-wpdf-search="active"]').length,
      // Boxes on the page we are looking at, active and inactive together.
      bandsOnPage: box ? box.querySelectorAll('rect[data-wpdf-search]').length : 0,
    };
  });

/* ------------------------------------------------------------------ links */

/**
 * Every hit area of one kind that is on screen right now, with the point to
 * click. A link under the sticky bar, or half off the viewport, cannot be
 * clicked, so it is not a candidate.
 */
const linkCandidates = (kind) =>
  page.evaluate(`(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    const chrome = document.querySelector('.topbar')?.offsetHeight ?? 0;
    const out = [];
    for (const svg of sr.querySelectorAll('svg.wpdf-page-svg')) {
      for (const a of svg.querySelectorAll('a[data-wpdf-link="${kind}"]')) {
        const r = a.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.top < chrome + 8 || r.bottom > innerHeight - 8) continue;
        out.push({
          slot: a.closest('.wpdf-page')?.dataset.page ?? null,
          page: a.getAttribute('data-wpdf-page'),
          dest: a.getAttribute('data-wpdf-y'),
          uri: a.getAttribute('data-wpdf-uri'),
          href: a.getAttribute('href'),
          tabindex: a.getAttribute('tabindex'),
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
        });
      }
    }
    return out;
  })()`);

/** What the browser actually hits at a point - the transparent rect, hopefully. */
const whatIsAt = (cx, cy) =>
  page.evaluate(`(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    const el = sr.elementFromPoint(${cx}, ${cy});
    const a = el && el.closest ? el.closest('a[data-wpdf-link]') : null;
    return {
      tag: el ? el.tagName : null,
      kind: a ? a.getAttribute('data-wpdf-link') : null,
      page: a ? a.getAttribute('data-wpdf-page') : null,
      uri: a ? a.getAttribute('data-wpdf-uri') : null,
    };
  })()`);

/** Where a destination ended up, and whether anything navigated to get there. */
const landed = (page_, y) =>
  page.evaluate(`(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    const box = sr.querySelector('.wpdf-page[data-page="${page_}"]');
    const scale = window.webpdf.viewer().zoom;
    return {
      pageno: document.getElementById('pageno').value,
      scrollY: Math.round(window.scrollY),
      // The destination point, measured in the viewport it was supposed to land in.
      top: box ? Math.round(box.getBoundingClientRect().top + ${y} * scale) : null,
      chrome: document.querySelector('.topbar')?.offsetHeight ?? 0,
      hash: location.hash,
      href: location.href,
      url: document.getElementById('toast')?.textContent ?? '',
    };
  })()`);

const mouseClick = async (cx, cy) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
};

const pressEnter = async () => {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
};

/** Wait for an expression *string* to become truthy (the page's number is in it). */
const waitUntil = async (expression, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(expression);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
};

/** Wait for a page's SVG to be in the DOM, so its links can be clicked. */
const waitForPage = async (n, timeout = 30000) => {
  await waitUntil(
    `(() => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      return !!sr?.querySelector('.wpdf-page[data-page="${n}"] svg.wpdf-page-svg');
    })()`,
    `page ${n} render`,
    timeout,
  );
  await new Promise((r) => setTimeout(r, 300));
};

try {
  await page.goto(url);
  // The module graph includes a 10 MB wasm fetch, so wait until the app has
  // actually finished bootstrapping before touching its UI.
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  await page.waitFor(() => !!document.getElementById('viewer'), { label: 'demo shell' });

  console.log('— loading the sample through the UI —');
  const beforeLoad = await page.evaluate(() => ({
    sampleHidden: document.getElementById('sample')?.hidden === true,
    emptyHidden: document.getElementById('empty')?.hidden,
    options: [...document.querySelectorAll('#sample option')].map((o) => o.value).filter(Boolean),
  }));
  if (beforeLoad.sampleHidden) fail('the sample picker should be offered before a document is open');
  if (beforeLoad.emptyHidden !== false) fail('the empty state should be showing before a document is open');
  if (!beforeLoad.options.includes(PUBLIC_EXAMPLE)) {
    fail(`the picker should offer the public example ${PUBLIC_EXAMPLE}, got ${JSON.stringify(beforeLoad.options)}`);
  }
  // The local copy of a cached paper, when the cache behind `/pdf` has one.
  const cachedDoc = beforeLoad.options.find((value) => value.startsWith(CACHED_PREFIX)) ?? null;
  const document_ = cachedDoc ?? PUBLIC_EXAMPLE;
  if (!cachedDoc) console.log('  (cache empty - using the public URL, document-specific checks skipped)');
  await open(document_);

  await page.waitFor(
    () => {
      const host = document.getElementById('viewer');
      const sr = host && host.shadowRoot;
      return !!sr && sr.querySelectorAll('svg.wpdf-page-svg').length > 0;
    },
    { label: 'first page render', timeout: 90000 },
  );

  // Let the adjacent-page pre-render settle too.
  await new Promise((r) => setTimeout(r, 1500));

  const report = await page.evaluate(() => {
    const host = document.getElementById('viewer');
    const sr = host.shadowRoot;
    const svgs = [...sr.querySelectorAll('svg.wpdf-page-svg')];
    // Font faces live on the document (shadow-scoped @font-face is not loaded
    // by Chromium), either in adopted stylesheets or in a <style> element.
    const css = [
      ...[...sr.querySelectorAll('style')].map((s) => s.textContent),
      ...[...document.querySelectorAll('style[data-wpdf="fonts"]')].map((s) => s.textContent),
      ...[...document.adoptedStyleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join('\n')),
    ].join('\n');
    const families = [...new Set([...sr.querySelectorAll('svg text')].map((e) => e.getAttribute('font-family')))];
    const first = svgs[0];
    const firstText = first?.querySelector('text');
    const box = first?.getBoundingClientRect();
    return {
      toast: document.getElementById('toast')?.textContent,
      perf: document.getElementById('stats')?.textContent,
      pageCount: document.getElementById('pagecount')?.textContent,
      zoom: document.getElementById('zoom-value')?.value,
      zoomMenu: [...document.querySelectorAll('#zoom-menu .zoom-option')].map((o) => o.textContent),
      zoomMenuOpen: document.getElementById('zoom-menu')?.hidden === false,
      // Any element of the bar that says "fit width"/"fit page" while neither
      // being the (closed) dropdown nor containing it.
      barFitLabels: [...document.querySelectorAll('.topbar *')]
        .filter((el) => !el.closest('#zoom-menu') && !el.querySelector('#zoom-menu'))
        .filter((el) => /fit (width|page)/i.test(el.textContent || '')).length,
      tocEntries: document.querySelectorAll('#toc-body .toc-item').length,
      tocOpen: document.getElementById('toc')?.hidden === false,
      emptyHidden: document.getElementById('empty')?.hidden,
      sampleHidden: document.getElementById('sample')?.hidden,
      hasStatusBar: !!document.querySelector('.statusbar'),
      hasExport: !!document.getElementById('export'),
      hasSearch: !!document.getElementById('search'),
      shadowRoot: !!sr,
      rendersInWorker: window.webpdf.viewer()?.rendersInWorker ?? null,
      slots: sr.querySelectorAll('.wpdf-page').length,
      renderedPages: svgs.length,
      textElements: sr.querySelectorAll('svg text').length,
      outlineUses: sr.querySelectorAll('svg use').length,
      fontFaces: (css.match(/@font-face/g) || []).length,
      fontBytes: (css.match(/base64,([A-Za-z0-9+/=]+)/g) || []).reduce((a, m) => a + m.length, 0),
      familiesUsed: families.length,
      firstSvgBox: box ? [box.x, box.y, box.width, box.height].map((n) => Math.round(n)) : null,
      sampleText: (firstText?.textContent ?? '').slice(0, 64),
      sampleFont: firstText?.getAttribute('font-family') ?? '',
      selectable: (() => {
        if (!firstText) return false;
        const range = document.createRange();
        range.selectNodeContents(firstText);
        return range.toString().length;
      })(),
    };
  });

  // Shadow-scoped @font-face rules do not appear in document.fonts, and a probe
  // measured during the `font-display: block` window still reports fallback
  // metrics - so measure asynchronously, after the face has had time to load.
  const applied = await page.evaluate(async () => {
    const sr = document.getElementById('viewer').shadowRoot;
    const family = sr.querySelector('svg text')?.getAttribute('font-family');
    if (!family) return null;
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-9999px;top:0;font-size:100px;white-space:nowrap';
    const make = (f) => {
      const span = document.createElement('span');
      span.textContent = 'Hamburgefonstiv 0123';
      span.style.fontFamily = `'${f}'`;
      box.appendChild(span);
      return span;
    };
    const a = make(family);
    const b = make('definitely-not-a-real-font-xyz');
    sr.appendChild(box);
    await new Promise((r) => setTimeout(r, 1200));
    const out = {
      family,
      withGenerated: +a.getBoundingClientRect().width.toFixed(2),
      withFallback: +b.getBoundingClientRect().width.toFixed(2),
    };
    box.remove();
    return out;
  });
  report.fontApplied = applied;

  console.log(JSON.stringify(report, null, 2));

  if (!report.shadowRoot) fail('expected a shadow root');
  if (report.rendersInWorker !== true) fail(`expected worker-backed rendering, got ${report.rendersInWorker}`);
  if (report.renderedPages < 1) fail('no page rendered');
  if (report.textElements < 1) fail('no text elements produced');
  if (report.fontFaces < 1) fail('no @font-face rules injected');
  if (!applied || Math.abs(applied.withGenerated - applied.withFallback) < 0.5) {
    fail(`generated font is not being applied: ${JSON.stringify(applied)}`);
  }
  if ((report.sampleText ?? '').length < 4) fail('first text element is empty');
  if (report.selectable < 4) fail('text is not selectable');
  if (report.tocEntries < 5) fail('outline did not populate');
  if (report.emptyHidden !== true) fail('empty state still visible');
  if (report.sampleHidden !== true) fail('the sample picker should be gone once a document is open');
  if (report.hasStatusBar) fail('the status bar should be gone');
  if (report.hasExport) fail('the export button should be gone');
  if (report.hasSearch !== true) fail('the search box is missing');
  if (!/^\d+ ms$/.test(report.perf ?? '')) {
    fail(`the perf readout should be nothing but a time, got ${JSON.stringify(report.perf)}`);
  }
  if (!/^\d+$/.test(report.zoom ?? '')) {
    fail(`the zoom box should hold a bare number, got ${JSON.stringify(report.zoom)}`);
  }
  // The fit levels are named in the dropdown, by what they resolve to, and
  // nowhere else on the bar.
  if (!report.zoomMenu?.some((p) => /^\d+% \(fit width\)$/.test(p))) {
    fail(`the dropdown should list fit width as a percentage, got ${JSON.stringify(report.zoomMenu)}`);
  }
  if (!report.zoomMenu?.some((p) => /^\d+% \(fit page\)$/.test(p))) {
    fail(`the dropdown should list fit page as a percentage, got ${JSON.stringify(report.zoomMenu)}`);
  }
  if (report.zoomMenu?.length < 9) {
    fail(`the dropdown should offer the whole ladder, got ${JSON.stringify(report.zoomMenu)}`);
  }
  if (report.zoomMenuOpen) fail('the zoom dropdown should start closed');
  if (report.barFitLabels > 0) {
    fail('the bar itself should not spell out a fit mode; only the dropdown may');
  }

  const logs = page.consoleMessages.filter((m) => m.level === 'error' || m.level === 'exception');
  if (logs.length) console.log('console errors:\n' + logs.map((l) => `  [${l.level}] ${l.text}`).join('\n'));

  // A document opens one level below fit-width, not at it.
  console.log('— the starting level is the rung below fit width —');
  const startLevel = await page.evaluate(() => {
    const v = window.webpdf.viewer();
    return { zoom: v.zoom, mode: v.zoomMode, fitWidth: v.resolveZoom('fit-width') };
  });
  if (startLevel.mode === 'fit-width') fail('a document should not open at fit width');
  if (!(startLevel.zoom < startLevel.fitWidth - 1e-6)) {
    fail(`the starting level should be below fit width (${startLevel.fitWidth}), got ${startLevel.zoom}`);
  }
  // Nothing sits between: one step up must land exactly on fit width.
  await page.evaluate(() => document.getElementById('zoom-in').click());
  await new Promise((r) => setTimeout(r, 500));
  const steppedUp = await page.evaluate(() => {
    const v = window.webpdf.viewer();
    return { mode: v.zoomMode, box: document.getElementById('zoom-value').value };
  });
  if (steppedUp.mode !== 'fit-width') {
    fail(`stepping up from the start should land on fit width, got ${steppedUp.mode} (${steppedUp.box})`);
  }
  console.log(`start ${Math.round(startLevel.zoom * 100)}% (${startLevel.mode}) -> fit width ${Math.round(startLevel.fitWidth * 100)}%`);
  // Back to the level a document opens at: the state everything below assumes,
  // and the level the screenshot ends up showing.
  await page.evaluate(() => document.getElementById('zoom-out').click());
  await new Promise((r) => setTimeout(r, 500));

  // The outline floats over the pages: toggling it must not touch the document's
  // width or zoom, or a fit-width layout would visibly re-zoom for a nav panel.
  console.log('— the outline floats, so it cannot re-zoom the document —');
  const outlineState = () =>
    page.evaluate(() => ({
      open: document.getElementById('toc').hidden === false,
      position: getComputedStyle(document.getElementById('toc')).position,
      zoom: window.webpdf.viewer().zoom,
      width: document.getElementById('viewer').clientWidth,
      pageBox: (() => {
        const r = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page')?.getBoundingClientRect();
        return r ? Math.round(r.width) : 0;
      })(),
    }));
  const openOutline = await outlineState();
  if (openOutline.position !== 'fixed') fail(`the outline should float, got position: ${openOutline.position}`);
  await page.evaluate(() => document.getElementById('toc-close').click());
  await new Promise((r) => setTimeout(r, 500));
  const closedOutline = await outlineState();
  await page.evaluate(() => document.getElementById('toc-toggle').click());
  await new Promise((r) => setTimeout(r, 500));
  const reopened = await outlineState();
  if (closedOutline.open || !reopened.open) fail('the outline toggle did not work');
  if (Math.abs(reopened.zoom - openOutline.zoom) > 1e-6 || reopened.width !== openOutline.width || reopened.pageBox !== openOutline.pageBox) {
    fail(`the outline changed the layout: zoom ${openOutline.zoom} -> ${reopened.zoom}, width ${openOutline.width} -> ${reopened.width}, page ${openOutline.pageBox} -> ${reopened.pageBox}`);
  }

  // Also check that switching pages works and unloads far-away pages.
  await page.evaluate(() => document.getElementById('next').click());
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => document.getElementById('next').click());
  await new Promise((r) => setTimeout(r, 1200));
  const after = await page.evaluate(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    return {
      pageno: document.getElementById('pageno').value,
      slots: sr.querySelectorAll('.wpdf-page').length,
      rendered: sr.querySelectorAll('svg.wpdf-page-svg').length,
      pages: [...sr.querySelectorAll('.wpdf-page')].map((e) => e.dataset.page),
    };
  });
  console.log('after paging: ' + JSON.stringify(after));
  if (after.pageno !== '3') fail(`expected page 3, got ${after.pageno}`);
  if (after.rendered < 1) fail('page 3 did not render');
  if (after.slots > 4) fail(`virtualisation is keeping too many slots: ${after.slots}`);

  // ---------------------------------------------------------------- search
  // The checks below count matches in the cached paper, which never changes.
  // (The same search runs against a public URL further down, where the exact
  // numbers are the document's business, not ours.)
  if (!cachedDoc) {
    console.log('— skipping the search checks: they are written against the cached paper —');
  } else {
    // "encoder" appears on all three pages of the sample (2/3/7). Typing is
    // enough: like a browser's find bar the first match is boxed and jumped to
    // with no Enter, and every match on the page is boxed, not just the active
    // one.
    console.log('— searching the document —');
    for (const wait of [600, 1200]) {
      await page.evaluate(() => document.getElementById('prev').click());
      await new Promise((r) => setTimeout(r, wait));
    }
    await page.evaluate(() => {
      const input = document.getElementById('search');
      input.focus();
      input.value = 'encoder';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The trailing ellipsis means the background indexer is still going.
    await page.waitFor(() => /^\d+\/\d+$/.test(document.getElementById('search-count')?.textContent ?? ''), {
      label: 'search results',
      timeout: 60000,
    });
    const found = await searchState();
    const total = Number(found.count.split('/')[1] ?? '0');
    console.log('typed "encoder": ' + JSON.stringify(found));
    if (!/^1\/\d+$/.test(found.count)) fail(`the first match should be selected without pressing Enter, got ${found.count}`);
    if (total < 9) fail(`expected at least 9 matches for "encoder", got ${total}`);
    if (found.pageno !== '1') fail(`expected to land on page 1, got ${found.pageno}`);
    // Page 1 has two occurrences: both boxed, one of them active.
    if (found.bandsOnPage !== 2) fail(`every match on the visible page should be boxed, got ${found.bandsOnPage}`);
    if (found.activeHighlights !== 1) fail(`exactly one match should be the active one, got ${found.activeHighlights}`);

    // Enter still means "next", not "first".
    await page.evaluate(() => {
      const input = document.getElementById('search');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 500));
    const next = await searchState();
    console.log('after Enter: ' + JSON.stringify(next));
    if (next.count !== `2/${total}`) fail(`Enter should move to the second match, got ${next.count}`);

    await page.evaluate(() => document.getElementById('search-next').click());
    await new Promise((r) => setTimeout(r, 500));
    const jumped = await searchState();
    console.log('after one more match: ' + JSON.stringify(jumped));
    if (jumped.count !== `3/${total}`) fail(`expected match 3 of ${total}, got ${jumped.count}`);
    if (jumped.pageno !== '2') fail(`the third match is on page 2, got ${jumped.pageno}`);
    if (jumped.bandsOnPage < 1) fail('the matches on page 2 are not boxed');
    if (jumped.activeHighlights !== 1) fail(`exactly one match should be active on page 2, got ${jumped.activeHighlights}`);

    // Chrome's other habit: clearing the query clears the boxes.
    await page.evaluate(() => {
      const input = document.getElementById('search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 400));
    const cleared = await page.evaluate(() => ({
      count: document.getElementById('search-count').textContent,
      highlights: document.getElementById('viewer').shadowRoot.querySelectorAll('rect[data-wpdf-search]').length,
    }));
    if (cleared.highlights !== 0 || cleared.count !== '') fail(`clearing should remove the boxes, got ${JSON.stringify(cleared)}`);
  }

  // ----------------------------------------------------------------- links
  // Everything below drives real mouse and key events, because the point of a
  // link is that a transparent rectangle is hit-testable where it looks like it
  // is: a synthetic `el.click()` would pass even if nothing could be clicked.
  if (!cachedDoc) {
    console.log('— skipping the link checks: they are written against the cached paper —');
  } else {
    console.log('— links: an internal jump —');
    // Page 1 of the paper is its title page and carries no links at all; the
    // citations start on page 2.
    await page.evaluate(() => window.webpdf.viewer().goToPage(2));
    await waitForPage(2);

    const internal = (await linkCandidates('internal')).filter((l) => Number(l.page) !== 2);
    console.log(`candidates on page 2: ${internal.length}`);
    if (!internal.length) fail('page 2 of the paper should offer internal links');
    const jump = internal[0];
    if (jump.tabindex !== '0') fail(`a hit area should be focusable, got tabindex=${jump.tabindex}`);

    const hit = await whatIsAt(jump.cx, jump.cy);
    if (hit.kind !== 'internal' || hit.page !== jump.page) {
      fail(`the click point should hit the link itself, got ${JSON.stringify(hit)}`);
    }

    const before = await landed(2, 0);
    await mouseClick(jump.cx, jump.cy);
    await waitUntil(`document.getElementById('pageno').value === ${JSON.stringify(jump.page)}`, `jump to page ${jump.page}`);
    await new Promise((r) => setTimeout(r, 400));
    const after = await landed(jump.page, jump.dest === null ? 0 : Number(jump.dest));
    console.log(`clicked a link to page ${jump.page} (y=${jump.dest}): ` + JSON.stringify(after));
    if (after.pageno !== jump.page) fail(`the jump should land on page ${jump.page}, got ${after.pageno}`);
    // The destination is put at the top of the viewport, clear of the sticky bar
    // - not at the top of the window, which is where the bar is.
    if (after.top === null) fail(`page ${jump.page} is not rendered after the jump`);
    else if (Math.abs(after.top - after.chrome) > 3) {
      fail(`the destination should sit just below the bar (${after.chrome}px), it is at ${after.top}px`);
    }
    // An internal link is the viewer's own business: the page's URL is the
    // host's, and a PDF destination is not a document fragment.
    if (after.hash !== '' || after.href !== before.href) {
      fail(`an internal jump must not touch the URL: ${before.href} -> ${after.href}`);
    }

    console.log('— links: Back returns to where the link was clicked —');
    // The jump is in the session history (with the URL untouched), so Back is the
    // reader's undo: the position before the click, then Forward for the jump.
    await page.evaluate('history.back()');
    await waitUntil(`document.getElementById('pageno').value === ${JSON.stringify(before.pageno)}`, `Back to page ${before.pageno}`);
    await new Promise((r) => setTimeout(r, 400));
    const wentBack = await landed(before.pageno, 0);
    console.log(`after Back: page ${wentBack.pageno}, scrollY ${wentBack.scrollY} (was ${before.scrollY})`);
    if (Math.abs(wentBack.scrollY - before.scrollY) > 2) {
      fail(`Back should restore the scroll position ${before.scrollY}, it is at ${wentBack.scrollY}`);
    }
    if (wentBack.hash !== '' || wentBack.href !== before.href) {
      fail(`Back must not change the URL either: ${wentBack.href}`);
    }

    await page.evaluate('history.forward()');
    await waitUntil(`document.getElementById('pageno').value === ${JSON.stringify(jump.page)}`, `Forward to page ${jump.page}`);
    await new Promise((r) => setTimeout(r, 400));
    const wentForward = await landed(jump.page, jump.dest === null ? 0 : Number(jump.dest));
    console.log(`after Forward: page ${wentForward.pageno}, scrollY ${wentForward.scrollY} (was ${after.scrollY})`);
    if (Math.abs(wentForward.scrollY - after.scrollY) > 2) {
      fail(`Forward should return to the link's destination (${after.scrollY}), it is at ${wentForward.scrollY}`);
    }

    console.log('— links: the keyboard reaches them too —');
    await page.evaluate(() => window.webpdf.viewer().goToPage(2));
    await waitForPage(2);
    const focused = await page.evaluate(`(() => {
      const sr = document.getElementById('viewer').shadowRoot;
      const a = [...sr.querySelectorAll('a[data-wpdf-link="internal"]')]
        .find((el) => el.getAttribute('data-wpdf-page') !== '2');
      if (!a) return null;
      a.focus();
      return { page: a.getAttribute('data-wpdf-page'), active: sr.activeElement === a || document.activeElement === a };
    })()`);
    if (!focused) fail('no internal link to focus on page 2');
    else if (!focused.active) fail('an <a tabindex="0"> hit area did not take focus');
    else {
      await pressEnter();
      await waitUntil(`document.getElementById('pageno').value === ${JSON.stringify(focused.page)}`, `keyboard jump to page ${focused.page}`);
      console.log(`Enter on a focused link: page ${focused.page}`);
    }

    console.log('— links: an external target —');
    // A new tab is the viewer's default, and this is what opening one looks
    // like without one: the URI the document carries, handed to `window.open`.
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (uri, target, features) => {
        window.__opened.push([uri, target, features]);
        return null;
      };
    });
    let external = [];
    for (const n of [9, 10, 11, 8]) {
      await page.evaluate(`window.webpdf.viewer().goToPage(${n})`);
      await waitForPage(n);
      external = (await linkCandidates('external')).filter((l) => /^https?:/.test(l.uri ?? ''));
      if (external.length) break;
    }
    if (!external.length) fail('no external link could be found in the paper');
    else {
      const link = external[0];
      console.log(`external link: ${link.uri}`);
      const hit = await whatIsAt(link.cx, link.cy);
      if (hit.kind !== 'external' || hit.uri !== link.uri) {
        fail(`the click point should hit the external link, got ${JSON.stringify(hit)}`);
      }
      const before = await landed(link.slot, 0);
      await mouseClick(link.cx, link.cy);
      await new Promise((r) => setTimeout(r, 600));
      const opened = await page.evaluate('window.__opened');
      const after = await landed(link.slot, 0);
      console.log('opened: ' + JSON.stringify(opened));
      if (opened.length !== 1) fail(`exactly one link should have been opened, got ${JSON.stringify(opened)}`);
      else {
        if (opened[0][0] !== link.uri) fail(`opened ${opened[0][0]}, expected ${link.uri}`);
        if (opened[0][1] !== '_blank') fail(`a link should open in a new tab, got target ${opened[0][1]}`);
        if (!/noopener/.test(String(opened[0][2]))) fail(`the new tab should not get an opener: ${opened[0][2]}`);
      }
      // Following a link out of the document must not navigate the page that is
      // showing it - that is the whole reason the viewer owns the click.
      if (after.href !== before.href) fail(`the page navigated away: ${before.href} -> ${after.href}`);
      if (!/new tab/.test(after.url)) fail(`the demo should say what it did with the link, got ${JSON.stringify(after.url)}`);
    }

    console.log('— links: one a browser cannot follow —');
    // The GPT-4 report's header links to `file://gpt4-report@openai.com`. There
    // is nothing a page can do with that, and the honest answer is to say so
    // rather than to leave a link that looks broken.
    const localPaper = beforeLoad.options.find((value) => value.includes('2303.08774'));
    if (!localPaper) {
      console.log('  (the GPT-4 report is not in the cache - skipped)');
    } else {
      await open(localPaper);
      await page.waitFor(
        () => {
          const sr = document.getElementById('viewer')?.shadowRoot;
          return !!sr && sr.querySelectorAll('svg.wpdf-page-svg').length > 0;
        },
        { label: 'GPT-4 report render', timeout: 120000 },
      );
      await new Promise((r) => setTimeout(r, 1200));
      await page.evaluate('window.__opened = []');
      // That link is at the foot of the title page, well below the fold at this
      // zoom: bring the bottom-most external link into view before clicking it.
      await page.evaluate(`(() => {
        const sr = document.getElementById('viewer').shadowRoot;
        const links = [...sr.querySelectorAll('a[data-wpdf-link="external"]')];
        const last = links[links.length - 1];
        if (last) last.scrollIntoView({ block: 'center' });
        return links.length;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const untouchable = (await linkCandidates('external')).filter((l) => l.href === null);
      if (!untouchable.length) {
        fail('the GPT-4 report should offer its `file:` link as a hit area with no href');
      } else {
        const link = untouchable[0];
        console.log(`unopenable link: ${link.uri}`);
        if (!/^file:/.test(link.uri ?? '')) fail(`expected the file: link, got ${link.uri}`);
        const hit = await whatIsAt(link.cx, link.cy);
        if (hit.uri !== link.uri) fail(`the click point should hit the link itself, got ${JSON.stringify(hit)}`);
        await mouseClick(link.cx, link.cy);
        await new Promise((r) => setTimeout(r, 500));
        const openedLinks = await page.evaluate('window.__opened');
        const said = await page.evaluate("document.getElementById('toast')?.textContent ?? ''");
        console.log(`said: ${JSON.stringify(said)}`);
        if (openedLinks.length !== 0) fail(`nothing should have been opened, got ${JSON.stringify(openedLinks)}`);
        if (!/cannot open/.test(said)) fail(`the demo should say the link cannot be opened, got ${JSON.stringify(said)}`);
      }
    }
  }

  // ------------------------------------------------------- the public example
  // The shipped page has no documents of its own, so this is the path a reader
  // takes: the example is downloaded from its public URL and rendered like any
  // other file. arXiv serves it with `access-control-allow-origin: *`, which is
  // what makes that possible without a proxy.
  console.log('— opening the public example —');
  await open(PUBLIC_EXAMPLE);
  await page.waitFor(
    () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      return !!sr && sr.querySelectorAll('svg.wpdf-page-svg').length > 0;
    },
    { label: 'example render', timeout: 120000 },
  );
  await new Promise((r) => setTimeout(r, 1500));
  const remote = await page.evaluate(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    const text = [...sr.querySelectorAll('svg text')].map((t) => t.textContent).join(' ');
    return {
      pages: document.getElementById('pagecount')?.textContent,
      textElements: sr.querySelectorAll('svg text').length,
      outline: document.querySelectorAll('#toc-body .toc-item').length,
      title: document.title,
      rendersInWorker: window.webpdf.viewer()?.rendersInWorker ?? null,
      prose: /encoder/i.test(text),
    };
  });
  console.log('example: ' + JSON.stringify(remote));
  if (Number(remote.pages) < 5) fail(`the example should be a real multi-page paper, got ${remote.pages} pages`);
  if (remote.textElements < 20) fail(`the example rendered almost no text (${remote.textElements} elements)`);
  if (!remote.prose) fail('the rendered page 1 of the example has no recognisable prose');
  if (remote.outline < 5) fail(`the example's outline did not populate (${remote.outline} entries)`);
  // A document fetched over the network must still be a document we can open.
  if (remote.rendersInWorker !== true) fail('the example did not render in the worker');
  if (!remote.title) fail('the example did not set a document title');

  // The same find bar, on a document nobody wrote for this test.
  await page.evaluate(() => {
    const input = document.getElementById('search');
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitFor(() => /^\d+\/\d+$/.test(document.getElementById('search-count')?.textContent ?? ''), {
    label: 'example search results',
    timeout: 60000,
  });
  const remoteHits = await searchState();
  console.log('example search: ' + JSON.stringify(remoteHits));
  if (!/^1\/\d+$/.test(remoteHits.count)) fail(`the first example match should be selected, got ${remoteHits.count}`);
  if (remoteHits.bandsOnPage < 1) fail('the example matches are not boxed');
  if (remoteHits.activeHighlights !== 1) fail(`exactly one example match should be active, got ${remoteHits.activeHighlights}`);

  await shot(out);
} finally {
  await page.close();
  await browser.close();
}

console.log(process.exitCode ? 'DEMO CHECK FAILED' : 'DEMO CHECK PASSED');
