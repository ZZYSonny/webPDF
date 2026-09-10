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

const browser = await launch();
const page = await browser.newPage();
await page.setViewport(1440, 900);

const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exitCode = 1;
};

try {
  await page.goto(url);
  // The module graph includes a 10 MB wasm fetch, so wait until the app has
  // actually finished bootstrapping before touching its UI.
  await page.waitFor(() => typeof window.webpdf === 'object', { label: 'demo bootstrap', timeout: 90000 });
  await page.waitFor(() => !!document.getElementById('viewer'), { label: 'demo shell' });

  console.log('— loading the LaTeX sample through the UI —');
  await page.evaluate(() => {
    const sel = document.getElementById('sample');
    sel.value = '/sample-latex.pdf';
    sel.dispatchEvent(new Event('change'));
  });

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
      status: document.getElementById('status')?.textContent,
      stats: document.getElementById('stats')?.textContent,
      pageCount: document.getElementById('pagecount')?.textContent,
      zoom: document.getElementById('zoom-label')?.textContent,
      tocEntries: document.querySelectorAll('#toc-body .toc-item').length,
      emptyHidden: document.getElementById('empty')?.hidden,
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

  const logs = page.consoleMessages.filter((m) => m.level === 'error' || m.level === 'exception');
  if (logs.length) console.log('console errors:\n' + logs.map((l) => `  [${l.level}] ${l.text}`).join('\n'));

  await page.screenshot(out);
  console.log('screenshot: ' + out);

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
} finally {
  await page.close();
  await browser.close();
}

console.log(process.exitCode ? 'DEMO CHECK FAILED' : 'DEMO CHECK PASSED');
