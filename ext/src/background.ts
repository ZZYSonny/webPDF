/**
 * The worker: it notices a PDF being opened, and gives the tab to the viewer.
 *
 * There is no welcome page and no "open a file" button in this extension - a
 * document arrives the way it always did, by being clicked, typed or dragged, and
 * the extension's whole first move is to make sure the *viewer* is what ends up
 * on screen. Three things can see that happen, and all three are here:
 *
 *   the redirect rule  a `.pdf` path is turned into the viewer before a single
 *                      byte of the document is asked for (so a 50 MB paper is
 *                      fetched once, by us, and not once by Chrome first)
 *   the header watch   a response that *is* a PDF whatever its URL looks like -
 *                      `arxiv.org/pdf/1706.03762v7` has no extension to match -
 *                      takes the tab over as soon as the content type is known
 *   the commit watch   anything that still committed as a PDF URL (a `file://`
 *                      document, a rule the browser would not take) is taken
 *                      over on the spot
 *
 * What it does *not* do is fetch the document, and it does not remember anything
 * about it either: the viewer page is an extension page too, so it has the same
 * access and streams the bytes itself - and it is the viewer, not this worker,
 * that remembers where the reader was, in its own storage. The worker's part is
 * the interception, the tab handover and one URL for the toolbar button.
 *
 * The handover carries a token: the redirect the browser performs cannot know
 * which tab it was for, so the viewer URL carries a secret that only this worker
 * has, and the worker will only resolve a document for a page that presents it.
 * A web page that embeds or opens the viewer's URL therefore gets nothing: it
 * cannot guess the token.
 *
 * The redirect rule is a *dynamic* rule - written into the profile, not into a
 * session - and the token is kept beside it in local storage, because both have
 * to outlive the worker. A service worker is stopped when it is idle, and the
 * events that would wake it are not always delivered: a PDF opened in the second
 * between the browser starting and the worker coming back up is a PDF the rule
 * has to catch on its own. That is exactly what a stored rule does, and what a
 * session rule (which the browser drops on exit) does not.
 */

import { isOpenable } from './lib/url.js';

/** The viewer page, as a URL this extension may be redirected to. */
const VIEWER = chrome.runtime.getURL('viewer.html');

/** The one redirect rule this extension installs, replaced on every start. */
const RULE_ID = 1;

/** Where the handover token lives. Beside the rule, and for the same reason. */
const TOKEN_KEY = 'token';

/** The document the toolbar button offers to open again: one URL, and its name. */
const LAST_KEY = 'last';

/** A URL whose *path* ends in `.pdf` - the rule and the checks agree on this. */
function looksLikePdf(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- the token */

/**
 * The secret in a viewer URL: made once, when the extension is first installed,
 * and kept. It outlives the worker and the browser, because the rule that carries
 * it does - a viewer tab that is reloaded, or a tab restored with the session,
 * still has to be able to say which document it was opened for.
 */
async function handoverToken(): Promise<string> {
  const stored = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  if (typeof stored === 'string' && stored.length > 0) return stored;
  const token = crypto.randomUUID().replace(/-/g, '');
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
  return token;
}

/** A viewer URL for a document: the token, an optional page, and the source last. */
function viewerUrl(token: string, url: string, page: number | null = null): string {
  // The source is the last parameter and is *not* encoded, because a URL is not
  // a value this can safely round-trip through `encodeURIComponent` twice: the
  // page reads everything after `u=` as the URL itself.
  const bare = url.split('#')[0] ?? url;
  const hint = page && page > 1 ? `page=${page}&` : '';
  return `${VIEWER}?t=${token}&${hint}u=${bare}`;
}

/** Where the reader was, when the viewer says so: one document, for the button. */
async function rememberLast(entry: { url: string; name?: string }): Promise<void> {
  await chrome.storage.local.set({ [LAST_KEY]: entry });
}

async function lastDocument(): Promise<{ url: string; name?: string } | null> {
  const stored = (await chrome.storage.local.get(LAST_KEY))[LAST_KEY] as { url?: unknown; name?: unknown } | undefined;
  if (!stored || !isOpenable(stored.url)) return null;
  return { url: stored.url, name: typeof stored.name === 'string' ? stored.name : undefined };
}

/* --------------------------------------------------- interception, part 1 */

/**
 * The fast path: the browser rewrites a `.pdf` navigation itself, before the
 * request leaves - and does it whether or not this worker is running, because the
 * rule is stored in the profile rather than held in a session.
 *
 * It cannot be a *static* rule (the kind written in the manifest): its redirect
 * target is this extension's own URL with this extension's token in it, and
 * neither is known when the manifest is written. A dynamic rule is the same thing
 * with those two values filled in, and it is written on install and re-written on
 * every start, so a rule that somehow went missing comes back by itself.
 */
async function installRules(token: string): Promise<void> {
  const rule: chrome.declarativeNetRequest.Rule = {
    id: RULE_ID,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${VIEWER}?t=${token}&u=\\1` } },
    condition: {
      // The whole URL is captured, fragment and all, so a `#page=7` that Chrome
      // would have honoured arrives at the viewer as its own fragment.
      regexFilter: '^((?:https?|file)://[^?#]*\\.pdf(?:[?#].*)?)$',
      resourceTypes: ['main_frame'],
      isUrlFilterCaseSensitive: false,
    },
  };
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules: [rule] });
  } catch (error) {
    // A browser that will not take the rule still gets the document: the commit
    // watch below takes the navigation over a moment later instead.
    console.warn('webpdf: no redirect rule, falling back to taking over on commit', error);
  }
}

/* --------------------------------------------------- interception, part 2 */

async function takeOver(tabId: number, url: string, page: number | null = null): Promise<void> {
  try {
    const token = await handoverToken();
    await chrome.tabs.update(tabId, { url: viewerUrl(token, url, page) });
  } catch (error) {
    // The tab is gone, or a tab may not be sent to that URL: either way there is
    // nothing to do about it here, and the reader is left with Chrome's viewer.
    console.warn('webpdf: could not take the tab over', url, error);
  }
}

/** A response header, by name, whatever its case. */
function header(details: chrome.webRequest.Details, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const item of details.responseHeaders ?? []) {
    if (item.name.toLowerCase() === wanted) return item.value ?? '';
  }
  return null;
}

/**
 * Anything that committed *as* a PDF URL: a local file (which no rule sees), or a
 * navigation the redirect rule did not catch. The tab is on Chrome's viewer by
 * now, so this is the second chance rather than the first.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || !looksLikePdf(details.url)) return;
  if (details.url.startsWith('chrome-extension:')) return;
  void takeOver(details.tabId, details.url);
});

/**
 * The content type, which is the only way to recognise a PDF whose URL does not
 * say so. Chrome is about to hand the tab to its own viewer; this takes it
 * first. A response meant to be saved is left alone: `attachment` means the
 * reader asked for a file, and a viewer is not what they asked for.
 */
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== 'main_frame' || details.tabId < 0) return;
    if (!(header(details, 'content-type') ?? '').toLowerCase().includes('application/pdf')) return;
    if (/^\s*attachment/i.test(header(details, 'content-disposition') ?? '')) return;
    if (details.url.startsWith('chrome-extension:')) return;
    void takeOver(details.tabId, details.url);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders'],
);

/* ------------------------------------------------------------- the viewer */

/**
 * What the viewer page asks for.
 *
 * `resolve` is the handover: the page says which document it was opened for and
 * proves it was sent here, and gets back the URL to fetch. `last` is the page
 * saying what it opened, so that the toolbar button can offer it again. There is
 * nothing else - no positions, no settings, no list: those are the viewer's own
 * memory, in the viewer's own storage, where they can be shared with every other
 * way of opening that page.
 */
type Request =
  | { type: 'resolve'; token: string; url: string }
  | { type: 'last'; url: string; name?: string };

async function handle(request: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (request?.type) {
    case 'resolve': {
      if (request.token !== (await handoverToken())) return { ok: false, error: 'This tab was not opened by this extension.' };
      if (!isOpenable(request.url)) return { ok: false, error: 'That is not a URL this extension will open.' };
      // Only a document of its own: a viewer page inside another page's frame is
      // not the tab's document, and a document is what a tab is for.
      if (typeof sender.tab?.id !== 'number' || sender.frameId !== 0) return { ok: false, error: 'Not a viewer tab.' };
      await rememberLast({ url: request.url });
      return { ok: true, url: request.url, name: '' };
    }
    case 'last': {
      if (!isOpenable(request.url)) return { ok: false };
      await rememberLast({ url: request.url, name: typeof request.name === 'string' ? request.name : undefined });
      return { ok: true };
    }
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Every answer is asynchronous - storage is - so the channel stays open.
  void handle(message as Request, sender)
    .then(respond)
    .catch((error) => respond({ ok: false, error: String((error as Error)?.message ?? error) }));
  return true;
});

/* ------------------------------------------------------------- the button */

/**
 * The toolbar button opens the document this extension last handed over. It is
 * not a list and not a history: the reader's place in it is the viewer's own
 * memory, and the viewer puts it back. With nothing to open there is nothing to
 * open - and this extension has no page to offer instead, which is the point.
 */
chrome.action.onClicked.addListener(() => {
  void (async () => {
    const document = await lastDocument();
    if (!document) return;
    const token = await handoverToken();
    await chrome.tabs.create({ url: viewerUrl(token, document.url) });
  })();
});

/* -------------------------------------------------------------- the start */

async function start(): Promise<void> {
  const token = await handoverToken();
  await installRules(token);
  await chrome.action.setTitle({ title: 'webPDF — open the document you were reading' });
}

chrome.runtime.onInstalled.addListener(() => void start());
chrome.runtime.onStartup.addListener(() => void start());
void start();
