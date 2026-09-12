/**
 * The extension page: it fetches the document and the viewer draws it.
 *
 * This page is a shell, and deliberately a thin one. The viewer it frames is the
 * page this repository publishes at `zzysonny.github.io/webPDF/`, so the
 * extension is a couple of hundred lines of plumbing around a viewer that is
 * already tested on its own - and a fix to that viewer lands without shipping a
 * new extension. `viewer.json`, written by the build, is the one line that says
 * where it is; the browser's own cache is what makes the second document as fast
 * as the first.
 *
 * What the shell does is the part a page cannot do for itself:
 *
 *   * it reads the document. An extension page has this extension's host
 *     permissions, so a PDF that a web page could not fetch across origins - the
 *     usual case, `Access-Control-Allow-Origin` is not something PDF servers
 *     send - arrives here anyway, and is handed to the frame as bytes. Nothing
 *     is uploaded and nothing is proxied: the bytes go from the server to this
 *     tab, which is where they were going in the first place.
 *   * it remembers. The frame says where the reader is and how the document is
 *     set up; the worker writes that down for the hundred most recent documents,
 *     and hands it back the next time one of them is opened.
 *   * it is the reader's keyboard. Ctrl+S saves the document, Ctrl+O opens a
 *     local file, Ctrl+F and the zoom keys are forwarded into the frame - which
 *     a page cannot do for a frame it does not have focus in.
 *
 * The two sides are updated on different schedules: this extension is installed
 * once, and the viewer it frames is redeployed whenever the repository is. So the
 * handshake is versioned. The viewer's `hello` says which bridge revision it
 * speaks and which host revisions it still serves, this page answers `ready` with
 * its own revision, and a viewer that can no longer serve this extension is
 * reported to the reader - an extension that is out of date should say so, not
 * sit on a tab that never draws.
 */

import { keyOfFile, type HostState } from './lib/history.js';

/** Written by the build: which viewer to frame, and what to call this build. */
interface Viewer {
  /** The viewer's URL - the published site, or a server `--remote` pointed at. */
  app: string;
  /** The extension's version, for the record in `viewer.json`. */
  version: string;
}

/**
 * The bridge revision this extension speaks.
 *
 * It is a promise in both directions, and the only thing either side needs to
 * know about the other's version: a viewer keeps serving this revision until it
 * says otherwise, and this extension understands everything a viewer that serves
 * it can say. Adding to the protocol is compatible - a message this extension
 * does not know is ignored, and anything the viewer adds is only sent to a host
 * whose `ready` says it knows it.
 *
 * It is not a promise to keep working with a viewer that *breaks* the protocol:
 * this extension does not guess at a changed message and does not carry two
 * implementations of anything. A viewer that has to break it says so by no longer
 * serving this revision, and what the reader gets is the card below rather than a
 * tab that draws the wrong thing or nothing at all.
 */
const BRIDGE = 1;

/** The oldest viewer revision this extension can be driven by. */
const NEEDS = 1;

/** The frame answered, and cannot serve this extension (or the other way round). */
class Stale extends Error {}

/** How long the viewer is given to say it is up. */
const HELLO_MS = 30000;

/** How long a burst of reading is allowed to go unwritten. */
const SAVE_MS = 700;

/* ------------------------------------------------------------- the pieces */

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const app = el<HTMLIFrameElement>('app');
const loading = el('loading');
const loadingBar = el('loading-bar');
const note = el('note');
const noteTitle = el('note-title');
const noteText = el('note-text');
const noteRetry = el<HTMLButtonElement>('note-retry');
const noteSave = el<HTMLButtonElement>('note-save');
const fileInput = el<HTMLInputElement>('file');

/**
 * What this tab was opened for.
 *
 * The URL is the *last* parameter and is taken raw, because a URL is not a value
 * that survives a round trip through query encoding: everything after `u=` is the
 * source, `&` and all. The page number may arrive either way - the redirect rule
 * carries a `.pdf#page=7` through as this page's own fragment, and the worker
 * writes a page into the query when it takes a tab over itself.
 */
const query = ((): { token: string; url: string | null; page: number | null } => {
  const search = location.search;
  const at = search.indexOf('u=');
  const head = new URLSearchParams(at < 0 ? search : search.slice(0, at));
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const page = Number.parseInt(head.get('page') ?? hash.get('page') ?? '', 10);
  return {
    token: head.get('t') ?? '',
    url: at < 0 ? null : search.slice(at + 2),
    page: Number.isFinite(page) && page > 1 ? page : null,
  };
})();

/** The viewer's window, once it has said hello. */
let frame: Window | null = null;
/** What this tab is showing: the key the memory knows it by, and its URL. */
let showing: { key: string; url: string | null; name: string; size: number } | null = null;
/** What was handed to the frame, so a document the *frame* opened is told apart. */
let handed: { name: string; size: number; key: string; url: string | null } | null = null;
let saveTimer = 0;
let lastState: HostState | null = null;

/* ------------------------------------------------------------ the worker */

async function ask<T = unknown>(message: unknown): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(message)) as { ok?: boolean; error?: string } & Record<string, unknown>;
  if (!answer || answer.ok === false) throw new Error(answer?.error ?? 'the extension worker did not answer');
  return answer as T;
}

/** Write the reader's position down now, rather than at the end of the window. */
function flush(): void {
  if (!saveTimer || !showing || !lastState) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  void chrome.runtime.sendMessage({ type: 'state', key: showing.key, state: lastState });
}

/** The position and settings changed: write them, once the reader stops moving. */
function rememberState(state: HostState): void {
  lastState = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, SAVE_MS);
}

/* ----------------------------------------------------------- what is shown */

function send(message: Record<string, unknown>, transfer: Transferable[] = []): void {
  const target = frame;
  if (!target) return;
  const origin = appOrigin();
  target.postMessage({ wpdf: 'host', ...message }, origin ?? '*', transfer);
}

function appOrigin(): string | null {
  try {
    return new URL(booted.app).origin;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the browser */

let booted: Viewer = { app: '', version: '' };

/** Frame the viewer, and wait for it to say it is up. */
async function attach(viewer: Viewer): Promise<Window> {
  // An absolute URL - the published site, or wherever this build points. The
  // origin it ends up on is the origin the messages go back to.
  booted = { ...viewer, app: new URL(viewer.app, location.href).href };
  app.src = withHost(booted.app);
  return await new Promise<Window>((resolve, reject) => {
    const give_up = window.setTimeout(() => {
      window.removeEventListener('message', onHello);
      reject(new Error(`the viewer at ${viewer.app} did not answer`));
    }, HELLO_MS);
    const onHello = (event: MessageEvent): void => {
      const message = event.data as { wpdf?: string; kind?: string; bridge?: unknown; accepts?: unknown } | null;
      if (event.source !== app.contentWindow || message?.wpdf !== 'host' || message.kind !== 'hello') return;
      window.clearTimeout(give_up);
      window.removeEventListener('message', onHello);

      // What the viewer says about itself. A viewer from before revisions says
      // nothing, which is revision 1: the contract as it has always been.
      const speaks = typeof message.bridge === 'number' ? message.bridge : 1;
      const serves = Array.isArray(message.accepts) ? message.accepts.filter((each) => typeof each === 'number') : [1];
      if (!serves.includes(BRIDGE)) {
        reject(
          new Stale(
            `The viewer at ${booted.app} speaks bridge ${speaks} and serves hosts of revision ${serves.length ? serves.join(', ') : 'none'}, while this extension speaks bridge ${BRIDGE}. Install the current build of the extension - the crx on the repository's latest workflow run - and this tab will open documents again.`,
          ),
        );
        return;
      }
      if (speaks < NEEDS) {
        reject(
          new Stale(
            `The viewer at ${booted.app} speaks bridge ${speaks}, and this extension needs at least bridge ${NEEDS}. It is probably an older copy of the page served from the browser's cache; reloading in a moment should find the current one.`,
          ),
        );
        return;
      }

      // Answer with this extension's own revision, so the viewer knows what it
      // may say - and only then is the frame worth talking to.
      frame = event.source as Window;
      send({ kind: 'ready', bridge: BRIDGE });
      resolve(frame);
    };
    window.addEventListener('message', onHello);
  });
}

/** The viewer's URL, as the *hosted* page: it must not offer a document. */
function withHost(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('host', '1');
  return parsed.href;
}

/* -------------------------------------------------------------- the bytes */

function showProgress(loaded: number, total: number): void {
  loading.hidden = false;
  const fraction = total > 0 ? Math.min(1, loaded / total) : 0;
  loadingBar.style.width = `${Math.round(fraction * 100)}%`;
  // With no length to measure against there is still a sign of life.
  if (total <= 0) loadingBar.style.width = '12%';
}

/** Read a document over the network, reporting how much of it has arrived. */
async function readUrl(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!response.ok) throw new Error(`the server answered ${response.status} ${response.statusText}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  if (!response.body) return await response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      showProgress(loaded, total);
    }
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * A local file cannot be `fetch`ed by anything, a page or an extension - but an
 * extension that the reader has let see file URLs can *read* one, which is what
 * an `XMLHttpRequest` does and a `fetch` does not.
 */
function readFile(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.onload = () =>
      request.status === 0 || (request.status >= 200 && request.status < 300)
        ? resolve(request.response as ArrayBuffer)
        : reject(new Error(`the file answered ${request.status}`));
    request.onerror = () => reject(new Error('the file could not be read — does this extension have access to file URLs?'));
    request.onprogress = (event) => showProgress(event.loaded, event.total);
    request.send();
  });
}

async function readDocument(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('file:')) return await readFile(url);
  try {
    return await readUrl(url);
  } catch (error) {
    // A `file:` URL that was not caught above (a redirect, a spelling) is worth
    // one more try the other way round before giving up on it.
    if (!/^file:/i.test(url)) throw error;
    return await readFile(url);
  }
}

/* ---------------------------------------------------------------- a failure */

function fail(title: string, text: string, options: { retry?: boolean; save?: boolean } = {}): void {
  loading.hidden = true;
  noteTitle.textContent = title;
  noteText.textContent = text;
  noteRetry.hidden = options.retry === false;
  noteSave.hidden = options.save !== true;
  note.hidden = false;
}

/* ------------------------------------------------------------- the document */

/**
 * Hand a document to the frame.
 *
 * Everything the viewer needs is in this one message: the bytes (transferred, not
 * copied), what to call them, and what was remembered about the document - the
 * position and the settings. The frame reports back what it opened, and from then
 * on it is the one saying where the reader is.
 */
function handOff(doc: {
  bytes?: ArrayBuffer;
  url: string | null;
  key: string;
  name: string;
  size: number;
  page: number | null;
  state: HostState | null;
}): void {
  showing = { key: doc.key, url: doc.url, name: doc.name, size: doc.size };
  handed = { name: doc.name, size: doc.size, key: doc.key, url: doc.url };
  lastState = doc.state;
  const message = { kind: 'open', doc: { bytes: doc.bytes, url: doc.url, name: doc.name, size: doc.size, page: doc.page, state: doc.state } };
  send(message, doc.bytes ? [doc.bytes] : []);
}

/** The document this tab was opened for, from the worker and then the network. */
async function openFromTab(): Promise<void> {
  const url = query.url;
  if (!url) {
    fail('Nothing to open', 'This tab was not opened for a document. Open a PDF from the address bar, a link, or your file manager.', { retry: false });
    return;
  }
  const resolved = await ask<{ url: string; key: string; name: string; state: HostState | null }>({
    type: 'resolve',
    token: query.token,
    url,
  });
  const bytes = await readDocument(resolved.url);
  handOff({
    bytes,
    url: resolved.url,
    key: resolved.key,
    name: resolved.name || nameOfUrl(resolved.url),
    size: bytes.byteLength,
    page: query.page,
    state: resolved.state,
  });
}

/** A file the reader chose with Ctrl+O: no URL, and a key made of its name and size. */
async function openLocalFile(file: File): Promise<void> {
  const key = keyOfFile(file.name, file.size);
  const stored = await ask<{ state: HostState | null }>({ type: 'entry', key });
  const bytes = await file.arrayBuffer();
  handOff({ bytes, url: null, key, name: file.name, size: file.size, page: null, state: stored.state });
}

/** What to call a document with no title: its URL, without the scheme. */
function nameOfUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

/* -------------------------------------------------------------- the frame */

/**
 * What the frame says.
 *
 * `opened` is the document being on screen, which is the moment this tab knows
 * what it is showing and the moment the memory gets its entry. `state` is the
 * reader moving. Neither is trusted for anything but what it is: a name, a size,
 * a page number and a handful of settings.
 */
function onFrameMessage(event: MessageEvent): void {
  if (event.source !== app.contentWindow) return;
  const message = event.data as { wpdf?: string; kind?: string; [k: string]: unknown } | null;
  if (!message || message.wpdf !== 'host') return;

  switch (message.kind) {
    case 'opened': {
      const info = message.info as { title?: string; pages?: number } | null;
      const name = typeof message.name === 'string' && message.name ? message.name : 'document';
      const size = typeof message.size === 'number' ? message.size : 0;
      // A document the *frame* opened - a PDF dropped onto the pages, or one
      // chosen from its own Ctrl+O - is not the one that was handed to it, and
      // has to be looked up under its own name.
      const mine = handed && handed.name === name && handed.size === size;
      const key = mine && handed ? handed.key : keyOfFile(name, size);
      const url = mine && handed ? handed.url : null;
      showing = { key, url, name, size };
      handed = null;
      loading.hidden = true;
      note.hidden = true;
      document.title = info?.title || name;
      void chrome.runtime.sendMessage({
        type: 'remember',
        key,
        url,
        name,
        title: info?.title ?? '',
        pages: info?.pages ?? 0,
      });
      if (!mine) void restore(key);
      break;
    }
    case 'state':
      if (showing && message.state) rememberState(message.state as HostState);
      break;
    case 'error':
      fail('The document could not be opened', String(message.message ?? 'the viewer reported an error'), {
        save: showing?.url != null,
      });
      break;
    case 'password': {
      // A cross-origin frame cannot open a prompt of its own; this page can.
      const password = window.prompt('This document is password protected. Password:');
      send({ kind: 'secret', password: password ?? null });
      break;
    }
  }
}

/** Put a document the frame opened itself back where the reader left it. */
async function restore(key: string): Promise<void> {
  try {
    const stored = await ask<{ state: HostState | null }>({ type: 'entry', key });
    if (stored.state) send({ kind: 'apply', state: stored.state });
  } catch {
    /* nothing remembered about it: it opens at its first page, which it is on */
  }
}

/* ------------------------------------------------------------ the keyboard */

async function save(): Promise<void> {
  const url = showing?.url ?? query.url;
  if (!url) return;
  await chrome.downloads.download({ url, filename: nameOfUrl(url).split('/').pop() ?? undefined });
}

window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === 's') {
    event.preventDefault();
    void save();
  } else if (key === 'o') {
    event.preventDefault();
    fileInput.click();
  } else if (key === 'f') {
    event.preventDefault();
    send({ kind: 'find' });
  } else if (key === '=' || key === '+' || key === '-' || key === '0') {
    // Forwarded as a real key in the frame's own document: the viewer's zoom
    // handling stays in one place, and this page has no opinion about it.
    event.preventDefault();
    send({ kind: 'key', key: event.key });
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  void openLocalFile(file).catch((error: unknown) => {
    fail('The file could not be read', String((error as Error)?.message ?? error));
  });
});

noteRetry.addEventListener('click', () => location.reload());
noteSave.addEventListener('click', () => void save());
window.addEventListener('message', onFrameMessage);
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

/* ---------------------------------------------------------------- the start */

void (async () => {
  const response = await fetch(chrome.runtime.getURL('viewer.json'));
  const viewer = (await response.json()) as Viewer;
  try {
    frame = await attach(viewer);
  } catch (error) {
    if (error instanceof Stale) {
      fail('This extension is out of date', String(error.message), { save: query.url != null });
      return;
    }
    fail(
      'The viewer could not be loaded',
      `This build draws documents with the viewer at ${viewer.app}, which this browser could not reach — it is fetched and cached like any page, and that is the one thing this build does not carry with it. ${String((error as Error)?.message ?? error)}`,
      { save: query.url != null },
    );
    return;
  }

  try {
    await openFromTab();
  } catch (error) {
    fail('The document could not be opened', String((error as Error)?.message ?? error), { save: query.url != null });
  }
})();
