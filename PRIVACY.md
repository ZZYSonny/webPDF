# webPDF — privacy policy

_Last updated: 20 November 2026_

webPDF is a Chrome extension that reads PDFs in the browser. This page describes
what the extension does with your data. It is short because the extension does
not collect any.

## What the extension does not do

- It does not create an account, and there is nothing to sign in to.
- It does not collect, transmit, sell or share personal data.
- It does not use analytics, crash reporting, advertising or tracking of any
  kind.
- It does not send the documents you open to us or to anyone else.

## What it accesses, and why

**The PDF you open.** When you open a PDF, the extension's page fetches that one
file from the address you opened and hands the bytes to the viewer, which draws
the pages on your machine. The file goes from its own server to your browser; no
proxy of ours is in the middle, and the document is not uploaded anywhere. The
request is made the way your browser would make it, so it carries any cookies
that site has already set for you. The viewer itself is loaded from
`zzysonny.github.io`, but the document is handed to it inside the tab; it is not
uploaded to that site.

**The address of the last PDF.** So that the toolbar button can offer to reopen
the document you were reading, the extension keeps its URL and title in
`chrome.storage.local`. That record stays in your browser. Uninstalling the
extension removes it.

**Where you were in a document.** The viewer remembers your page, zoom and
outline state, so a document opens where you left it. That is kept in the
viewer's own site storage (`zzysonny.github.io`), not in the extension, and can
be cleared from Chrome's site-data settings.

**A random handover token.** A secret made when the extension is installed, kept
in `chrome.storage.local`, so a tab that the extension redirects to the viewer
can prove which document it was opened for. It contains nothing about you.

## Permissions

The extension asks for four API permissions and one host permission. Each is used
only for PDFs, and only in the way described here.

**`storage`** keeps the random handover token and the address and title of the
last PDF in `chrome.storage.local`. It keeps no history of earlier documents,
no settings and no document content.

**`declarativeNetRequestWithHostAccess`** adds one dynamic rule, and no static
rules: a top-level navigation whose URL path ends in `.pdf` is redirected to the
extension's own viewer page before the file is downloaded. The rule is replaced
whenever the extension starts, and it never blocks or modifies a request.

**`webRequest`** reads the `Content-Type` and `Content-Disposition` headers of
top-level navigations, so a PDF served from a URL without a `.pdf` ending (for
example `arxiv.org/pdf/1706.03762v7`) is recognised by its content type. It does
not read request bodies, does not modify headers, does not inspect subresources,
and leaves responses sent as attachments alone.

**`webNavigation`** watches top-level commits, so a navigation that has already
committed as a PDF can still be handed to the viewer: a local `file://` PDF, or a
case where Chrome refused the redirect rule.

**The `<all_urls>` host permission** lets the extension page fetch the one
document you opened from the site that hosts it. A web page cannot do this,
because PDF servers generally do not send `Access-Control-Allow-Origin`. The
bytes are used to draw the document; there is no proxy, and nothing is sent
anywhere else. Access to `file://` PDFs stays off unless you enable **Allow
access to file URLs** for the extension.

### What it does not ask for

- No `tabs` permission: the tab is handed over with `tabs.update`, and the
  extension does not enumerate or read the URLs of your other tabs.
- No `alarms` permission.
- No content scripts, and no `scripting` permission: the extension cannot read or
  change the DOM of the pages you visit.
- No `downloads`, `nativeMessaging` or `history` permission.
- Its extension pages use `script-src 'self'`, without `wasm-unsafe-eval`.

For comparison, the Chrome Web Store's PDF.js viewer asks for `tabs`, `alarms`
and a content script on every page in addition to the permissions above. webPDF
asks for none of those three.

## Network requests

The extension makes two kinds of request, both to servers it does not control:

1. the PDF, fetched from the site whose link you opened;
2. the viewer page and its files, served by GitHub Pages at
   `https://zzysonny.github.io/webPDF/`.

Like any web host, those servers receive the request itself (such as your IP
address and user agent). GitHub's handling of that is described in the
[GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

If this policy changes, the new version will be published at this address with a
new date above.

## Contact

Questions about this policy or the extension:

Open an issue at <https://github.com/ZZYSonny/webPDF/issues>.
