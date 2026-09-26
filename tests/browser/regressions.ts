/** Consolidates font-uri, second-open, crop-race, restore-order and perf-frames.
 * node tests/browser/regressions.ts [url] [--complete]
 * Essential uses generated PDFs; complete adds both modes, more crop cycles,
 * and longer down/up scrolling. Frame times are diagnostic, not FPS assertions.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launch, type Page } from './cdp.ts';
import { cachedPapers } from '../pdf-cache.ts';
import { keyOfFile } from '../../demo/memory.ts';
import { textPdf } from '../helpers/pdf.ts';

const base = process.argv.find((arg) => /^https?:/.test(arg)) ?? 'http://127.0.0.1:5178/';
const complete = process.argv.includes('--complete');
const dir = await mkdtemp(path.join(os.tmpdir(), 'webpdf-regressions-'));
const browser = await launch();

async function drawn(page: Page): Promise<void> {
  await page.waitFor(() => {
    const v = window.webpdf?.viewer();
    return window.webpdf?.plan()?.ready && v && v.pageElement(v.place().page)?.querySelector('text');
  }, { label: 'current page drawn with planned text', timeout: 60000 });
}

async function fonts(page: Page, expectedCount?: number): Promise<void> {
  const report = await page.evaluate(async () => {
    const svg = document.getElementById('viewer')!.shadowRoot!.querySelector('svg')!;
    const doc = svg.ownerDocument;
    const rules = [...doc.adoptedStyleSheets].flatMap((s) => [...s.cssRules])
      .filter((r): r is CSSFontFaceRule => r instanceof CSSFontFaceRule);
    const results = [];
    for (const rule of rules) {
      const family = rule.style.fontFamily.replace(/^['"]|['"]$/g, '');
      const url = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue('src'))?.[1] ?? '';
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      const loaded = await doc.fonts.load(`18px "${family}"`);
      results.push({ family, url, ok: response.ok, bytes: bytes.byteLength, loaded: loaded.length, mime: response.headers.get('content-type') });
    }
    const used = [...document.getElementById('viewer')!.shadowRoot!.querySelectorAll('svg text')]
      .map((t) => t.getAttribute('font-family'));
    return { results, used };
  });
  assert.ok(report.used.length > 0);
  assert.ok(report.results.length > 0);
  if (expectedCount !== undefined) assert.equal(report.results.length, expectedCount, 'old document fonts were released');
  assert.equal(new Set(report.results.map((f) => f.family)).size, report.results.length, 'no duplicate faces');
  for (const face of report.results) {
    assert.ok(face.url.startsWith('blob:') && face.ok && face.bytes > 0 && face.loaded > 0, JSON.stringify(face));
    assert.match(face.mime ?? '', /^font\//);
  }
  for (const family of report.used) assert.ok(report.results.some((f) => f.family === family), `unregistered ${family}`);
}

try {
  const files = [path.join(dir, 'a.pdf'), path.join(dir, 'b.pdf')];
  await writeFile(files[0], textPdf(24, 'Helvetica', 'Scrolling and cropping', 612, 792, 24));
  await writeFile(files[1], textPdf(12, 'Courier', 'Different document', 612, 792, 24));
  for (const mode of complete ? ['global', 'progressive'] : ['global']) {
    const page = await browser.newPage();
    try {
      await page.setViewport(1100, 800);
      const url = new URL(base); url.searchParams.set('mode', mode);
      console.log(`opening ${url.href}`);
      await page.goto(url.href);
      console.log('page loaded');
      await page.waitFor(() => !!window.webpdf, { label: 'bootstrap' });
      if (process.argv.includes('--dev')) {
        assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, 'dev has no service worker');
      }
      const key = keyOfFile('a.pdf', (await stat(files[0])).size);
      await page.evaluate(`localStorage.setItem('webpdfDebug', '1'); localStorage.setItem('webpdf.memory', JSON.stringify({ [${JSON.stringify(key)}]: { pos: { page: 8, y: 200 }, at: Date.now() } }));`);
      await page.goto(url.href);
      await page.waitFor(() => !!window.webpdf, { label: 'bootstrap with stored position' });
      page.consoleMessages.length = 0;
      let opened = 0;
      for (const file of [files[0], files[1], files[0]]) {
        console.log(`selecting ${path.basename(file)}`);
        await page.send('DOM.enable');
        const { root } = await page.send('DOM.getDocument');
        const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
        // Clear first: choosing the same file must still fire change.
        await page.send('DOM.setFileInputFiles', { files: [], nodeId });
        await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
        await page.waitFor(new Function(`return window.webpdf?.info()?.pageCount === ${file === files[0] ? 24 : 12}`) as () => boolean, { label: 'document open' });
        await drawn(page);
        console.log(`drawn ${mode}: ${path.basename(file)}`);
        await fonts(page, 1);
        if (opened++ === 0) {
          assert.equal(await page.evaluate(() => window.webpdf!.viewer()!.place().page), 8, 'remembered position restored');
          const first = page.consoleMessages.find((m) => m.text.includes('render start'));
          assert.ok(first && /render start 7$/.test(first.text), `restore renders visible page first: ${first?.text}`);
        }
      }
      for (let round = 0; round < (complete ? 6 : 2); round++) {
        await page.evaluate(() => window.webpdf!.viewer()!.goToPage(8));
        await drawn(page);
        await page.evaluate(() => window.webpdf!.viewer()!.goToDestination(3, 200));
        await drawn(page);
        await page.evaluate(() => {
          const v = window.webpdf!.viewer()!;
          v.setCrop(['^Never matches$'], 6);
          v.setCrop(null);
          v.setCrop(['^Never matches$'], 6);
        });
        await page.waitFor(() => window.webpdf?.viewer()?.cropProgress.running === false, { label: 'crop finished' });
        await drawn(page);
        assert.equal(await page.evaluate(() => window.webpdf!.viewer()!.place().page), 3, 'crop preserves the visited page');
      }
      await page.evaluate(() => { window.webpdf!.viewer()!.setCrop(null); window.webpdf!.viewer()!.goToPage(1); });
      await drawn(page);
      const metrics = await page.evaluate(`(async () => {
        const frames = []; let previous = performance.now();
        let inserts = 0, insertionMs = 0;
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        Object.defineProperty(Element.prototype, 'innerHTML', { ...descriptor, set(value) {
          const started = performance.now(); descriptor.set.call(this, value);
          if (this.classList.contains('wpdf-page')) { inserts++; insertionMs += performance.now() - started; }
        }});
        try {
        const count = ${complete ? 240 : 60};
        for (let i = 0; i < count; i++) {
          await new Promise(requestAnimationFrame);
          const now = performance.now(); frames.push(now - previous); previous = now;
          window.scrollBy(0, i < count / 2 ? 120 : -120);
        }
        frames.sort((a,b) => a-b);
        return { frames: count, p95Ms: frames[Math.floor(count * .95)], maxMs: frames[count - 1], inserts, insertionMs };
        } finally { Object.defineProperty(Element.prototype, 'innerHTML', descriptor); }
      })()`);
      await drawn(page);
      await fonts(page);
      await page.waitFor(() => {
        const slots = [...document.getElementById('viewer')!.shadowRoot!.querySelectorAll('.wpdf-page')];
        const visible = slots.filter((slot) => { const r = slot.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
        return visible.length > 0 && visible.every((slot) => !!slot.querySelector('svg text'));
      }, { label: 'all visible pages drawn after scrolling' });
      console.log(JSON.stringify({ mode, scrolling: metrics }));
      if (complete) {
        const papers = cachedPapers();
        assert.ok(papers.length > 0, 'complete browser checks require the corpus');
        for (const file of papers) {
          const pdfUrl = new URL(`pdf/${path.basename(file)}`, base).href;
          await page.evaluate(`window.webpdf.open(${JSON.stringify(pdfUrl)})`);
          await drawn(page);
          await fonts(page);
          console.log(`PASS ${mode}: corpus font URLs ${path.basename(file)}`);
        }
      }
      const errors = page.consoleMessages.filter((m) => m.level === 'exception');
      assert.deepEqual(errors, [], 'no uncaught browser exceptions');
      console.log(`PASS ${mode}: A/B/A fonts, crop/revisit, down/up scrolling`);
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
