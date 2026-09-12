/**
 * How a page is drawn while the document's fonts are being planned.
 *
 * The engine plans a document's fonts the moment it is open - one `@font-face`
 * per *font*, for every page of it - and the plan costs 0.6-2.3 s for a corpus
 * paper. Nothing waits for it: `open` returns as soon as the document is read,
 * and what the reader looks at in the meantime is the viewer's choice
 * (`RenderMode`, and the dropdown on the demo's card):
 *
 *   frames       a frame and its own fonts per page, nothing shared, and no
 *                plan at all - the mode a reader starts in;
 *   progressive  frames until the plan is ready, then one document;
 *   global       one document, and nothing drawn until the plan is ready.
 *
 * Two things are on trial, and they are the reason the mode exists:
 *
 *   1. every mode shows a page without waiting for the plan, and none of them
 *      ever waits on a network or a timer to do it;
 *   2. in `frames`, the faces a page brings are registered in that page's own
 *      document - a page arriving cannot make the browser lay out any other
 *      page, which is the property the whole design is for.
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
 * A page is a frame's document while the pages are drawn one to a frame, and
 * the slot's own child after the switch, so every question here is asked of
 * whichever document holds the page - and the viewer's own document is asked
 * about separately, because *that* is the one whose layout a page's fonts must
 * never invalidate.
 */
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__state = () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      if (!sr) return null;
      const rows = [...sr.querySelectorAll('.wpdf-page')].map((el) => {
        const frame = el.querySelector('iframe');
        const doc = frame?.contentDocument ?? el;
        const svg = doc.querySelector('svg.wpdf-page-svg');
        const text = svg?.querySelector('text');
        return {
          page: Number(el.dataset.page),
          framed: !!frame,
          fonts: frame ? (doc.fonts?.size ?? -1) : -1,
          family: text?.getAttribute('font-family') ?? null,
          chars: text?.textContent?.length ?? 0,
        };
      });
      return {
        frames: sr.querySelectorAll('iframe').length,
        topFonts: document.fonts.size,
        framed: window.webpdf?.pagesInFrames?.() ?? null,
        mode: window.webpdf?.mode?.() ?? null,
        rows: rows.sort((a, b) => a.page - b.page),
      };
    };
    // The moment the first page is on screen, and what it was drawn in. Read
    // after the fact rather than watched for, because "the first page arrived
    // before the plan" is exactly what a test cannot ask for once it has
    // finished arriving.
    window.__firstDraw = null;
    // The card's own answer: the three modes it offers, the one it stars (a
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
    const tick = () => {
      const sr = document.getElementById('viewer')?.shadowRoot;
      if (sr) {
        if (sr.querySelector('iframe')) window.__frameSeen = true;
        if (!window.__firstDraw) {
          const drawn = [...sr.querySelectorAll('.wpdf-page')].find((el) =>
            (el.querySelector('iframe')?.contentDocument ?? el).querySelector('svg.wpdf-page-svg'),
          );
          if (drawn) {
            const doc = drawn.querySelector('iframe')?.contentDocument ?? drawn;
            window.__firstDraw = {
              framed: window.webpdf?.pagesInFrames?.() ?? null,
              frames: sr.querySelectorAll('iframe').length,
              topFonts: document.fonts.size,
              family: doc.querySelector('text')?.getAttribute('font-family') ?? null,
            };
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();`,
});

/** Load the demo in one mode, open a paper through the card, and report. */
async function openExample(mode) {
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
    document.getElementById('example-btn').click();
  });
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('#example-menu .menu-option')].map((el) => el.dataset.url).filter(Boolean),
  );
  const chosen = options.find((value) => value.startsWith(CACHED_PREFIX)) ?? PUBLIC_EXAMPLE;
  const started = Date.now();
  await page.evaluate(
    `[...document.querySelectorAll('#example-menu .menu-option')].find((el) => el.dataset.url === ${JSON.stringify(chosen)}).click()`,
  );
  await page.waitFor(() => window.__firstDraw !== null, { label: `a page in ${mode} mode`, timeout: 120000 });
  const first = await page.evaluate('window.__firstDraw');
  return { chosen, first, firstMs: Date.now() - started };
}

try {
  /* ------------------------------------------------------- a frame a page */
  console.log('\n— frames: a page is a document of its own —');
  const frames = await openExample('frames');
  console.log('  ' + JSON.stringify({ firstPageMs: frames.firstMs, ...frames.first }));
  if (frames.first.framed !== true) fail('the first page was not drawn in a frame in the frame mode');
  if (frames.first.frames < 1) fail('no page frame is open in the frame mode');
  if (frames.first.topFonts !== 0) fail(`the viewer's document was told about ${frames.first.topFonts} faces`);
  if (!frames.first.family) fail('the first page has no text run, so nothing is proven about where its fonts are');
  else ok(`page 1 drawn ${frames.firstMs} ms after the click, in a frame of its own, viewer document untouched`);

  // The viewer's document is never told about a font, whatever the reader does.
  const framed = await page.evaluate('window.__state()');
  if (!framed.rows.some((row) => row.fonts > 0)) fail('a page frame registered no fonts of its own');
  if (framed.topFonts !== 0) fail(`${framed.topFonts} faces reached the viewer's document in the frame mode`);
  else ok(`${framed.rows.length} page frame(s), each with its own faces (${framed.rows.map((r) => r.fonts).join(', ')}), viewer document clean`);

  /**
   * And a page arriving touches nothing else.
   *
   * This is the property frames exist for. The pages on screen have their own
   * documents with their own faces; a page that arrives with a face nobody has
   * seen registers it in *its* document, and every document that was already
   * there is left exactly as it was.
   */
  const before = await page.waitFor(
    () => {
      const state = window.__state();
      // Two pages, both drawn: a page whose slot is still empty has no frame
      // yet, and "unchanged" would be true of it for the wrong reason.
      return state && state.rows.filter((row) => row.fonts > 0).length >= 2 ? state : false;
    },
    { label: 'two pages drawn one to a frame', timeout: 60000 },
  );
  const scrollBy = await page.evaluate('Math.round(innerHeight * 0.5)');
  for (let i = 0; i < 3; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 700,
      y: 500,
      deltaX: 0,
      deltaY: scrollBy,
      pointerType: 'mouse',
    });
    await sleep(180);
  }
  await sleep(2500);
  const after = await page.evaluate('window.__state()');
  const survived = before.rows.filter(
    (row) => row.fonts > 0 && after.rows.some((now) => now.page === row.page),
  );
  const disturbed = survived.filter((row) => after.rows.find((now) => now.page === row.page).fonts !== row.fonts);
  console.log(
    '  ' +
      JSON.stringify({
        pagesBefore: before.rows.map((r) => `${r.page}:${r.fonts}`),
        pagesAfter: after.rows.map((r) => `${r.page}:${r.fonts}`),
        viewerDocumentFaces: after.topFonts,
      }),
  );
  if (!survived.length) fail('every page on screen was replaced by the scroll, so nothing could be compared');
  else if (disturbed.length) {
    fail(`a page arriving changed the fonts of ${disturbed.length} other page(s): ${JSON.stringify(disturbed.map((r) => r.page))}`);
  } else if (after.topFonts !== 0) fail(`${after.topFonts} faces reached the viewer's document while scrolling`);
  else ok(`${survived.length} page document(s) unchanged by the pages arriving after them`);
  if (!after.rows.some((row) => row.fonts > 0)) fail('no page frame has fonts after scrolling');

  /* ------------------------------------------------- frames into one document */
  console.log('\n— progressive: frames first, one document once the plan is ready —');
  const progressive = await openExample('progressive');
  console.log('  ' + JSON.stringify({ firstPageMs: progressive.firstMs, ...progressive.first }));
  if (progressive.first.framed !== true) {
    fail('the first page was not drawn in a frame, so the reader waited for the plan');
  } else {
    ok(`page 1 drawn ${progressive.firstMs} ms after the click, before the plan was ready`);
  }
  const framedFamily = progressive.first.family;
  const switching = Date.now();
  await page.waitFor(() => window.webpdf.pagesInFrames() === false, {
    label: 'the switch to one document',
    timeout: 120000,
  });
  const switchMs = Date.now() - switching;
  // The pages are drawn again, under the document's faces, so the slot is not
  // finished until its text is back.
  const switched = await page.waitFor(
    () => {
      const state = window.__state();
      const one = state?.rows.find((row) => row.page === 1);
      return one && !one.framed && one.chars > 0 && one.family !== null ? state : false;
    },
    { label: 'page 1 drawn again as one document', timeout: 60000 },
  ).catch(async (error) => {
    console.log('  diagnostics: ' + JSON.stringify(await page.evaluate('window.__state()')));
    throw error;
  });
  const one = switched.rows.find((row) => row.page === 1);
  console.log(
    '  ' +
      JSON.stringify({
        switchMs,
        frames: switched.frames,
        viewerDocumentFaces: switched.topFonts,
        page1: { framed: one.framed, chars: one.chars, family: one.family },
      }),
  );
  if (switched.frames !== 0) fail(`${switched.frames} page frame(s) survived the switch`);
  if (one.framed) fail('page 1 is still in a frame after the switch');
  if (switched.topFonts < 1) fail('the document was told about no faces at the switch');
  if (!one.chars) fail('the page came back from the switch with no text');
  if (one.family === framedFamily) {
    fail(`page 1 still uses the family it had before the switch (${one.family}), so it was not drawn again`);
  } else {
    ok(`switched ${switchMs} ms after the first page: ${switched.topFonts} document faces, page 1 redrawn under ${one.family}`);
  }

  /* ---------------------------------------------------- one document only */
  console.log('\n— global: one document, nothing drawn until the plan is ready —');
  const global = await openExample('global');
  await sleep(500);
  const state = await page.evaluate('window.__state()');
  const frameSeen = await page.evaluate('window.__frameSeen');
  console.log('  ' + JSON.stringify({ firstPageMs: global.firstMs, ...global.first, frameSeen }));
  if (frameSeen) fail('a page frame appeared in the global mode');
  if (global.first.framed !== false) fail('the global mode reported itself as drawing frames');
  if (global.first.frames !== 0) fail(`${global.first.frames} frame(s) were open when the first global page was drawn`);
  if (global.first.topFonts < 1) fail('the first planned page was drawn before the document had any faces');
  if (!global.first.family) fail('the first global page has no text run');
  if (!state.rows.every((row) => !row.framed)) fail('a page is in a frame in the global mode');
  else ok(`page 1 drawn ${global.firstMs} ms after the click, one document from the first pixel, no frame ever`);

  /* ------------------------------------------------- the card, and memory */
  /**
   * Which mode a reader gets, which one they keep, and what the star means.
   *
   * With nothing on the URL it is the frame mode - every page its own document
   * with its own fonts - and the card stars that row, because a star here is a
   * *recommendation* and not a state (the crop menu's star is the same): the row
   * in force is the one the menu opens on and colours. Choosing another one and
   * reading a document under it is a choice the reader made, so it is remembered
   * with that document like every other setting, and the next visit builds the
   * engine and the viewer with it - while the star stays where the recommendation
   * is.
   */
  console.log('\n— the card: the default, the reader’s own choice, and the star —');
  await page.evaluate("localStorage.removeItem('webpdf.memory')");
  await page.goto(url);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  const byDefault = await page.evaluate(() => ({ mode: window.webpdf.mode(), card: window.__card() }));
  console.log('  ' + JSON.stringify(byDefault));
  if (byDefault.mode !== 'frames') fail(`a reader who has chosen nothing should start in the frame mode, got ${byDefault.mode}`);
  if (byDefault.card.rows.length !== 3) fail(`the card should offer three modes, got ${JSON.stringify(byDefault.card.rows)}`);
  if (byDefault.card.starred.join() !== 'frames') fail(`the card should star the recommended mode, got ${JSON.stringify(byDefault.card.starred)}`);
  if (byDefault.card.selected.join() !== byDefault.mode) {
    fail(`the card should mark the mode in force (${byDefault.mode}), got ${JSON.stringify(byDefault.card.selected)}`);
  }
  if (!/IFrame \+ Per Page Font/.test(byDefault.card.label)) fail(`the card should name the mode in force, got ${JSON.stringify(byDefault.card.label)}`);
  else ok(`a fresh page starts in ${byDefault.mode}, and the card stars the recommendation and marks the choice`);

  await page.evaluate(() => {
    document.getElementById('mode-btn').click();
    document.querySelector('#mode-menu .menu-option[data-mode="global"]').click();
  });
  const chosen = await page.evaluate(() => ({ mode: window.webpdf.mode(), label: document.getElementById('mode-label').textContent }));
  if (chosen.mode !== 'global') fail(`choosing Global Font Only should take effect before the next document, got ${chosen.mode}`);
  const remember = await openExample('global');
  if (remember.first.framed !== false) fail('the chosen global mode did not take effect for the document that followed it');
  // The memory is written once the reader settles into the document.
  await sleep(1200);
  await page.goto(url);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap again', timeout: 90000 });
  const remembered = await page.evaluate(() => ({ mode: window.webpdf.mode(), card: window.__card() }));
  console.log('  ' + JSON.stringify(remembered));
  if (remembered.mode !== 'global') fail(`the mode a reader chose should come back on the next visit, got ${remembered.mode}`);
  else if (remembered.card.selected.join() !== 'global') {
    fail(`the card should mark the remembered mode as the one in force, got ${JSON.stringify(remembered.card.selected)}`);
  } else if (remembered.card.starred.join() !== 'frames') {
    fail(`the star should stay on the recommendation, got ${JSON.stringify(remembered.card.starred)}`);
  } else ok('the chosen mode came back and is marked as the choice, with the star still on the recommendation');
} catch (error) {
  fail(String(error && error.stack ? error.stack.split('\n')[0] : error));
} finally {
  await browser.close();
}

console.log(failures ? '\nRENDER MODE CHECK FAILED' : '\nRENDER MODE CHECK PASSED');
process.exit(failures ? 1 : 0);
