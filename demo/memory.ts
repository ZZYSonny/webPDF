/**
 * The memory: where the reader was in the documents they have read, and how they
 * had them set up.
 *
 * It belongs to this page rather than to anything that frames it. A position is a
 * page and a point in the document's own units; the settings are the viewer's own
 * - zoom, crop, fade, outline. Those are this page's concepts, so this page is
 * where they are kept: a reader who opens the published demo and a reader who
 * arrives through the extension get the same memory, and nothing that frames the
 * page has to know that it exists.
 *
 * The list is the recency order and it is capped: the hundred most recent
 * documents, the oldest falling off the end. It is one small JSON object in
 * `localStorage` - a page, a point, a few settings and a timestamp each - so it
 * survives a reload without anyone's permission and costs nothing to read.
 *
 * Pure on purpose, and free of both `localStorage` and the viewer: the page hands
 * it a string and takes a string back, which is what lets the whole of it be
 * tested in Node. The settings are the viewer's, so their types are the viewer's
 * - a type-only import, which is gone by the time this runs.
 */

import type { CropRuleId, ZoomMode } from '../src/index.ts';

/** Where the reader is: a page, and a point within it in the document's units. */
export interface Place {
  page: number;
  y: number | null;
}

/**
 * How the reader has the document set up. These are the settings the viewer
 * understands today, and unknown ones are kept rather than dropped: a page that
 * is newer than the one reading it may have put something else in here, and a
 * cached copy of this page is not entitled to throw it away.
 */
export interface Settings {
  zoom?: { level: number; mode: ZoomMode } | null;
  crop?: { rules: CropRuleId[]; padding: number } | null;
  bionic?: { on: boolean; dim: number } | null;
  outline?: boolean;
  [setting: string]: unknown;
}

/**
 * What is kept for one document. Fields this version does not know are kept as
 * they were found, for the same reason unknown settings are: a newer version of
 * this page may have put something here, and an older one - served from a cache,
 * or left open in a tab - is not entitled to throw it away.
 */
export interface Remembered {
  pos: Place | null;
  settings: Settings | null;
  /** When it was last touched, used only for the order of the list. */
  at: number;
  [field: string]: unknown;
}

/** The whole memory: documents by key, in recency order, newest first. */
export type Memory = Record<string, Remembered>;

/** Where the memory lives in `localStorage`. */
export const MEMORY_KEY = 'webpdf.memory';

/** How many documents are remembered. The hundred most recent, and no more. */
export const LIMIT = 100;

/**
 * The key for a document that has a URL.
 *
 * The fragment is dropped because it never reaches a server and Chrome uses it
 * for its own viewer's page number; a URL differing only in its fragment is the
 * same document. The scheme and host are lowercased for the same reason: they are
 * case-insensitive, and two spellings of one address are one document.
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
 * The key for a document with no URL to be identified by: its name and its size.
 * Two files with the same name and size are the same document as far as this can
 * tell, which is the honest answer - the alternative is reading every byte of
 * every file to find out.
 */
export function keyOfFile(name: string, size: number): string {
  return `local:${name.trim().toLowerCase()}:${size}`;
}

/** A place, if that is what this is: a page, and optionally a point on it. */
function placeOf(raw: unknown): Place | null {
  if (!raw || typeof raw !== 'object') return null;
  const place = raw as Partial<Place>;
  if (typeof place.page !== 'number' || !Number.isFinite(place.page)) return null;
  return {
    page: Math.max(1, Math.round(place.page)),
    y: typeof place.y === 'number' && Number.isFinite(place.y) ? place.y : null,
  };
}

/** The settings, kept as they are: this page does not police what a viewer saves. */
function settingsOf(raw: unknown): Settings | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Settings) : null;
}

/** One remembered document, out of anything that claims to be one. */
function rememberedOf(raw: unknown, fallbackAt: number): Remembered | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<Remembered>;
  const pos = placeOf(value.pos);
  const settings = settingsOf(value.settings);
  if (!pos && !settings) return null;
  return {
    ...value,
    pos,
    settings,
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : fallbackAt,
  };
}

/**
 * Whatever was in storage, as a memory: newest first, never longer than the
 * limit, and nothing trusted. Storage is a file on a disk this code does not own,
 * and it is shared with every other version of this page the reader has ever
 * loaded - so an entry that does not look like one is dropped, and one that does
 * is read for exactly what it is.
 */
export function read(raw: string | null, now = Date.now()): Memory {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const memory: Memory = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === '') continue;
    const remembered = rememberedOf(value, now);
    if (remembered) memory[key] = remembered;
    if (Object.keys(memory).length === LIMIT) break;
  }
  return memory;
}

/** The memory as it goes back into storage. */
export function write(memory: Memory): string {
  return JSON.stringify(memory);
}

/** What is known about a document, or null if it has never been read. */
export function get(memory: Memory, key: string): Remembered | null {
  return memory[key] ?? null;
}

/**
 * Write what is known about a document, and return the memory with it in front.
 *
 * The document moves to the front because it is the most recent thing the reader
 * touched - that is the whole of the expiry policy, and it is why nothing here is
 * ever sorted. A field that is not mentioned is left as it was, so a reader
 * moving inside a document does not throw away the settings that came with it.
 */
export function put(
  memory: Memory,
  key: string,
  patch: { pos?: Place | null; settings?: Settings | null },
  now = Date.now(),
): Memory {
  const previous = memory[key];
  const next: Remembered = {
    ...previous,
    pos: patch.pos !== undefined ? patch.pos : (previous?.pos ?? null),
    settings: patch.settings !== undefined ? patch.settings : (previous?.settings ?? null),
    at: now,
  };
  const rest = Object.fromEntries(Object.entries(memory).filter(([each]) => each !== key));
  // The new entry first, then everything else in the order it already had; the
  // oldest falls off the end because the object is never longer than the limit.
  return Object.fromEntries([[key, next], ...Object.entries(rest)].slice(0, LIMIT));
}

/**
 * The settings to start a document with that has never been read: the ones the
 * reader last used. A new paper opens at the zoom, crop and fade of the last one
 * - which is what the page itself does between two documents in one sitting - and
 * its *position* is deliberately not inherited: page one, always.
 */
export function inherited(memory: Memory): Settings | null {
  for (const remembered of Object.values(memory)) {
    if (remembered.settings) return remembered.settings;
  }
  return null;
}
