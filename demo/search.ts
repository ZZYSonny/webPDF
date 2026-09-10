/**
 * Text search over the document.
 *
 * The viewer keeps only the pages near the viewport in the DOM, so searching
 * "the document" means indexing every page once: a page that is on screen is read
 * straight out of its own SVG, and one that is not is rendered through the
 * viewer's engine (already warm - the document is parsed and the page fonts are
 * built) and then kept as plain text. Indexing runs in the background, one page
 * at a time, and reports hits as they are found.
 *
 * Runs are indexed with all whitespace removed. The renderer emits one `<text>`
 * run per positioned string and does not always carry the PDF's word spaces
 * across, so "attention is all you need" would otherwise never match the
 * `AttentionIsAllYouNeed` run it produced. Normalising both sides the same way
 * makes the search indifferent to that.
 *
 * A hit is painted by measuring the matched characters with a `Range` and mapping
 * the resulting client rects back through the page's own matrix: one highlighter
 * band per line of the match, and nothing in the page's markup is restyled.
 */

import type { PdfViewer } from '../src/index.ts';

export interface SearchHit {
  /** 1-based page number. */
  page: number;
  /** Offsets into the page's normalised text. */
  start: number;
  end: number;
}

export interface SearchState {
  /** The normalised query, empty when nothing is being searched for. */
  query: string;
  hits: SearchHit[];
  /** Index into `hits`, or -1 when no match is selected. */
  active: number;
  /** Pages whose text is known, out of `total`. */
  indexed: number;
  total: number;
  /** The background indexer is still working through the document. */
  running: boolean;
  /** The hit list was capped; there are more matches than are listed. */
  truncated: boolean;
}

export interface SearchController {
  /** Forget everything: a different document is being opened. */
  reset(): void;
  setQuery(raw: string): void;
  step(delta: 1 | -1): void;
  clear(): void;
  /** Re-paint the current match (a page finished rendering, or scrolled in). */
  refresh(): void;
  destroy(): void;
}

const MAX_HITS = 1000;
/** Bands drawn per repaint: a visual aid, so a page dense with hits can stop. */
const MAX_BANDS = 400;
const MATCH_COLOUR = '#ffe066';
const ACTIVE_COLOUR = '#ff9800';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Lower-case and drop every space, identically for the page and the query. */
const SPACE = /[ \t\n\r\f\v]/;

function normalise(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SPACE.test(ch)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

/**
 * The same, plus where each surviving character came from - a match is painted by
 * measuring those characters, so the offsets have to survive the normalisation.
 */
function normaliseWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SPACE.test(ch)) continue;
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

const TEXT_ELEMENT = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
const ANY_TAG = /<[^>]*>/g;
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, dec: string, hex: string, name: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    return String.fromCodePoint(Number.parseInt(dec ?? hex, dec ? 10 : 16));
  });
}

/** The text runs of a serialised SVG, in document order. */
function runsOfSource(svg: string): string[] {
  const out: string[] = [];
  for (const match of svg.matchAll(TEXT_ELEMENT)) out.push(decodeEntities(match[1].replace(ANY_TAG, '')));
  return out;
}

/** The text runs of a page that is on screen right now, in document order. */
function runsOfSvg(svg: Element): string[] {
  return [...svg.querySelectorAll('text')].map((el) => el.textContent ?? '');
}

interface PageText {
  /** The page's text with whitespace removed, lower-cased. */
  norm: string;
}

/** One rendered text run, located in the page's normalised text. */
interface RunSpan {
  el: Element;
  start: number;
  end: number;
  /** For each normalised character, its index in the run's own text. */
  map: number[];
}

function indexRuns(runs: readonly string[]): PageText {
  let norm = '';
  for (const run of runs) norm += normalise(run);
  return { norm };
}

export interface SearchOptions {
  viewer: PdfViewer;
  onChange: (state: SearchState) => void;
}

export function createSearch({ viewer, onChange }: SearchOptions): SearchController {
  /** Page number -> indexed text. */
  const pages = new Map<number, PageText>();
  /** The bands currently inserted into the pages. */
  const painted: SVGRectElement[] = [];

  let query = '';
  let hits: SearchHit[] = [];
  let active: SearchHit | null = null;
  let truncated = false;
  /** A step asked for before there was anything to step to. */
  let pending: 1 | -1 | null = null;
  /** Still following the first match: cleared as soon as the user navigates. */
  let follow = true;
  /** Bumped when the document changes, so an in-flight indexer gives up. */
  let epoch = 0;
  let running = false;
  let destroyed = false;

  const state = (): SearchState => ({
    query,
    hits,
    active: active ? hits.indexOf(active) : -1,
    indexed: pages.size,
    total: viewer.pageCount,
    running,
    truncated,
  });

  const emit = (): void => {
    if (!destroyed) onChange(state());
  };

  /* ------------------------------------------------------------- painting */

  function unpaint(): void {
    for (const band of painted) band.remove();
    painted.length = 0;
  }

  /** The text nodes inside one run, in order. */
  function textNodesOf(el: Element): Text[] {
    const out: Text[] = [];
    const walk = (node: Node): void => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) out.push(child as Text);
        else walk(child);
      }
    };
    walk(el);
    return out;
  }

  /** A DOM range over `[start, end)` of the run's own text, across its nodes. */
  function rangeOf(el: Element, start: number, end: number): Range | null {
    const range = document.createRange();
    let at = 0;
    let opened = false;
    for (const node of textNodesOf(el)) {
      const length = node.data.length;
      if (!opened && start < at + length) {
        range.setStart(node, start - at);
        opened = true;
      }
      if (opened && end <= at + length) {
        range.setEnd(node, end - at);
        return range;
      }
      at += length;
    }
    return null;
  }

  /**
   * One highlighter band for one occurrence. The characters are measured with a
   * Range - which is line-aware and glyph-accurate, unlike the run's bounding box
   * (a run can cover a whole paragraph) - and the client rects are mapped back
   * through the SVG's own matrix, so the band lands in page coordinates whatever
   * transform the run was emitted with.
   */
  function paintHit(svg: SVGSVGElement, span: RunSpan, hit: SearchHit, isActive: boolean): boolean {
    const first = span.map[hit.start - span.start];
    const last = span.map[Math.min(hit.end, span.end) - span.start - 1];
    if (first === undefined || last === undefined) return false;
    const range = rangeOf(span.el, first, last + 1);
    const matrix = svg.getScreenCTM?.();
    if (!range || !matrix) return false;
    const inverse = matrix.inverse();

    // Chromium hands back one rect per glyph; merge them per line.
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    for (const client of range.getClientRects()) {
      if (!client.width || !client.height) continue;
      const a = new DOMPoint(client.left, client.top).matrixTransform(inverse);
      const b = new DOMPoint(client.right, client.bottom).matrixTransform(inverse);
      boxes.push({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
      });
    }
    boxes.sort((p, q) => p.y - q.y || p.x - q.x);
    const lines: typeof boxes = [];
    for (const box of boxes) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(box.y - line.y) < line.h * 0.5 && box.x <= line.x + line.w + line.h * 0.4) {
        const right = Math.max(line.x + line.w, box.x + box.w);
        const bottom = Math.max(line.y + line.h, box.y + box.h);
        line.x = Math.min(line.x, box.x);
        line.y = Math.min(line.y, box.y);
        line.w = right - line.x;
        line.h = bottom - line.y;
      } else {
        lines.push({ ...box });
      }
    }

    for (const line of lines) {
      const pad = line.h * 0.12;
      const band = document.createElementNS(SVG_NS, 'rect');
      band.setAttribute('x', String(line.x - pad * 0.5));
      band.setAttribute('y', String(line.y - pad));
      band.setAttribute('width', String(line.w + pad));
      band.setAttribute('height', String(line.h + pad * 2));
      band.setAttribute('rx', String(pad * 0.7));
      band.setAttribute('fill', isActive ? ACTIVE_COLOUR : MATCH_COLOUR);
      // Marked, so it is obvious in the DOM (and in tests) what the search added.
      band.dataset.wpdfSearch = isActive ? 'active' : 'match';
      // First child: behind everything the page draws, in root coordinates.
      svg.insertBefore(band, svg.firstChild);
      painted.push(band);
    }
    return lines.length > 0;
  }

  /**
   * Offsets of every rendered run, in the same normalised coordinates the index
   * uses - the run list is produced by the same renderer either way.
   */
  function runSpans(svg: Element): RunSpan[] {
    const spans: RunSpan[] = [];
    let at = 0;
    for (const el of svg.querySelectorAll('text')) {
      const { norm, map } = normaliseWithMap(el.textContent ?? '');
      spans.push({ el, start: at, end: at + norm.length, map });
      at += norm.length;
    }
    return spans;
  }

  /**
   * Every match on every page that is currently rendered, with the active one in
   * its own colour - a find bar boxes what is in front of you, not just the
   * match it scrolled to.
   */
  function paint(scroll: boolean): void {
    unpaint();
    if (!active || hits.length === 0) return;
    let budget = MAX_BANDS;
    for (const page of new Set(hits.map((hit) => hit.page))) {
      const svg = viewer.pageElement(page) as SVGSVGElement | null;
      if (!svg) continue;
      const spans = runSpans(svg);
      const onPage = hits.filter((hit) => hit.page === page);
      // The match we are on goes first, so a page dense with hits cannot crowd it
      // out of the budget.
      for (const hit of [...onPage.filter((h) => h === active), ...onPage.filter((h) => h !== active)]) {
        if (budget <= 0) break;
        for (const span of spans) {
          if (span.end <= hit.start || span.start >= hit.end) continue;
          if (paintHit(svg, span, hit, hit === active)) budget -= 1;
        }
      }
    }
    if (scroll) {
      // The first band of the active match.
      painted.find((el) => el.dataset.wpdfSearch === 'active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  /* -------------------------------------------------------------- jumping */

  const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  /** Wait for a page to be in the DOM, so its matches can be painted. */
  async function waitForPage(page: number, timeout = 4000): Promise<boolean> {
    const deadline = performance.now() + timeout;
    for (;;) {
      if (destroyed) return false;
      if (viewer.pageElement(page)) return true;
      if (performance.now() > deadline) return false;
      await nextFrame();
    }
  }

  async function goTo(hit: SearchHit): Promise<void> {
    active = hit;
    emit();
    viewer.goToPage(hit.page);
    if (await waitForPage(hit.page)) paint(true);
  }

  /**
   * Follow the first match until the user navigates, the way a browser's find bar
   * does: typing boxes every hit and takes you to the first one straight away,
   * with no Enter needed. Matches can arrive later (the index fills in from page
   * one) which is why this also runs as the list grows.
   */
  function followFirst(): void {
    if (!follow || hits.length === 0) return;
    const first = hits[0];
    if (active && active.page === first.page && active.start === first.start) return;
    void goTo(first);
  }

  /* ------------------------------------------------------------- indexing */

  /** Every occurrence of the current query in one page's text. */
  function scan(page: number): SearchHit[] {
    const text = pages.get(page);
    if (!text || !query) return [];
    const found: SearchHit[] = [];
    let at = text.norm.indexOf(query);
    while (at !== -1 && found.length < MAX_HITS) {
      found.push({ page, start: at, end: at + query.length });
      at = text.norm.indexOf(query, at + query.length);
    }
    return found;
  }

  /** Rebuild the hit list from the pages indexed so far, in page order. */
  function rescan(): void {
    hits = [];
    truncated = false;
    for (let page = 1; page <= viewer.pageCount; page++) {
      const found = scan(page);
      if (hits.length + found.length > MAX_HITS) {
        hits.push(...found.slice(0, MAX_HITS - hits.length));
        truncated = true;
        break;
      }
      hits.push(...found);
    }
  }

  async function indexPage(page: number, myEpoch: number): Promise<void> {
    const svg = viewer.pageElement(page);
    const runs = svg ? runsOfSvg(svg) : runsOfSource(await viewer.exportSvg(page));
    if (destroyed || epoch !== myEpoch) return;
    pages.set(page, indexRuns(runs));
  }

  /** Index whatever is left, one page at a time, reporting hits as they land. */
  async function indexRest(): Promise<void> {
    if (running || !query) return;
    running = true;
    emit();
    const myEpoch = epoch;
    try {
      for (;;) {
        if (destroyed || epoch !== myEpoch || !query || truncated) return;
        let next = 0;
        for (let page = 1; page <= viewer.pageCount; page++) {
          if (!pages.has(page)) {
            next = page;
            break;
          }
        }
        if (!next) return;
        await indexPage(next, myEpoch);
        if (destroyed || epoch !== myEpoch) return;
        const found = scan(next);
        if (found.length) {
          hits = [...hits, ...found].sort((a, b) => a.page - b.page || a.start - b.start);
          if (hits.length > MAX_HITS) {
            hits = hits.slice(0, MAX_HITS);
            truncated = true;
          }
        }
        // Someone pressed Enter (or a next button) before the index had anything
        // in it: honour that the moment the first match shows up.
        if (pending && hits.length) {
          const delta = pending;
          pending = null;
          void goTo(delta > 0 ? hits[0] : hits[hits.length - 1]);
        } else {
          // ...or the index just reached an earlier page than the one we jumped
          // to, and the first match is now a different one.
          followFirst();
        }
        emit();
        // One render per frame at most: the viewer is rendering the same pages
        // the user is looking at, and it wins.
        await nextFrame();
      }
    } finally {
      if (epoch === myEpoch) {
        running = false;
        emit();
      }
    }
  }

  /* ----------------------------------------------------------------- API */

  return {
    reset(): void {
      epoch++;
      pages.clear();
      query = '';
      hits = [];
      active = null;
      pending = null;
      follow = true;
      truncated = false;
      running = false;
      unpaint();
      emit();
    },

    setQuery(raw: string): void {
      const next = normalise(raw);
      if (next === query) {
        emit();
        return;
      }
      query = next;
      active = null;
      pending = null;
      follow = true;
      unpaint();
      rescan();
      emit();
      // No Enter needed: show and jump to the first match as soon as there is one.
      followFirst();
      void indexRest();
    },

    step(delta: 1 | -1): void {
      follow = false;
      if (!hits.length) {
        // Nothing indexed yet: remember the intent rather than dropping it.
        pending = delta;
        return;
      }
      const at = active ? hits.indexOf(active) : -1;
      const next = at === -1 ? (delta > 0 ? hits[0] : hits[hits.length - 1]) : hits[(at + delta + hits.length) % hits.length];
      void goTo(next);
    },

    clear(): void {
      query = '';
      hits = [];
      active = null;
      pending = null;
      follow = true;
      unpaint();
      emit();
    },

    refresh(): void {
      paint(false);
    },

    destroy(): void {
      destroyed = true;
      unpaint();
    },
  };
}
