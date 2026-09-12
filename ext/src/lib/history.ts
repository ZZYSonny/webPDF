/**
 * The memory: the documents this browser has read, and where the reader was in
 * each of them.
 *
 * A document is identified by where it came from - its URL without the fragment,
 * or, for a file that never had one, its name and size - because that is the only
 * thing that survives a reload. What is kept for it is small and entirely the
 * reader's own: the page and the point on it, the zoom, the crop rules, the fade,
 * whether the outline was open, and when it was last touched. No bytes, no text,
 * no titles beyond the document's own.
 *
 * The list *is* the recency order: an entry that is written moves to the front,
 * so the hundred most recent documents are the first hundred entries and the
 * oldest falls off the end by itself. That is the whole of the eviction policy,
 * and it is why the array is never sorted here.
 *
 * Plain JavaScript on purpose: this module is imported by the service worker
 * (which Chrome loads as it is written) and by the tests (which run it in Node),
 * so there is no build step between the two.
 */

/** Where the list lives in `chrome.storage.local`. */
export const HISTORY_KEY = 'history';

/** How many documents are remembered. The hundred most recent, and no more. */
export const LIMIT = 100;

/** A point in a document: a page, and a point on it in page units. */
export interface HostPlace {
  page: number;
  y: number | null;
}

/** How the reader had a document set up. Mirrors the page's own state object. */
export interface HostSettings {
  zoom?: { level: number; mode: string } | null;
  crop?: { rules: string[]; padding: number } | null;
  bionic?: { on: boolean; dim: number } | null;
  outline?: boolean;
}

export interface HostState {
  pos?: HostPlace | null;
  settings?: HostSettings | null;
}

/** One remembered document. */
export interface Entry {
  /** What identifies it: `url:<url>`, `file:<path>`, or `local:<name>:<size>`. */
  key: string;
  /** Where it came from, when it came from somewhere a tab can be opened on. */
  url: string | null;
  /** What to call it in a list: the document's title, or the URL's own name. */
  name: string;
  /** The document's own title, as the PDF declares it (may be empty). */
  title: string;
  /** How many pages it has, so a stale page number can be caught. */
  pages: number;
  /** Where the reader was. */
  pos: HostPlace | null;
  /** How they had it set up. */
  settings: HostSettings | null;
  /** When it was first opened, and when it was last touched. */
  openedAt: number;
  updatedAt: number;
  /** How many times it has been opened. */
  opens: number;
}

/**
 * The key for a document that has a URL.
 *
 * The fragment is dropped because it never reaches a server and Chrome uses it
 * for its own viewer's page number; a URL differing only in its fragment is the
 * same document. The scheme and host are lowercased for the same reason: they
 * are case-insensitive, and two spellings of one address are one document.
 */
export function keyOfUrl(url: string): string {
  let bare = url.split('#')[0] ?? url;
  try {
    const parsed = new URL(bare);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    bare = parsed.href;
  } catch {
    /* not a URL a browser would parse: keep the text as it was given */
  }
  return bare.startsWith('file:') ? `file:${bare.slice('file:'.length)}` : `url:${bare}`;
}

/**
 * The key for a file the reader opened from their own machine and that has no URL
 * to be identified by: its name and its size. Two files with the same name and
 * size are the same document as far as this can tell, which is the honest
 * answer - the alternative is reading every byte of every file to find out.
 */
export function keyOfFile(name: string, size: number): string {
  return `local:${name.trim().toLowerCase()}:${size}`;
}

/** A URL that can be fetched and shown: the only schemes that are ever touched. */
export function isOpenable(url: unknown): url is string {
  return typeof url === 'string' && /^(https?|file):/i.test(url) && !url.startsWith('chrome');
}

/** Read an entry out of anything that claims to be one, or null. */
function entryOf(raw: unknown): Entry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<Entry>;
  if (typeof value.key !== 'string' || value.key === '') return null;
  const place = value.pos as HostPlace | null | undefined;
  const pos =
    place && typeof place.page === 'number' && Number.isFinite(place.page)
      ? { page: Math.max(1, Math.round(place.page)), y: typeof place.y === 'number' && Number.isFinite(place.y) ? place.y : null }
      : null;
  return {
    key: value.key,
    url: isOpenable(value.url) ? value.url : null,
    name: typeof value.name === 'string' ? value.name : '',
    title: typeof value.title === 'string' ? value.title : '',
    pages: typeof value.pages === 'number' && Number.isFinite(value.pages) ? Math.max(0, Math.round(value.pages)) : 0,
    pos,
    settings: value.settings && typeof value.settings === 'object' ? (value.settings as HostSettings) : null,
    openedAt: typeof value.openedAt === 'number' ? value.openedAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    opens: typeof value.opens === 'number' && value.opens > 0 ? Math.round(value.opens) : 0,
  };
}

/**
 * Whatever was in storage, as a list of entries: in order, newest first, and
 * never longer than the limit. Storage is a file on a disk that this code does
 * not own, so anything unexpected in it is dropped rather than trusted.
 */
export function read(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const item of raw) {
    const entry = entryOf(item);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
    if (entries.length === LIMIT) break;
  }
  return entries;
}

/** The entry for a document, or null if it has never been read. */
export function find(entries: readonly Entry[], key: string): Entry | null {
  return entries.find((entry) => entry.key === key) ?? null;
}

export interface RememberOptions {
  /** The document itself was opened, rather than only moved or re-configured. */
  opened?: boolean;
  /** The clock, so a test can say when this happened. */
  now?: number;
}

/**
 * Write what is known about a document, and return the list with it.
 *
 * The entry moves to the front - it is the most recent thing the reader touched -
 * and the list is cut back to `LIMIT`. Opening a document is told apart from
 * moving inside one, because "how often do I come back to this" is worth knowing
 * and a scroll is not an opening.
 */
export function remember(entries: readonly Entry[], patch: Partial<Entry> & { key: string }, options: RememberOptions = {}): Entry[] {
  const now = options.now ?? Date.now();
  const previous = find(entries, patch.key);
  // `undefined` means "not said", never "make it empty": a state update carries
  // only the position, and must not erase the title that came with the open.
  const said = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const merged: Entry = {
    key: patch.key,
    url: previous?.url ?? null,
    name: previous?.name ?? '',
    title: previous?.title ?? '',
    pages: previous?.pages ?? 0,
    pos: previous?.pos ?? null,
    settings: previous?.settings ?? null,
    openedAt: previous?.openedAt ?? now,
    updatedAt: now,
    opens: previous?.opens ?? 0,
    ...said,
  };
  if (options.opened) {
    merged.opens = (previous?.opens ?? 0) + 1;
    merged.openedAt = now;
  }
  return [merged, ...entries.filter((entry) => entry.key !== patch.key)].slice(0, LIMIT);
}

/** Forget a document. */
export function forget(entries: readonly Entry[], key: string): Entry[] {
  return entries.filter((entry) => entry.key !== key);
}

/**
 * The settings to start a document with that has never been read: the ones the
 * reader last used. A new paper opens at the zoom, crop and fade of the last one
 * - which is what the page itself does between two documents in one sitting - and
 * its *position* is deliberately not inherited: page one, always.
 */
export function inheritedSettings(entries: readonly Entry[]): HostSettings | null {
  for (const entry of entries) {
    if (entry.settings) return entry.settings;
  }
  return null;
}
