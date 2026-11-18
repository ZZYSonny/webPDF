# webPDF — privacy policy

_Last updated: 18 November 2026_

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
proxy of ours is in the middle, and the document is not uploaded anywhere.

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

The extension's other permissions are used only to recognise and redirect PDFs;
they are explained in the extension's Chrome Web Store listing. It does not read
the content of pages that are not PDFs.

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
