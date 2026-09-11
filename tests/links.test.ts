/**
 * Links: what a PDF's link annotations become, and what may be done with them.
 *
 * Two halves, deliberately:
 *
 *  - A document generated here, in memory, carrying every kind of link that is
 *    awkward - an internal destination, a URI with a quote in it, `javascript:`,
 *    `file:`, a rectangle with no area. It is built with MuPDF's own PDF writer,
 *    so no PDF is stored in the repository and the test needs no network.
 *  - A real paper from the corpus (see `demo/papers.mjs`), because a real
 *    document's links are the ones that have to work: 100+ annotations whose
 *    destinations point at every page of the document.
 *
 *   node tests/links.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as mupdf from 'mupdf';
import { PdfEngine } from '../src/core/engine.ts';
import {
  injectSvgLinks,
  isOpenableUri,
  svgLinks,
  type ExternalLink,
  type InternalLink,
  type PageLink,
} from '../src/core/links.ts';
import { PageLayout } from '../src/viewer/layout.ts';
import { PAPERS } from '../demo/papers.mjs';
import { cachedFile, download } from './pdf-cache.mjs';

/** `#page=3` sits in here with the URIs on purpose: it is an internal link. */
const SYNTHETIC: Array<[number, number, number, number, string]> = [
  [10, 10, 100, 30, 'https://example.com/a?b=1&c=2'],
  [10, 40, 100, 60, 'mailto:someone@example.com'],
  [10, 70, 100, 90, 'javascript:alert(1)'],
  [10, 100, 100, 120, 'file:///etc/passwd'],
  [10, 130, 100, 150, '#page=3'],
  // No area: the annotation exists, but there is nothing to click.
  [10, 160, 100, 160, 'https://example.com/degenerate'],
  // Attribute injection, one unescaped quote away from being markup.
  [10, 190, 100, 210, 'https://example.com/"onmouseover="alert(1)'],
];

/** A three-page document whose first page carries `SYNTHETIC`. */
function syntheticPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([0, 0, 300, 400], 0, null, new mupdf.Buffer());
    doc.insertPage(i, page);
  }
  const first = doc.loadPage(0);
  for (const [x0, y0, x1, y1, uri] of SYNTHETIC) first.createLink([x0, y0, x1, y1], uri);
  first.destroy();
  const buffer = doc.saveToBuffer('compress');
  const bytes = buffer.asUint8Array();
  buffer.destroy();
  doc.destroy();
  return bytes;
}

/** Every `<a ...>` the emitter wrote, as attribute strings. */
function anchors(svg: string): string[] {
  return [...svg.matchAll(/<a\s([^>]*)>/g)].map((m) => m[1]);
}

function attr(anchor: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(' ' + anchor);
  return m ? m[1] : null;
}

test('a generated document: every link is reported, only safe ones are clickable', async () => {
  const engine = new PdfEngine();
  // `paths` keeps this test about links: the font pipeline has its own.
  const page = await engine.open(syntheticPdf()).then(() => engine.renderPage(0, { textMode: 'paths' }));
  engine.close();

  assert.equal(page.links.length, SYNTHETIC.length, 'every annotation is reported');
  assert.deepEqual(
    page.links.map((l) => l.kind),
    ['external', 'external', 'external', 'external', 'internal', 'external', 'external'],
    'internal links are the ones the PDF does not call external',
  );

  const internal = page.links[4];
  assert.equal(internal.kind, 'internal');
  assert.equal(internal.page, 3, '`#page=3` resolves to the third page');
  assert.equal(internal.rect[0], 10);

  // The degenerate rectangle is reported - it is a real annotation - but it is
  // not turned into something to click.
  const drawn = anchors(page.svg);
  assert.equal(drawn.length, SYNTHETIC.length - 1, 'the empty rectangle is not drawn');
  assert.ok(!/width="0"/.test(page.svg));

  const withHref = drawn.filter((a) => /\shref="/.test(' ' + a));
  assert.equal(withHref.length, 3, 'https, mailto and https-with-a-quote are the openable ones');
  assert.ok(!/href="javascript:/i.test(page.svg), 'a javascript: URI never becomes an href');
  assert.ok(!/href="file:/i.test(page.svg), 'a file: URI never becomes an href');
  // The quote in the URI is escaped rather than closing the attribute, so the
  // injected `onmouseover` stays text.
  assert.ok(page.svg.includes('&quot;onmouseover=&quot;alert(1)'));
  assert.ok(!/onmouseover="/.test(page.svg), 'a URI cannot introduce an attribute');
  assert.equal(attr(drawn[2], 'data-wpdf-uri'), 'javascript:alert(1)', 'the URI is still reported');
  assert.equal(attr(drawn[2], 'title'), 'javascript:alert(1)');

  // Every hit area is a transparent rectangle in a real anchor.
  for (const a of drawn) {
    assert.ok(/\stabindex="0"/.test(' ' + a), 'hit areas are reachable from the keyboard');
    assert.ok(/class="wpdf-link"/.test(a));
  }
  assert.ok(/<g class="wpdf-links" fill="transparent">/.test(page.svg), 'painted, so it can be clicked');
  assert.ok(/<rect x="10" y="130" width="90" height="20"\/>/.test(page.svg), 'rects are page coordinates');

  assert.equal(attr(drawn[4], 'data-wpdf-link'), 'internal');
  assert.equal(attr(drawn[4], 'data-wpdf-page'), '3');
  assert.equal(attr(drawn[4], 'data-wpdf-y'), null, 'a #page= destination has no point to scroll to');
  assert.ok(!/\shref=/.test(' ' + drawn[4]), 'an internal link does not navigate the host page');
});

test('a link with nowhere to go is reported but not drawn', () => {
  const links: PageLink[] = [
    { kind: 'internal', rect: [0, 0, 10, 10], page: -1, x: null, y: null },
    { kind: 'internal', rect: [0, 20, 0, 40], page: 2, x: null, y: null },
    { kind: 'internal', rect: [0, 60, 10, 80], page: 2, x: 5, y: 12.3456 },
  ];
  const markup = svgLinks(links);
  assert.equal(anchors(markup).length, 1);
  assert.equal(attr(anchors(markup)[0], 'data-wpdf-y'), '12.35', 'which point, to two decimals');
  assert.equal(svgLinks([]), '', 'nothing to draw, nothing added');
});

test('a URI no browser can follow gets no href, whatever it is', () => {
  const link = (uri: string): PageLink => ({ kind: 'external', rect: [0, 0, 10, 10], uri });
  for (const uri of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'www.example.com', '/etc/passwd', '']) {
    assert.equal(isOpenableUri(uri), false, uri);
    assert.ok(!/\shref=/.test(' ' + anchors(svgLinks([link(uri)]))[0]), `${uri} must not become an href`);
  }
  for (const uri of ['https://example.com', 'http://example.com', 'mailto:a@b.c', 'tel:+1234']) {
    assert.equal(isOpenableUri(uri), true, uri);
  }
});

test('characters XML cannot represent never reach the output', () => {
  // C0 controls are illegal in XML 1.0 even as numeric references, and a lone
  // surrogate cannot be encoded at all: either would make the page unparseable.
  const markup = svgLinks([{ kind: 'external', rect: [0, 0, 10, 10], uri: 'https://x/\u0000\u0007\u001b\ud800y' }]);
  assert.equal(attr(anchors(markup)[0], 'data-wpdf-uri'), 'https://x/y');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/.test(markup));
});

test('hit areas are appended to the page, not wrapped around it', () => {
  const svg = '<svg width="10" height="10"><path d="M0 0"/></svg>';
  const out = injectSvgLinks(svg, [{ kind: 'external', rect: [1, 2, 3, 4], uri: 'https://example.com' }]);
  assert.ok(out.startsWith('<svg width="10" height="10"><path d="M0 0"/>'));
  assert.ok(out.endsWith('</svg>'));
  assert.equal(injectSvgLinks('not svg at all', [{ kind: 'external', rect: [0, 0, 1, 1], uri: 'https://x.test' }]), 'not svg at all');
});

test('a destination scrolls to a point inside the page, not just to the page', () => {
  const layout = new PageLayout(
    [
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ],
    { gap: 10, padding: 20, scale: 1, columns: 1 },
  );
  assert.equal(layout.boxes[1].top, 822, 'second page after the first and the gap');
  assert.equal(layout.offsetOf(1), 802, 'a page scrolls to just above its own top');
  assert.equal(layout.offsetOfPoint(1, 100, 1), 922, 'a point scrolls to the top edge');
  assert.equal(layout.offsetOfPoint(1, 100, 2), 1022, 'at the layout scale, like everything else');
  assert.equal(layout.offsetOfPoint(1, 0, 1), 822, 'the page top is a destination too');
  assert.equal(layout.offsetOfPoint(1, 10_000, 1), 1614, 'a destination past the page is clamped to it');
  assert.equal(layout.offsetOfPoint(1, Number.NaN, 1), 822, 'a broken destination falls back to the page');
  assert.equal(layout.offsetOfPoint(99, 10, 1), layout.boxes[1].top + 10, 'and an out-of-range page to the last one');
});

test('a remembered position comes back where it was, at any zoom', () => {
  const layout = new PageLayout(
    [
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ],
    { gap: 10, padding: 20, scale: 1, columns: 1 },
  );
  // `pointAt` is what turns "where the reader is" into something a history entry
  // can hold, so it has to be the exact inverse of the two scroll helpers.
  const places: Array<[number, number | null]> = [
    [0, null],
    [1, null],
    [1, 0],
    [1, 100],
    [0, 500.5],
    [1, 792],
  ];
  for (const [index, y] of places) {
    const offset = y === null || y === 0 ? layout.offsetOf(index) : layout.offsetOfPoint(index, y, 1);
    const back = layout.pointAt(offset, 1);
    assert.equal(back.index, index, `page of ${index}/${y}`);
    if (y === null || y === 0) assert.equal(back.y, null, `page top of ${index}`);
    else assert.ok(Math.abs((back.y ?? -1) - y) < 1e-6, `point of ${index}/${y} came back as ${back.y}`);
  }
  // Page units, not pixels: the same offset read at twice the zoom is the same
  // place in the document, which is what makes a remembered position survive a
  // zoom between the two visits.
  assert.deepEqual(layout.pointAt(layout.offsetOfPoint(1, 100, 2), 2), { index: 1, y: 100 });
  assert.deepEqual(layout.pointAt(layout.offsetOfPoint(1, 100, 1), 1), { index: 1, y: 100 });
  assert.deepEqual(layout.pointAt(-50, 1), { index: 0, y: null }, 'above the first page is its top');
});

/** The cached file for a paper, downloaded if it is missing. */
async function corpusFile(url: string): Promise<string> {
  const file = cachedFile(url) ?? (await download(url).catch((error: Error) => error));
  if (!file || file instanceof Error) {
    assert.fail(`the corpus paper could not be fetched: ${file instanceof Error ? file.message : url}`);
  }
  return file;
}

test('a real paper: the links in the document are the links in the SVG', async (t) => {
  const paper = PAPERS[1];
  const file = await corpusFile(paper.url);
  t.diagnostic(`  ${paper.label} (${file})`);

  const engine = new PdfEngine();
  const info = await engine.open(new Uint8Array(fs.readFileSync(file)));
  const page = await engine.renderPage(0, { textMode: 'paths' });
  engine.close();

  const internal = page.links.filter((l): l is InternalLink => l.kind === 'internal');
  const external = page.links.filter((l): l is ExternalLink => l.kind === 'external');
  assert.ok(internal.length > 20, `expected a reference list's worth of internal links, got ${internal.length}`);
  assert.ok(external.length > 0, 'expected at least one external link');
  t.diagnostic(`  page 1: ${internal.length} internal, ${external.length} external links`);

  for (const link of internal) {
    assert.ok(link.page >= 1 && link.page <= info.pageCount, `destination page ${link.page} is outside the document`);
    const [x0, y0, x1, y1] = link.rect;
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= page.width + 1 && y1 <= page.height + 1, `rect ${link.rect} is off the page`);
    if (link.y !== null) assert.ok(link.y >= 0 && link.y <= page.height, `destination y ${link.y} is off the page`);
  }
  for (const link of external) {
    assert.match(link.uri, /^https?:\/\//, 'arXiv links are absolute URLs');
    assert.equal(isOpenableUri(link.uri), true);
  }

  // The markup and the data have to agree: one rect per link, in order, with the
  // same coordinates - this is what makes a click land where it looks like it
  // should.
  const drawn = anchors(page.svg);
  assert.equal(drawn.length, page.links.filter((l) => l.rect[2] > l.rect[0] && l.rect[3] > l.rect[1]).length);
  const rects = [...page.svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"\/>/g)].map((m) =>
    m.slice(1, 5).map(Number),
  );
  assert.equal(rects.length, drawn.length);
  let at = 0;
  for (const link of page.links) {
    if (!(link.rect[2] > link.rect[0] && link.rect[3] > link.rect[1])) continue;
    const [x, y, w, h] = rects[at++];
    assert.ok(Math.abs(x - link.rect[0]) < 0.01 && Math.abs(y - link.rect[1]) < 0.01, `hit area ${at} is misplaced`);
    assert.ok(Math.abs(w - (link.rect[2] - link.rect[0])) < 0.01 && Math.abs(h - (link.rect[3] - link.rect[1])) < 0.01);
  }
  assert.equal(at, rects.length, 'every hit area belongs to a link');
});

test('a real document that links to a local file: reported, with nothing to follow', async (t) => {
  // The GPT-4 report links to `file://gpt4-report@openai.com` in its header - a
  // link a browser will not follow, and exactly the case the policy is for.
  const paper = PAPERS[2];
  const file = await corpusFile(paper.url);
  t.diagnostic(`  ${paper.label}`);

  const engine = new PdfEngine();
  await engine.open(new Uint8Array(fs.readFileSync(file)));
  const page = await engine.renderPage(0, { textMode: 'paths' });
  engine.close();

  const local = page.links.filter((l): l is ExternalLink => l.kind === 'external' && !isOpenableUri(l.uri));
  assert.equal(local.length, 1, `expected the file: link, got ${JSON.stringify(local.map((l) => l.uri))}`);
  assert.match(local[0].uri, /^file:/);
  const drawn = anchors(page.svg).filter((a) => attr(a, 'data-wpdf-uri') === local[0].uri);
  assert.equal(drawn.length, 1, 'the link is still a hit area');
  assert.ok(!/\shref=/.test(' ' + drawn[0]), 'but it is not an href');
  assert.ok(!/href="file:/i.test(page.svg));
});
