/**
 * The host bridge: the page's outward face when something else is driving it.
 *
 * The demo is a page like any other - the reader brings it a document. A *host*
 * (the browser extension this repository builds, an embedding application) is the
 * other way round: it has the document and it wants this page to draw it. That
 * conversation is one small `postMessage` protocol, and nothing else:
 *
 *   page -> host   {wpdf:'hello', bridge, accepts}   the page is up, and what it speaks
 *   page -> host   {wpdf:'opened', info, name, size} a document is on screen
 *   page -> host   {wpdf:'error', message}           it could not be opened
 *   host -> page   {wpdf:'ready', bridge}            the host is up, and what it speaks
 *   host -> page   {wpdf:'open', doc}                open this document
 *
 * Two messages each way, and every one of them is something only the other side
 * can do. Handing over a document is the host's: it has the bytes, and this page
 * never fetches one it was not given. *What opened* is the page's, and the host is
 * told it so that it can name the tab.
 *
 * Everything else the reader does belongs to the page and stays in it: the
 * position and the settings are remembered here (see `memory.ts`), the keyboard is
 * this document's once it has focus, saving is a write of bytes this page is
 * already holding, and a password is asked for in a card in this document - a
 * cross-origin frame may not raise a `window.prompt`, but it can draw its own
 * field, and the page that is drawing the document is the right place to ask for
 * the key to it. None of that is a host's business, so none of it is in the
 * protocol - which is why the protocol is small enough to keep working for a long
 * time.
 *
 * It is wired up only when the page is told it is hosted (`?host=1`) *and* is
 * framed, so a reader who opens the published demo gets exactly the page it always
 * was, and a host gets a viewer it can hand bytes to without either side knowing
 * anything else about the other. Which is also why the protocol carries nothing
 * secret: a page that is framed by anyone can be handed a document by that anyone
 * - that is what a viewer is for.
 *
 * The two sides are updated on completely different schedules: this page is
 * redeployed whenever the repository is, and the extension that frames it is
 * updated whenever its reader gets round to it. So `hello` carries `bridge` (the
 * revision this page speaks) and `accepts` (the host revisions it can still
 * serve), the host answers with `ready`, and a host that does not answer at all is
 * revision 1 - which is what every extension released before revisions existed
 * looks like, and it is served. Adding a message is therefore free: it is only
 * sent to a host whose `ready` says it knows it. Everything else is a new
 * revision.
 *
 * That is a courtesy for compatible changes, not a promise to carry two interfaces
 * forever. A change that genuinely has to break - a message that comes to mean
 * something else, a document that can no longer be handed over the old way - takes
 * the old revision off `accepts` and leaves it there; the host is then told to
 * update instead of being quietly mis-served. What is not allowed is a *silent*
 * break: if a host of a revision on this list would not understand something, that
 * something is either gated on its `host` revision or it is a new revision, and
 * nothing in between.
 */

/** The bridge revision this page speaks. */
export const BRIDGE = 1;

/**
 * The host revisions this page still serves - the promise an installed extension
 * relies on. Taking one off the list is a breaking change to it: the host is told
 * so through `error` rather than left waiting for a document that never comes.
 *
 * Removing one is the whole ceremony for a break. There is no obligation to keep
 * serving a revision this page would only serve badly.
 */
export const ACCEPTS: readonly number[] = [1];

/** Whether this page was opened to be driven by a host (`?host=1`). */
export function isHosted(): boolean {
  return new URLSearchParams(location.search).get('host') === '1';
}

/** A document handed over by the host, however the host came by it. */
export interface HostDocument {
  /** The bytes, when the host has already read them. */
  bytes?: ArrayBuffer | Uint8Array | null;
  /** The URL they came from, when they came from one - which is how the page
   * identifies the document in its own memory. */
  url?: string | null;
  /** A local file's name, when there is no URL to name it by. */
  name?: string | null;
  /** The document's size in bytes; with the name, this is what identifies it. */
  size?: number | null;
  /** A page to open on, when the host was asked for one and nothing is remembered. */
  page?: number | null;
}

/** What the bridge needs from the page: the things only the page knows. */
export interface HostHooks {
  /** Open a document. The page reports the outcome through the bridge. */
  open(doc: HostDocument): Promise<void>;
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
  /**
   * The host's revision: 1 for a host that never said, which is any extension
   * from before revisions existed. Anything added to this protocol that an old
   * host would not understand is sent only when this is at least the revision
   * that understands it.
   */
  readonly host: number;
  /** A document is on screen: what it is, and what to call it. */
  opened(payload: { info: HostDocumentInfo | null; name: string; size: number }): void;
  /** It could not be opened, and the host is the one who can say why. */
  failed(message: string): void;
}

const noop: HostBridge = {
  active: false,
  host: 1,
  opened: () => {},
  failed: () => {},
};

/**
 * Wire the page to its host, or do nothing at all.
 *
 * The returned bridge is inert unless the page is hosted and framed, so callers
 * can wire it unconditionally.
 */
export function createHostBridge(hooks: HostHooks): HostBridge {
  if (!isHosted() || window.parent === window) return noop;

  const host = window.parent;
  /** The host's revision, until it says otherwise: the oldest one there is. */
  let revision = 1;
  /** A host this page cannot serve is told once, and given no document. */
  let refused = false;
  const post = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    host.postMessage({ wpdf: 'host', ...message }, '*', transfer);
  };

  window.addEventListener('message', (event: MessageEvent) => {
    // Only the frame that opened us, and only our own envelope: this is the one
    // door into the page, and it stays a door the host is standing at.
    if (event.source !== host) return;
    const message = event.data as { wpdf?: string; kind?: string; doc?: HostDocument; [k: string]: unknown } | null;
    if (!message || message.wpdf !== 'host') return;

    switch (message.kind) {
      case 'ready': {
        // The host has said which revision it is. A host that cannot be served
        // is told so, in the one shape every revision understands: an error.
        const said = typeof message.bridge === 'number' ? message.bridge : 1;
        if (!ACCEPTS.includes(said)) {
          refused = true;
          post({
            kind: 'error',
            message: `This viewer speaks bridge ${BRIDGE} and serves hosts of revision ${ACCEPTS.join(', ')}; a host of revision ${said} needs a newer viewer than this one.`,
          });
          break;
        }
        revision = said;
        break;
      }
      case 'open':
        // A host that was refused is not given a document to draw either.
        if (refused) break;
        void (async () => {
          try {
            await hooks.open(message.doc ?? {});
          } catch (error) {
            post({ kind: 'error', message: String((error as Error)?.message ?? error) });
          }
        })();
        break;
    }
  });

  // The handshake. The host answers with `open` - and with `ready` first, if it is
  // new enough to know about revisions; until it does, the page has no document,
  // and nothing of its own to show.
  post({ kind: 'hello', bridge: BRIDGE, accepts: ACCEPTS });

  return {
    active: true,
    get host() {
      return revision;
    },
    opened(payload) {
      post({ kind: 'opened', ...payload });
    },
    failed(message) {
      post({ kind: 'error', message });
    },
  };
}
