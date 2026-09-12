/**
 * How a page is drawn while the document's fonts are being planned.
 *
 * The core has one font path and it is the document's: a page shows real text
 * once the plan has walked the document and built its faces, and until then every
 * glyph is an outline - the same shapes in the same places, with no text layer.
 * The plan is cheap but it is not instant, so the engine starts it the moment a
 * document is open and `open` returns without waiting for it. What the reader
 * looks at in the meantime is the viewer's choice (`RenderMode`, and the dropdown
 * on the demo's card):
 *
 *   global       nothing drawn until the plan is ready, and then every page once,
 *                as text - the mode a reader starts in;
 *   progressive  the page at once, as outlines, and drawn again under the
 *                document's faces when the plan is ready.
 *
 * Three things are on trial, and they are the reason the mode exists:
 *
 *   1. a page is a node of the one document in both modes, and no frame is ever
 *      made for one;
 *   2. in `global`, the first page drawn is only drawn once the plan is ready, so
 *      it is text the first time it is on screen and is never drawn twice;
 *   3. in `progressive`, the handover to the document's faces is not something
 *      the reader can see: a page that was on screen when the plan arrived stays
 *      on screen through it.
 *
 *   node tests/browser/modes.mjs [url]
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

/**
 * What the viewer is drawing, from outside it.
 *
 * Every page is a node of the viewer's own document now, so this is one
 * `querySelectorAll` on the shadow root - and a page drawn again under the
 * document's faces is a *second* `<svg>` in the same slot for as long as the
 * handover takes, which is what `pictures` counts.
 */
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const pages = () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      return sr ? [...sr.querySelectorAll('.wpdf-page')] : [];
    };
    const pictures = (el) => [...el.querySelectorAll('svg.wpdf-page-svg')];
    window.__state = () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      if (!sr) return null;
      const rows = pages().map((el) => {
        const svgs = pictures(el);
        const withText = svgs.find((svg) => svg.querySelector('text')) ?? svgs[0] ?? null;
        const text = withText?.querySelector('text') ?? null;
        return {
          page: Number(el.dataset.page),
          pictures: svgs.length,
          family: text?.getAttribute('font-family') ?? null,
          chars: text?.textContent?.length ?? 0,
        };
      });
      return {
        frames: sr.querySelectorAll('iframe').length,
        topFonts: document.fonts.size,
        ready: window.webpdf?.plan?.()?.ready ?? null,
        mode: window.webpdf?.mode?.() ?? null,
        rows: rows.sort((a, b) => a.page - b.page),
      };
    };
    // The moment the first page is on screen, and what it was drawn in. Read
    // after the fact rather than watched for, because "the first page arrived
    // before the plan" is exactly what a test cannot ask for once it has
    // finished arriving.
    window.__firstDraw = null;
    // The card's own answer: the modes it offers (in order), the one it stars (a
    // recommendation, not a state), the one in force (aria-selected), and what
    // the button calls it.
    window.__card = () => {
      const button = document.getElementById('mode-btn');
      button.click();
      const rows = [...document.querySelectorAll('#mode-menu .menu-option')];
      const card = {
        rows: rows.map((row) => row.dataset.mode),
        starred: rows.filter((row) => row.querySelector('.star')).map((row) => row.dataset.mode),
        selected: rows.filter((row) => row.getAttribute('aria-selected') === 'true').map((row) => row.dataset.mode),
        label: document.getElementById('mode-label')?.textContent ?? '',
      };
      button.click();
      return card;
    };
    window.__frameSeen = false;
    /**
     * Whether a slot is holding a page at all. A slot that holds none is a page
     * the reader can only see as blank, which is what the handover must never
     * produce.
     */
    const holds = (el) => el.querySelector('svg.wpdf-page-svg') !== null;
    // The pages that were on screen when the plan became ready, and the ones that
    // stopped holding a page while the redraw happened. The second list is the
    // flash the handover exists to avoid.
    window.__paintedAtReady = null;
    window.__lostPaint = [];
    const tick = () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      if (sr) {
        const ready = window.webpdf?.plan?.()?.ready === true;
        if (ready && window.__paintedAtReady === null && window.__firstDraw) {
          window.__paintedAtReady = pages().filter(holds).map((el) => Number(el.dataset.page));
        }
        if (window.__paintedAtReady) {
          for (const el of pages()) {
            const page = Number(el.dataset.page);
            if (!window.__paintedAtReady.includes(page) || holds(el)) continue;
            if (!window.__lostPaint.includes(page)) window.__lostPaint.push(page);
          }
        }
        if (sr.querySelector('iframe')) window.__frameSeen = true;
        if (!window.__firstDraw) {
          const drawn = pages().find(holds);
          if (drawn) {
            window.__firstDraw = {
              pictures: pictures(drawn).length,
              topFonts: document.fonts.size,
              ready: window.webpdf?.plan?.()?.ready ?? null,
              family: drawn.querySelector('text')?.getAttribute('font-family') ?? null,
              chars: drawn.querySelector('text')?.textContent?.length ?? 0,
            };
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();`,
});

/**
 * Load the demo in one mode, open a paper through the card, and report.
 *
 * `prefer` picks the example by a substring of its URL, so a section that needs
 * a plan long enough to watch can ask for a bigger document than the one the
 * card happens to list first.
 */
async function openExample(mode, prefer = null) {
  const at = `${url}${url.includes('?') ? '&' : '?'}mode=${mode}`;
  await page.goto(at);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  // The memory belongs to the page - it is read once, at start-up, and written
  // back as the reader moves - so a section that is about where a document
  // *starts* has to clear the store and load the page again. Without this the
  // mode before it leaves the reader somewhere in the middle of the paper, and
  // page 1 is not on screen at all.
  await page.evaluate("localStorage.removeItem('webpdf.memory')");
  await page.goto(at);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  await page.evaluate(() => {
    window.__firstDraw = null;
    window.__frameSeen = false;
    window.__paintedAtReady = null;
    window.__lostPaint = [];
    document.getElementById('example-btn').click();
  });
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('#example-menu .menu-option')].map((el) => el.dataset.url).filter(Boolean),
  );
  const chosen =
    (prefer && options.find((value) => value.includes(prefer))) ??
    options.find((value) => value.startsWith(CACHED_PREFIX)) ??
    PUBLIC_EXAMPLE;
  const started = Date.now();
  await page.evaluate(
    `[...document.querySelectorAll('#example-menu .menu-option')].find((el) => el.dataset.url === ${JSON.stringify(chosen)}).click()`,
  );
  await page.waitFor(() => window.__firstDraw !== null, { label: `a page in ${mode} mode`, timeout: 120000 });
  const first = await page.evaluate('window.__firstDraw');
  return { chosen, first, firstMs: Date.now() - started };
}

try {
  /* ------------------------------------------------- outlines, then text */
  console.log('\n— progressive: outlines at once, the document’s text once the plan is ready —');
  // A hundred-page report rather than the paper the card lists first: the plan
  // for a paper is over before the first page is drawn, and a mode whose whole
  // point is what happens *while* it is not ready can only be watched on a
  // document where it is not ready yet.
  const progressive = await openExample('progressive', '2303.08774');
  console.log('  ' + JSON.stringify({ firstPageMs: progressive.firstMs, ...progressive.first }));
  if (progressive.first.family !== null) {
    // Not a failure: `open` never waits for the plan, and when the plan wins the
    // race the first page is already text. It is worth saying which happened.
    console.log('  (the plan was ready before the first page: nothing to hand over)');
  } else if (progressive.first.chars !== 0) {
    fail('page 1 was drawn before the plan with text in it, so it was not outlines');
  } else {
    ok(`page 1 drawn ${progressive.firstMs} ms after the click, as outlines, before the plan was ready`);
  }
  if (progressive.first.pictures !== 1) fail(`the first page arrived as ${progressive.first.pictures} picture(s)`);
  if (progressive.first.topFonts !== 0) fail(`the document had ${progressive.first.topFonts} faces before the plan`);

  /**
   * The pages are drawn again under the document's faces, and each old picture
   * stays until the new one has painted - so the end of the handover is the
   * outlines going, not the flag that says it started. And while that happens
   * every page that was on screen at the start of it has to keep holding a page:
   * the outlines cover the redraw, and it is the repaint that must be waited for,
   * not a blank the reader would see.
   */
  await page.waitFor(
    () => {
      const state = window.__state();
      const one = state?.rows.find((row) => row.page === 1);
      // Text in the page, and the outline picture it was drawn over now gone:
      // two pictures is the handover in progress, not the end of it.
      return state && one && one.chars > 0 && one.family !== null && one.pictures === 1 ? state : false;
    },
    { label: 'page 1 drawn again as text', timeout: 120000 },
  ).catch(async (error) => {
    console.log('  diagnostics: ' + JSON.stringify(await page.evaluate('window.__state()')));
    throw error;
  });
  const redrawn = await page.evaluate('window.__state()');
  const lost = await page.evaluate('window.__lostPaint');
  const painted = await page.evaluate('window.__paintedAtReady');
  const one = redrawn.rows.find((row) => row.page === 1);
  console.log(
    '  ' +
      JSON.stringify({
        frames: redrawn.frames,
        viewerDocumentFaces: redrawn.topFonts,
        page1: { pictures: one.pictures, chars: one.chars, family: one.family },
        paintedAtReady: painted,
        wentBlank: lost,
      }),
  );
  if (redrawn.frames !== 0) fail(`${redrawn.frames} page frame(s) were made, so the pages are not one document`);
  if (redrawn.topFonts < 1) fail('the document was told about no faces when the plan became ready');
  if (one.family === null) fail('page 1 came out of the handover with no family, so the document faces did not reach it');
  if (one.pictures !== 1) fail(`page 1 ended the handover with ${one.pictures} pictures`);
  if (lost.length) fail(`page(s) ${lost.join(', ')} went blank while the outlines were let go`);
  else if (painted) ok(`${painted.length} page(s) on screen at the plan stayed drawn throughout the handover`);

  /* ---------------------------------------------------- one document only */
  console.log('\n— global: one document, nothing drawn until the plan is ready —');
  const global = await openExample('global');
  await sleep(500);
  const state = await page.evaluate('window.__state()');
  const frameSeen = await page.evaluate('window.__frameSeen');
  console.log('  ' + JSON.stringify({ firstPageMs: global.firstMs, ...global.first, frameSeen }));
  if (frameSeen) fail('a page frame appeared in the global mode');
  if (global.first.pictures !== 1) fail(`the first page arrived as ${global.first.pictures} picture(s)`);
  if (global.first.ready !== true) fail('the global mode drew a page before the plan was ready');
  if (global.first.topFonts < 1) fail('the first global page was drawn before the document had any faces');
  if (!global.first.family) fail('the first global page has no text run');
  if (!state.rows.every((row) => row.pictures === 1)) fail('a page holds more than one picture in the global mode');
  else ok(`page 1 drawn ${global.firstMs} ms after the click, as text, only once the plan was ready, no frame ever`);

  /* ------------------------------------------------- the card, and memory */
  /**
   * Which mode a reader gets, which one they keep, and what the star means.
   *
   * With nothing on the URL it is the global mode - nothing drawn until the plan
   * is ready, and then every page once - and the card stars that row, because a
   * star here is a *recommendation* and not a state (the crop menu's star is the
   * same): the row in force is the one the menu opens on and colours. Choosing
   * another one and reading a document under it is a choice the reader made, so
   * it is remembered with that document like every other setting, and the next
   * visit builds the engine and the viewer with it - while the star stays where
   * the recommendation is.
   */
  console.log('\n— the card: the default, the reader’s own choice, and the star —');
  await page.evaluate("localStorage.removeItem('webpdf.memory')");
  await page.goto(url);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  const byDefault = await page.evaluate(() => ({ mode: window.webpdf.mode(), card: window.__card() }));
  console.log('  ' + JSON.stringify(byDefault));
  if (byDefault.mode !== 'global') fail(`a reader who has chosen nothing should start in the global mode, got ${byDefault.mode}`);
  if (byDefault.card.rows.join() !== 'global,progressive')
    fail(`the card should offer global first and progressive second, got ${JSON.stringify(byDefault.card.rows)}`);
  if (byDefault.card.starred.join() !== 'global')
    fail(`the card should star the recommended mode, got ${JSON.stringify(byDefault.card.starred)}`);
  if (byDefault.card.selected.join() !== byDefault.mode) {
    fail(`the card should mark the mode in force (${byDefault.mode}), got ${JSON.stringify(byDefault.card.selected)}`);
  }
  if (!/Global Font Only/.test(byDefault.card.label)) fail(`the card should name the mode in force, got ${JSON.stringify(byDefault.card.label)}`);
  else ok(`a fresh page starts in ${byDefault.mode}, first in the list, and the card stars it and marks it as the choice`);

  await page.evaluate(() => {
    document.getElementById('mode-btn').click();
    document.querySelector('#mode-menu .menu-option[data-mode="progressive"]').click();
  });
  const chosen = await page.evaluate(() => ({ mode: window.webpdf.mode(), label: document.getElementById('mode-label').textContent }));
  if (chosen.mode !== 'progressive') fail(`choosing progressive should take effect before the next document, got ${chosen.mode}`);
  // Read a document under the chosen mode, which is what writes the choice down.
  await openExample('progressive');
  // The memory is written once the reader settles into the document.
  await sleep(1200);
  await page.goto(url);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap again', timeout: 90000 });
  const remembered = await page.evaluate(() => ({ mode: window.webpdf.mode(), card: window.__card() }));
  console.log('  ' + JSON.stringify(remembered));
  if (remembered.mode !== 'progressive') fail(`the mode a reader chose should come back on the next visit, got ${remembered.mode}`);
  else if (remembered.card.selected.join() !== 'progressive') {
    fail(`the card should mark the remembered mode as the one in force, got ${JSON.stringify(remembered.card.selected)}`);
  } else if (remembered.card.starred.join() !== 'global') {
    fail(`the star should stay on the recommendation, got ${JSON.stringify(remembered.card.starred)}`);
  } else ok('the chosen mode came back and is marked as the choice, with the star still on the recommendation');

  // `?plan=0` predates the menu, when "do not plan" was the only other answer
  // there was; it still means "do not wait for the plan", which is progressive.
  await page.evaluate("localStorage.removeItem('webpdf.memory')");
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}plan=0`);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap with plan=0', timeout: 90000 });
  const legacy = await page.evaluate('window.webpdf.mode()');
  if (legacy !== 'progressive') fail(`?plan=0 should still mean the mode that does not wait for the plan, got ${legacy}`);
  else ok('?plan=0 still names the mode that does not wait for the plan');
} catch (error) {
  fail(String(error && error.stack ? error.stack.split('\n')[0] : error));
} finally {
  await browser.close();
}

console.log(failures ? '\nRENDER MODE CHECK FAILED' : '\nRENDER MODE CHECK PASSED');
process.exit(failures ? 1 : 0);
