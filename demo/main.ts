/**
 * Demo application.
 *
 * Deliberately built only on the public API - no private reach-ins - so it
 * doubles as a test that the integration surface is sufficient for a real app
 * (and, by extension, for a browser extension content script).
 *
 * The chrome is one bar and nothing else, and that bar is one line however
 * narrow the window is: the document, its outline and the page number on the
 * left, the layout zoom level in the middle, finding and the two drawing modes
 * on the right. Everything on it that opens something is a dropdown built from
 * `menu.ts`; everything else is an icon. There is no status bar - messages float
 * in a toast, and the last render's cost is not shown at all - so the pages get
 * every pixel below the bar, and the browser's own pinch is never competing with
 * chrome that claims to be fixed.
 *
 * The bar is the *document's* chrome, so it arrives with the first page: with
 * nothing open there is nothing for it to hold, and the empty card offers the
 * two ways to get a document in (`#example-field` is one of them). A scroll of
 * the pages puts the chrome away the way a pinch does - see `dismissOnScroll`.
 */

import {
  createViewer,
  BIONIC_DIM,
  DEFAULT_ZOOM_STEPS,
  PdfViewer,
  type DocumentInfo,
  type ViewerEvent,
} from '../src/index.ts';
import { createSearch, type SearchController, type SearchState } from './search.ts';
import { createCropMenu, type CropMenu } from './crop.ts';
import { createMenu, type Menu } from './menu.ts';
import { scrollIntoPanel } from './panels.ts';
import { exampleDocuments, type Example } from './examples.ts';
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
  file: $<HTMLInputElement>('file'),
  exampleBtn: $<HTMLButtonElement>('example-btn'),
  exampleMenu: $('example-menu'),
  tocToggle: $<HTMLButtonElement>('toc-toggle'),
  toc: $('toc'),
  tocBody: $('toc-body'),
  tocClose: $<HTMLButtonElement>('toc-close'),
  navGroup: $('nav-group'),
  pageno: $<HTMLInputElement>('pageno'),
  pagecount: $('pagecount'),
  zoomGroup: $('zoom-group'),
  zoomValue: $<HTMLInputElement>('zoom-value'),
  zoomMenu: $('zoom-menu'),
  zoomMenuBtn: $<HTMLButtonElement>('zoom-menu-btn'),
  searchGroup: $('search-group'),
  search: $<HTMLInputElement>('search'),
  searchCount: $('search-count'),
  searchPrev: $<HTMLButtonElement>('search-prev'),
  searchNext: $<HTMLButtonElement>('search-next'),
  cropGroup: $('crop-group'),
  cropBtn: $<HTMLButtonElement>('crop-btn'),
  cropMenu: $('crop-menu'),
  cropStatus: $('crop-status'),
  cropList: $('crop-list'),
  cropAll: $<HTMLButtonElement>('crop-all'),
  cropNone: $<HTMLButtonElement>('crop-none'),
  cropPadding: $<HTMLInputElement>('crop-padding'),
  bionicGroup: $('bionic-group'),
  bionicBtn: $<HTMLButtonElement>('bionic-btn'),
  bionicMenu: $('bionic-menu'),
  viewer: $('viewer'),
  empty: $('empty'),
  emptyOpen: $<HTMLButtonElement>('empty-open'),
  progress: $('progress'),
  toast: $('toast'),
};

let viewer: PdfViewer | null = null;
let search: SearchController | null = null;
let crop: CropMenu | null = null;
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
/**
 * How the last document was named: a file's own name, or a URL without its
 * scheme. It is what the tab says when the document declares no title of its
 * own - see `document-loaded` below.
 */
let sourceName = '';

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

/**
 * What to call a document that has no title of its own: the file's name, or the
 * URL with its scheme taken off - `arxiv.org/pdf/1706.03762v7` says where the
 * document came from, where `https://arxiv.org/...` mostly says what a browser
 * tab always says.
 */
const nameOf = (source: File | string): string =>
  typeof source === 'string' ? source.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : source.name;

/** Fetch a document from a URL. */
async function openUrl(url: string): Promise<void> {
  await openSource(resolve(url));
}

/* ----------------------------------------------------------------- menus */

/**
 * The dropdowns in the bar. `createMenu` owns the behaviour they share - one at
 * a time, arrows to walk, Escape to leave - and each one rebuilds its rows when
 * it opens, so a menu that depends on the document (the examples) or on the
 * value in force (the zoom level, bionic's fade) is never stale.
 */
const zoomMenu: Menu = createMenu({
  anchors: [els.zoomMenuBtn],
  menu: els.zoomMenu,
  prepare: () => {
    refreshZoomMenu();
    markZoomMenu();
  },
  items: () => [...els.zoomMenu.querySelectorAll<HTMLElement>('.menu-option')],
});

const exampleMenu: Menu = createMenu({
  anchors: [els.exampleBtn],
  menu: els.exampleMenu,
  items: () => [...els.exampleMenu.querySelectorAll<HTMLElement>('.menu-option')],
});

const bionicMenu: Menu = createMenu({
  anchors: [els.bionicBtn],
  menu: els.bionicMenu,
  prepare: fillBionicMenu,
  items: () => [...els.bionicMenu.querySelectorAll<HTMLElement>('.menu-option')],
});

/**
 * Everything that can be open over the pages. A scroll puts all of it away (see
 * `dismissOnScroll`), and so does a pinch.
 */
const menus: readonly Menu[] = [zoomMenu, exampleMenu, bionicMenu];

/* --------------------------------------------------------- examples menu */

/** One row of the example list: the paper, and where it comes from. */
function exampleOption(item: Example): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'menu-option';
  el.setAttribute('role', 'option');
  el.dataset.url = item.url;
  el.title = item.title;
  const name = document.createElement('span');
  name.className = 'menu-name';
  name.textContent = item.label;
  const note = document.createElement('span');
  note.className = 'menu-note';
  note.textContent = item.note;
  el.append(name, note);
  el.addEventListener('click', () => {
    exampleMenu.close();
    void openUrl(item.url);
  });
  return el;
}

/** The list behind the control: whatever this page can actually open. */
function fillExampleMenu(): void {
  const list = exampleDocuments();
  els.exampleMenu.replaceChildren(...list.map(exampleOption));
  els.exampleBtn.disabled = list.length === 0;
}

/* ------------------------------------------------------------- bootstrap */

// The menu is populated before anything can be clicked, so the page never
// offers a document it cannot fetch.
fillExampleMenu();

async function ensureViewer(): Promise<PdfViewer> {
  if (viewer) return viewer;
  viewer = await createViewer({
    container: els.viewer,
    zoom: 'fit-width',
    // The same ladder the zoom box lists, so the dropdown and Ctrl +/- all
    // offer identical levels.
    zoomSteps: DEFAULT_ZOOM_STEPS,
    gap: 16,
    padding: 18,
    keepPages: 1,
    shadowDom: true,
    // Read at each scroll rather than captured, so chrome that changes height
    // (the outline's own header, a bar that grows a pixel) is accounted for.
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
      // The bar is the document's chrome: it arrives with the first page, and
      // with it the controls that only mean something with a document open.
      if (topbar) topbar.hidden = false;
      els.tocToggle.hidden = false;
      els.navGroup.hidden = false;
      els.zoomGroup.hidden = false;
      els.searchGroup.hidden = false;
      els.cropGroup.hidden = false;
      els.bionicGroup.hidden = false;
      // The title rule is only usable on a document that declares a title.
      if (viewer) ensureCropMenu(viewer).setDocument(event.info.title);
      els.pagecount.textContent = String(event.info.pageCount);
      els.pageno.value = '1';
      // A new document starts on page one, whatever page the last one was left
      // on; the outline is marked from that, not from the old position.
      currentPage = 1;
      els.search.value = '';
      // What the tab says, in order of what the reader would recognise: the
      // document's own title, then the file's name, then where it came from.
      document.title = event.info.title || sourceName || 'webpdf';
      renderOutline(event.info);
      // The outline starts closed - the pages are what the page is for - and is
      // opened from the bar (or from Ctrl+B's panel-scrolling equivalent).
      setOutline(false);
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
    case 'crop-change':
      // Nothing to do but say so: the viewer has already re-laid-out the pages.
      crop?.setProgress({ measured: event.measured, total: event.total, running: event.running });
      break;
    case 'render':
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

function zoomOptionElement(option: ZoomOption): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'menu-option';
  el.setAttribute('role', 'option');
  const name = document.createElement('span');
  name.className = 'menu-name';
  name.textContent = option.label;
  el.appendChild(name);
  el.addEventListener('click', () => {
    applyZoomLevel(option.level);
    zoomMenu.close();
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
}

/** Show which rung the viewer is on now. */
function markZoomMenu(): void {
  if (!viewer || menuOptions.length === 0) return;
  const current = menuOptions.findIndex((option) => isCurrentLevel(option.level, viewer!.zoom, viewer!.zoomMode));
  els.zoomMenu.querySelectorAll<HTMLElement>('.menu-option').forEach((el, index) => {
    el.setAttribute('aria-selected', String(index === current));
  });
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

/* ------------------------------------------------------------------ crop */

/**
 * The crop dropdown: rules in, a selection out. Applying it is one call - the
 * viewer measures the pages and re-lays them out as the boxes arrive - and the
 * progress it reports back is what the panel's status line shows.
 */
function ensureCropMenu(v: PdfViewer): CropMenu {
  if (crop) return crop;
  crop = createCropMenu({
    button: els.cropBtn,
    menu: els.cropMenu,
    list: els.cropList,
    status: els.cropStatus,
    allButton: els.cropAll,
    noneButton: els.cropNone,
    padding: els.cropPadding,
    onChange: (rules, padding) => v.setCrop(rules, padding),
  });
  return crop;
}

/* --------------------------------------------------------------- bionic */

/**
 * Bionic reading is one choice: off, or a fade at some strength. The menu is
 * where the choice is made - the button is its face - and the star on a row
 * marks the fade in force, so the value a reader settled on is always the one
 * the menu opens on and always the one they can see.
 *
 * The library's default (a half) is `BIONIC_DIM`; the values either side of it
 * are here because how much of a word to hold is a matter of taste and of
 * eyesight. Below 0.3 the remainder reads as a printing fault and above 0.7
 * there is nothing much left to hold, so that is the range on offer.
 */
const BIONIC_CHOICES: ReadonlyArray<{ dim: number; note: string }> = [
  { dim: 0.3, note: 'the rest of each word is barely there' },
  { dim: 0.4, note: 'a strong fade' },
  { dim: BIONIC_DIM, note: 'the default — the balance the eye wants' },
  { dim: 0.6, note: 'a light fade' },
  { dim: 0.7, note: 'barely faded at all' },
];

function bionicOption(
  label: string,
  note: string,
  state: { selected: boolean; starred: boolean },
  choose: () => void,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'menu-option';
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', String(state.selected));
  const name = document.createElement('span');
  name.className = 'menu-name';
  name.textContent = label;
  if (state.starred) {
    const star = document.createElement('span');
    star.className = 'star';
    star.setAttribute('aria-hidden', 'true');
    star.textContent = '★';
    star.title = 'the value in force';
    name.appendChild(star);
  }
  const detail = document.createElement('span');
  detail.className = 'menu-note';
  detail.textContent = note;
  el.append(name, detail);
  el.addEventListener('click', () => {
    choose();
    bionicMenu.close();
  });
  return el;
}

function fillBionicMenu(): void {
  const on = viewer?.bionic ?? false;
  const dim = viewer?.bionicDim ?? BIONIC_DIM;
  const rows = [
    bionicOption('Off', 'the pages as the document sets them', { selected: !on, starred: false }, () => setBionic(false)),
  ];
  for (const choice of BIONIC_CHOICES) {
    const starred = Math.abs(choice.dim - dim) < 1e-9;
    rows.push(
      bionicOption(
        `Fade the rest to ${Math.round(choice.dim * 100)}%`,
        choice.note,
        { selected: on && starred, starred },
        () => setBionic(true, choice.dim),
      ),
    );
  }
  els.bionicMenu.replaceChildren(...rows);
  els.bionicBtn.dataset.on = String(on);
  els.bionicBtn.title = on
    ? `Bionic reading on — the rest of every word at ${Math.round(dim * 100)}%`
    : 'Bionic reading — hold the first letters of every word at full strength';
}

/** The mode, and how faint the rest of a word is drawn. */
function setBionic(on: boolean, dim?: number): void {
  if (!viewer) return;
  viewer.setBionic(on, dim);
  fillBionicMenu();
}

/* ---------------------------------------------------------------- panels */

/**
 * Close everything that was opened over the pages - the outline, the dropdowns,
 * the crop rules - and take focus out of it.
 *
 * Two things do this rather than an accident of a toggle. A pinch is the
 * browser's page scale, and chrome drawn next to the pages is magnified with
 * them and can be panned out of view; a scroll of the pages moves the document
 * out from under an open panel just as surely. A panel left open behind either
 * one is not just invisible, it is still live, and still scrolling itself into
 * view. Dismissing says what is true - there is nothing on screen to read - and
 * keeps the document the only thing that can move.
 *
 * Cheap enough to call on every scroll: the common case is four checks.
 */
function dismissChrome(): void {
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && (topbar?.contains(active) === true || els.toc.contains(active));
  const open = !els.toc.hidden || menus.some((menu) => menu.isOpen) || crop?.isOpen === true;
  if (!open && !focused) return;
  if (!els.toc.hidden) setOutline(false);
  for (const menu of menus) menu.close();
  crop?.close();
  // Focus left in a control that has just been hidden would swallow keystrokes.
  // The viewer's link hit areas are not chrome, and keep theirs.
  if (focused) active.blur();
}

/**
 * A scroll of the pages is a reader moving the document, and it puts the chrome
 * away the way a pinch does.
 *
 * This listens for the *intent* - a wheel, a touch drag, a scrolling key -
 * rather than for `scroll` itself, because the viewer scrolls the document
 * programmatically all the time: a link, a page jump, a crop that re-lays the
 * pages out. Those are the reader's own commands, and closing the panel they
 * gave the command from would be the wrong answer. Chrome that scrolls itself
 * (the outline, an open dropdown) is left alone for the same reason.
 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);

function dismissOnScroll(): void {
  const inPanel = (event: Event): boolean => {
    const target = event.target;
    // The bar, the outline, and the card that offers a document: a wheel over
    // any of them is scrolling *that*, not the pages - and with no document
    // open there are no pages for a scroll to move in the first place.
    return target instanceof Element && target.closest('.topbar, .toc, .empty') !== null;
  };
  window.addEventListener(
    'wheel',
    (event) => {
      if (!inPanel(event)) dismissChrome();
    },
    { passive: true },
  );
  window.addEventListener(
    'touchmove',
    (event) => {
      if (!inPanel(event)) dismissChrome();
    },
    { passive: true },
  );
  window.addEventListener('keydown', (event) => {
    if (!SCROLL_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    // A key pressed into a control is that control's: Space activates a button,
    // an arrow moves the caret in a text field.
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
    dismissChrome();
  });
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
  // Read by `document-loaded`, which fires while `load` is still running.
  sourceName = nameOf(source);
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

els.emptyOpen.addEventListener('click', () => els.file.click());
// A file can still be opened once a document is: Ctrl+O, a drop on the pages,
// or the viewer's own drop target.
els.file.addEventListener('change', () => {
  const file = els.file.files?.[0];
  if (file) void openSource(file);
  els.file.value = '';
});

els.pageno.addEventListener('change', () => {
  const n = Number.parseInt(els.pageno.value, 10);
  if (Number.isFinite(n)) viewer?.goToPage(n);
  else els.pageno.value = String(currentPage);
});

els.zoomValue.addEventListener('change', applyZoomInput);
els.zoomValue.addEventListener('blur', syncZoomBox);
els.zoomValue.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    // With the list open, Enter takes the highlighted level.
    if (zoomMenu.isOpen) zoomMenu.current()?.click();
    else applyZoomInput();
    zoomMenu.close();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    zoomMenu.move(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (zoomMenu.isOpen) zoomMenu.close();
    else {
      syncZoomBox();
      els.zoomValue.blur();
    }
  }
});
// A click anywhere else, or a resize that would move the anchor, closes the list.
document.addEventListener('pointerdown', (event) => {
  const target = event.target as Element | null;
  if (!els.cropMenu.hidden && !target?.closest?.('.crop-field')) crop?.close();
});
// A resize moves the fit levels; if the current level is a factor, no zoom event
// fires, so ask for the rebuild directly.
window.addEventListener('resize', () => {
  zoomMenu.close();
  crop?.close();
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

els.cropBtn.addEventListener('click', () => crop?.toggle());

els.tocToggle.addEventListener('click', () => setOutline(els.toc.hidden));
els.tocClose.addEventListener('click', () => setOutline(false));

dismissOnScroll();

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
 * The sticky chrome offsets need to know how tall the topbar actually is. It is
 * one line at every width now, but a font that loads late can still move it a
 * pixel, and the viewer reads this on every scroll.
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
