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
/**
 * The rendering mode this run is about.
 *
 * The demo starts in the frame mode - a page and its own fonts per frame (see
 * `RenderMode`) - and the checks below are about the *planned* document: one
 * document, one face per font, every face before the first page and none after
 * it. So this run asks for the mode that ends there and lets the switch happen
 * before it starts. The frame half of the story, and the mode that never leaves
 * a frame, are `modes.mjs`.
 */
const at = `${url}${url.includes('?') ? '&' : '?'}mode=progressive`;
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
 * Every `@font-face` the document is told about, from before it boots.
 *
 * Registering a face is not a no-op: the font set of the document changes and
 * the browser lays out every text run in it again - every page currently
 * rendered, not just the page the face belongs to. A page carries the faces it
 * needs whether they are new or not, so the same family must never be
 * registered twice.
 */
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__faces = [];
    const insertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      const m = /@font-face\\s*\\{[^}]*font-family:\\s*'([^']+)'/.exec(String(rule));
      if (m) window.__faces.push(m[1]);
      return insertRule.call(this, rule, index);
    };

    /**
     * The pages and their fonts live in this one document, inside the viewer's
     * shadow root. The helpers below are written the way a reader would ask:
     * "the pages on screen", "the text in them", "the faces this document was
     * told about".
     */
    window.__pages = () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      if (!sr) return [];
      return [...sr.querySelectorAll('.wpdf-page')];
    };
    window.__pageSvg = (el) => el.querySelector('svg.wpdf-page-svg');
    window.__pageSvgs = () => window.__pages().map(window.__pageSvg).filter(Boolean);
    window.__svgOfPage = (n) => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      const el = sr?.querySelector('.wpdf-page[data-page="' + n + '"]');
      return el ? window.__pageSvg(el) : null;
    };
    window.__pageLinks = (kind) =>
      window.__pageSvgs().flatMap((svg) => [...svg.querySelectorAll('a[data-wpdf-link="' + kind + '"]')]);
    /** What is on screen, for a failure that is about one document too few. */
    window.__diag = () => ({
      pageno: document.getElementById('pageno')?.value ?? '',
      pagecount: document.getElementById('pagecount')?.textContent ?? '',
      framed: window.webpdf?.pagesInFrames?.() ?? null,
      frames: document.getElementById('viewer')?.shadowRoot?.querySelectorAll('iframe').length ?? -1,
      live: window.__pageSvgs().length,
      texts: window.__pageTexts().length,
      uses: window.__pageSvgs().reduce((n, svg) => n + svg.querySelectorAll('use').length, 0),
      outlines: window.__pageSvgs().reduce((n, svg) => n + (svg.querySelector('defs')?.children.length ?? 0), 0),
    });
    /** A rect in the page's own coordinates: the pages are in this document. */
    window.__pageRect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    /** What is really under a point, through the viewer's shadow root. */
    window.__elementAt = (x, y) => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      return sr ? sr.elementFromPoint(x, y) : document.elementFromPoint(x, y);
    };
    window.__pageTexts = () => window.__pageSvgs().flatMap((svg) => [...svg.querySelectorAll('text')]);
    /** Every stylesheet the pages' document carries: the faces are registered there. */
    window.__pageCss = () => {
      const doc = window.__pageSvgs()[0]?.ownerDocument ?? document;
      const sheets = [...doc.adoptedStyleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join('\\n'));
      return [...sheets, ...[...doc.querySelectorAll('style')].map((s) => s.textContent ?? '')].join('\\n');
    };
    window.__allFaces = () => {
      const out = [{ id: 'top', faces: [...(window.__faces ?? [])] }];
      const seen = new Set([document]);
      // A frame is not supposed to be there at all any more, and this is what
      // says so: every document reachable from here is walked, so a face
      // registered in one would be counted rather than hidden.
      const visit = (doc) => {
        const frames = [];
        const scan = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'IFRAME') frames.push(el);
            if (el.shadowRoot) scan(el.shadowRoot);
          }
        };
        scan(doc);
        for (const frame of frames) {
          const inner = frame.contentDocument;
          if (!inner || seen.has(inner)) continue;
          seen.add(inner);
          try {
            out.push({ id: inner.title || inner.URL, faces: [...(inner.defaultView?.__faces ?? [])] });
          } catch {
            /* cross-origin: not ours */
          }
          visit(inner);
        }
      };
      visit(document);
      return out;
    };
  })();`,
});

/**
 * A page that has never been asked to draw anything.
 *
 * The memory belongs to the page - it is read once, at start-up, and written back
 * as the reader moves - so forgetting it means clearing the store *and* loading the
 * page again. What is left is a document-free demo, which is where a section that
 * is about defaults has to start.
 */
const forgetMemory = async () => {
  await page.evaluate("localStorage.removeItem('webpdf.memory')");
  await page.goto(at);
  // The page's own handle is installed at the end of its module graph, which is
  // what says the buttons on it are wired.
  await page.waitFor(() => !!window.webpdf?.info, { label: 'the demo to come back up' });
};

/**
 * Open one of the example papers, from the dropdown on the empty card, and wait
 * until the *new* document is the one on screen.
 *
 * The click starts a fetch and an open, and both are the page's own: until they
 * finish, the viewer is still holding the document before it. Waiting for "a
 * page is drawn" would therefore be answered by the page already there, and
 * every check after it would be about the wrong document - so this waits for the
 * tab's own title to change, and then for the pages to be one document (this run
 * is `IFrame → Global Font`, so a page of the new document spends its first
 * moments in a frame).
 *
 * The value is embedded in the expression because `page.evaluate(fn, args)` takes
 * evaluation options as its second argument, not arguments for the function.
 */
const open = async (value) => {
  const before = await page.evaluate('document.title');
  await page.evaluate(`document.getElementById('example-btn').click()`);
  await page.evaluate(`(() => {
    const url = ${JSON.stringify(value)};
    const row = [...document.querySelectorAll('#example-menu .menu-option')].find((el) => el.dataset.url === url);
    if (!row) throw new Error('no example row for ' + url);
    row.click();
  })()`);
  try {
    // A predicate that carries the old title: `waitFor` calls what it is given
    // with no arguments, so the value has to be inside it.
    await page.waitFor(new Function(`return document.title !== ${JSON.stringify(before)};`), {
      label: `the document at ${value}`,
      timeout: 120000,
    });
  } catch (error) {
    console.log(
      '  open diagnostics: ' +
        JSON.stringify(
          await page.evaluate(() => ({
            title: document.title,
            pagecount: document.getElementById('pagecount')?.textContent ?? '',
            toast: document.getElementById('toast')?.textContent ?? '',
            loading: document.getElementById('progress')?.hidden === false,
          })),
        ),
    );
    console.log('  console: ' + JSON.stringify(page.consoleMessages.slice(-6)));
    throw error;
  }
  await page.waitFor(() => window.webpdf.pagesInFrames() === false, {
    label: `one document for ${value}`,
    timeout: 120000,
  });
};

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
    const bands = (root) => root.querySelectorAll('rect[data-wpdf-search]').length;
    // A band is a child of the page's own `svg`, so it is counted there rather
    // than in the document: the pages share one document now, and a
    // document-wide count would be every page's bands at once.
    const perPage = window.__pageSvgs().map((svg) => bands(svg));
    return {
      count: document.getElementById('search-count')?.textContent ?? '',
      pageno: page,
      highlights: perPage.reduce((a, b) => a + b, 0),
      activeHighlights: window
        .__pageSvgs()
        .reduce((n, svg) => n + svg.querySelectorAll('rect[data-wpdf-search="active"]').length, 0),
      // Boxes on the page we are looking at, active and inactive together.
      bandsOnPage: box && window.__pageSvg(box) ? bands(window.__pageSvg(box)) : 0,
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
    for (const svg of window.__pageSvgs()) {
      for (const a of svg.querySelectorAll('a[data-wpdf-link="${kind}"]')) {
        const r = window.__pageRect(a);
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
    const el = window.__elementAt(${cx}, ${cy});
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

/** Press Ctrl+<key> through the browser's own input pipeline, as a reader would. */
const pressCtrl = async (key) => {
  const virtualKey = key.toUpperCase().charCodeAt(0);
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      modifiers: 2, // ctrl
      key,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: virtualKey,
      nativeVirtualKeyCode: virtualKey,
    });
  }
  await new Promise((r) => setTimeout(r, 300));
};

/** Wait for a download to land, and to stop growing. */
const waitForFile = async (dir, seconds) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const name = fs.readdirSync(dir).find((each) => !each.endsWith('.crdownload'));
    if (name) {
      const size = fs.statSync(path.join(dir, name)).size;
      await new Promise((r) => setTimeout(r, 200));
      if (size > 0 && fs.statSync(path.join(dir, name)).size === size) return { name, size };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
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
      const box = sr?.querySelector('.wpdf-page[data-page="${n}"]');
      return !!box && !!window.__pageSvg(box);
    })()`,
    `page ${n} render`,
    timeout,
  );
  await new Promise((r) => setTimeout(r, 300));
};

try {
  await page.goto(at);
  // The module graph includes a 10 MB wasm fetch, so wait until the app has
  // actually finished bootstrapping before touching its UI.
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  await page.waitFor(() => !!document.getElementById('viewer'), { label: 'demo shell' });

  console.log('— loading the sample through the UI —');
  const beforeLoad = await page.evaluate(() => ({
    // The bar is the *document's* chrome: with no document open there is
    // nothing for it to hold, and the card that offers one stands alone.
    barHidden: document.querySelector('.topbar')?.hidden === true,
    emptyHidden: document.getElementById('empty')?.hidden,
    offered: ['example-btn', 'empty-open', 'mode-btn'].map((id) => !!document.getElementById(id)?.offsetParent),
    // Nothing that opens a document, and none of the controls that were taken
    // off the bar, is still in the document at all.
    gone: ['open', 'sample', 'prev', 'next', 'zoom-in', 'zoom-out', 'stats'].filter((id) => document.getElementById(id)),
    options: [...document.querySelectorAll('#example-menu .menu-option')].map((o) => o.dataset.url).filter(Boolean),
  }));
  if (!beforeLoad.barHidden) fail('the bar should not be in the way before a document is open');
  if (beforeLoad.emptyHidden !== false) fail('the empty state should be showing before a document is open');
  if (beforeLoad.offered.includes(false)) fail('the empty card should offer a file, the example papers and the rendering mode');
  // The rendering mode: three ways to draw a page while the document's fonts
  // are being planned. A star here is a recommendation and not a state - the
  // crop menu's is the same - so the starred row is the recommended mode, and
  // the row in force is the one the menu marks as selected. This run asks for
  // `IFrame → Global Font` on the URL, so that is the choice; the mode a reader
  // gets with no URL at all, and the one they are remembered as having chosen,
  // are `modes.mjs`.
  const chosenMode = await page.evaluate('window.webpdf.mode()');
  const modes = await page.evaluate(() => {
    document.getElementById('mode-btn').click();
    return [...document.querySelectorAll('#mode-menu .menu-option')].map((o) => ({
      mode: o.dataset.mode,
      starred: !!o.querySelector('.star'),
      selected: o.getAttribute('aria-selected') === 'true',
    }));
  });
  await page.evaluate(() => document.getElementById('mode-btn').click());
  const starred = modes.filter((row) => row.starred).map((row) => row.mode);
  const selected = modes.filter((row) => row.selected).map((row) => row.mode);
  if (modes.length !== 3) fail(`the rendering mode should offer three modes, got ${JSON.stringify(modes)}`);
  if (starred.join() !== 'frames') fail(`the card should star the recommended mode, got ${JSON.stringify(starred)}`);
  if (selected.join() !== chosenMode) fail(`the card should mark the mode in force (${chosenMode}), got ${JSON.stringify(selected)}`);
  if (beforeLoad.gone.length) fail(`the bar still carries ${beforeLoad.gone.join(', ')}`);
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
      return !!sr && window.__pageSvgs().length > 0;
    },
    { label: 'first page render', timeout: 90000 },
  );

  // Let the adjacent-page pre-render settle too.
  await new Promise((r) => setTimeout(r, 1500));

  const report = await page.evaluate(() => {
    const host = document.getElementById('viewer');
    const sr = host.shadowRoot;
    const svgs = window.__pageSvgs();
    // A page's faces live in the page's own document, either in an adopted
    // stylesheet or in a <style> element; the viewer's own document is not told
    // about a font at all.
    const css = window.__pageCss();
    const families = [...new Set(window.__pageTexts().map((e) => e.getAttribute('font-family')))];
    const first = svgs[0];
    const firstText = first?.querySelector('text');
    const box = first?.getBoundingClientRect();
    return {
      toast: document.getElementById('toast')?.textContent,
      pageCount: document.getElementById('pagecount')?.textContent,
      zoom: document.getElementById('zoom-value')?.value,
      zoomMenu: [...document.querySelectorAll('#zoom-menu .menu-option')].map((o) => o.textContent),
      zoomMenuOpen: document.getElementById('zoom-menu')?.hidden === false,
      // Any element of the bar that says "fit width"/"fit page" while neither
      // being the (closed) dropdown nor containing it.
      barFitLabels: [...document.querySelectorAll('.topbar *')]
        .filter((el) => !el.closest('#zoom-menu') && !el.querySelector('#zoom-menu'))
        .filter((el) => /fit (width|page)/i.test(el.textContent || '')).length,
      tocEntries: document.querySelectorAll('#toc-body .toc-item').length,
      tocOpen: document.getElementById('toc')?.hidden === false,
      emptyHidden: document.getElementById('empty')?.hidden,
      barHidden: document.querySelector('.topbar')?.hidden,
      barHeight: Math.round(document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0),
      barOverflow: Math.round((document.querySelector('.topbar')?.scrollWidth ?? 0) - (document.querySelector('.topbar')?.clientWidth ?? 0)),
      // Every control that is only a mark: no word spelled out on the bar.
      iconButtons: [...document.querySelectorAll('.topbar .btn.icon')].map((el) => ({
        id: el.id,
        words: (el.textContent ?? '').replace(/[^A-Za-z]/g, ''),
        mark: !!el.querySelector('svg'),
      })),
      title: document.title,
      icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '',
      hasStatusBar: !!document.querySelector('.statusbar'),
      hasExport: !!document.getElementById('export'),
      hasSearch: !!document.getElementById('search'),
      shadowRoot: !!sr,
      rendersInWorker: window.webpdf.viewer()?.rendersInWorker ?? null,
      slots: sr.querySelectorAll('.wpdf-page').length,
      renderedPages: svgs.length,
      textElements: window.__pageTexts().length,
      outlineUses: svgs.reduce((n, svg) => n + svg.querySelectorAll('use').length, 0),
      fontFaces: (css.match(/@font-face/g) || []).length,
      fontBytes: (css.match(/base64,([A-Za-z0-9+/=]+)/g) || []).reduce((a, m) => a + m.length, 0),
      familiesUsed: families.length,
      firstSvgBox: box ? [box.x, box.y, box.width, box.height].map((n) => Math.round(n)) : null,
      sampleText: (firstText?.textContent ?? '').slice(0, 64),
      sampleFont: firstText?.getAttribute('font-family') ?? '',
      selectable: (() => {
        if (!firstText) return false;
        const range = firstText.ownerDocument.createRange();
        range.selectNodeContents(firstText);
        return range.toString().length;
      })(),
    };
  });

  // A face belongs to the document it was registered in, and a page is drawn in
  // its own document - so the probe has to measure *there*, not in the viewer's.
  // It also has to wait: a probe taken during the `font-display: block` window
  // still reports fallback metrics.
  const applied = await page.evaluate(async () => {
    const svg = window.__pageSvgs()[0];
    const family = window.__pageTexts()[0]?.getAttribute('font-family');
    if (!svg || !family) return null;
    const doc = svg.ownerDocument;
    const box = doc.createElement('div');
    box.style.cssText = 'position:absolute;left:-9999px;top:0;font-size:100px;white-space:nowrap';
    const make = (f) => {
      const span = doc.createElement('span');
      span.textContent = 'Hamburgefonstiv 0123';
      span.style.fontFamily = `'${f}'`;
      box.appendChild(span);
      return span;
    };
    const a = make(family);
    const b = make('definitely-not-a-real-font-xyz');
    doc.body.appendChild(box);
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
  if (report.barHidden !== false) fail('the bar should be there once a document is open');
  if (report.iconButtons.some((b) => !b.mark)) fail(`an icon button has no mark: ${JSON.stringify(report.iconButtons)}`);
  if (report.iconButtons.some((b) => b.words)) fail(`an icon button spells itself out: ${JSON.stringify(report.iconButtons)}`);
  if (!report.icon) fail('the page declares no icon');
  // The tab names the document: its own title, else the file, else where it
  // came from - never a URL with its scheme on.
  if (!report.title || /:\/\//.test(report.title)) fail(`the tab title should name the document, got ${JSON.stringify(report.title)}`);
  if (!report.title.endsWith(document_.split('/').pop())) {
    fail(`the tab title should name ${JSON.stringify(document_)}, got ${JSON.stringify(report.title)}`);
  }
  if (report.hasStatusBar) fail('the status bar should be gone');
  if (report.hasExport) fail('the export button should be gone');
  if (report.hasSearch !== true) fail('the search box is missing');
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
  await page.evaluate(() => window.webpdf.viewer().zoomIn());
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
  await page.evaluate(() => window.webpdf.viewer().zoomOut());
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
  const closedByDefault = await outlineState();
  if (closedByDefault.open) fail('the outline should start closed');
  await page.evaluate(() => document.getElementById('toc-toggle').click());
  await new Promise((r) => setTimeout(r, 500));
  const openOutline = await outlineState();
  if (!openOutline.open) fail('the outline toggle did not open it');
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

  // Paging works, the window is wider than the viewport, and pages far outside
  // it are unloaded. The window is deliberately not "the visible pages": a page
  // is rendered a viewport before it is read, so that arriving at it is free.
  await page.evaluate(() => window.webpdf.viewer().nextPage());
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.webpdf.viewer().nextPage());
  await new Promise((r) => setTimeout(r, 1200));
  const after = await page.evaluate(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    const chrome = document.querySelector('.topbar')?.offsetHeight ?? 0;
    const slots = [...sr.querySelectorAll('.wpdf-page')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        page: Number(el.dataset.page),
        rendered: !!window.__pageSvg(el),
        // How far outside the viewport this page is, in viewport heights.
        away: r.bottom < chrome ? (chrome - r.bottom) / innerHeight : r.top > innerHeight ? (r.top - innerHeight) / innerHeight : 0,
      };
    });
    return {
      pageno: document.getElementById('pageno').value,
      slots: slots.length,
      rendered: slots.filter((s) => s.rendered).length,
      pages: slots.map((s) => s.page),
      visible: slots.filter((s) => s.away === 0).map((s) => s.page),
      outside: slots.filter((s) => s.away > 0),
      // What the viewer thinks it has in hand but has not put on screen.
      prepared: window.webpdf.viewer().preparedPages,
    };
  });
  console.log('after paging: ' + JSON.stringify(after));
  if (after.pageno !== '3') fail(`expected page 3, got ${after.pageno}`);
  if (!after.visible.includes(3)) fail(`page 3 is not in the viewport: ${JSON.stringify(after.visible)}`);
  if (after.rendered < 1) fail('page 3 did not render');
  if (after.outside.length === 0) fail('the window does not reach past the viewport, so a page is rendered only once it is being read');
  // Every slot is within a couple of pages of the viewport: the window is
  // bounded, so a long document does not accumulate pages.
  if (after.slots > 8) fail(`virtualisation is keeping too many slots: ${after.slots}`);
  if (after.pages.includes(10)) fail(`a page nowhere near the reader is still in the DOM: ${JSON.stringify(after.pages)}`);
  // And while the reader sits still, the pages just past the viewport are not
  // merely rendered but *installed*: they have their documents, their fonts are
  // compiled into those documents, and they are drawn. Reaching one is then a
  // scroll and nothing else - which is the promise the preparation exists to
  // keep, and the one a frame's own document makes expensive to keep late.
  const strays = after.pages.filter((p) => !after.prepared.includes(p));
  if (strays.length) fail(`a page in the DOM is not one the viewer is holding: ${JSON.stringify(strays)}`);
  const beyond = after.outside.filter((s) => s.away > 0.5);
  if (beyond.length === 0) fail(`nothing past the viewport was prepared while the reader was at rest: ${JSON.stringify(after)}`);
  const unrendered = beyond.filter((s) => !s.rendered);
  if (unrendered.length) fail(`a page prepared past the viewport was left unrendered: ${JSON.stringify(unrendered)}`);

  /**
   * A scroll defers what the reader is not looking at.
   *
   * Jumping a long way and then scrolling continuously is the case the whole
   * mechanism exists for: pages are being rendered while the reader moves, and
   * putting one in the document costs a frame - and registering the fonts it
   * brings costs a layout of every page already rendered. So a page that is
   * ready but not being looked at waits for the scroll to stop; a page the
   * reader is looking at (or one page away from it) goes in regardless, because
   * a blank page is worse than a dropped frame.
   */
  console.log('— a scroll defers what is not being looked at —');
  await page.evaluate(() => window.webpdf.viewer().goToPage(3));
  await new Promise((r) => setTimeout(r, 1500));
  const seen = [];
  for (let i = 0; i < 40; i++) {
    // Part way in, everything on screen is thrown away and has to be rendered
    // again while the reader is still moving - which is the case the deferral
    // exists for. (A mode change is the honest way to cause it: it is what a
    // reader does to a document that is already in front of them.)
    if (i === 4) await page.evaluate(() => window.webpdf.viewer().setBionic(true, 0.5));
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 640,
      y: 500,
      deltaX: 0,
      deltaY: 25,
      pointerType: 'mouse',
    });
    await new Promise((r) => setTimeout(r, 16));
    seen.push(
      await page.evaluate(() => {
        const sr = document.getElementById('viewer').shadowRoot;
        const prepared = new Set(window.webpdf.viewer().preparedPages);
        const waiting = [];
        for (const el of sr.querySelectorAll('.wpdf-page')) {
          if (window.__pageSvg(el)) continue;
          const page = Number(el.dataset.page);
          const r = el.getBoundingClientRect();
          // Looking at it, or one page away from it, which is where the haste
          // rule applies.
          const looked = r.bottom >= -r.height && r.top <= innerHeight + r.height;
          if (prepared.has(page)) waiting.push({ page, looked });
        }
        return waiting;
      }),
    );
  }
  const deferred = seen.flat();
  const deferredFar = deferred.filter((w) => !w.looked);
  const readyButBlank = deferred.filter((w) => w.looked);
  console.log(
    'during the scroll: ' +
      JSON.stringify({
        samples: seen.length,
        deferred: deferredFar.length,
        deferredPages: [...new Set(deferredFar.map((w) => w.page))],
        readyButBlank,
      }),
  );
  if (deferredFar.length === 0) fail('a page that was rendered during a scroll went in immediately, so nothing was deferred');
  if (readyButBlank.length) fail(`a page that was ready was left blank while the reader was looking at it: ${JSON.stringify(readyButBlank)}`);
  // Once the scroll stops, everything in the window is in the document - and
  // the mode that forced the renders is turned back off.
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.webpdf.viewer().setBionic(false));
  await new Promise((r) => setTimeout(r, 1500));
  const blank = await page.evaluate(`(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    return [...sr.querySelectorAll('.wpdf-page')].filter((el) => !window.__pageSvg(el)).map((el) => Number(el.dataset.page));
  })()`);
  console.log('after the scroll settles, blank pages in the window: ' + JSON.stringify(blank));
  if (blank.length) fail(`pages were left blank after the scroll stopped: ${JSON.stringify(blank)}`);

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
      await page.evaluate(() => window.webpdf.viewer().prevPage());
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
      highlights: window.__pageSvgs().reduce((n, svg) => n + svg.querySelectorAll('rect[data-wpdf-search]').length, 0),
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
      const a = [...window.__pageLinks('internal')]
        .find((el) => el.getAttribute('data-wpdf-page') !== '2');
      if (!a) return null;
      a.focus();
      // The hit areas live in the viewer's shadow root, so the active element is
      // the root's, one step in from the document's.
      return { page: a.getAttribute('data-wpdf-page'), active: (a.getRootNode()).activeElement === a };
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
          return !!sr && window.__pageSvgs().length > 0;
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
        const links = [...window.__pageLinks('external')];
        const last = links[links.length - 1];
        if (last) last.scrollIntoView({ block: 'center' });
        return links.length;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const untouchable = (await linkCandidates('external')).filter((l) => l.href === null);
      if (!untouchable.length) {
        console.log('  diagnostics: ' + JSON.stringify(await page.evaluate('window.__diag()')));
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
  // The page remembers where the reader was and how they had it set up, so this
  // section - which is about the crop control's own defaults, and about a
  // document that has not been touched - starts from a page that has never been
  // asked to draw anything. Forgetting that means a reload: the page reads its
  // memory once, at start-up.
  await forgetMemory();
  await open(document_);
  await waitForPage(1);

  /** Everything about the crop control and the page in front of the reader. */
  const cropState = () =>
    page.evaluate(`(() => {
      const sr = document.getElementById('viewer').shadowRoot;
      const host = document.getElementById('viewer');
      const shown = document.getElementById('pageno').value;
      const box = sr.querySelector('.wpdf-page[data-page="' + shown + '"]');
      const svg = box ? window.__pageSvg(box) : null;
      const items = [...document.querySelectorAll('#crop-list .crop-option')];
      const search = document.getElementById('search-box');
      const button = document.getElementById('crop-btn');
      return {
        // Where the control lives: the instruction was "after the search".
        afterSearch: !!(search.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
        rows: items.map((el) => el.dataset.id),
        // The star is a recommendation, not part of the rule's name.
        names: items.map((el) => (el.querySelector('.crop-name')?.textContent ?? '').replace('★', '')),
        checked: items.filter((el) => el.getAttribute('aria-selected') === 'true').map((el) => el.dataset.id),
        disabledRows: items.filter((el) => el.getAttribute('aria-disabled') === 'true').map((el) => el.dataset.id),
        menuOpen: !document.getElementById('crop-menu').hidden,
        lit: document.getElementById('crop-btn').dataset.on,
        face: document.getElementById('crop-btn').textContent,
        status: document.getElementById('crop-status').textContent,
        allHidden: document.getElementById('crop-all').hidden,
        noneHidden: document.getElementById('crop-none').hidden,
        // The rule the menu recommends: starred, and still unchecked.
        starred: items.filter((el) => el.querySelector('.star')).map((el) => el.dataset.id),
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
      const svg = window.__svgOfPage(shown);
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
  if (start.lit !== 'false') fail(`the crop control should be plain while nothing is checked, got ${JSON.stringify(start.lit)}`);
  // One bulk button at a time, and it says what is left to do.
  if (start.allHidden || !start.noneHidden) fail('with nothing checked, "Enable all" should be the only bulk action');
  if (start.starred.join() !== 'page-number') fail(`the menu should star the page-number rule, got ${JSON.stringify(start.starred)}`);
  if (!/^0 0 /.test(start.viewBox ?? '')) fail(`an untouched page should keep its own viewBox, got ${start.viewBox}`);
  // Padding is a margin around a crop, so with no crop there is nothing to pad.
  if (start.padding !== '6' || !start.paddingOff) {
    fail(`the padding field should start at 6pt and inert, got ${JSON.stringify({ value: start.padding, disabled: start.paddingOff })}`);
  }

  // Where the reader is, and what is in front of them: the crop has to leave
  // both alone apart from the page's size.
  await page.evaluate(`(() => {
    const input = document.getElementById('pageno');
    input.value = '3';
    input.dispatchEvent(new Event('change'));
  })()`);
  await waitForPage(3);
  const before = await cropState();

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
  // Measuring finishing is not the same moment as the page in front of the
  // reader being redrawn through the new window: the pages are re-rendered as
  // their boxes arrive, and the reader's own page is last in the queue only
  // because everything else had to be measured first.
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      const viewBox = svg?.getAttribute('viewBox') ?? '';
      return viewBox && !viewBox.startsWith('0 0 ') ? viewBox : false;
    })()`,
    'the page in front of the reader to be redrawn cropped',
    60000,
  );
  const cropped = await cropState();
  console.log('after crop  : ' + JSON.stringify({ status: all, page: cropped.page, viewBox: cropped.viewBox, box: [cropped.pageWidth, cropped.pageHeight], elements: cropped.elements }));
  console.log('kept in place: ' + JSON.stringify({ was: { page: before.page, top: before.pageTop, scrollY: before.scrollY }, now: { page: cropped.page, top: cropped.pageTop, scrollY: cropped.scrollY } }));

  const [px, py, pw, ph] = (cropped.viewBox ?? '').split(/\s+/).map(Number);
  if (!cropped.checked.length) fail('"Enable all" checked nothing');
  // The face of the control says "on" the way bionic reading's does, and says
  // nothing about how many rules that took.
  if (cropped.lit !== 'true') fail(`the crop control should light up while it is cropping, got ${JSON.stringify(cropped.lit)}`);
  if (/\d/.test(cropped.face)) fail(`the crop control should not count its rules on the bar, got ${JSON.stringify(cropped.face)}`);
  // A crop is a smaller window onto the page: inside it, and smaller than it.
  if (!(px > 0 && py >= 0 && pw > 0 && ph > 0)) fail(`the cropped viewBox is not a box: ${cropped.viewBox}`);
  if (!(px + pw <= 612.001 && py + ph <= 792.001)) fail(`the crop is not inside the page: ${cropped.viewBox}`);
  if (!(pw < 612 && ph < 792)) fail(`the crop did not trim the page: ${cropped.viewBox}`);
  if (!(cropped.pageWidth < before.pageWidth && cropped.pageHeight < before.pageHeight)) fail('the page box did not follow the crop');
  if (!(cropped.docHeight < before.docHeight)) fail('the document is no shorter than before the crop');
  // Nothing was removed to achieve it: same elements, same text runs.
  if (cropped.elements !== before.elements) fail(`cropping changed the page's elements (${before.elements} -> ${cropped.elements})`);
  if (cropped.texts !== before.texts || !cropped.texts) fail(`cropping changed the page's text (${before.texts} -> ${cropped.texts})`);
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
  if (cropped.page !== before.page) fail(`the reader moved from page ${before.page} to ${cropped.page}`);
  if (Math.abs(cropped.pageTop - before.pageTop) > 6) fail(`the page moved on screen by ${Math.abs(cropped.pageTop - before.pageTop)}px`);
  // The bulk button says what is left to do: with everything on, the only move
  // left is back.
  if (!cropped.allHidden || cropped.noneHidden) fail('once every usable rule is on, "Disable all" should be the only bulk action');
  if (!/\+6 pt/.test(cropped.status)) fail(`the default margin should be 6pt, got ${JSON.stringify(cropped.status)}`);

  // The margin is a control, not a re-measurement: it grows the box the SVG is
  // given and the pages re-lay-out around the reader.
  console.log('— a margin around the content —');
  const setPadding = async (value) => {
    await page.evaluate(`(() => {
      const input = document.getElementById('crop-padding');
      input.value = ${JSON.stringify(String(value))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    return waitUntil(
      `(() => {
        const status = document.getElementById('crop-status').textContent;
        const want = ${JSON.stringify(value)} > 0 ? ', +${value} pt' : 'minus';
        if (status.startsWith('Cropping') || !status.includes(want)) return false;
        const shown = document.getElementById('pageno').value;
        const svg = window.__svgOfPage(shown);
        return svg ? svg.getAttribute('viewBox') : false;
      })()`,
      `the ${value}pt margin to be applied`,
      60000,
    );
  };

  // No margin at all is the content box itself, which is where the arithmetic
  // below starts: the default 6 is that box grown on every side.
  const exact = (await setPadding(0)).split(/\s+/).map(Number);
  const defaulted = (await setPadding(6)).split(/\s+/).map(Number);
  const [ex, ey, ew, eh] = exact;
  const [dx, dy, dw, dh] = defaulted;
  console.log('margin 0 vs 6: ' + JSON.stringify({ content: exact, padded: defaulted }));
  if (Math.abs(dx - Math.max(0, ex - 6)) > 0.01 || Math.abs(dy - Math.max(0, ey - 6)) > 0.01) {
    fail(`6pt should grow the content box on every side, got ${defaulted} from ${exact}`);
  }
  if (Math.abs(dw - (ew + (ex - dx) + 6)) > 0.01 || Math.abs(dh - (eh + (ey - dy) + 6)) > 0.01) {
    fail(`6pt should add 6pt on every side, got ${defaulted} from ${exact}`);
  }

  const padded = await setPadding(8);
  const withMargin = await cropState();
  console.log('padded by 8 : ' + JSON.stringify({ viewBox: padded, box: [withMargin.pageWidth, withMargin.pageHeight], status: withMargin.status }));
  const [qx, qy, qw, qh] = padded.split(/\s+/).map(Number);
  if (Math.abs(qx - Math.max(0, ex - 8)) > 0.01 || Math.abs(qy - Math.max(0, ey - 8)) > 0.01) {
    fail(`padding should grow the box on every side, got ${padded} from ${exact}`);
  }
  if (Math.abs(qw - (ew + (ex - qx) + 8)) > 0.01 || Math.abs(qh - (eh + (ey - qy) + 8)) > 0.01) {
    fail(`padding should add 8pt on every side, got ${padded} from ${exact}`);
  }
  if (!(withMargin.pageWidth > cropped.pageWidth && withMargin.pageHeight > cropped.pageHeight)) fail('the page box did not follow the margin');
  if (withMargin.elements !== cropped.elements || withMargin.texts !== cropped.texts) fail('padding changed what is in the page');
  if (withMargin.page !== cropped.page || Math.abs(withMargin.pageTop - cropped.pageTop) > 6) fail('padding moved the reader');
  if (!/\+8 pt/.test(withMargin.status)) fail(`the menu should say what the margin is, got ${JSON.stringify(withMargin.status)}`);
  // And back to the content box, exactly where it started.
  const unpadded = await setPadding(0);
  if (unpadded !== exact.join(' ')) fail(`a margin of 0 should be the crop itself (${exact.join(' ')} -> ${unpadded})`);

  console.log('— one rule off, then all of them —');
  await page.evaluate(() => document.querySelector('#crop-list .crop-option[data-id="page-number"]').click());
  const one = await waitUntil(
    `(() => {
      const status = document.getElementById('crop-status').textContent;
      const svg = window.__pageSvgs()[0];
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
      const svg = window.__svgOfPage(shown);
      const viewBox = svg?.getAttribute('viewBox') ?? '';
      return viewBox.startsWith('0 0 ') && svg.querySelectorAll('text').length > 0 ? viewBox : false;
    })()`,
    'the pages to come back',
    60000,
  );
  const restored = await cropState();
  console.log('disable all : ' + JSON.stringify({ viewBox: back, box: [restored.pageWidth, restored.pageHeight], elements: restored.elements }));
  if (restored.checked.length) fail('"Disable all" left rules checked');
  if (back !== before.viewBox) fail(`disabling every rule should restore the page exactly (${before.viewBox} -> ${back})`);
  if (restored.pageWidth !== before.pageWidth || restored.pageHeight !== before.pageHeight) fail('the page box did not come back');
  if (restored.docHeight !== before.docHeight) fail(`the document height did not come back (${before.docHeight} -> ${restored.docHeight})`);

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
      const svg = window.__svgOfPage(shown);
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
      const svg = window.__svgOfPage(shown);
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
   * is off until it is asked for, it is really *drawn* (an attribute that put no
   * pixel on the page would be a lie, and the attribute is the easy part to get
   * right), and it changes nothing else - the same characters, in the same
   * places, saying the same thing.
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

  /**
   * Choose a row of the bionic menu by what it says. The control is a dropdown
   * - off, or a fade - so this is how the mode is turned on, turned off, and
   * moved to another value.
   */
  const chooseBionic = async (match) => {
    await page.evaluate(`document.getElementById('bionic-btn').click()`);
    await page.evaluate(`(() => {
      const want = ${JSON.stringify(match)};
      const row = [...document.querySelectorAll('#bionic-menu .menu-option')]
        .find((el) => el.querySelector('.menu-name').textContent.includes(want));
      if (!row) throw new Error('no bionic row matching ' + want);
      row.click();
    })()`);
  };

  /** The value in force, and what the menu says about it. */
  const bionicMenu = async () => {
    await page.evaluate(`document.getElementById('bionic-btn').click()`);
    const state = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#bionic-menu .menu-option')];
      const name = (el) => el.querySelector('.menu-name').textContent.replace('★', '').trim();
      return {
        rows: rows.map(name),
        star: name(rows.find((el) => el.querySelector('.star')) ?? rows[0]),
        chosen: rows.filter((el) => el.getAttribute('aria-selected') === 'true').map(name),
      };
    })()`);
    await page.evaluate(`document.getElementById('bionic-btn').click()`);
    return state;
  };

  /** The control, and the page in front of the reader, character by character. */
  const bionicState = () =>
    page.evaluate(`(() => {
      const sr = document.getElementById('viewer').shadowRoot;
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
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
      const faded = svg ? svg.querySelector('tspan[fill-opacity]') : null;
      const fixation = svg ? svg.querySelector('tspan:not([fill-opacity])') : null;
      return {
        exists: !document.getElementById('bionic-group').hidden,
        afterSearch: rect.left > search.left,
        afterCrop: rect.left > crop.left,
        face: button.textContent.trim(),
        on: window.webpdf.viewer().bionic,
        dim: window.webpdf.viewer().bionicDim,
        viewBox: svg ? svg.getAttribute('viewBox') : null,
        texts: texts.length,
        chars: all.length,
        words: words.length,
        // A page with no spaces in it averages tens of characters per "word".
        perWord: words.length ? Math.round((all.length / words.length) * 10) / 10 : 0,
        prose: all.slice(0, 80),
        full: all.slice(0, 4000),
        faded: svg ? svg.querySelectorAll('tspan[fill-opacity]').length : 0,
        opacity: faded ? getComputedStyle(faded).fillOpacity : null,
        // Nothing may be emboldened: the rebuilt fonts have one weight, so a
        // bold here is the browser's synthetic smearing.
        weighted: svg ? svg.querySelectorAll('[font-weight="bold"]').length : 0,
        weight: fixation ? getComputedStyle(fixation).fontWeight : null,
        starts,
      };
    })()`);

  const plainText = await bionicState();
  console.log(
    'bionic off : ' +
      JSON.stringify({
        face: plainText.face,
        afterCrop: plainText.afterCrop,
        on: plainText.on,
        texts: plainText.texts,
        words: plainText.words,
        perWord: plainText.perWord,
        prose: plainText.prose,
      }),
  );
  if (!plainText.exists) fail('the bionic control is not in the bar');
  if (!plainText.afterSearch || !plainText.afterCrop) fail('the bionic control should sit after the crop control');
  if (!/^B/.test(plainText.face)) fail(`the bionic control should be its own letter, got ${JSON.stringify(plainText.face)}`);
  if (plainText.on !== false || plainText.face !== 'B▾') fail(`bionic reading should start off, got ${JSON.stringify({ on: plainText.on, face: plainText.face })}`);
  // The menu of values, before anything is faded: off is what is in force, and
  // the star is on the default fade.
  const beforeMenu = await bionicMenu();
  console.log('bionic menu: ' + JSON.stringify(beforeMenu));
  if (beforeMenu.rows[0] !== 'Off' || !beforeMenu.rows.some((r) => /^Fade the rest to \d+%$/.test(r))) {
    fail(`the bionic menu should offer off and a set of fades, got ${JSON.stringify(beforeMenu.rows)}`);
  }
  if (beforeMenu.chosen.join() !== 'Off') fail(`nothing is faded yet, so "Off" is the value in force, got ${JSON.stringify(beforeMenu.chosen)}`);
  if (beforeMenu.star !== 'Fade the rest to 50%') fail(`the default fade should be starred, got ${JSON.stringify(beforeMenu.star)}`);
  if (plainText.faded) fail(`nothing should be faded before it is asked for (${plainText.faded} runs)`);
  // The words, which is what bionic reading needs and what a reader copies.
  if (plainText.words < 100) fail(`page 1 should have real words in it, found ${plainText.words}`);
  if (plainText.perWord > 12) fail(`the page averages ${plainText.perWord} characters per word: the spaces are missing`);
  if (!/\bthe\b/.test(plainText.full)) fail(`page 1 does not read as prose: ${JSON.stringify(plainText.prose)}`);

  await chooseBionic('50%');
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      return !!svg && svg.querySelectorAll('tspan[fill-opacity]').length > 0;
    })()`,
    'the bionic render',
    60000,
  );
  const marked = await bionicState();
  console.log('bionic on  : ' + JSON.stringify({ on: marked.on, dim: marked.dim, faded: marked.faded, opacity: marked.opacity, weighted: marked.weighted, texts: marked.texts }));
  if (marked.on !== true || marked.face !== 'B▾') fail(`the control should report the mode on, got ${JSON.stringify({ on: marked.on, face: marked.face })}`);
  if (marked.faded < 100) fail(`bionic reading faded ${marked.faded} runs, which is not the rest of every word`);
  // The fade has to be a real one, at the strength the library defaults to.
  if (Number(marked.opacity) > 0.6 || Number(marked.opacity) < 0.4) fail(`the faded text is drawn at ${marked.opacity}`);
  if (Math.abs(marked.dim - 0.5) > 1e-9) fail(`the default fade should be a half, got ${marked.dim}`);

  // The fade is a setting, and the star follows it: 30% is a different page
  // drawn from the same characters.
  console.log('— the fade is configurable —');
  await chooseBionic('30%');
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      const faded = svg?.querySelector('tspan[fill-opacity]');
      return !!faded && Number(getComputedStyle(faded).fillOpacity) < 0.4;
    })()`,
    'the 30% fade',
    60000,
  );
  const fainter = await bionicState();
  const fainterMenu = await bionicMenu();
  console.log('bionic 30% : ' + JSON.stringify({ dim: fainter.dim, opacity: fainter.opacity, star: fainterMenu.star, chosen: fainterMenu.chosen }));
  if (Math.abs(fainter.dim - 0.3) > 1e-9) fail(`choosing 30% should set the fade to 0.3, got ${fainter.dim}`);
  if (Math.abs(Number(fainter.opacity) - 0.3) > 0.02) fail(`the faded text should be drawn at 0.3, got ${fainter.opacity}`);
  if (fainterMenu.star !== 'Fade the rest to 30%') fail(`the star should have moved to 30%, got ${JSON.stringify(fainterMenu.star)}`);
  if (fainterMenu.chosen.join() !== 'Fade the rest to 30%') fail(`30% should be the value in force, got ${JSON.stringify(fainterMenu.chosen)}`);
  if (fainter.chars !== marked.chars || JSON.stringify(fainter.starts) !== JSON.stringify(marked.starts)) {
    fail('changing the fade changed the text or moved a character');
  }
  // Back to the default for the ink measurements below.
  await chooseBionic('50%');
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      const faded = svg?.querySelector('tspan[fill-opacity]');
      return !!faded && Math.abs(Number(getComputedStyle(faded).fillOpacity) - 0.5) < 0.02;
    })()`,
    'the default fade to come back',
    60000,
  );
  // And nothing is emboldened: a synthetic bold would smear the letterforms and
  // crowd the character after it.
  if (marked.weighted) fail(`${marked.weighted} element(s) were emboldened`);
  if (marked.weight !== '400') fail(`the fixation points are not at the font's own weight (${marked.weight})`);
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
  console.log('search while faded: ' + JSON.stringify(found));
  if (found.bandsOnPage < 1) fail('the find bar lost the text when it was faded');

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
        let dark = 0, mass = 0, left = canvas.width, top = canvas.height, right = -1, bottom = -1;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            const alpha = data[i + 3] / 255;
            // Ink as the eye receives it: how dark the pixel is, not how many
            // pixels passed a threshold - a faded glyph is the same glyph with
            // less of it, which no single cut-off measures.
            mass += alpha * (1 - (data[i] + data[i + 1] + data[i + 2]) / (3 * 255));
            if (alpha > 0.5) {
              dark++;
              if (x < left) left = x;
              if (x > right) right = x;
              if (y < top) top = y;
              if (y > bottom) bottom = y;
            }
          }
        }
        const round = (n) => Math.round(n * 100) / 100;
        return { dark, mass: round(mass), perMille: round((1000 * mass) / (canvas.width * canvas.height)), box: [left, top, right, bottom] };
      } finally {
        URL.revokeObjectURL(url);
      }
    })()`);

  const fadedInk = await ink();
  await chooseBionic('Off');
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      return !!svg && svg.querySelectorAll('tspan[fill-opacity]').length === 0;
    })()`,
    'the plain render to come back',
    60000,
  );
  const plainInk = await ink();
  const turnedOff = await bionicState();
  console.log('ink        : ' + JSON.stringify({ plain: plainInk.perMille, bionic: fadedInk.perMille, plainBox: plainInk.box, fadedBox: fadedInk.box }));
  // Fading has to be visible: the page loses around a tenth of its ink, since
  // the fixation points stay at full strength and the rules and figures on the
  // page are drawings, which nothing fades.
  if (!(fadedInk.mass < plainInk.mass * 0.95)) fail(`bionic reading should lighten the page (${plainInk.mass} -> ${fadedInk.mass})`);
  // The same page with the same edges: the light is turned down, nothing moved
  // and nothing grew.
  for (const [i, edge] of ['left', 'top', 'right', 'bottom'].entries()) {
    if (Math.abs(fadedInk.box[i] - plainInk.box[i]) > 3) {
      fail(`bionic reading changed where the page's ink is (${edge}: ${plainInk.box[i]} -> ${fadedInk.box[i]})`);
    }
  }
  if (turnedOff.on !== false || turnedOff.face !== 'B▾' || turnedOff.faded) fail('choosing "Off" should put the page back exactly as it was');
  if (JSON.stringify(turnedOff.starts) !== JSON.stringify(plainText.starts)) fail('turning it off did not restore the page');

  // The crop and bionic controls are independent: a crop is a window onto the
  // page, and how the text in it is drawn cannot move the window.
  await page.evaluate(() => document.querySelector('#crop-list .crop-option[data-id="page-number"]').click());
  const croppedBox = await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      const viewBox = svg?.getAttribute('viewBox') ?? '';
      return viewBox && !viewBox.startsWith('0 0 ') ? viewBox : false;
    })()`,
    'the crop',
    60000,
  );
  await chooseBionic('50%');
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      return !!svg && svg.querySelectorAll('tspan[fill-opacity]').length > 0;
    })()`,
    'the bionic render of a cropped page',
    60000,
  );
  const croppedFaded = await bionicState();
  console.log('cropped + faded: ' + JSON.stringify({ viewBox: croppedBox, fadedViewBox: croppedFaded.viewBox }));
  if (croppedFaded.viewBox !== croppedBox) fail(`bionic reading changed the crop (${croppedBox} -> ${croppedFaded.viewBox})`);
  // Back to nothing at all, which is where the next section finds the reader.
  await chooseBionic('Off');
  await page.evaluate(() => document.getElementById('crop-none').click());
  await waitUntil(
    `(() => {
      const shown = document.getElementById('pageno').value;
      const svg = window.__svgOfPage(shown);
      return !!svg && (svg.getAttribute('viewBox') ?? '').startsWith('0 0 ') && svg.querySelectorAll('tspan[fill-opacity]').length === 0;
    })()`,
    'the page and the text to come back',
    60000,
  );

  // ------------------------------------------------------------- the fonts
  /**
   * Every face goes in once, when the plan is ready, and never again.
   *
   * This is the cost that used to land on a page boundary: telling a document
   * about a `@font-face` makes the browser lay out every text run in that
   * document again, so a page arriving with a face of its own used to re-lay-out
   * the whole viewport. The engine plans the document's fonts - one face per
   * *font*, not per page - in the background, and the viewer writes all of them
   * into its own document in one go the moment the plan is ready, replacing the
   * frames the pages were drawn in until then. After that there is one document,
   * no page is a document of its own, and a redraw (a fade on and off, which
   * re-renders every page) registers nothing at all.
   */
  console.log('— every face goes in once, when the plan is ready —');
  await page.waitFor(() => window.webpdf.pagesInFrames() === false, {
    label: 'the pages to become one document',
    timeout: 90000,
  });
  const facesBefore = await page.evaluate('window.__allFaces()');
  const framesBefore = await page.evaluate(
    "document.getElementById('viewer').shadowRoot.querySelectorAll('iframe').length",
  );
  await page.evaluate(() => window.webpdf.viewer().setBionic(true, 0.4));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.webpdf.viewer().setBionic(false));
  await new Promise((r) => setTimeout(r, 1500));
  const facesAfter = await page.evaluate('window.__allFaces()');
  const total = (docs) => docs.reduce((n, d) => n + d.faces.length, 0);
  const repeated = facesAfter.flatMap((d) => {
    const seen = new Set();
    return d.faces.filter((f) => (seen.has(f) ? true : (seen.add(f), false))).map((f) => `${d.id}:${f}`);
  });
  const top = facesAfter.find((d) => d.id === 'top');
  console.log(
    'fonts: ' +
      JSON.stringify({
        documents: facesAfter.length,
        registered: total(facesAfter),
        inTheViewerDocument: top?.faces.length ?? 0,
        perPageDocuments: facesAfter.length - 1,
        pageFrames: framesBefore,
        repeated: repeated.length,
        afterRedraw: total(facesAfter) - total(facesBefore),
      }),
  );
  if (total(facesAfter) === 0) fail('no font face was registered at all, so the pages are not drawn with the fonts they were built with');
  if (framesBefore) fail(`${framesBefore} page frame(s) are still in the viewer: a page should not need a document of its own`);
  // Every face in the one document the pages are in. (The demo shell's own print
  // frame is a document too, and it holds none.)
  const withFaces = facesAfter.filter((d) => d.faces.length > 0).length;
  if (withFaces !== 1) fail(`the pages' faces are spread over ${withFaces} documents; a planned document should be one`);
  if (repeated.length) fail(`the same font face was registered twice in one document: ${JSON.stringify(repeated.slice(0, 4))}`);
  if (total(facesAfter) !== total(facesBefore)) {
    fail(`re-rendering the pages registered ${total(facesAfter) - total(facesBefore)} more font faces (the document already had them)`);
  }

  // The claim the whole plan exists for: past the first page, scrolling a
  // planned document registers nothing - so the browser is never asked to lay
  // the document out again while the reader is reading it.
  console.log('— and no page after the first registers anything —');
  const far = Number(await page.evaluate('window.webpdf.info().pageCount'));
  await page.evaluate(`(() => {
    const input = document.getElementById('pageno');
    input.value = ${JSON.stringify(String(far))};
    input.dispatchEvent(new Event('change'));
  })()`);
  await waitForPage(far);
  await new Promise((r) => setTimeout(r, 900));
  const facesLast = await page.evaluate('window.__allFaces()');
  const framesAfter = await page.evaluate(
    "document.getElementById('viewer').shadowRoot.querySelectorAll('iframe').length",
  );
  console.log('  ' + JSON.stringify({ lastPage: far, documents: facesLast.length, registered: total(facesLast), pageFrames: framesAfter }));
  if (total(facesLast) !== total(facesAfter)) {
    fail(`reaching the last page registered ${total(facesLast) - total(facesAfter)} more font faces`);
  }
  if (framesAfter) fail(`${framesAfter} page frame(s) appeared on the way to the last page`);

  // ------------------------------------------------------------- the bar
  /**
   * The bar is one line at every width. It is the only chrome above the pages,
   * so a bar that wrapped would cost the document a row of height on exactly the
   * windows that can least afford one - and it holds no way to open a document,
   * in either case: that lives on the card, where a reader who has none is
   * looking (see the check on the empty state above).
   */
  console.log('— the bar, at every width —');
  const barAt = async (width) => {
    await page.setViewport(width, 820);
    await new Promise((r) => setTimeout(r, 450));
    return page.evaluate(() => {
      const bar = document.querySelector('.topbar');
      const r = bar.getBoundingClientRect();
      const bionic = document.getElementById('bionic-btn').getBoundingClientRect();
      return {
        width: innerWidth,
        height: Math.round(r.height),
        overflow: Math.round(bar.scrollWidth - bar.clientWidth),
        right: Math.round(bionic.right),
      };
    });
  };
  for (const width of [1440, 1024, 768, 560, 430, 360]) {
    const state = await barAt(width);
    console.log(`  ${width}px: ${state.height}px tall, ${state.overflow}px of overflow`);
    if (state.height > 52) fail(`the bar wrapped to ${state.height}px at ${width}px`);
    if (state.overflow > 1) fail(`the bar overflows its window by ${state.overflow}px at ${width}px`);
    if (state.right > width) fail(`the controls run past the right edge at ${width}px (${state.right})`);
  }
  await page.setViewport(1440, 900);
  await new Promise((r) => setTimeout(r, 450));

  // ------------------------------------------------- scrolling and chrome
  /**
   * A scroll of the pages puts the chrome away, the way a pinch does. What
   * counts is the reader's *intent*: the viewer scrolls the document itself for
   * a link, a page jump or a crop, and closing the panel the reader gave that
   * command from would be the wrong answer.
   */
  console.log('— a scroll puts the chrome away —');
  const chromeState = () =>
    page.evaluate(() => ({
      outline: document.getElementById('toc').hidden === false,
      zoom: document.getElementById('zoom-menu').hidden === false,
      crop: document.getElementById('crop-menu').hidden === false,
      bionic: document.getElementById('bionic-menu').hidden === false,
    }));
  await page.evaluate(`(() => {
    document.getElementById('toc-toggle').click();
    document.getElementById('zoom-menu-btn').click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const chromeOpen = await chromeState();
  if (!chromeOpen.outline || !chromeOpen.zoom) fail(`the outline and the dropdown should both be open, got ${JSON.stringify(chromeOpen)}`);
  await page.evaluate(() => window.webpdf.viewer().goToPage(3));
  await waitForPage(3);
  const afterJump = await chromeState();
  if (!afterJump.outline || !afterJump.zoom) fail('a page jump the reader asked for should leave the chrome alone');
  await page.evaluate(`window.dispatchEvent(new WheelEvent('wheel', { deltaY: 320, bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  const afterWheel = await chromeState();
  console.log('after a wheel: ' + JSON.stringify(afterWheel));
  if (afterWheel.outline || afterWheel.zoom) fail('a scroll should put the outline and the dropdown away');
  // The keyboard scrolls too, and the same rule applies to it.
  await page.evaluate(`(() => {
    document.getElementById('toc-toggle').click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  if ((await chromeState()).outline) fail('PageDown should put the outline away too');

  // ------------------------------------------------------------- the icon
  console.log('— the site icon —');
  const icon = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]') ?? document.querySelector('link[rel="icon"]');
    if (!link) return { href: null };
    const res = await fetch(link.href);
    const body = await res.text();
    return { href: link.getAttribute('href'), ok: res.ok, svg: body.includes('<svg') };
  });
  console.log('icon: ' + JSON.stringify(icon));
  if (!icon.href) fail('the page declares no icon');
  else if (!icon.ok || !icon.svg) fail(`the icon did not load: ${JSON.stringify(icon)}`);

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
      return !!sr && window.__pageSvgs().length > 0;
    },
    { label: 'example render', timeout: 120000 },
  );
  await new Promise((r) => setTimeout(r, 1500));
  const remote = await page.evaluate(() => {
    const sr = document.getElementById('viewer').shadowRoot;
    const text = window.__pageTexts().map((t) => t.textContent).join(' ');
    return {
      pages: document.getElementById('pagecount')?.textContent,
      textElements: window.__pageTexts().length,
      outline: document.querySelectorAll('#toc-body .toc-item').length,
      title: document.title,
      rendersInWorker: window.webpdf.viewer()?.rendersInWorker ?? null,
      prose: /encoder/i.test(text),
    };
  });
  console.log('example: ' + JSON.stringify(remote));
  if (remote.textElements < 20) console.log('  diagnostics: ' + JSON.stringify(await page.evaluate('window.__diag()')));
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

  // ------------------------------------------- the document, kept and printed
  // Two keys that mean the document rather than this page. What is on screen is
  // a drawing of the document - SVG the viewer built, one text run at a time -
  // and the browser's own answers would both be about the page instead: Ctrl+S
  // would write this HTML, and Ctrl+P would print the drawing of it.
  console.log('— Ctrl+S saves the document, not the page —');
  const downloads = path.join(here, 'out', 'downloads');
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.mkdirSync(downloads, { recursive: true });
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await pressCtrl('s');
  const saved = await waitForFile(downloads, 20);
  const magic = saved ? fs.readFileSync(path.join(downloads, saved.name)).subarray(0, 5).toString('latin1') : '';
  console.log('saved: ' + JSON.stringify(saved) + ' starting ' + JSON.stringify(magic));
  if (!saved) fail('Ctrl+S wrote nothing');
  else if (!saved.name.endsWith('.pdf')) fail(`Ctrl+S saved "${saved.name}", which is not a document`);
  // This page is tens of kilobytes; the paper it is drawing is megabytes. That
  // gap is the whole difference between the document and the HTML around it.
  else if (saved.size < 500_000) fail(`Ctrl+S wrote ${saved.size} bytes, which is the page rather than the document`);
  else if (magic !== '%PDF-') fail(`Ctrl+S wrote bytes starting ${JSON.stringify(magic)}, which is not a PDF`);

  console.log('— Ctrl+P prints the document, not the page —');
  await pressCtrl('p');
  const printed = await page.evaluate(`(async () => {
    const deadline = Date.now() + 20000;
    let frame = null;
    while (Date.now() < deadline) {
      frame = document.getElementById('print');
      if (frame && frame.src.startsWith('blob:')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!frame || !frame.src.startsWith('blob:')) return { ok: false };
    const res = await fetch(frame.src);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      ok: true,
      type: res.headers.get('content-type'),
      size: bytes.length,
      magic: String.fromCharCode(...bytes.slice(0, 5)),
    };
  })()`);
  console.log('printed: ' + JSON.stringify(printed));
  if (!printed.ok) fail('Ctrl+P put no document in the print frame');
  else if (printed.type !== 'application/pdf') fail(`the print frame holds ${printed.type}`);
  else if (printed.magic !== '%PDF-') fail(`the print frame holds ${JSON.stringify(printed.magic)}, which is not a PDF`);
  // The same document Ctrl+S wrote, written out by the engine a second time: a
  // printer is handed the document, not the SVG pages on screen.
  else if (!saved || Math.abs(printed.size - saved.size) > 4096) {
    fail(`the printed document is ${printed.size} bytes and the saved one ${saved?.size ?? 0}`);
  }

  await shot(out);
} finally {
  await page.close();
  await browser.close();
}

console.log(process.exitCode ? 'DEMO CHECK FAILED' : 'DEMO CHECK PASSED');
