/**
 * Demo application.
 *
 * Deliberately built only on the public API - no private reach-ins - so it
 * doubles as a test that the integration surface is sufficient for a real app
 * (and, by extension, for a browser extension content script).
 *
 * The chrome is one bar and nothing else: the document and its outline on the
 * left, the layout zoom level in the middle, search and the last render cost on
 * the right. There is no status bar - messages float in a toast - so the pages
 * get every pixel below the bar, and the browser's own pinch is never competing
 * with chrome that claims to be fixed.
 */

import {
  createViewer,
  DEFAULT_ZOOM_STEPS,
  PdfViewer,
  type DocumentInfo,
  type ViewerEvent,
} from '../src/index.ts';
import { createSearch, type SearchController, type SearchState } from './search.ts';
import { defaultExample, exampleDocuments, type Example } from './examples.ts';
import { isCurrentLevel, parseZoomInput, zoomLevels, zoomPercent, type ZoomLevel, type ZoomOption } from './zoom.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/**
 * The sticky bar. It is chrome: its height feeds every scroll the viewer makes
 * (`scrollMargin` below), and its controls are focused and scrolled by hand.
 */
const topbar = document.querySelector<HTMLElement>('.topbar');

const els = {
  open: $<HTMLButtonElement>('open'),
  file: $<HTMLInputElement>('file'),
  sample: $<HTMLSelectElement>('sample'),
  tocToggle: $<HTMLButtonElement>('toc-toggle'),
  toc: $('toc'),
  tocBody: $('toc-body'),
  tocClose: $<HTMLButtonElement>('toc-close'),
  navGroup: $('nav-group'),
  prev: $<HTMLButtonElement>('prev'),
  next: $<HTMLButtonElement>('next'),
  pageno: $<HTMLInputElement>('pageno'),
  pagecount: $('pagecount'),
  zoomGroup: $('zoom-group'),
  zoomIn: $<HTMLButtonElement>('zoom-in'),
  zoomOut: $<HTMLButtonElement>('zoom-out'),
  zoomValue: $<HTMLInputElement>('zoom-value'),
  zoomMenu: $('zoom-menu'),
  zoomMenuBtn: $<HTMLButtonElement>('zoom-menu-btn'),
  searchGroup: $('search-group'),
  searchBox: $('search-box'),
  search: $<HTMLInputElement>('search'),
  searchCount: $('search-count'),
  searchPrev: $<HTMLButtonElement>('search-prev'),
  searchNext: $<HTMLButtonElement>('search-next'),
  stats: $('stats'),
  viewer: $('viewer'),
  empty: $('empty'),
  emptyOpen: $<HTMLButtonElement>('empty-open'),
  emptySample: $<HTMLButtonElement>('empty-sample'),
  progress: $('progress'),
  toast: $('toast'),
};

let viewer: PdfViewer | null = null;
let search: SearchController | null = null;
let info: DocumentInfo | null = null;
let currentPage = 1;
let busy = 0;
let toastTimer = 0;
/**
 * Height of the sticky bar, kept current by the observer at the bottom of this
 * file. The pages scroll *under* it, so every scroll the viewer performs has to
 * stop this far short or it parks the target behind the chrome.
 */
let topbarHeight = 0;

/* ---------------------------------------------------------------- sources */

/**
 * Where this page lives, so a document URL or an upload can be resolved against
 * it rather than against a domain root: the built demo is published under a
 * path ([user].github.io/<repo>/) that it has no other way of knowing.
 */
const BASE = (() => {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  return src ? new URL('.', src).href : new URL('.', document.baseURI).href;
})();

const resolve = (url: string): string => new URL(url, BASE).href;

/** Fetch a document from a URL, with the picker saying which one is loading. */
async function openUrl(url: string): Promise<void> {
  await openSource(resolve(url));
}

/** The document the empty tray opens - the first public example. */
let example: Example | null = null;

/** The picker lists whatever this page can actually open. */
function fillSamplePicker(): void {
  const list = exampleDocuments();
  example = defaultExample() ?? list[0] ?? null;
  els.sample.replaceChildren(
    new Option('Example…', ''),
    ...list.map((item) => {
      const option = new Option(`${item.label} · ${item.note}`, item.url);
      // What the document is like, for anyone deciding which one to open.
      option.title = item.title;
      return option;
    }),
  );
  els.sample.value = '';
  els.emptySample.hidden = example === null;
}

/* ------------------------------------------------------------- bootstrap */

// The picker is populated before anything can be clicked, so the page never
// offers a document it cannot fetch.
fillSamplePicker();

async function ensureViewer(): Promise<PdfViewer> {
  if (viewer) return viewer;
  viewer = await createViewer({
    container: els.viewer,
    zoom: 'fit-width',
    // The same ladder the zoom box lists, so the dropdown, the +/- buttons and
    // Ctrl +/- all offer identical levels.
    zoomSteps: DEFAULT_ZOOM_STEPS,
    gap: 16,
    padding: 18,
    keepPages: 1,
    shadowDom: true,
    // Read at each scroll rather than captured, so a bar that wraps to two rows
    // on a narrow window keeps the pages clear of it.
    scrollMargin: () => topbarHeight,
    onEvent: onViewerEvent,
  });
  search = createSearch({ viewer, onChange: renderSearch });
  return viewer;
}

function onViewerEvent(event: ViewerEvent): void {
  switch (event.type) {
    case 'document-loaded': {
      info = event.info;
      search?.reset();
      els.empty.hidden = true;
      // The sample picker is part of getting a document in, so it goes away once
      // one is open; "Open PDF…" is the way to a different file from here.
      els.sample.hidden = true;
      els.navGroup.hidden = false;
      els.zoomGroup.hidden = false;
      els.searchGroup.hidden = false;
      els.pagecount.textContent = String(event.info.pageCount);
      els.pageno.value = '1';
      // A new document starts on page one, whatever page the last one was left
      // on; the outline is marked from that, not from the old position.
      currentPage = 1;
      els.search.value = '';
      els.stats.textContent = '';
      document.title = event.info.title || 'webpdf';
      renderOutline(event.info);
      // The outline is a left-hand column, so a document that has one opens with
      // it showing - on a window wide enough to afford the width.
      if (event.info.outline.length > 0 && window.innerWidth >= 1024) setOutline(true);
      // Open one level *below* fit-width rather than at it. Fit-width is the
      // largest level that still shows the page's full width, and starting there
      // leaves the paper touching both edges of the window. Ctrl+0 still means
      // fit width; the ladder is resolved by scale, so this is the next rung down
      // whatever the window size is.
      viewer?.stepZoom(-1);
      break;
    }
    case 'page-change':
      currentPage = event.page;
      els.pageno.value = String(event.page);
      highlightOutline(event.page);
      search?.refresh();
      break;
    case 'zoom-change':
      // The box shows the *layout* zoom; a pinch is the browser's page scale and
      // never reaches this value. While it has focus the text is the user's.
      if (document.activeElement !== els.zoomValue) syncZoomBox();
      refreshZoomMenu();
      document.body.classList.toggle('wpdf-zoomed', event.zoomed);
      // A pinch owns the whole screen: it magnifies the chrome along with the
      // document and can pan the visual viewport over it, so anything left open
      // is gone from view but still live - see `dismissChrome`.
      if (event.zoomed) dismissChrome();
      break;
    case 'render':
      // Only the cost: everything else about a render is a debugging detail.
      els.stats.textContent = `${Math.round(event.ms)} ms`;
      els.stats.title =
        `Page ${event.page}: ${event.ms} ms · ` +
        `${event.asText.toLocaleString()} glyphs as text` +
        (event.asOutlines ? ` · ${event.asOutlines.toLocaleString()} as outlines` : '');
      search?.refresh();
      break;
    case 'link':
      // The viewer has already done the work - an internal link jumped, an
      // external one opened in a new tab - so this only says what happened. A
      // document can link to anything, and the ones a browser will not follow
      // are worth spelling out rather than leaving as a dead click.
      if (event.kind === 'external') {
        if (event.openable) notify(`Opening ${event.uri} in a new tab`);
        else notify(`This document links to ${event.uri}, which a browser cannot open`, 'error');
      }
      break;
    case 'drop-accepted':
      notify(`Opening ${event.name}…`);
      break;
    case 'error':
      console.error(event.error);
      notify(`Error: ${String((event.error as Error)?.message ?? event.error)}`, 'error');
      break;
  }
}

/* ------------------------------------------------------------------ toast */

function notify(text: string, kind: 'info' | 'error' = 'info'): void {
  els.toast.textContent = text;
  els.toast.classList.toggle('error', kind === 'error');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, kind === 'error' ? 8000 : 3500);
}

/* ------------------------------------------------------------------- zoom */

/**
 * The dropdown lists every rung of the ladder, and a fit mode is named by the
 * percentage it resolves to *now* - so the list is rebuilt when those percentages
 * move with the window. The rebuild is skipped unless they actually changed, so a
 * pinch - which fires `zoom-change` on every frame and must stay layout-free -
 * never touches it.
 */
let menuOptions: ZoomOption[] = [];
let menuKey = '';
let menuCursor = 0;

function zoomOptionElement(option: ZoomOption, index: number): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'zoom-option';
  el.setAttribute('role', 'option');
  el.dataset.index = String(index);
  el.textContent = option.label;
  el.addEventListener('click', () => {
    applyZoomLevel(option.level);
    closeZoomMenu();
    els.zoomValue.focus();
  });
  return el;
}

function refreshZoomMenu(): void {
  if (!viewer) return;
  const fitWidth = zoomPercent(viewer.resolveZoom('fit-width'));
  const fitPage = zoomPercent(viewer.resolveZoom('fit-page'));
  const key = `${fitWidth}/${fitPage}`;
  if (key !== menuKey) {
    menuKey = key;
    menuOptions = zoomLevels(DEFAULT_ZOOM_STEPS, (level) => viewer!.resolveZoom(level));
    els.zoomMenu.replaceChildren(...menuOptions.map(zoomOptionElement));
  }
  markZoomMenu();
}

/** Show which rung the viewer is on now. */
function markZoomMenu(): void {
  if (!viewer || menuOptions.length === 0) return;
  const current = menuOptions.findIndex((option) => isCurrentLevel(option.level, viewer!.zoom, viewer!.zoomMode));
  els.zoomMenu.querySelectorAll<HTMLElement>('.zoom-option').forEach((el, index) => {
    el.setAttribute('aria-selected', String(index === current));
    el.classList.toggle('active', index === menuCursor);
  });
}

function openZoomMenu(): void {
  if (!viewer) return;
  refreshZoomMenu();
  const current = menuOptions.findIndex((option) => isCurrentLevel(option.level, viewer!.zoom, viewer!.zoomMode));
  menuCursor = current >= 0 ? current : 0;
  markZoomMenu();
  els.zoomMenu.hidden = false;
  els.zoomMenuBtn.setAttribute('aria-expanded', 'true');
  const chosen = els.zoomMenu.querySelectorAll<HTMLElement>('.zoom-option')[menuCursor];
  if (chosen) scrollIntoPanel(chosen, els.zoomMenu);
}

function closeZoomMenu(): void {
  els.zoomMenu.hidden = true;
  els.zoomMenuBtn.setAttribute('aria-expanded', 'false');
}

function moveZoomMenu(delta: number): void {
  if (menuOptions.length === 0) return;
  menuCursor = Math.min(menuOptions.length - 1, Math.max(0, menuCursor + delta));
  markZoomMenu();
  const chosen = els.zoomMenu.querySelectorAll<HTMLElement>('.zoom-option')[menuCursor];
  if (chosen) scrollIntoPanel(chosen, els.zoomMenu);
}

/* ---------------------------------------------------------------- panels */

/**
 * Bring an element into view *inside the panel that scrolls it*, and nowhere
 * else. The behaviour is `block: 'nearest'`, the only mode either caller wants.
 *
 * `Element.scrollIntoView` walks the entire ancestor chain and ends at the
 * document viewport, which is wrong twice over here: the outline is
 * `position: fixed` and the zoom list sits in the sticky bar, so as soon as the
 * browser is magnified and the visual viewport is panned over the page, both
 * count as off screen. Scrolling past a page then made the browser drag the
 * magnified view sideways to "reveal" a panel the reader could not even see -
 * the browser test measures a 657 px jump of the view the moment the current
 * page changes. The panel is scrolled by hand instead, and the document stays
 * exactly where the reader put it.
 */
function scrollIntoPanel(el: HTMLElement, panel: HTMLElement): void {
  const item = el.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  // A scrollport is the padding box, which is what `block: 'nearest'` measures
  // against: `clientTop` is the border, `clientHeight` the padding box height.
  const top = box.top + panel.clientTop;
  const bottom = top + panel.clientHeight;
  if (item.top < top) panel.scrollTop -= top - item.top;
  else if (item.bottom > bottom) panel.scrollTop += item.bottom - bottom;
}

/**
 * Close everything that was opened over the pages - the outline, the zoom
 * dropdown - and take focus out of it.
 *
 * Zoom is the reason this exists rather than an accident of the toggle: a pinch
 * is the browser's page scale, and chrome drawn next to the pages is magnified
 * with them and can be panned out of view. A panel left open behind the zoom is
 * not just invisible, it is still live, and still scrolling itself into view.
 * Dismissing says what is true - while the page is magnified there is nothing
 * on screen to read - and keeps the document the only thing that can move.
 *
 * Cheap enough to call on every `zoom-change`: the common case is three checks.
 */
function dismissChrome(): void {
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && (topbar?.contains(active) === true || els.toc.contains(active));
  if (els.toc.hidden && els.zoomMenu.hidden && !focused) return;
  if (!els.toc.hidden) setOutline(false);
  if (!els.zoomMenu.hidden) closeZoomMenu();
  // Focus left in a control that the zoom has made invisible would swallow
  // keystrokes. The viewer's link hit areas are not chrome, and keep theirs.
  if (focused) active.blur();
}

function applyZoomLevel(level: ZoomLevel): void {
  viewer?.setZoom(level);
  syncZoomBox();
}

function syncZoomBox(): void {
  // The number is the editable part; `%` is the control's own unit.
  if (viewer) els.zoomValue.value = String(zoomPercent(viewer.zoom));
}

/** Commit whatever is in the box: a percentage, a ratio, or a fit mode. */
function applyZoomInput(): void {
  const level = parseZoomInput(els.zoomValue.value);
  if (level !== null) viewer?.setZoom(level);
  syncZoomBox();
}

/* ---------------------------------------------------------------- search */

function renderSearch(state: SearchState): void {
  const { query, hits, active, indexed, total, running, truncated } = state;
  const navigable = hits.length > 0;
  els.searchNext.hidden = !navigable;
  els.searchPrev.hidden = !navigable;
  if (!query) {
    els.searchCount.textContent = '';
    els.searchCount.title = '';
    els.search.classList.remove('no-matches');
    return;
  }
  if (!navigable) {
    els.searchCount.textContent = running ? `${indexed}/${total}` : 'none';
    els.searchCount.title = running ? `Searched ${indexed} of ${total} pages` : 'No match in this document';
  } else {
    // Before the first jump there is nothing selected, so the count is the
    // total; after it, the position in the list.
    const shown = active < 0 ? String(hits.length) : `${active + 1}/${hits.length}`;
    els.searchCount.textContent = `${shown}${truncated ? '+' : ''}${running ? '…' : ''}`;
    els.searchCount.title = truncated
      ? `Showing the first ${hits.length} matches`
      : `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${new Set(hits.map((h) => h.page)).size} pages`;
  }
  els.search.classList.toggle('no-matches', !navigable && !running);
}

/* --------------------------------------------------------------- outline */

interface TocEntry {
  title: string;
  page: number;
  el: HTMLButtonElement;
}

const tocEntries: TocEntry[] = [];

function setOutline(open: boolean): void {
  els.toc.hidden = !open;
  els.tocToggle.setAttribute('aria-expanded', String(open));
  els.tocToggle.classList.toggle('active', open);
}

function renderOutline(doc: DocumentInfo): void {
  tocEntries.length = 0;
  els.tocBody.innerHTML = '';
  if (!doc.outline.length) {
    const p = document.createElement('div');
    p.className = 'toc-empty';
    p.textContent = 'This document has no outline.';
    els.tocBody.appendChild(p);
    return;
  }
  const add = (nodes: typeof doc.outline, depth: number): void => {
    for (const node of nodes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toc-item';
      btn.textContent = node.title || '(untitled)';
      btn.style.paddingLeft = `${12 + depth * 12}px`;
      btn.title = node.title;
      if (node.page > 0) {
        btn.addEventListener('click', () => {
          viewer?.goToPage(node.page);
          if (window.innerWidth < 1024) setOutline(false);
        });
      } else {
        btn.disabled = true;
        btn.style.opacity = '0.55';
      }
      els.tocBody.appendChild(btn);
      tocEntries.push({ title: node.title, page: node.page, el: btn });
      if (node.children.length) add(node.children, depth + 1);
    }
  };
  add(doc.outline, 0);
  // Mark where the reader already is: a document opens on a page, and an outline
  // that highlights nothing until the first page change looks broken.
  highlightOutline(currentPage);
}

function highlightOutline(page: number): void {
  let match: TocEntry | null = null;
  for (const entry of tocEntries) {
    if (entry.page > 0 && entry.page <= page) match = entry;
  }
  for (const entry of tocEntries) entry.el.classList.toggle('active', entry === match);
  // The list follows the current page; the pages themselves do not move.
  if (match && !els.toc.hidden) scrollIntoPanel(match.el, els.tocBody);
}

/* ------------------------------------------------------------------ load */

async function openSource(source: File | string): Promise<void> {
  const label = typeof source === 'string' ? source : source.name;
  busy++;
  els.progress.hidden = false;
  try {
    const v = await ensureViewer();
    const loaded = await v.load(source);
    notify(
      `${loaded.title || label} — ${loaded.pageCount} page${loaded.pageCount === 1 ? '' : 's'}` +
        (loaded.author ? ` · ${loaded.author}` : '') +
        (v.rendersInWorker ? ' · rendering in a worker' : ' · rendering inline'),
    );
  } catch (error) {
    if ((error as Error)?.name === 'PasswordRequiredError') {
      const password = window.prompt('This document is password protected. Password:');
      if (password) {
        try {
          const v = await ensureViewer();
          await v.load(source, password);
        } catch (again) {
          notify(`Error: ${String((again as Error).message)}`, 'error');
        }
      }
    } else {
      console.error(error);
      notify(`Error: ${String((error as Error)?.message ?? error)}`, 'error');
    }
  } finally {
    busy--;
    if (busy <= 0) els.progress.hidden = true;
  }
}

/* ---------------------------------------------------------------- events */

els.open.addEventListener('click', () => els.file.click());
els.emptyOpen.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const file = els.file.files?.[0];
  if (file) void openSource(file);
  els.file.value = '';
});

els.sample.addEventListener('change', () => {
  const url = els.sample.value;
  if (url) void openUrl(url);
  els.sample.value = '';
});

els.emptySample.addEventListener('click', () => {
  if (example) void openUrl(example.url);
});

els.prev.addEventListener('click', () => viewer?.prevPage());
els.next.addEventListener('click', () => viewer?.nextPage());
els.pageno.addEventListener('change', () => {
  const n = Number.parseInt(els.pageno.value, 10);
  if (Number.isFinite(n)) viewer?.goToPage(n);
  else els.pageno.value = String(currentPage);
});

els.zoomIn.addEventListener('click', () => viewer?.zoomIn());
els.zoomOut.addEventListener('click', () => viewer?.zoomOut());
els.zoomValue.addEventListener('change', applyZoomInput);
els.zoomValue.addEventListener('blur', syncZoomBox);
els.zoomValue.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    // With the list open, Enter takes the highlighted level.
    if (els.zoomMenu.hidden) applyZoomInput();
    else if (menuOptions[menuCursor]) applyZoomLevel(menuOptions[menuCursor].level);
    closeZoomMenu();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (els.zoomMenu.hidden) openZoomMenu();
    else moveZoomMenu(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (!els.zoomMenu.hidden) closeZoomMenu();
    else {
      syncZoomBox();
      els.zoomValue.blur();
    }
  }
});
els.zoomMenuBtn.addEventListener('click', () => {
  if (els.zoomMenu.hidden) openZoomMenu();
  else closeZoomMenu();
});
// A click anywhere else, or a resize that would move the anchor, closes the list.
document.addEventListener('pointerdown', (event) => {
  if (!els.zoomMenu.hidden && !(event.target as Element | null)?.closest?.('.zoom-field')) closeZoomMenu();
});
// A resize moves the fit levels; if the current level is a factor, no zoom event
// fires, so ask for the rebuild directly.
window.addEventListener('resize', () => {
  closeZoomMenu();
  refreshZoomMenu();
});

let searchTimer = 0;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => search?.setQuery(els.search.value), 160);
});
els.search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(searchTimer);
    search?.setQuery(els.search.value);
    search?.step(event.shiftKey ? -1 : 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    clearTimeout(searchTimer);
    els.search.value = '';
    search?.clear();
  }
});
els.searchNext.addEventListener('click', () => search?.step(1));
els.searchPrev.addEventListener('click', () => search?.step(-1));

els.tocToggle.addEventListener('click', () => setOutline(els.toc.hidden));
els.tocClose.addEventListener('click', () => setOutline(false));

window.addEventListener('keydown', (event) => {
  if (!viewer) return;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return;
  const key = event.key.toLowerCase();
  if (key === 'o') {
    event.preventDefault();
    els.file.click();
  } else if (key === 'f') {
    event.preventDefault();
    els.search.focus();
    els.search.select();
  }
});

/**
 * The sticky chrome offsets need to know how tall the topbar actually is (it
 * stacks on narrow windows). Kept in CSS pixels and updated on resize only.
 */
if (topbar) {
  const measure = (): void => {
    topbarHeight = topbar.offsetHeight;
    document.documentElement.style.setProperty('--topbar-h', `${topbarHeight}px`);
  };
  measure();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(topbar);
  else window.addEventListener('resize', measure);
}

// A debug handle is genuinely useful when embedding (and when driving the demo
// from an automated test); there is no other global state in the library.
declare global {
  interface Window {
    webpdf?: { viewer(): PdfViewer | null; info(): DocumentInfo | null };
  }
}
window.webpdf = { viewer: () => viewer, info: () => info };

notify('Ready — open a PDF to begin.');
