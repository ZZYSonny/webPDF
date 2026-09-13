/**
 * Demo application.
 *
 * The page is the host: it owns the chrome - the bar, the outline, the crop menu,
 * the reader's memory - and hands the document to a viewer that draws it. What
 * used to be two halves of one repository (`src/`, a published library, and
 * `demo/`, a page that imported it) is now this page and the Rust core it drives;
 * `demo/core/` is the layer that spells the core's protocol in TypeScript, and
 * `demo/viewer.ts` is the viewer itself. Nothing here reaches past those two.
 *
 * The chrome is one bar and nothing else, and that bar is one line however
 * narrow the window is: the document, its outline and the page number on the
 * left, the layout zoom level in the middle, finding and the two drawing modes
 * on the right. Everything on it that opens something is a dropdown built from
 * `menu.ts`; everything else is an icon. There is no status bar, and a document
 * that is open says nothing at all: only a failure the reader has to answer for
 * reaches them, in a toast, and the last render's cost is not shown either - so
 * the pages get every pixel below the bar, and the browser's own pinch is never
 * competing with chrome that claims to be fixed.
 *
 * The bar is the *document's* chrome, so it arrives with the first page: with
 * nothing open there is nothing for it to hold, and the empty card offers the
 * two ways to get a document in (`#example-field` is one of them). A scroll of
 * the pages puts the chrome away the way a pinch does - see `dismissOnScroll`.
 */

import { PdfEngine } from './core/engine.ts';
import { createWorkerEngine } from './core/client.ts';
import { BIONIC_DIM } from './core/bionic.ts';
import type { DocumentInfo, FontPlanProgress, PdfEngineLike } from './core/types.ts';
import { DEFAULT_ZOOM_STEPS, PdfViewer, type RenderMode, type ViewerEvent } from './viewer.ts';
import { core } from 'virtual:webpdf/core';
import { createHostBridge, isHosted, type HostBridge, type HostDocument } from './host.ts';
import { createOffline } from './offline.ts';
import { get, inherited, keyOfFile, keyOfUrl, MEMORY_KEY, put, read, write, type Memory, type Place, type Settings } from './memory.ts';
import { createSearch, type SearchController, type SearchState } from './search.ts';
import { createCropMenu, type CropMenu } from './crop.ts';
import { CUSTOM_RULES_KEY, readCustomRules, writeCustomRules, type CropRule } from './core/rules.ts';
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
  modeBtn: $<HTMLButtonElement>('mode-btn'),
  modeMenu: $('mode-menu'),
  modeLabel: $('mode-label'),
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
  cropAdd: $<HTMLFormElement>('crop-add'),
  cropNewName: $<HTMLInputElement>('crop-new-name'),
  cropNewPattern: $<HTMLInputElement>('crop-new-pattern'),
  cropNewError: $('crop-new-error'),
  bionicGroup: $('bionic-group'),
  bionicBtn: $<HTMLButtonElement>('bionic-btn'),
  bionicMenu: $('bionic-menu'),
  viewer: $('viewer'),
  empty: $('empty'),
  emptyOpen: $<HTMLButtonElement>('empty-open'),
  progress: $('progress'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $<HTMLButtonElement>('toast-action'),
  toastDismiss: $<HTMLButtonElement>('toast-dismiss'),
  password: $('password'),
  passwordForm: $<HTMLFormElement>('password-form'),
  passwordText: $('password-text'),
  passwordInput: $<HTMLInputElement>('password-input'),
  passwordCancel: $<HTMLButtonElement>('password-cancel'),
  /** Where the printer is handed the document: see `printDocument`. */
  print: $<HTMLIFrameElement>('print'),
};

let viewer: PdfViewer | null = null;
let search: SearchController | null = null;
let crop: CropMenu | null = null;
let info: DocumentInfo | null = null;
let currentPage = 1;
let busy = 0;
let toastTimer = 0;
/** How long a burst of scrolling is allowed to go unwritten. */
const REPORT_MS = 400;
/**
 * The reader's own memory: what this page has been asked to draw before, and
 * where the reader was in it. Read once, at start-up, and written back whole.
 */
let memory: Memory = read(localStorage.getItem(MEMORY_KEY));
/**
 * The crop rules the reader wrote, which belong to them and not to a document:
 * read once, at start-up, and written back whole. They are the vocabulary of
 * marks a reader has built up, so they follow them from one paper to the next.
 */
let customCropRules: CropRule[] = readCustomRules(localStorage.getItem(CUSTOM_RULES_KEY));
/** What identifies the document on screen in that memory, if one is open. */
let openKey: string | null = null;
let rememberTimer = 0;
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
 * it rather than against a domain root: the built demo is published under a path
 * ([user].github.io/<repo>/) that it has no other way of knowing.
 *
 * It is the *page's* directory, not the module's: the module is one of the
 * hashed files under `assets/`, and a reader typing a relative URL - or an
 * address this build hands the page for something it serves itself, like the
 * engine's wasm - means it relative to the page they are looking at.
 */
const BASE = new URL('.', document.baseURI).href;

const resolve = (url: string): string => new URL(url, BASE).href;

/**
 * Where the core is: the glue script this build emitted, resolved against the
 * page rather than against this module - the module is one of the hashed files
 * under `assets/`, the core is not, and a reader behind a different path
 * (`[user].github.io/<repo>/`, a server that mounted the build a level down)
 * has to find it the way they find the page.
 */
const coreUrl = new URL(core.url, BASE).href;

/**
 * Where the core's binary is, which is not the glue's name with a different
 * extension: the build names the release binary for the digest of its bytes, so
 * that the copy a service worker kept for the build before this one is never
 * asked for under this one's name. Only the build knows that name, so it is
 * resolved here - against the page, like the glue - and handed to the engine as
 * a fact rather than worked out again by whoever needs it.
 */
const wasmUrl = new URL(core.wasm, BASE).href;
const wasm = { url: wasmUrl, integrity: core.integrity };

/**
 * The engine: a worker that owns the core, or - where there is no worker to be
 * had - the core on this thread.
 *
 * The worker is preferred because a page render is tens of milliseconds of
 * arithmetic and the reader is scrolling through it; the fallback is the honest
 * one, because a viewer that refuses to draw without a worker is a viewer that
 * does not work in a frame that has none. Nothing above this line knows which
 * one it got: both answer the same calls, and the page never asks - a reader
 * does not care which thread has the document, so nothing here mentions it.
 */
async function createEngine(planFonts: boolean): Promise<PdfEngineLike> {
  const options = { coreUrl, wasmUrl, planFonts, onWarn: warn };
  const worker = await createWorkerEngine(options);
  if (worker) return worker;
  // The wasm is fetched and instantiated here and now, on this thread.
  return await PdfEngine.create(options);
}

/**
 * The offline half of the page: the service worker, and the documents worth
 * keeping. A page that is being driven inside a host's frame keeps none of it -
 * see `demo/offline.ts`.
 */
const offline = createOffline({
  engine: wasm,
  hosted: isHosted() && window.parent !== window,
  onWarn: warn,
  // A newer build of the viewer, waiting for a page willing to reload into it.
  // The page says so and lets the reader decide; the alternative is a build that
  // installs and then sits there until every tab of the old one is closed.
  onUpdate: (apply) => announceUpdate(apply),
});

/**
 * What to call a document that has no title of its own: the file's name, or the
 * URL with its scheme taken off - `arxiv.org/pdf/1706.03762v7` says where the
 * document came from, where `https://arxiv.org/...` mostly says what a browser
 * tab always says.
 */
const urlName = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
const nameOf = (source: File | string): string => (typeof source === 'string' ? urlName(source) : source.name);

/** Anything the reader, the page, or a host can hand to `openSource`. */
type Source = File | string | ArrayBuffer | Uint8Array | Blob;

/** What to call a document that arrived as bytes, or through a host. */
function labelOf(source: Source, host?: HostDocument | null): string {
  if (host?.name) return host.name;
  if (typeof source === 'string') return urlName(source);
  if (typeof File !== 'undefined' && source instanceof File) return source.name;
  return 'document';
}

/**
 * A filename a browser will write, out of whatever the document is called.
 *
 * A URL names a document as `host/path/paper.pdf`, which is a fine title and not
 * a filename: what is written to disk is the last part of it.
 */
function fileNameFor(label: string): string {
  const base = label.split(/[\\/]/).filter(Boolean).pop() ?? 'document';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

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

/* ---------------------------------------------------------- render mode */

/**
 * How the pages are drawn, chosen once on the card that offers a document.
 *
 * There is one font path in the core and it is the document's: a page shows real
 * text only once the plan has walked the document and built its faces, and until
 * then every glyph is an outline - the same shapes, in the same places, with no
 * text to select or search. The plan is cheap (0.2 s for a hundred pages, 0.9 s
 * for the 756-page specification, measured) but it is not instant, so the
 * question the two modes answer is what to do with it:
 *
 *   - `'global'` draws nothing at all until the plan is ready, and then draws
 *     once: the page a reader sees is never drawn twice. This is the mode the
 *     page starts in and stars.
 *   - `'progressive'` is the fallback path: pages are drawn incrementally as
 *     outlines, which look like the page they are, and are never blocked by the
 *     font conversion. Each is redrawn under the document's faces the moment
 *     they are ready, handing over without the reader seeing it.
 */
const RENDER_MODES: ReadonlyArray<{ id: RenderMode; label: string; note: string }> = [
  {
    id: 'global',
    label: 'Global Font Only',
    note: 'the most performant path — nothing is drawn until the document’s fonts are planned, then each page once',
  },
  {
    id: 'progressive',
    label: 'Start with Outline',
    note: 'the fallback path — pages render incrementally as outlines, not blocked by the font conversion, then redraw under the document’s faces',
  },
];

/**
 * The mode this page starts in, and the one it stars.
 *
 * A star in this page is a recommendation and not a state - the crop menu's
 * works the same way, and its README says so - so the row it sits on is the
 * setting worth choosing and the row *in force* is the one the menu opens on and
 * colours (`aria-selected`). Waiting for the plan is the recommended one because
 * the plan is cheap even for a 756-page document, and because waiting means no
 * page is ever drawn twice: the reader gets the finished page, with its text, the
 * first time it is on screen. `'progressive'` is one click away on the same
 * dropdown, for a reader who would rather see the page at once.
 */
const RECOMMENDED_MODE: RenderMode = 'global';

function modeNamed(value: unknown): RenderMode | null {
  return RENDER_MODES.some((mode) => mode.id === value) ? (value as RenderMode) : null;
}

function requestedMode(): RenderMode {
  const params = new URLSearchParams(location.search);
  // `?plan=0` is the name this page used before there was a menu, when "do not
  // plan" was the only other answer there was; it still means "do not wait for
  // the plan", which is the one mode that does not.
  if (params.get('plan') === '0') return 'progressive';
  return modeNamed(params.get('mode')) ?? modeNamed(inherited(memory)?.renderMode) ?? RECOMMENDED_MODE;
}

let renderMode = requestedMode();

const modeMenu: Menu = createMenu({
  anchors: [els.modeBtn],
  menu: els.modeMenu,
  prepare: fillModeMenu,
  items: () => [...els.modeMenu.querySelectorAll<HTMLElement>('.menu-option')],
});

function modeOption(mode: (typeof RENDER_MODES)[number]): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'menu-option';
  el.setAttribute('role', 'option');
  // The row in force, which is what the menu opens on and colours...
  el.setAttribute('aria-selected', String(mode.id === renderMode));
  el.dataset.mode = mode.id;
  const name = document.createElement('span');
  name.className = 'menu-name';
  name.textContent = mode.label;
  // ...and the row this page recommends, which is the one that carries the star.
  if (mode.id === RECOMMENDED_MODE) {
    const star = document.createElement('span');
    star.className = 'star';
    star.setAttribute('aria-hidden', 'true');
    star.textContent = '★';
    star.title = 'the recommended mode';
    name.appendChild(star);
  }
  const note = document.createElement('span');
  note.className = 'menu-note';
  note.textContent = mode.note;
  el.append(name, note);
  el.addEventListener('click', () => {
    chooseMode(mode.id);
    modeMenu.close();
  });
  return el;
}

function fillModeMenu(): void {
  els.modeMenu.replaceChildren(...RENDER_MODES.map(modeOption));
}

function syncModeLabel(): void {
  const chosen = RENDER_MODES.find((mode) => mode.id === renderMode);
  els.modeLabel.textContent = chosen?.label ?? renderMode;
  els.modeBtn.title = chosen ? `Rendering mode — ${chosen.note}` : 'Rendering mode';
}

/**
 * Take the mode for the session.
 *
 * The card is only on screen while no document is open, so this is a choice
 * about the engine and the viewer that are about to be built rather than about
 * a document: both are made once, on the first open, and neither can change its
 * mind afterwards. It is remembered with the document that is opened under it,
 * like every other setting, so the next visit starts the way this one was set
 * up.
 */
function chooseMode(mode: RenderMode): void {
  if (mode === renderMode) return;
  renderMode = mode;
  syncModeLabel();
  fillModeMenu();
  rememberHere();
}

syncModeLabel();
fillModeMenu();

/**
 * Everything that can be open over the pages. A scroll puts all of it away (see
 * `dismissOnScroll`), and so does a pinch.
 */
const menus: readonly Menu[] = [zoomMenu, exampleMenu, bionicMenu, modeMenu];

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
  // The plan is not optional: it is where text comes from, and every mode wants
  // it. What the mode chooses is when to draw and where a page's faces live.
  const engine = await createEngine(true);
  viewer = PdfViewer.create({
    container: els.viewer,
    engine,
    zoom: 'fit-width',
    // The same ladder the zoom box lists, so the dropdown and Ctrl +/- all
    // offer identical levels.
    zoomSteps: DEFAULT_ZOOM_STEPS,
    gap: 16,
    padding: 18,
    // Pages either side of the viewport that stay in the document. The window
    // itself is a viewport wider than that on each side, and the pages just past
    // it are rendered while the reader is at rest, so that turning a page costs
    // neither a render nor a font registration - see the README.
    keepPages: 1,
    shadowDom: true,
    // What is drawn while the document's fonts are planned - see `RENDER_MODES`
    // above, and `RenderMode` in the viewer.
    renderMode,
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
      // The bar is whole now, and its height is what every scroll of the pages
      // stops short by. Measured here rather than when it was unhidden, because
      // a bar whose controls are still hidden is a different height - and the
      // observer that keeps this current runs a frame later, which is after the
      // first scroll of a document: the one a host makes when it puts the reader
      // back where they were, which would then come back wrong by exactly the
      // height the bar grew.
      measureTopbar();
      // Open one level *below* fit-width rather than at it. Fit-width is the
      // largest level that still shows the page's full width, and starting there
      // leaves the paper touching both edges of the window. Ctrl+0 still means
      // fit width; the ladder is resolved by scale, so this is the next rung down
      // whatever the window size is.
      viewer?.stepZoom(-1);
      break;
    }
    case 'plan-change':
      // In `'global'` the pages were blank a moment ago and are about to be
      // drawn; in `'progressive'` they were outlines and are about to be text.
      // Either way the reader is looking at the document throughout, so there is
      // nothing to say - the page itself is the answer. A host that wants a
      // progress strip reads `plan`.
      break;
    case 'page-change':
      currentPage = event.page;
      els.pageno.value = String(event.page);
      highlightOutline(event.page);
      search?.refresh();
      // A page turn moves the reader: this is the position to come back to.
      rememberHere();
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
      rememberHere();
      break;
    case 'render':
      search?.refresh();
      break;
    case 'link':
      // The viewer has already done the work - an internal link jumped and an
      // external one opened in a new tab - and neither of those needs saying: the
      // page moved, or a tab appeared, and a line over the document telling the
      // reader what they just watched happen is chrome. The one case that does
      // need saying is the link a browser will not follow: nothing happened, and
      // a click that looks broken is worth a sentence rather than silence.
      if (event.kind === 'external' && !event.openable) {
        notify(`This document links to ${event.uri}, which a browser cannot open`, 'error');
      }
      break;
    case 'error':
      console.error(event.error);
      notify(`Error: ${String((event.error as Error)?.message ?? event.error)}`, 'error');
      break;
  }
}

/* ------------------------------------------------------------------ toast */

/**
 * The one message that does not leave on its own: a newer build is installed
 * and waiting to take over (`offline.ts` finds it). It stays until the reader
 * answers it - the button, or the × - because a deploy that nobody is told
 * about is a deploy that never arrives, and unlike the failures below this one
 * is a question rather than a statement.
 */
let applyUpdate: (() => void) | null = null;

/**
 * What the page is willing to interrupt the reader with: a failure. A document
 * that will not open, a document that will not be written out, a link the
 * browser will not follow - each is something only the page can say, and each
 * goes away on its own. Nothing else is said at all: the document's title, its
 * page count, the tab a link opened in and whether its pages are being drawn in
 * a worker are things the tab, the bar and the picture already carry, and a line
 * over the pages repeating them is chrome in the reader's way.
 */
function notify(text: string, kind: 'info' | 'error' = 'info'): void {
  clearTimeout(toastTimer);
  applyUpdate = null;
  els.toastText.textContent = text;
  els.toast.classList.toggle('error', kind === 'error');
  els.toastAction.hidden = true;
  els.toastDismiss.hidden = true;
  els.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, kind === 'error' ? 8000 : 3500);
}

/**
 * Something the machinery under the page had to say while it worked: a worker
 * that would not boot on this browser, a document's faces that could not be
 * planned, an offline copy that did not fit. None of it is the reader's to
 * answer and all of it is recoverable, so none of it floats over the pages - it
 * goes where the next person to open a console will find it, prefixed so they
 * know which layer said it.
 */
function warn(message: string): void {
  console.warn(`[webpdf] ${message}`);
}

/** Say that a newer build is waiting, and take the reader's answer to it. */
function announceUpdate(apply: () => void): void {
  clearTimeout(toastTimer);
  applyUpdate = apply;
  els.toastText.textContent = 'A newer version of the viewer is ready.';
  els.toast.classList.remove('error');
  els.toastAction.textContent = 'Reload';
  els.toastAction.disabled = false;
  els.toastAction.hidden = false;
  els.toastDismiss.hidden = false;
  els.toast.hidden = false;
}

els.toastAction.addEventListener('click', () => {
  const apply = applyUpdate;
  if (!apply) return;
  applyUpdate = null;
  // The page is about to be replaced; saying so is the last thing this one does.
  els.toastAction.disabled = true;
  els.toastAction.textContent = 'Reloading…';
  apply();
});

els.toastDismiss.addEventListener('click', () => {
  // Not now is an answer: the build stays waiting, and the next visit is told
  // about it again.
  applyUpdate = null;
  els.toast.hidden = true;
});

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
 * The crop dropdown: regular expressions in, a selection out. Applying it is
 * one call - the viewer measures the pages and re-lays them out as the boxes
 * arrive - and the progress it reports back is what the panel's status line
 * shows.
 *
 * The reader's own rules are the page's to keep: the menu hands them back here
 * whenever they change, and this is where they go into `localStorage` and come
 * back from it.
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
    add: {
      form: els.cropAdd,
      name: els.cropNewName,
      pattern: els.cropNewPattern,
      error: els.cropNewError,
    },
    customRules: customCropRules,
    onCustomRules: (rules) => {
      customCropRules = [...rules];
      try {
        localStorage.setItem(CUSTOM_RULES_KEY, writeCustomRules(rules));
      } catch {
        /* storage full or blocked: the rule still applies for this sitting */
      }
    },
    checkPattern: (pattern) => v.checkCropPattern(pattern),
    onChange: (patterns, padding) => v.setCrop(patterns, padding),
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
  rememberHere();
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
  rememberHere();
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

/**
 * What this page is holding: the bytes of the document on screen, when it has
 * them, and the name they are known by.
 *
 * A document a host handed over, or one the reader opened from their own disk,
 * is here - and those bytes are the reader's own file, which is what saving it
 * has to write back out, byte for byte. A document this page was only given the
 * URL of is not here, and is written out by the engine that read it instead:
 * see `documentBytes`.
 */
let saving: { bytes: BlobPart; name: string } | null = null;

/** The bytes of a document, when this page has them, and what to write them as. */
function savable(source: Source, label: string): { bytes: BlobPart; name: string } | null {
  const name = fileNameFor(label);
  if (typeof Blob !== 'undefined' && source instanceof Blob) return { bytes: source, name };
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return { bytes: source as BlobPart, name };
  return null;
}

/**
 * The document's own bytes, for the two things a reader does with a document
 * besides read it: keep it, and print it.
 *
 * What this page is holding comes back untouched, because it *is* the document -
 * the reader's file, or the one a host fetched for them. A document this page
 * only has the URL of is written out by the engine that read it: the same
 * document, in MuPDF's own copy of it, with no second trip over the network for
 * bytes that have been read once already and no dependence on the server that
 * served them still being willing to.
 *
 * `fresh` asks for that engine copy even when the page is holding bytes, which
 * is what printing an encrypted document needs: the file still carries the
 * password, and the browser's own PDF viewer - the thing a printer is handed -
 * would ask for it in a frame nobody can see. MuPDF writes the document out
 * without it, because the page has already answered for it.
 */
async function documentBytes(fresh = false): Promise<{ bytes: BlobPart; name: string } | null> {
  if (!fresh && saving) return saving;
  if (!viewer) return null;
  // Read before the wait: a document switched mid-write must not name its
  // predecessor's bytes after it.
  const name = fileNameFor(sourceName);
  try {
    // The cast is the same one `savable` makes: a `Uint8Array` from the engine
    // is a `BlobPart` at runtime whatever TypeScript makes of a view's buffer.
    return { bytes: (await viewer.save()) as BlobPart, name };
  } catch (error) {
    notify(`Cannot write the document out: ${String((error as Error)?.message ?? error)}`, 'error');
    return null;
  }
}

/** Write the open document out, under the name it is known by. */
function saveDocument({ bytes, name }: { bytes: BlobPart; name: string }): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // The browser has read the blob the moment the download begins; a minute is
  // long enough for that and short enough not to hold a document all session.
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Ctrl+S: the document, which is not the same thing as this page.
 *
 * What is on screen is a drawing of the document - SVG the viewer built, one
 * text run at a time - and what a reader means by saving a PDF is the PDF. The
 * browser's own answer here would be worse than that: with nothing but a page to
 * save, it writes the HTML that happens to be drawing the document.
 */
async function saveCurrent(): Promise<void> {
  const doc = await documentBytes();
  if (doc) saveDocument(doc);
}

/* ----------------------------------------------------------------- print */

/** How long a print waits for the frame to hold the document, at the most. */
const PRINT_LOAD_MS = 4000;

/** The blob the print frame is showing, so the copy before it can be let go. */
let printUrl: string | null = null;

/**
 * Ctrl+P: the same bytes, given to the printer.
 *
 * A printer is not a screen. Handing it the pages on screen would re-lay every
 * one of them out at the paper's width, and it would be printing the viewer's
 * drawing of the document rather than the document. A PDF *is* a print format,
 * and the browser prints one natively and exactly, so the document goes into a
 * frame of its own (`#print`) and the frame is what is printed: nothing of this
 * page - its SVG, its chrome, its scrolling - is part of the job.
 *
 * What is printed is the document as it is, not as it is being read: cropping,
 * bionic reading and the zoom level belong to the reader's screen and none of
 * them is a thing a printer can be asked for.
 */
async function printDocument(): Promise<void> {
  // A document that had to be unlocked is written out by the engine rather than
  // printed from the file this page is holding: that file still carries the
  // password, and the browser's viewer would ask for it in a frame nobody can
  // see. (`encrypted` stays true after MuPDF has been given the password.)
  const doc = await documentBytes(info?.encrypted === true);
  if (!doc) return;
  const url = URL.createObjectURL(new Blob([doc.bytes], { type: 'application/pdf' }));
  const previous = printUrl;
  printUrl = url;
  const frame = els.print;
  const loaded = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
  frame.src = url;
  // The browser has read the blob into the frame the moment it loads it; a
  // minute is long enough for that and short enough not to hold a copy of a
  // document that has already been replaced.
  if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 60000);
  // A frame that has loaded the viewer is a print that starts immediately. One
  // that never says it has is one that is not going to print at all, and waiting
  // on it forever is worse than printing into it anyway.
  await Promise.race([loaded, new Promise<void>((resolve) => window.setTimeout(resolve, PRINT_LOAD_MS))]);
  const win = frame.contentWindow;
  if (win) win.print();
  else window.open(url, '_blank');
}

/**
 * Let go of the document the printer was given.
 *
 * The frame is kept between prints, because a frame that has already loaded the
 * browser's PDF viewer is a print that starts at once - but the document in it
 * is a document, held by that viewer as well as by this page, and opening
 * another one is the moment it is worth nothing.
 */
function releasePrint(): void {
  if (!printUrl) return;
  URL.revokeObjectURL(printUrl);
  printUrl = null;
  els.print.removeAttribute('src');
}

/**
 * Fetch a document from a URL, as a blob this page is holding.
 *
 * The engine could fetch it for itself - it is handed a URL as happily as bytes
 * - but then the document would exist only inside the worker that read it, and
 * the page could neither keep it for an offline visit nor write it back out
 * untouched when the reader saves it. So the page reads it, once, and hands the
 * same bytes to both.
 *
 * The fragment is dropped because it names a place *in* a document rather than a
 * document: `#page=7` from a host is not a different document, and the URL the
 * copy is kept under has to be the URL that was fetched.
 */
async function fetchDocument(url: string): Promise<Blob> {
  const target = new URL(url);
  target.hash = '';
  let response: Response;
  try {
    response = await fetch(target.href);
  } catch (error) {
    // A fetch that fails with no network is the one failure a reader can act on,
    // and "Failed to fetch" says nothing about why or about what to do.
    if (!navigator.onLine) throw new Error(`this browser is offline, and ${url} has not been kept for offline reading`);
    throw error;
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return await response.blob();
}

/**
 * Open a document, from wherever it came: a file the reader chose, a URL the
 * page was asked for, or bytes a host handed over.
 *
 * `host` is what the host knows about the document that the page cannot work out
 * for itself - its name, its size, and the page a `#page=` asked for - and it is
 * the only thing that differs between the reader's own document and one the
 * extension brought. Where the reader was is this page's own business: it is in
 * the memory, and it is what the page puts back before the host is told what
 * opened.
 */
async function openSource(source: Source, host?: HostDocument | null): Promise<void> {
  const label = labelOf(source, host);
  const key = keyFor(source, label, host);
  // Read by `document-loaded`, which fires while `load` is still running.
  sourceName = host?.url ? urlName(host.url) : label;
  busy++;
  saving = null;
  // The document the printer was given is not this one: let it go with the
  // document it belonged to.
  releasePrint();
  // Whatever the reader did to the document that is being replaced, write it down
  // now: a settings change within the debounce window would otherwise be lost by
  // the switch.
  commitMemory();
  openKey = null;
  els.progress.hidden = false;
  try {
    const v = await ensureViewer();
    // A document that lives at a URL is read *here*, by the page, rather than by
    // the engine that will draw it. Two things follow from that, and both of them
    // are the reader's: bytes this page has read are bytes it can keep for the
    // next visit with no network (`offline.keep`), and they are the document
    // itself, so saving it writes what the server sent rather than a copy of it
    // (see `documentBytes`).
    const fetched = typeof source === 'string' ? await fetchDocument(source) : null;
    const document_ = fetched ?? source;
    // An encrypted document is the one failure the reader can answer for, so the
    // question is repeated for as long as they are willing to answer it: a wrong
    // password comes back as the same error, and only Cancel ends it. The count
    // is a guard against a document that never accepts anything, not a limit a
    // reader would ever reach.
    let password: string | undefined;
    for (let tries = 0; ; tries++) {
      try {
        await v.load(document_, password);
        break;
      } catch (error) {
        if ((error as Error)?.name !== 'PasswordRequiredError' || tries >= 20) throw error;
        const answer = await askPassword(tries > 0);
        if (answer == null) throw error;
        password = answer;
      }
    }
    // The document says nothing for itself once it is open: its title is on the
    // tab, its page count is on the bar, and which thread is drawing it is this
    // page's business rather than the reader's.
    openKey = key;
    // Where this document was left, or - if it has never been read here - the
    // settings of the last one, at its first page.
    restoreMemory(key, host);
    saving = savable(document_, label);
    // The engine has now been read for a document, whichever document it was: a
    // copy of it is what makes the next visit work with no network at all, and it
    // is asked for once, here, rather than at start-up for a reader who may never
    // open anything.
    offline.used();
    // A document from a URL is worth keeping, whole and unread, so that opening it
    // again is not a download. A file the reader chose is already theirs.
    if (fetched && typeof source === 'string') offline.keep(source, fetched);
    // Written now rather than at the end of the window: a document the reader
    // opens and closes without moving is still a document they read.
    commitMemory();
    hostBridge.opened({ info: hostInfo(), name: label, size: sizeOf(source, host) });
  } catch (error) {
    console.error(error);
    const message = String((error as Error)?.message ?? error);
    notify(`Error: ${message}`, 'error');
    hostBridge.failed(message);
  } finally {
    busy--;
    if (busy <= 0) els.progress.hidden = true;
  }
}

/** How big the document is, as far as anyone here can tell. */
function sizeOf(source: Source, host?: HostDocument | null): number {
  if (host?.size) return host.size;
  if (typeof source === 'object' && source !== null && 'byteLength' in source) return source.byteLength;
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source.size;
  return 0;
}

/**
 * The password for an encrypted document, asked for in the page.
 *
 * Not with `window.prompt`: a cross-origin frame may not raise a dialog at all,
 * and a page that is drawing the document is the right place to ask for the key
 * to it in any case. The card is ordinary markup in this document, so the prompt
 * is the same whether the page was opened by a reader or framed by an extension -
 * and the extension is not asked, because it has nothing to do with it.
 *
 * A wrong password comes back as another `PasswordRequiredError`, and the caller
 * asks again: the only way out is Cancel, which is a null here.
 */
function askPassword(again = false): Promise<string | null> {
  els.passwordText.textContent = again
    ? 'That password did not open it. Try again, or cancel.'
    : 'Enter the password to open it.';
  els.password.hidden = false;
  els.passwordInput.value = '';
  els.passwordInput.focus();
  return new Promise((resolve) => {
    const done = (password: string | null): void => {
      els.password.hidden = true;
      els.passwordForm.removeEventListener('submit', onSubmit);
      els.passwordCancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(password);
    };
    const onSubmit = (event: Event): void => {
      event.preventDefault();
      done(els.passwordInput.value || null);
    };
    const onCancel = (): void => done(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        done(null);
      }
    };
    els.passwordForm.addEventListener('submit', onSubmit);
    els.passwordCancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
}

/**
 * Put the page back the way the reader left it: zoom, crop, fade and outline
 * first (they change the layout), then the position in it - a position is a page
 * and a point on it, so it means the same thing at every zoom.
 *
 * A document that has never been read here starts at the settings of the last one
 * and at its first page; a page the *host* asked for (a `#page=7` on the URL it
 * was opened with) is used only when there is nothing remembered, because a
 * remembered position is where the reader actually left off.
 */
function restoreMemory(key: string, host?: HostDocument | null): void {
  const known = get(memory, key);
  // A document that has been read here before comes back exactly as it was left,
  // outline and all. One that has never been read starts the way this page always
  // starts: the reader's own zoom, crop and fade, and the outline closed - which
  // is where they were rather than how they like to read.
  applySettings(known ? known.settings : outlineClosed(inherited(memory)));
  const place = known?.pos ?? (host?.page ? { page: host.page, y: null } : null);
  if (place) viewer?.goToDestination(place.page, place.y ?? null);
}

/** The reader's settings, with the outline left as a fresh document opens it. */
function outlineClosed(settings: Settings | null): Settings | null {
  return settings ? { ...settings, outline: false } : null;
}

/** Apply remembered settings to the open document. */
function applySettings(settings: Settings | null): void {
  if (!viewer || !settings) return;
  // A fit mode is re-resolved against this window; a fixed scale is restored as
  // it was, which is what makes "as I left it" true on any screen. What is not
  // recognised is ignored rather than passed on: this may be a store a newer
  // version of this page wrote, and only the page that wrote it knows what its
  // own additions mean.
  if (settings.zoom) {
    const { level, mode } = settings.zoom;
    if (mode === 'custom') viewer.setZoom(level);
    else if (mode === 'fit-width' || mode === 'fit-page') viewer.setZoom(mode);
  }
  if (settings.crop) ensureCropMenu(viewer).setPatterns(settings.crop.patterns, settings.crop.padding);
  if (settings.bionic) setBionic(settings.bionic.on, settings.bionic.dim);
  if (typeof settings.outline === 'boolean') setOutline(settings.outline);
  syncZoomBox();
}

/**
 * Write where the reader is, once they stop moving.
 *
 * Every scroll and every settings change comes through here, so the write waits
 * out the burst: the position that matters is the one they stop at. A tab that is
 * going away is the exception - that is the one moment there is no later.
 */
function rememberHere(): void {
  if (!openKey || !viewer) return;
  if (rememberTimer) return;
  rememberTimer = window.setTimeout(commitMemory, REPORT_MS);
}

/** Write it now, rather than at the end of the window. */
function commitMemory(): void {
  if (rememberTimer) {
    clearTimeout(rememberTimer);
    rememberTimer = 0;
  }
  if (!openKey || !viewer) return;
  memory = put(memory, openKey, hostState());
  try {
    localStorage.setItem(MEMORY_KEY, write(memory));
  } catch {
    /* storage full, or blocked: the reader's place is not worth an error card */
  }
}

/** What the host is told about the document on screen. */
function hostInfo(): { title: string; pages: number; author: string } | null {
  return info ? { title: info.title, pages: info.pageCount, author: info.author } : null;
}

/**
 * Where the reader is, and how the document is set up, in one JSON-safe object -
 * the whole of what is remembered about a document. Everything in it is either a
 * page number, a factor or a flag: no pixels, so it outlives a zoom, a resize and
 * a different screen.
 */
function hostState(): { pos: Place | null; settings: Settings } {
  return {
    pos: viewer?.place() ?? null,
    settings: {
      zoom: viewer ? { level: viewer.zoom, mode: viewer.zoomMode } : null,
      // With nothing checked there is no crop to remember - and the padding
      // field is inert without it, so a "padding" of its own is not something
      // the reader ever chose. (The viewer's own default padding is zero; the
      // demo's is 6pt, and inheriting a zero would quietly replace it.) What is
      // kept is the *expressions*, which is what the viewer is applying and
      // what the menu can name again when the same document comes back.
      crop: viewer && viewer.crop.length ? { patterns: [...viewer.crop], padding: viewer.cropPadding } : null,
      bionic: viewer ? { on: viewer.bionic, dim: viewer.bionicDim } : null,
      outline: !els.toc.hidden,
      // Not something the viewer is told; it is what the *next* visit builds the
      // engine and the viewer with (see `requestedMode`).
      renderMode,
    },
  };
}

/**
 * What identifies the document on screen, for the memory: where it came from, or
 * - for a file that never had a URL - its name and its size.
 */
function keyFor(source: Source, label: string, host?: HostDocument | null): string {
  const url = host?.url ?? (typeof source === 'string' ? source : null);
  return url ? keyOfUrl(url) : keyOfFile(label, sizeOf(source, host));
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

/**
 * What the keyboard in front of the reader calls the shortcut key: `⌘` on Apple
 * hardware, `Ctrl` everywhere else. Every shortcut below and in `viewer.ts`
 * takes either modifier (`event.ctrlKey || event.metaKey`), so this is a label
 * and nothing else - but it is the label the card writes its rows with and the
 * one the find box's tooltip names, and `Ctrl` on a Mac keyboard would name a
 * key that is not what a reader there presses.
 */
const MOD_LABEL = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
for (const key of document.querySelectorAll<HTMLElement>('.mod-key')) key.textContent = MOD_LABEL;
for (const el of document.querySelectorAll<HTMLElement>('[data-mod-title]')) {
  el.title = (el.dataset.modTitle ?? '').split('{mod}').join(MOD_LABEL);
}

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
  } else if (key === 's') {
    // The document, not this page: a reader with a PDF open means the PDF, and
    // what the browser would save instead is the HTML drawing it.
    event.preventDefault();
    void saveCurrent();
  } else if (key === 'p') {
    // The document again, and for the same reason - what is on screen is a
    // drawing of it, and a printer is handed the document itself.
    event.preventDefault();
    void printDocument();
  }
});

/**
 * The sticky chrome offsets need to know how tall the topbar actually is. It is
 * one line at every width now, but a font that loads late can still move it a
 * pixel, and the viewer reads this on every scroll.
 */
/**
 * How tall the sticky bar is, read now and kept current by the observer below.
 *
 * Read on demand rather than cached: with no document open the bar is not on
 * screen at all, so the first measurement of a session is the one that matters,
 * and it is taken the moment the bar arrives (see `document-loaded`).
 */
function measureTopbar(): void {
  if (!topbar) return;
  topbarHeight = topbar.offsetHeight;
  document.documentElement.style.setProperty('--topbar-h', `${topbarHeight}px`);
}

if (topbar) {
  measureTopbar();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureTopbar).observe(topbar);
  else window.addEventListener('resize', measureTopbar);
}

// A debug handle is genuinely useful when embedding (and when driving the demo
// from an automated test); there is no other global state in the library. `open`
// is `openSource` itself - the same path a click on an example paper takes, the
// same URL resolution, the same memory and the same keeping for offline - which
// is what makes it worth driving from a test rather than reaching into the page.
declare global {
  interface Window {
    webpdf?: {
      viewer(): PdfViewer | null;
      info(): DocumentInfo | null;
      open(url: string): Promise<void>;
      /** The rendering mode this session was started in. */
      mode(): RenderMode;
      /** How far the document's font plan has got, or null before one starts. */
      plan(): FontPlanProgress | null;
    };
  }
}
window.webpdf = {
  viewer: () => viewer,
  info: () => info,
  open: (url) => openSource(resolve(url)),
  mode: () => renderMode,
  plan: () => viewer?.planProgress ?? null,
};

/**
 * The host, when there is one: the extension this page is the viewer for, or any
 * other application that opened it with `?host=1`. It is inert when the page is
 * opened by a reader, which is every other way of getting here.
 *
 * What it is for is the two things only a host can do: hand over a document (it
 * has the bytes, and this page never fetches one it was not given) and put a
 * password prompt in front of the reader is the page's own card, not the host's.
 * Everything else - where the reader is, how they had it set up, the keyboard,
 * saving - is this page's own, and the host is told what opened only so that it
 * can name the tab.
 */
const hostBridge: HostBridge = createHostBridge({
  open: async (doc) => {
    const bytes = doc.bytes ? (doc.bytes instanceof Uint8Array ? doc.bytes : new Uint8Array(doc.bytes)) : null;
    const source: Source | null = bytes ?? doc.url ?? null;
    if (!source) throw new Error('the host sent no document');
    await openSource(source, doc);
  },
});

/**
 * The File Handling API - what an installed application is given when the
 * operating system opens a file with it - which the DOM library does not carry.
 *
 * The manifest's `file_handlers` is what puts this page in the operating
 * system's own list of applications for a PDF. A launch from there is not a URL
 * the page could read: the browser opens the app at the handler's `action` and
 * puts the files on this queue, where they wait for the page to say what to do
 * with them.
 */
declare global {
  interface LaunchQueue {
    /** Take every launch, including any that arrived before this was called. */
    setConsumer(consumer: (params: LaunchParams) => void): void;
  }
  interface LaunchParams {
    /** The files the launch is for, as handles: the bytes stay where they are. */
    readonly files: FileSystemHandle[];
    /** The URL the app was launched at, which is the handler's `action`. */
    readonly targetURL: string;
  }
  var launchQueue: LaunchQueue;
}

/** Whether the operating system has handed this window a file to open. */
let launched = false;

/** Whether a handle is a file - `kind` is a string, so it narrows nothing. */
const isFile = (handle: FileSystemHandle): handle is FileSystemFileHandle => handle.kind === 'file';

/**
 * The files the operating system opened this application with.
 *
 * A launch is queued before this module runs and is handed over the moment a
 * consumer is set, so this is not a race: a reader who double-clicked a PDF is
 * being answered by the time the greeting below is reached, and is not told to
 * open the one they just opened.
 *
 * The manifest asks for `launch_type: "multiple-clients"`, so a launch carries
 * one file and a reader who opens three documents at once gets three windows,
 * one document each - which is the whole of what this viewer can show. Should a
 * launch carry several files anyway, they are opened one after another and the
 * last is what the window ends up showing: the queue is the operating system
 * asking for them, and dropping one without a word would be worse.
 */
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (params) => {
    launched = true;
    for (const handle of params.files) {
      // A handler for directories would be handed one; this page declared PDFs.
      if (!isFile(handle)) {
        warn(`${handle.name} is not a file, so it was not opened`);
        continue;
      }
      try {
        await openSource(await handle.getFile());
      } catch (error) {
        // Only the handover itself can fail here; `openSource` answers for its own.
        console.error(error);
        notify(`Error: ${String((error as Error)?.message ?? error)}`, 'error');
      }
    }
  });
}

if (isHosted()) {
  // A hosted page has no reader to greet and no document to offer: it is waiting
  // for the one it was opened for, which the card would only cover up.
  els.empty.hidden = true;
} else if (!launched) {
  notify('Ready — open a PDF to begin.');
}
