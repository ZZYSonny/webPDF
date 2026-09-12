/**
 * The host bridge: the page's outward face when something else is driving it.
 *
 * The demo is a page like any other - the reader brings it a document. A *host*
 * (the browser extension this repository builds, an embedding application) is
 * the other way round: it has the document, it wants this page to draw it, and
 * it wants to hear where the reader got to so that it can remember. That
 * conversation is one small `postMessage` protocol, and nothing else:
 *
 *   page -> host   {wpdf:'hello'}                       the page is up
 *   page -> host   {wpdf:'opened', info, name, size}    a document is on screen
 *   page -> host   {wpdf:'state', state}                where the reader is now
 *   page -> host   {wpdf:'error', message}              it could not be opened
 *   page -> host   {wpdf:'password'}                    it is encrypted; ask
 *   host -> page   {wpdf:'open', doc}                   open this document
 *   host -> page   {wpdf:'state'}                       say where the reader is
 *   host -> page   {wpdf:'apply', state}                put it back the way it was
 *   host -> page   {wpdf:'find'}                        put the caret in Find
 *   host -> page   {wpdf:'secret', password}            here is the password
 *
 * It is wired up only when the page is told it is hosted (`?host=1`) *and* is
 * framed, so a reader who opens the published demo gets exactly the page it
 * always was, and a host gets a viewer it can hand bytes to and take a position
 * from without either side knowing anything else about the other. The bytes are
 * the host's: this page never fetches a document it was not given.
 *
 * Which is also why the protocol carries nothing secret. A page that is framed
 * by anyone can be handed a document by that anyone - that is what a viewer is
 * for - and what it says back is where the reader is, which is what the host
 * needs to put them back there.
 */

import type { ZoomMode } from '../src/index.ts';
import type { CropRuleId } from '../src/index.ts';

/** Whether this page was opened to be driven by a host (`?host=1`). */
export function isHosted(): boolean {
  return new URLSearchParams(location.search).get('host') === '1';
}

/** Where the reader is: a page, and a point within it in the document's units. */
export interface HostPlace {
  page: number;
  y: number | null;
}

/** What the reader has chosen about how the document is drawn and arranged. */
export interface HostSettings {
  /** `mode` is the viewer's own: a fit mode, or `custom` for a fixed scale. */
  zoom: { level: number; mode: ZoomMode } | null;
  crop: { rules: CropRuleId[]; padding: number } | null;
  bionic: { on: boolean; dim: number } | null;
  outline: boolean;
}

export interface HostState {
  pos: HostPlace | null;
  settings: HostSettings;
}

/** A document handed over by the host, however the host came by it. */
export interface HostDocument {
  /** The bytes, when the host has already read them. */
  bytes?: ArrayBuffer | Uint8Array | null;
  /** The URL they came from, when they came from one. */
  url?: string | null;
  /** A local file's name, when there is no URL to name it by. */
  name?: string | null;
  /** The document's size in bytes; with the name, this is what identifies it. */
  size?: number | null;
  /** A page to open on, when the host knows one and nothing was remembered. */
  page?: number | null;
  /** Where the reader was, and how they had it set up, last time. */
  state?: HostState | null;
}

/** What the bridge needs from the page: the things only the page knows. */
export interface HostHooks {
  /** Open a document. The page reports the outcome through the bridge. */
  open(doc: HostDocument): Promise<void>;
  /** Where the reader is, and how the page is set up, right now. */
  state(): HostState;
  /** Apply remembered settings, and optionally a position, to what is open. */
  apply(state: HostState | null | undefined, pos?: HostPlace | null): void;
  /** The reader asked to search; only the page can move the caret. */
  find(): void;
}

/** What the host hears about the document on screen. */
export interface HostDocumentInfo {
  title: string;
  pages: number;
  author: string;
}

export interface HostBridge {
  /** Whether the page is actually hosted (the bridge is talking to someone). */
  readonly active: boolean;
  /** A document is on screen: what it is, and what to call it. */
  opened(payload: { info: HostDocumentInfo | null; name: string; size: number }): void;
  /** It could not be opened, and the host is the one who can say why. */
  failed(message: string): void;
  /** Say where the reader is and how the page is set up, if anything changed. */
  notify(): void;
  /** Ask the host for an encrypted document's password (null if it declines). */
  askPassword(): Promise<string | null>;
}

/** How long a burst of scrolling is allowed to go unreported. */
const REPORT_MS = 400;

/** How long the host has to answer a password prompt. */
const SECRET_MS = 120000;

const noop: HostBridge = {
  active: false,
  opened: () => {},
  failed: () => {},
  notify: () => {},
  askPassword: async () => null,
};

/**
 * Wire the page to its host, or do nothing at all.
 *
 * The returned bridge is inert unless the page is hosted and framed, so callers
 * can wire it unconditionally and call `notify()` wherever the reader's position
 * or setup changes.
 */
export function createHostBridge(hooks: HostHooks): HostBridge {
  if (!isHosted() || window.parent === window) return noop;

  const host = window.parent;
  /** The last state sent, so an unchanged report is not sent twice. */
  let sent = '';
  let timer = 0;
  /** A password question waiting on the host, if any. */
  let ask: ((password: string | null) => void) | null = null;

  const post = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    host.postMessage({ wpdf: 'host', ...message }, '*', transfer);
  };

  const sendState = (): void => {
    timer = 0;
    const state = hooks.state();
    const json = JSON.stringify(state);
    if (json === sent) return;
    sent = json;
    post({ kind: 'state', state });
  };

  const notify = (): void => {
    if (timer) return;
    // A scroll fires dozens of times a second and the host only needs the end of
    // it; a settings change is one message and waits for the same window.
    timer = window.setTimeout(sendState, REPORT_MS);
  };

  window.addEventListener('scroll', notify, { passive: true, capture: true });
  window.addEventListener('resize', notify);
  // A tab that is going away is the one moment the host must not be left with a
  // stale position: report what is known now rather than waiting out the window.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer);
      sendState();
    }
  });

  window.addEventListener('message', (event: MessageEvent) => {
    // Only the frame that opened us, and only our own envelope: this is the one
    // door into the page, and it stays a door the host is standing at.
    if (event.source !== host) return;
    const message = event.data as { wpdf?: string; kind?: string; doc?: HostDocument; [k: string]: unknown } | null;
    if (!message || message.wpdf !== 'host') return;

    switch (message.kind) {
      case 'open':
        void (async () => {
          try {
            await hooks.open(message.doc ?? {});
            // Whatever was restored may have moved the reader; say where they
            // ended up, so the host's record matches the screen.
            clearTimeout(timer);
            sendState();
          } catch (error) {
            post({ kind: 'error', message: String((error as Error)?.message ?? error) });
          }
        })();
        break;
      case 'state':
        clearTimeout(timer);
        sendState();
        break;
      case 'find':
        hooks.find();
        break;
      case 'apply':
        hooks.apply(message.state as HostState | null);
        notify();
        break;
      case 'secret':
        ask?.(typeof message.password === 'string' ? message.password : null);
        break;
    }
  });

  // The handshake. The host answers with `open`; until it does, the page has no
  // document, and nothing of its own to show.
  post({ kind: 'hello' });

  return {
    active: true,
    opened(payload) {
      post({ kind: 'opened', ...payload });
    },
    failed(message) {
      post({ kind: 'error', message });
    },
    notify,
    askPassword(): Promise<string | null> {
      // Only one question at a time, and never a second one on top of it.
      ask?.(null);
      post({ kind: 'password' });
      return new Promise((resolve) => {
        const done = (password: string | null): void => {
          ask = null;
          clearTimeout(timer_);
          resolve(password);
        };
        const timer_ = window.setTimeout(() => done(null), SECRET_MS);
        ask = done;
      });
    },
  };
}
