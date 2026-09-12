/**
 * How long the first page takes, in each of the three render modes.
 *
 *   node tests/browser/all.mjs                       # builds, serves, and caches the corpus
 *   node tests/first-page-latency.mjs [url] [paper] [rounds]
 *
 * This is a measurement, not a check: it prints a table and asserts nothing, so
 * it is run by hand like `tests/font-plan-cost.mjs` rather than by the suite. It
 * needs a server already serving the built demo (the commands above), and the
 * paper it measures has to be in the cache - `all.mjs` fetches the corpus.
 *
 * "First page" is the first picture of page 1 on screen - a slot holding an SVG,
 * in the frame's document or in the viewer's own - sampled once per animation
 * frame, and timed from the call to `window.webpdf.open()`. That is the demo's
 * own open path, and not the menu around it: what is being compared is the three
 * modes and not three ways of asking. The pages render in the engine's worker,
 * so the thread doing the sampling is free while they do, and the paper's own
 * bytes are read by the page in every mode, so that half is constant.
 *
 * What each mode costs, and why:
 *
 *   frames       the document read, and page 1 rendered with its own faces. No
 *                plan to walk at all;
 *   progressive  the same, with the plan walking behind it - the plan hands the
 *                thread back between slices so the viewer's request is answered
 *                (see `PdfEngine`'s `idle`), and page 1 is as late as one slice
 *                of the plan and nothing more;
 *   global       the whole plan first, so here the plan *is* the first page's
 *                latency - which is what the other two modes exist to avoid.
 *
 * The numbers are wall clock on one machine, in one browser, with the paper
 * served from the local cache; they move with the machine and are a comparison,
 * not a budget.
 */

import { launch } from './browser/cdp.mjs';
import { PAPERS, pdfPath } from '../demo/papers.mjs';
import { cachedFile } from './pdf-cache.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
/** The paper the modes are compared on: 100 pages, so the plan is long enough
 *  for the difference between "behind the page" and "in front of it" to show. */
const REFERENCE = PAPERS.find((paper) => /GPT-4/.test(paper.label)) ?? PAPERS[0];
const paper = process.argv[3] ?? pdfPath(REFERENCE.url);
const rounds = Number(process.argv[4] ?? 5);
const MODES = ['frames', 'progressive', 'global'];

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const span = (values) =>
  values.length ? `${Math.round(median(values))} (${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))})` : '—';

const browser = await launch();
const page = await browser.newPage();
await page.setViewport(1440, 900);

/**
 * The sampler, installed before every page script.
 *
 * A mark is armed by `__arm()` and the open follows it. Everything on the
 * timeline is relative to that instant: `openAt` the document read and laid out,
 * `planAt` the document's faces written into the viewer's document, `seen` the
 * first page on screen, `switched` the last frame let go.
 */
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__arm = () => {
      window.__lat = {
        t0: performance.now(), openAt: null, planAt: null, seen: null, seenNext: null,
        frames: null, framed: null, topFonts: null, family: null,
        switched: null, wasPainted: null, blank: null,
      };
    };
    const holds = (el) => {
      const frame = el.querySelector('iframe');
      if (frame?.contentDocument?.querySelector('svg.wpdf-page-svg')) return true;
      return el.querySelector('svg.wpdf-page-svg') !== null;
    };
    const sample = () => {
      const L = window.__lat;
      const sr = document.getElementById('viewer')?.shadowRoot;
      if (L?.t0 != null && sr) {
        const slots = [...sr.querySelectorAll('.wpdf-page')];
        const now = () => performance.now() - L.t0;
        if (L.planAt === null && document.fonts.size > 0) L.planAt = now();
        if (L.seen === null) {
          const el = slots.find(holds);
          if (el) {
            L.seen = now();
            L.frames = sr.querySelectorAll('iframe').length;
            L.framed = window.webpdf.pagesInFrames();
            L.topFonts = document.fonts.size;
            const doc = el.querySelector('iframe')?.contentDocument ?? el;
            L.family = doc.querySelector('text')?.getAttribute('font-family') ?? null;
          }
        } else {
          if (L.seenNext === null) L.seenNext = now();
          if (L.switched === null && sr.querySelectorAll('iframe').length === 0) L.switched = now();
          const holding = slots.filter(holds).map((el) => Number(el.dataset.page));
          if (L.wasPainted === null) L.wasPainted = holding;
          else {
            const lost = L.wasPainted.filter((p) => !holding.includes(p));
            if (lost.length && L.blank === null) L.blank = lost;
          }
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })();`,
});

/** One open in one mode, from the call to the first page on screen. */
async function run(mode) {
  const at = `${url}${url.includes('?') ? '&' : '?'}mode=${mode}`;
  await page.goto(at);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  // The memory is read at start-up and would put the reader back where the last
  // run left them; this is about where a document *starts*.
  await page.evaluate("localStorage.removeItem('webpdf.memory')");
  await page.goto(at);
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  await page.evaluate(
    `(() => {
       window.__arm();
       window.webpdf.open(${JSON.stringify(paper)}).then(
         () => { if (window.__lat?.t0 != null && window.__lat.openAt === null) window.__lat.openAt = performance.now() - window.__lat.t0; },
         () => {},
       );
     })(); true`,
  );
  await page.waitFor(() => window.__lat?.seen !== null, { label: `page 1 in ${mode}`, timeout: 180000, interval: 20 });
  // The handover is not the first page's latency, but a mode that never reaches
  // it is not the mode that was measured.
  if (mode === 'progressive') {
    await page.waitFor(() => window.__lat.switched !== null, { label: 'the frames let go', timeout: 120000, interval: 50 });
  }
  const lat = await page.evaluate('window.__lat');
  const reported = await page.evaluate('window.webpdf.mode()');
  return { mode, reported, ...lat };
}

console.log(`paper  ${paper}\nurl    ${url}\nrounds ${rounds} (+1 warm-up each, discarded)`);
if (paper === pdfPath(REFERENCE.url) && !cachedFile(REFERENCE.url)) {
  console.log(`\n(${REFERENCE.label} is not in the cache - run tests/browser/all.mjs, or name another paper)`);
}
console.log();

try {
  // Warm-ups, discarded: a browser with an empty profile has the engine's wasm,
  // the shell and the paper to fetch once, and none of that is a mode.
  for (const mode of MODES) await run(mode);

  const results = [];
  for (let round = 0; round < rounds; round++) {
    // Rotated, so a machine that slows down over the run does not slow one mode
    // more than another.
    const order = [...MODES.slice(round % 3), ...MODES.slice(0, round % 3)];
    for (const mode of order) {
      const one = await run(mode);
      results.push(one);
      console.log(
        `  ${String(round + 1).padStart(2)} ${mode.padEnd(11)} ` +
          `first page ${String(Math.round(one.seen)).padStart(5)} ms  ` +
          `open ${String(one.openAt === null ? '—' : Math.round(one.openAt)).padStart(5)} ms  ` +
          `faces ${String(one.planAt === null ? '—' : Math.round(one.planAt)).padStart(5)} ms  ` +
          `frames gone ${String(one.switched === null ? '—' : Math.round(one.switched)).padStart(5)} ms  ` +
          `[${one.framed ? 'frame' : 'document'}, ${one.topFonts} face(s)]` +
          (one.blank ? `  BLANK ${one.blank.join(',')}` : ''),
      );
    }
  }

  console.log('\n| mode | rounds | first page ms | open ms | faces written ms | frames gone ms |');
  console.log('|---|---|---|---|---|---|');
  for (const mode of MODES) {
    const rows = results.filter((row) => row.mode === mode);
    const at = (pick) => {
      const values = rows.map(pick).filter((value) => value !== null && value !== undefined);
      return span(values);
    };
    console.log(
      `| ${mode} | ${rows.length} | ${at((row) => row.seen)} | ${at((row) => row.openAt)} | ` +
        `${at((row) => row.planAt)} | ${at((row) => row.switched)} |`,
    );
  }

  const first = (mode) => median(results.filter((row) => row.mode === mode).map((row) => row.seen));
  const frames = first('frames');
  const progressive = first('progressive');
  const global = first('global');
  console.log(
    `\nprogressive is ${Math.round(progressive - frames)} ms behind frames ` +
      `(${((progressive / frames - 1) * 100).toFixed(1)}%), and ` +
      `${(global / progressive).toFixed(2)}x faster than global on this paper.`,
  );
  const wrong = results.filter((row) => row.reported !== row.mode);
  if (wrong.length) console.log(`WARNING: ${wrong.length} run(s) reported the wrong mode`);
  const blanks = results.filter((row) => row.blank);
  console.log(blanks.length ? `WARNING: ${blanks.length} run(s) went blank` : 'no run went blank at any point');
} finally {
  await browser.close();
}
