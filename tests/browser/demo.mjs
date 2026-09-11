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
    const viewer = window.webpdf.viewer();
    const scale = viewer.zoom;
    // Destinations are points on the document's own page; a cropped page starts
    // at the top of its crop, so the two differ by that much.
    const crop = viewer.cropBox(${page_});
    const point = crop ? Math.max(0, ${y} - crop.y) : ${y};
    return {
      pageno: document.getElementById('pageno').value,
      scrollY: Math.round(window.scrollY),
      // The destination point, measured in the viewport it was supposed to land in.
      top: box ? Math.round(box.getBoundingClientRect().top + point * scale) : null,
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
      // An outline that highlights nothing until the reader happens to change
      // page looks broken; this report's first entry is on page one, so opening
      // it is the moment to check that the panel says where the reader is.
      const marked = await page.evaluate("document.querySelector('#toc-body .toc-item.active')?.textContent ?? ''");
      if (!marked) fail('the outline should mark the entry for the page a document opens on');
      else console.log(`outline marks: ${JSON.stringify(marked)}`);
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


  // -------------------------------------------------------------- cropping
  /**
   * Cropping changes the size of every page, so it is the one control here that
   * can move the reader without being asked to. The checks are therefore about
   * both halves: the pages really are trimmed to their content, and nothing else
   * about the document changed - not its elements, not the text in it, and not
   * where the reader was.
   */
  console.log('— cropping pages to their content —');
  await open(document_);
  await waitForPage(1);

  /** Everything about the crop control and the page in front of the reader. */
  const cropState = () =>
    page.evaluate(`(() => {
      const sr = document.getElementById('viewer').shadowRoot;
      const host = document.getElementById('viewer');
      const shown = document.getElementById('pageno').value;
      const box = sr.querySelector('.wpdf-page[data-page="' + shown + '"]');
      const svg = box?.querySelector('svg');
      const items = [...document.querySelectorAll('#crop-list .crop-option')];
      const search = document.getElementById('search-box');
      const button = document.getElementById('crop-btn');
      return {
        // Where the control lives: the instruction was "after the search".
        afterSearch: !!(search.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
        rows: items.map((el) => el.dataset.id),
        names: items.map((el) => el.querySelector('.crop-name')?.textContent ?? ''),
        checked: items.filter((el) => el.getAttribute('aria-selected') === 'true').map((el) => el.dataset.id),
        disabledRows: items.filter((el) => el.getAttribute('aria-disabled') === 'true').map((el) => el.dataset.id),
        menuOpen: !document.getElementById('crop-menu').hidden,
        count: document.getElementById('crop-count').textContent,
        status: document.getElementById('crop-status').textContent,
        enableAllOff: document.getElementById('crop-all').disabled,
        disableAllOff: document.getElementById('crop-none').disabled,
        padding: document.getElementById('crop-padding').value,
        paddingOff: document.getElementById('crop-padding').disabled,
        page: shown,
        scrollY: Math.round(window.scrollY),
        pageTop: box ? Math.round(box.getBoundingClientRect().top) : null,
        pageWidth: box ? Math.round(box.offsetWidth) : null,
        pageHeight: box ? Math.round(box.offsetHeight) : null,
        viewBox: svg ? svg.getAttribute('viewBox') : null,
        elements: svg ? svg.querySelectorAll('path,use,image,text,g,rect').length : 0,
        texts: svg ? svg.querySelectorAll('text').length : 0,
        docHeight: Math.round(host.offsetHeight),
      };
    })()`);

  /**
   * Text that a crop sliced through: a glyph partly inside the window and
   * partly out of it. A mark left *outside* the box is the whole point of the
   * exercise, but a line that is half in and half out means the page lost
   * something a reader needed. Every glyph is measured through the SVG's own
   * matrix, so this is the geometry the browser itself uses to draw.
   */
  const cutText = () =>
    page.evaluate(`(() => {
      const sr = document.getElementById('viewer').shadowRoot;
      const shown = document.getElementById('pageno').value;
      const svg = sr.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      if (!svg) return null;
      const [x, y, w, h] = svg.getAttribute('viewBox').split(/\\s+/).map(Number);
      const toPage = (el, dx, dy) =>
        new DOMPoint(dx, dy).matrixTransform(el.getScreenCTM()).matrixTransform(svg.getScreenCTM().inverse());
      const cut = [];
      for (const el of svg.querySelectorAll('text, use')) {
        let box;
        try { box = el.getBBox(); } catch { continue; }
        if (!box.width && !box.height) continue;
        const a = toPage(el, box.x, box.y);
        const b = toPage(el, box.x + box.width, box.y + box.height);
        const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
        const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
        // A text element's box is its *advance* box, and the font the renderer
        // rebuilt rounds its advances a little differently from MuPDF's own, so
        // a run can stick out sideways by a fraction of an em without a glyph
        // being lost. Sideways, half an em is therefore tolerated; vertically,
        // a run is a line of text and a point of it outside is a sliced line.
        const em = Number.parseFloat(el.getAttribute('font-size') ?? '10') || 10;
        const slackX = Math.max(1, em * 0.5);
        const slackY = 1;
        const inside = left >= x - slackX && right <= x + w + slackX && top >= y - slackY && bottom <= y + h + slackY;
        const outside = right < x || bottom < y || left > x + w || top > y + h;
        if (!inside && !outside) cut.push([(el.textContent ?? '').slice(0, 20), Math.round(top), Math.round(bottom)]);
      }
      return { box: [x, y, w, h].map((v) => Math.round(v * 10) / 10), cut: cut.slice(0, 6), cutCount: cut.length };
    })()`);

  const start = await cropState();
  console.log('crop control: ' + JSON.stringify({ names: start.names, afterSearch: start.afterSearch }));
  console.log('before crop : ' + JSON.stringify({ page: start.page, viewBox: start.viewBox, box: [start.pageWidth, start.pageHeight], elements: start.elements }));
  if (!start.afterSearch) fail('the crop control should sit after the search box');
  if (start.rows.length < 6) fail(`the crop menu should list the rules, got ${JSON.stringify(start.rows)}`);
  for (const name of ['arXiv stamp', 'Conference header', 'Page number', 'Section number', 'Chapter heading', 'PRIME AI watermark', 'Running title']) {
    if (!start.names.includes(name)) fail(`the crop menu is missing the rule named ${JSON.stringify(name)}`);
  }
  // Nothing is selected, and nothing has happened to the document.
  if (start.checked.length) fail(`cropping should start with nothing selected, got ${JSON.stringify(start.checked)}`);
  if (!/shown whole/.test(start.status)) fail(`the menu should say the pages are untouched, got ${JSON.stringify(start.status)}`);
  if (!start.disableAllOff || start.enableAllOff) fail('with nothing checked, only "Disable all" should be greyed out');
  if (!/^0 0 /.test(start.viewBox ?? '')) fail(`an untouched page should keep its own viewBox, got ${start.viewBox}`);
  // Padding is a margin around a crop, so with no crop there is nothing to pad.
  if (start.padding !== '0' || !start.paddingOff) {
    fail(`the padding field should start at 0 and inert, got ${JSON.stringify({ value: start.padding, disabled: start.paddingOff })}`);
  }

  // Where the reader is, and what is in front of them: the crop has to leave
  // both alone apart from the page's size.
  await page.evaluate(`(() => {
    const input = document.getElementById('pageno');
    input.value = '3';
    input.dispatchEvent(new Event('change'));
  })()`);
  await waitForPage(3);
  const here = await cropState();

  console.log('— a rule is checked —');
  await page.evaluate(() => document.getElementById('crop-btn').click());
  const opened = await cropState();
  if (!opened.menuOpen) fail('the crop button should open the dropdown');
  await page.evaluate(() => document.getElementById('crop-all').click());
  const all = await waitUntil(
    `(() => {
      const status = document.getElementById('crop-status').textContent;
      return status.startsWith('Cropping') ? false : status;
    })()`,
    'the crop to finish measuring',
    60000,
  );
  const cropped = await cropState();
  console.log('after crop  : ' + JSON.stringify({ status: all, page: cropped.page, viewBox: cropped.viewBox, box: [cropped.pageWidth, cropped.pageHeight], elements: cropped.elements }));
  console.log('kept in place: ' + JSON.stringify({ was: { page: here.page, top: here.pageTop, scrollY: here.scrollY }, now: { page: cropped.page, top: cropped.pageTop, scrollY: cropped.scrollY } }));

  const [px, py, pw, ph] = (cropped.viewBox ?? '').split(/\s+/).map(Number);
  if (!cropped.checked.length) fail('"Enable all" checked nothing');
  if (cropped.count !== String(cropped.checked.length)) fail(`the button should show how many rules are on, got ${JSON.stringify(cropped.count)}`);
  // A crop is a smaller window onto the page: inside it, and smaller than it.
  if (!(px > 0 && py >= 0 && pw > 0 && ph > 0)) fail(`the cropped viewBox is not a box: ${cropped.viewBox}`);
  if (!(px + pw <= 612.001 && py + ph <= 792.001)) fail(`the crop is not inside the page: ${cropped.viewBox}`);
  if (!(pw < 612 && ph < 792)) fail(`the crop did not trim the page: ${cropped.viewBox}`);
  if (!(cropped.pageWidth < here.pageWidth && cropped.pageHeight < here.pageHeight)) fail('the page box did not follow the crop');
  if (!(cropped.docHeight < here.docHeight)) fail('the document is no shorter than before the crop');
  // Nothing was removed to achieve it: same elements, same text runs.
  if (cropped.elements !== here.elements) fail(`cropping changed the page's elements (${here.elements} -> ${cropped.elements})`);
  if (cropped.texts !== here.texts || !cropped.texts) fail(`cropping changed the page's text (${here.texts} -> ${cropped.texts})`);
  const slicedAll = await cutText();
  console.log('text sliced by the crop: ' + JSON.stringify(slicedAll));
  if (slicedAll?.cutCount) fail(`the crop cut through ${slicedAll.cutCount} piece(s) of text: ${JSON.stringify(slicedAll.cut)}`);

  // A link's destination is a point on the *uncropped* page while the layout now
  // measures from the top of the crop, so a jump that ignored the difference
  // would land a margin too far down every page.
  console.log('— a link clicked while the pages are cropped —');
  await page.evaluate(`(() => {
    const input = document.getElementById('pageno');
    input.value = '2';
    input.dispatchEvent(new Event('change'));
  })()`);
  await waitForPage(2);
  const jumpy = (await linkCandidates('internal')).filter((l) => Number(l.dest) > 0 && Number(l.page) !== 2);
  if (!jumpy.length) {
    fail('page 2 of the paper should offer an internal link with a destination');
  } else {
    const link = jumpy[0];
    await mouseClick(link.cx, link.cy);
    await waitUntil(`document.getElementById('pageno').value === ${JSON.stringify(link.page)}`, `jump to page ${link.page}`);
    await new Promise((r) => setTimeout(r, 400));
    const after = await landed(Number(link.page), Number(link.dest));
    console.log(`cropped jump to page ${link.page} (y=${link.dest}): ` + JSON.stringify({ top: after.top, chrome: after.chrome }));
    if (after.pageno !== link.page) fail(`the jump should land on page ${link.page}, got ${after.pageno}`);
    if (after.top === null) fail(`page ${link.page} is not rendered after the jump`);
    else if (Math.abs(after.top - after.chrome) > 3) {
      fail(`a cropped destination should still sit just below the bar (${after.chrome}px), it is at ${after.top}px`);
    }
    await page.evaluate(() => window.webpdf.viewer().goToPage(3));
    await waitForPage(3);
  }
  // The reader kept their page, and their place on it.
  if (cropped.page !== here.page) fail(`the reader moved from page ${here.page} to ${cropped.page}`);
  if (Math.abs(cropped.pageTop - here.pageTop) > 6) fail(`the page moved on screen by ${Math.abs(cropped.pageTop - here.pageTop)}px`);
  // The bulk buttons say what they can still do.
  if (!cropped.enableAllOff) fail('"Enable all" should be greyed out once every usable rule is on');
  if (cropped.disableAllOff) fail('"Disable all" should be live once something is checked');

  // The margin is a control, not a re-measurement: it grows the box the SVG is
  // given and the pages re-lay-out around the reader.
  console.log('— a margin around the content —');
  const setPadding = async (value, expect) => {
    await page.evaluate(`(() => {
      const input = document.getElementById('crop-padding');
      input.value = ${JSON.stringify(String(value))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const box = await waitUntil(
      `(() => {
        const shown = document.getElementById('pageno').value;
        const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
        return svg && svg.getAttribute('viewBox').startsWith(${JSON.stringify(expect)}) ? svg.getAttribute('viewBox') : false;
      })()`,
      `the ${value}pt margin to be applied`,
      60000,
    );
    return box;
  };

  const padded = await setPadding(8, `${(px - 8).toFixed(3)} ${(py - 8).toFixed(3)}`);
  const withMargin = await cropState();
  console.log('padded by 8 : ' + JSON.stringify({ viewBox: padded, box: [withMargin.pageWidth, withMargin.pageHeight], status: withMargin.status }));
  const [qx, qy, qw, qh] = padded.split(/\s+/).map(Number);
  if (Math.abs(qx - (px - 8)) > 0.01 || Math.abs(qy - (py - 8)) > 0.01) fail(`padding should grow the box on every side, got ${padded} from ${cropped.viewBox}`);
  if (Math.abs(qw - (pw + 16)) > 0.01 || Math.abs(qh - (ph + 16)) > 0.01) fail(`padding should add 8pt on every side, got ${padded} from ${cropped.viewBox}`);
  if (!(withMargin.pageWidth > cropped.pageWidth && withMargin.pageHeight > cropped.pageHeight)) fail('the page box did not follow the margin');
  if (withMargin.elements !== cropped.elements || withMargin.texts !== cropped.texts) fail('padding changed what is in the page');
  if (withMargin.page !== cropped.page || Math.abs(withMargin.pageTop - cropped.pageTop) > 6) fail('padding moved the reader');
  if (!/\+8 pt/.test(withMargin.status)) fail(`the menu should say what the margin is, got ${JSON.stringify(withMargin.status)}`);
  // And back to nothing at all, exactly where it started.
  const unpadded = await setPadding(0, cropped.viewBox);
  if (unpadded !== cropped.viewBox) fail(`a margin of 0 should be the crop itself (${cropped.viewBox} -> ${unpadded})`);

  console.log('— one rule off, then all of them —');
  await page.evaluate(() => document.querySelector('#crop-list .crop-option[data-id="page-number"]').click());
  const one = await waitUntil(
    `(() => {
      const status = document.getElementById('crop-status').textContent;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('svg.wpdf-page-svg');
      return status.startsWith('Cropping') ? false : svg?.getAttribute('viewBox') ?? false;
    })()`,
    'the second measurement to finish',
    60000,
  );
  const single = await cropState();
  console.log('one rule off: ' + JSON.stringify({ viewBox: one, checked: single.checked.length }));
  if (single.checked.includes('page-number')) fail('clicking a checked rule should uncheck it');
  if (single.enableAllOff) fail('"Enable all" should be live again once a rule is off');
  if (one === cropped.viewBox) fail('removing a rule should change the box it produced');

  await page.evaluate(() => document.getElementById('crop-none').click());
  const back = await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      const viewBox = svg?.getAttribute('viewBox') ?? '';
      return viewBox.startsWith('0 0 ') && svg.querySelectorAll('text').length > 0 ? viewBox : false;
    })()`,
    'the pages to come back',
    60000,
  );
  const restored = await cropState();
  console.log('disable all : ' + JSON.stringify({ viewBox: back, box: [restored.pageWidth, restored.pageHeight], elements: restored.elements }));
  if (restored.checked.length) fail('"Disable all" left rules checked');
  if (back !== here.viewBox) fail(`disabling every rule should restore the page exactly (${here.viewBox} -> ${back})`);
  if (restored.pageWidth !== here.pageWidth || restored.pageHeight !== here.pageHeight) fail('the page box did not come back');
  if (restored.docHeight !== here.docHeight) fail(`the document height did not come back (${here.docHeight} -> ${restored.docHeight})`);

  // The reported failure, exactly as it was reported: the page-number rule on
  // its own, on page 5 of this paper, cut the foot off the text. A rule that
  // removes a mark must remove the mark and nothing else.
  console.log('— the page-number rule on its own —');
  await page.evaluate(`(() => {
    const input = document.getElementById('pageno');
    input.value = '5';
    input.dispatchEvent(new Event('change'));
  })()`);
  await waitForPage(5);
  await page.evaluate(() => document.querySelector('#crop-list .crop-option[data-id="page-number"]').click());
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      return document.getElementById('crop-status').textContent.startsWith('Cropping')
        ? false
        : !!svg && svg.getAttribute('viewBox').startsWith('0 0 ') === false;
    })()`,
    'the page-number crop',
    60000,
  );
  const numbered = await cropState();
  const sliced = await cutText();
  console.log('page-number only: ' + JSON.stringify({ page: numbered.page, viewBox: numbered.viewBox, sliced }));
  if (numbered.page !== '5') fail(`expected to be on page 5, got ${numbered.page}`);
  if (sliced?.cutCount) fail(`the crop cut through ${sliced.cutCount} piece(s) of text: ${JSON.stringify(sliced.cut)}`);

  await page.evaluate(() => document.getElementById('crop-none').click());
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      return !!svg && (svg.getAttribute('viewBox') ?? '').startsWith('0 0 ');
    })()`,
    'the page to come back',
    60000,
  );
  // Leave the dropdown as it was found, whatever left it open in between (a
  // click on a page closes it, and the toggle would then open it again).
  await page.evaluate(`(() => {
    if (!document.getElementById('crop-menu').hidden) document.getElementById('crop-btn').click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  // --------------------------------------------------------- bionic reading
  /**
   * Bionic reading is a mode, and there are three things to check about it: it
   * is off until it is asked for, it is really *drawn* (a bold attribute the
   * font cannot honour would be a lie, and the attribute is the part that is
   * easy to get right), and it changes nothing else - the same characters, in
   * the same places, saying the same thing.
   *
   * It is also where the spaces are checked where a reader meets them. An
   * outline SVG has none at all: the words arrive run together, and this is the
   * assertion that says they no longer do.
   */
  console.log('— bionic reading —');
  await page.evaluate(`(() => {
    const input = document.getElementById('pageno');
    input.value = '1';
    input.dispatchEvent(new Event('change'));
  })()`);
  await waitForPage(1);

  /** The toggle, and the page in front of the reader, character by character. */
  const bionicState = () =>
    page.evaluate(`(() => {
      const sr = document.getElementById('viewer').shadowRoot;
      const shown = document.getElementById('pageno').value;
      const svg = sr.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      const button = document.getElementById('bionic-btn');
      const rect = button.getBoundingClientRect();
      const crop = document.getElementById('crop-btn').getBoundingClientRect();
      const search = document.getElementById('search-box').getBoundingClientRect();
      const texts = svg ? [...svg.querySelectorAll('text')] : [];
      const all = texts.map((t) => t.textContent).join('');
      const words = all.split(/\\s+/).filter(Boolean);
      // Every character's own start position: the page's geometry as the
      // browser resolved it, which is what "nothing moved" has to mean.
      const starts = texts.flatMap((t) => {
        const out = [];
        for (let i = 0; i < (t.textContent ?? '').length; i++) {
          try {
            const p = t.getStartPositionOfChar(i);
            out.push(Math.round(p.x * 100) / 100 + ',' + Math.round(p.y * 100) / 100);
          } catch {
            out.push('?');
          }
        }
        return out;
      });
      const bold = svg ? svg.querySelector('tspan[font-weight="bold"]') : null;
      return {
        exists: !document.getElementById('bionic-group').hidden,
        afterSearch: rect.left > search.left,
        afterCrop: rect.left > crop.left,
        square: Math.abs(rect.width - rect.height) <= 1 && rect.width >= 20,
        pressed: button.getAttribute('aria-pressed'),
        viewBox: svg ? svg.getAttribute('viewBox') : null,
        texts: texts.length,
        chars: all.length,
        words: words.length,
        // A page with no spaces in it averages tens of characters per "word".
        perWord: words.length ? Math.round((all.length / words.length) * 10) / 10 : 0,
        prose: all.slice(0, 80),
        full: all.slice(0, 4000),
        bold: svg ? svg.querySelectorAll('tspan[font-weight="bold"]').length : 0,
        weight: bold ? getComputedStyle(bold).fontWeight : null,
        starts,
      };
    })()`);

  const plainText = await bionicState();
  console.log(
    'bionic off : ' +
      JSON.stringify({
        square: plainText.square,
        afterCrop: plainText.afterCrop,
        pressed: plainText.pressed,
        texts: plainText.texts,
        words: plainText.words,
        perWord: plainText.perWord,
        prose: plainText.prose,
      }),
  );
  if (!plainText.exists) fail('the bionic toggle is not in the bar');
  if (!plainText.afterSearch || !plainText.afterCrop) fail('the bionic toggle should sit after the crop control');
  if (!plainText.square) fail('the bionic toggle should be a square button');
  if (plainText.pressed !== 'false') fail(`bionic reading should start off, got aria-pressed=${plainText.pressed}`);
  if (plainText.bold) fail(`nothing should be bold before it is asked for (${plainText.bold} runs)`);
  // The words, which is what bionic reading needs and what a reader copies.
  if (plainText.words < 100) fail(`page 1 should have real words in it, found ${plainText.words}`);
  if (plainText.perWord > 12) fail(`the page averages ${plainText.perWord} characters per word: the spaces are missing`);
  if (!/\bthe\b/.test(plainText.full)) fail(`page 1 does not read as prose: ${JSON.stringify(plainText.prose)}`);

  await page.evaluate(() => document.getElementById('bionic-btn').click());
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      return !!svg && svg.querySelectorAll('tspan[font-weight="bold"]').length > 0;
    })()`,
    'the bionic render',
    60000,
  );
  const marked = await bionicState();
  console.log('bionic on  : ' + JSON.stringify({ pressed: marked.pressed, bold: marked.bold, weight: marked.weight, texts: marked.texts }));
  if (marked.pressed !== 'true') fail(`the toggle should report itself pressed, got ${marked.pressed}`);
  if (marked.bold < 100) fail(`bionic reading marked ${marked.bold} runs, which is not every word`);
  // Bold has to be a weight the font is actually drawn at.
  if (marked.weight !== '700') fail(`the fixation points are not bold (font-weight ${marked.weight})`);
  if (marked.chars !== plainText.chars || marked.words !== plainText.words) fail('bionic reading changed the text');
  if (marked.texts !== plainText.texts) fail(`bionic reading changed the page's text elements (${plainText.texts} -> ${marked.texts})`);
  if (JSON.stringify(marked.starts) !== JSON.stringify(plainText.starts)) {
    fail('bionic reading moved a character');
  }

  // The find bar measures the characters it boxes, and those characters are now
  // one tspan deeper in the markup: it has to still find them.
  await page.evaluate(`(() => {
    const input = document.getElementById('search');
    input.value = 'attention';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(() => /^\d+\/\d+$/.test(document.getElementById('search-count')?.textContent ?? ''), {
    label: 'bionic search results',
    timeout: 60000,
  });
  const found = await searchState();
  console.log('search while bold: ' + JSON.stringify(found));
  if (found.bandsOnPage < 1) fail('the find bar lost the text when it was drawn bold');

  /**
   * How much ink the page puts down, and where its edges are - rasterised from
   * the SVG the viewer would export, so this is the drawing itself and not the
   * attributes that asked for it.
   */
  const ink = () =>
    page.evaluate(`(async () => {
      const markup = await window.webpdf.viewer().exportSvg(1);
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
      try {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('the exported SVG did not rasterize'));
          img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 612;
        canvas.height = img.naturalHeight || 792;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0, left = canvas.width, top = canvas.height, right = -1, bottom = -1;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] > 128) {
              dark++;
              if (x < left) left = x;
              if (x > right) right = x;
              if (y < top) top = y;
              if (y > bottom) bottom = y;
            }
          }
        }
        return { dark, box: [left, top, right, bottom] };
      } finally {
        URL.revokeObjectURL(url);
      }
    })()`);

  const boldInk = await ink();
  await page.evaluate(() => document.getElementById('bionic-btn').click());
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      return !!svg && svg.querySelectorAll('tspan[font-weight="bold"]').length === 0;
    })()`,
    'the plain render to come back',
    60000,
  );
  const plainInk = await ink();
  const turnedOff = await bionicState();
  console.log('ink        : ' + JSON.stringify({ plain: plainInk.dark, bionic: boldInk.dark, plainBox: plainInk.box, boldBox: boldInk.box }));
  if (!(boldInk.dark > plainInk.dark * 1.05)) fail(`bionic reading should put down more ink (${plainInk.dark} -> ${boldInk.dark})`);
  for (const [i, edge] of ['left', 'top', 'right', 'bottom'].entries()) {
    if (Math.abs(boldInk.box[i] - plainInk.box[i]) > 3) {
      fail(`bionic reading changed where the page's ink is (${edge}: ${plainInk.box[i]} -> ${boldInk.box[i]})`);
    }
  }
  if (turnedOff.pressed !== 'false' || turnedOff.bold) fail('the toggle should put the page back exactly as it was');
  if (JSON.stringify(turnedOff.starts) !== JSON.stringify(plainText.starts)) fail('turning it off did not restore the page');

  // The crop and bionic controls are independent: a crop is a window onto the
  // page, and how the text in it is drawn cannot move the window.
  await page.evaluate(() => document.querySelector('#crop-list .crop-option[data-id="page-number"]').click());
  const croppedBox = await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      const viewBox = svg?.getAttribute('viewBox') ?? '';
      return viewBox && !viewBox.startsWith('0 0 ') ? viewBox : false;
    })()`,
    'the crop',
    60000,
  );
  await page.evaluate(() => document.getElementById('bionic-btn').click());
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      return !!svg && svg.querySelectorAll('tspan[font-weight="bold"]').length > 0;
    })()`,
    'the bionic render of a cropped page',
    60000,
  );
  const croppedBold = await bionicState();
  console.log('cropped + bold: ' + JSON.stringify({ viewBox: croppedBox, boldViewBox: croppedBold.viewBox }));
  if (croppedBold.viewBox !== croppedBox) fail(`bionic reading changed the crop (${croppedBox} -> ${croppedBold.viewBox})`);
  // Back to nothing at all, which is where the next section finds the reader.
  await page.evaluate(() => document.getElementById('bionic-btn').click());
  await page.evaluate(() => document.getElementById('crop-none').click());
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = document.getElementById('viewer').shadowRoot.querySelector('.wpdf-page[data-page="' + shown + '"] svg');
      return !!svg && (svg.getAttribute('viewBox') ?? '').startsWith('0 0 ') && svg.querySelectorAll('tspan[font-weight="bold"]').length === 0;
    })()`,
    'the page and the text to come back',
    60000,
  );

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
