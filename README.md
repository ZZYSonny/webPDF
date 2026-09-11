# webpdf

Render PDF pages to SVG where **the text is real text** — selectable, searchable,
hintable, and tiny — instead of thousands of glyph outlines.

```ts
import { createViewer } from 'webpdf';

const viewer = await createViewer({ container: '#viewer', source: file });
viewer.setZoom('fit-width');
```

![the demo: a paper downloaded from arXiv, rendered as SVG with its real fonts, its outline floating on the left, and every match of a search boxed](docs/demo.png)

---

## The problem

MuPDF can already emit SVG two ways, and neither is what a document viewer wants:

| mode | output | problem |
| --- | --- | --- |
| `text=text` | `<text font-family="…">` with the characters | only correct if the *browser* has that font. It almost never does: PDFs embed subsets, and a browser cannot use a Type 1 (PFB/PFA) font at all. Get it wrong and the page reflows into the wrong typeface. |
| `text=path` | `<use>` per glyph, referencing outlines in `<defs>` | always correct, but a single page becomes ~400 KB of paths with no selectable text. |

The previous project solved this by bundling a fixed set of fonts and patching
MuPDF to emit text only for those. That does not generalise: every LaTeX paper
embeds a different subset, and `/FontFile`-style Type 1 fonts — which pdfTeX
emits constantly — are not usable as web fonts in the first place.

## The approach

**Render outlines, then upgrade them back to text.** One pass produces a
guaranteed-correct baseline; a second pass replaces exactly the glyphs we can
prove we have a font for.

```
PDF page
   │
   │  MuPDF SVG writer, text=path  ───────────►  outline SVG   (always correct)
   │
   ├─ <path id="font_1_53" d="M.38 .6C…"/>        outlines, in em units, y-up
   └─ <use data-text="P" href="#font_1_53"
           transform="matrix(11.9 0 0 -11.9 124.6 81.9)"/>
                                                  ↑ MuPDF hands us the character
   │
   │  per font: build a web font
   │    outlines → cubic→quadratic → TrueType → WOFF → @font-face
   │
   │  rewrite: <use> runs ─────────────────────►  <text> runs
   │
   ▼
SVG with real text, plus outlines kept for whatever could not be converted
```

### Why this works

* **No font parsing.** The PDF's embedded font program is never touched. MuPDF
  (through FreeType) has already resolved every font — embedded CFF, raw Type 1
  PFB/PFA, TrueType, substituted base-14 faces, CJK — into normalised outlines.
  Re-emitting those outlines as a `glyf`-free CFF/OpenType font means the
  browser draws *exactly* the shape MuPDF would have drawn as a path. The
  verification suite measures this: **100.00% of the reference ink is
  reproduced**, within a one-pixel neighbourhood.
* **Type 1 is not a special case.** A PFB is simply a font whose outlines MuPDF
  read for us. The LaTeX paper the tests render embeds five `/FontFile` Type 1
  fonts and converts all of them - as does the pdfTeX paper the demo opens from
  arXiv.
* **Positioning comes from MuPDF.** MuPDF writes one `x` (and `y`) value per
  character, so the browser never has to agree with us about advances, kerning
  or shaping. The transform maths is exact:

  ```
  <use transform="matrix(a b c d e f)">          outlines are y-up, em units
  <text transform="matrix(A B C D 0 0)" font-size="K">   text space is y-down

  K = sqrt(|ad − bc|)   A = a/K   B = b/K   C = −c/K   D = −d/K
  (x, y) = [A C; B D]⁻¹ (e, f)                   per-character baseline origin
  ```

### Character mapping

Each glyph is reachable under a real Unicode value where MuPDF recorded one
(`data-text`), so copy, search and screen readers work. Glyphs that have no
Unicode of their own — ligatures such as `fi`, which is one glyph standing for
two characters — get a code point from the BMP Private Use Area instead
(`U+E000…U+F8FF`). Both cases produce a `cmap` entry pointing at the right
outline, so nothing renders blank.

### Falling back

Anything not provably safe stays an outline, glyph by glyph:

| situation | behaviour |
| --- | --- |
| Type 3 font, bitmap-only glyph | `<use>` outline kept (MuPDF emits a `<g>`) |
| glyph with no outline in `<defs>` | `<use>` outline kept |
| stroked text (`stroke` attribute) | `<use>` outline kept |
| right-to-left or complex-shaping scripts | `<use>` outline kept (see limitations) |
| more than 6400 unicode-less glyphs in one font | the excess stays outlines |
| `textMode: 'paths'` | the whole page stays outlines |

There is no configuration in which the output is *wrong*; the worst case is the
older, larger, still-correct representation.

---

## Results

Measured on page 1 of the papers in the test corpus, all of them downloaded from
their public URLs (`demo/papers.mjs`):

| document | outline SVG | with real text | glyphs as text | fonts (WOFF) |
| --- | --- | --- | --- | --- |
| *Attention Is All You Need*, 1 page (6 Type 1/PFB fonts) | 373 KB | 65 KB (**17%**) | 2464 / 2464 | 6 (21 KB) |
| *Deep Residual Learning*, 1 page (9 fonts, bitmap figures) | 572 KB | 103 KB (**18%**) | 3630 / 3630 | 9 (33 KB) |
| *GPT-4 Technical Report*, 1 page (6 fonts) | 397 KB | 78 KB (**20%**) | 2917 / 2917 | 6 (19 KB) |

The same paper over 3 pages: 1255 KB of outlines become 429 KB (34%) across 18
distinct faces, 51 KB of WOFF.

Those numbers are the default output, link hit areas included — that is what the
extra 1–7 KB buys: one anchor and one transparent rectangle per link annotation
(37 on the *Deep Residual Learning* page, 8 on the *GPT-4* page, 33 across the
first three pages of *Attention Is All You Need*, and none at all on its title
page). `links: false` drops them again.

Ink coverage of the text render against MuPDF's own outline render: **100.000%**
(page 1 of *Attention Is All You Need*), 99.5–99.9% across the other pages
tested. The residue is antialiasing and stem darkening, not missing or misplaced
glyphs.

---

## Usage

### A viewer

```ts
import { createViewer } from 'webpdf';

const viewer = await createViewer({
  container: document.querySelector('#viewer')!,
  source: fileOrUrlOrArrayBuffer,
  zoom: 'fit-width',
  shadowDom: true,
  onEvent: (e) => { if (e.type === 'page-change') console.log(e.page); },
});

viewer.goToPage(12);
viewer.setZoom(2);
viewer.destroy();
```

Only the pages touching the viewport, plus one on each side, are ever in the DOM.
Everyone else is an absolutely positioned box whose geometry was computed up
front, so zooming restyles boxes and never re-renders a page.

#### Who owns the zoom

Zoom is split by gesture, because the two gestures have completely different
cost profiles:

* **A touch pinch belongs to the browser.** It changes the page scale, which the
  compositor applies without any layout or script at all, and Chromium re-rasters
  the vector content at the new scale, so the pages stay crisp. The viewer never
  resizes or rescales anything while a pinch is in flight.
* **Ctrl+= / Ctrl+- / Ctrl+0 walk a ladder of layout zoom settings**
  (25%, 50%, 75%, 100%, 125%, 150%, 200%, 300%, 400%, fit-width, fit-page by
  default - pass `zoomSteps`, or import `DEFAULT_ZOOM_STEPS` to render the same
  list in a control of your own). The rungs are sorted by what they resolve to at
  the moment the key is pressed, because the fit modes move with the window:
  stepping up from "fit width (229%)" goes to the next *larger* level, not to a
  fixed one. These are discrete and not animated, so one re-layout per press is
  fine, and they deliberately *override* the browser's own zoom shortcuts:
  browser zoom scales the whole app, chrome included, and would put the layout
  scale out of step with what is on screen.
* **Ctrl+wheel is left to the browser** (a trackpad pinch on desktop) and does no
  layout work here.

Two consequences of letting the browser own the pinch:

* The **host element must be in the flow of the root scroller**. Panning while
  zoomed only chains into the root scroller - a nested `overflow:auto` ancestor
  traps the zoomed page inside one layout viewport. The document, not the viewer,
  is the scroller.
* Everything in the document is magnified together, so **chrome next to the
  pages is magnified too** and can pan out of view. `zoom-change` carries
  `zoomed` so a host can hide its chrome; the demo fades it with an opacity
  toggle (no layout involved).

The same event carries `layoutScale`, `mode` and `pageScale`, so a zoom control
can show the level the *layout* is at without re-deriving it from the effective
zoom - the browser's page scale is not a layout zoom and is not settable from
script.

Measured in this repository's Chromium (1440x900, three real LaTeX pages, one
page rendered either side of the viewport):

| gesture | layout | layout ms | frames p50/p95 |
|---|---|---|---|
| touch pinch, page scale 1 -> 10 | 8 trivial | **0.0** | 16.7 / 16.7 |
| pinch + chained pan + virtualisation | 29 | 10 | 16.7 / 16.7 |
| browser zoom (device pixel ratio 1 -> 1.5) | 0 | **0.0** | - |
| Ctrl+= (one ladder step, re-layout) | 3 | 30-90 | - |
| the previous design: JS resize of every page box per zoom step | 1/step | **~17.5/step** | 16.7 / 16.8 |

### Links

A PDF link is an invisible rectangle over the page content, so the renderer
supplies both the target and the affordance. Every link annotation becomes a
transparent, focusable `<a>` hit area inside the page's SVG, and the same links
come back as data on the rendered page:

```ts
const page = await engine.renderPage(0);
page.links;   // [{ kind: 'internal', rect, page, x, y }, { kind: 'external', rect, uri }]
```

Because the hit areas *are* part of the SVG, they scale with the page at any zoom
without anything being re-measured, they survive `exportSvg`, and a downloaded
SVG file carries its own links. They are invisible, though: a PDF's links are
invisible, an exported SVG should be the page's own pixels, and no browser boxes
an anchor either — so the pointer and the keyboard are what reveal them (hover
paints a wash over the link, focus rings it). A `javascript:` URI never becomes
an `href`: a PDF is untrusted input, and an `href` is an instruction to navigate.

In the viewer, a click (or Enter, on a focused hit area) is caught rather than
followed - the page showing the document is never replaced by what the document
links to:

```ts
createViewer({
  container: '#viewer',
  // The viewer's own chrome overlaps the pages, so jumps stop short of it.
  scrollMargin: () => document.querySelector('.topbar')!.offsetHeight,
  onEvent: (event) => {
    if (event.type !== 'link') return;
    if (event.kind === 'external' && !allowed(event.uri)) {
      openInMyOwnTab(event.uri);
      return false;             // taken over: the viewer does nothing
    }
    if (event.kind === 'internal') event.y = null;  // go to the page top instead
    // Returning anything else lets the default run, with the event as edited.
  },
});
```

* An **internal** link scrolls to the destination *point*, not just to the page:
  the destination the PDF names (its `y`, in points from the page's top-left)
  ends up at the top of the viewport, clear of `scrollMargin`. A destination
  without a point - `Fit`, `FitB`, a bare `#page=` - targets the page top
  instead. Nothing is written to the URL: a destination is not a document
  fragment, and in an embedded viewer the address bar belongs to the host.
* An **external** link opens in a new tab (`window.open(uri, '_blank',
  'noopener,noreferrer')`). The anchor keeps its own `href`, so middle-click,
  Ctrl-click and "copy link address" behave the way they do everywhere else.
* **Back undoes a jump.** Following an internal link writes two entries into the
  session history - the position being left, and the destination - so the
  browser's Back button returns to exactly where the link was clicked from, and
  Forward returns to where it went. A position is remembered as a page and a
  point inside it, not as a pixel offset, so it still lands on the same line
  after a zoom in between. The URL is never touched: the entries differ only in
  their state, and `history: false` opts out entirely for a host whose own router
  owns the history (or a viewer embedded in a single-page app, where Back should
  leave the document rather than step back inside it).
* A URI a browser will not follow - `javascript:`, `data:`, `file:`, a relative
  path - gets a hit area and a `link` event with `openable: false`, but no
  `href`. Only the host knows whether it can do something with one of those (an
  extension fetching a `file:` URL, say), so the viewer reports it and stops.

### The demo app

`npm run dev` serves the demo, which is this library plus a toolbar. The toolbar
is deliberately thin, because everything about the pages' zoom belongs to the
viewer:

* **The example documents are fetched, not shipped.** Every entry in the picker is
  a public URL - the first is *Attention Is All You Need* on arXiv, a pdfTeX paper
  whose Type 1 fonts are exactly the case this library exists for. A published page
  therefore carries no PDFs at all: the browser downloads the example from whoever
  hosts it (arXiv serves it with `access-control-allow-origin: *`, so no proxy of
  ours sits in the middle) and opens it like any other file. On a local dev or
  preview server, the papers the tests have cached are *also* offered, from
  `/pdf/<name>`; a build has no cache behind it, so the published site lists the
  public URLs and nothing else.
* **One bar, no status bar.** Messages float in a toast instead, so the pages own
  every pixel below the bar and there is no chrome pretending to stay put while
  the browser magnifies the document.
* **The zoom box holds a bare number.** `%` is the control's unit and nobody types
  it; the levels - including the fit modes, listed as the percentage they resolve
  to (`229% (fit width)`) - live in the dropdown, and `+`/`-` and Ctrl +/- step
  that same ladder with the box left free for typing `150` or `1.5`. A document
  opens one rung *below* fit-width (200% at the sizes above): fit-width is the
  widest level that still shows the page in full, and starting there leaves the
  paper touching both edges of the window. Ctrl+0 still means fit width.
* **The outline floats** over the pages rather than taking a column. A column
  would change the viewer's width every time it opened, and a fit-width layout
  would re-fit - visibly re-zooming the document - for a navigation panel.
* **Search behaves like the browser's find bar.** Typing boxes every match on the
  pages in front of you and jumps straight to the first one - no Enter needed -
  while the background index fills in from page one, so the count and the boxes
  settle as the rest of the document is read. `Enter` / `Shift+Enter` (and the
  arrows) walk the matches from there, `Esc` clears them. The viewer only keeps
  the pages near the viewport, so any page that is not on screen is rendered once
  and kept as text. A hit is painted as a `<rect>` measured from a `Range` over
  the matched characters and mapped back through the page's own matrix, so it
  lands on the word - and the page's markup is never restyled.
* **Search ignores whitespace on both sides.** Runs are one positioned string
  each and a space glyph has no outline to build a font from, so a page's text can
  read `AttentionIsAllYouNeed` (see the limitations).
* **Links are the viewer's, and the demo just says what happened.** Clicking an
  external link opens it in a new tab and the toast names the URI; a link a
  browser cannot follow (the *GPT-4 Technical Report* links to a local file) gets
  the same click, no navigation, and a toast that says so. Back - the browser's
  own button, there is no chrome for it - returns to the position a link was
  clicked from. The demo does not take a link over: `onEvent` returning `false`
  is the hook for a host that wants to.

### Headless rendering

```ts
import { PdfEngine, renderDocument } from 'webpdf';

// one page at a time, no DOM
const engine = new PdfEngine();
await engine.open(bytes);
const page = await engine.renderPage(0, { embedFonts: true, responsive: false });
console.log(page.svg, page.stats);

// or stream a whole document to standalone SVG files
for await (const page of renderDocument(bytes, { embedFonts: true })) {
  writeFileSync(`page-${page.index}.svg`, page.svg);
}
```

`embedFonts: true` puts the `@font-face` rules inside the SVG, which is what
makes an exported file self-contained — required for `<img src="…svg">`, for a
downloaded file, or for a CSS background.

Link hit areas are included by default, so the exported SVG is clickable where
it is opened as a document; `links: false` leaves them out, and `page.links` is
data either way.

### Browser extension notes

The library was written with content scripts in mind:

* **No globals.** The only optional one is a debug flag (`globalThis.__wpdfDebug`)
  and the `window.webpdf` handle the demo installs for itself.
* **Shadow DOM** (`shadowDom: true`) keeps a host page's CSS from touching the
  viewer, and vice versa. The pages themselves are ordinary blocks in the host
  document (there is no content iframe: a frame cannot own the pinch, and a
  frame's own scroller would not receive a zoomed pan), so the shadow root is
  what keeps host CSS away from them.
* **Give it the root scroller.** The viewer sets the container's height to the
  full layout height and expects the document to scroll; do not put it inside an
  `overflow:auto` wrapper, or a zoomed page cannot be panned past one viewport.
* **Fonts are registered on the document**, through a *constructed stylesheet*
  where available. Two reasons: Chromium does not load `@font-face` rules
  declared inside a shadow root, and a constructed stylesheet is not subject to
  a page's `style-src` policy.
* **Sanitised sources.** `File`, `Blob`, `ArrayBuffer`, `Uint8Array`, a URL
  string or `{ url, headers }` all work.
* **Nothing is assumed about the DOM.** The viewer mounts into whatever element
  you give it and cleans up fully in `destroy()`.
* **Rendering runs in a worker by default**, and falls back to the main thread
  automatically if a worker cannot be created or does not answer within 15 s -
  so opting in can never leave you with a viewer that does not render. Pass
  `worker: false` to force inline rendering. The prebuilt library resolves its
  worker relative to `dist/webpdf.js`; if you move `assets/` somewhere else (an
  extension must often vendor it), pass `workerUrl` explicitly.
* The MuPDF wasm binary is fetched relative to the module URL. If your extension
  needs to control that (for `web_accessible_resources`), set it explicitly
  before importing:

  ```ts
  globalThis.$libmupdf_wasm_Module = {
    locateFile: (p: string) => chrome.runtime.getURL(`vendor/${p}`),
  };
  ```

`PdfEngineLike` is exported, and `WorkerEngine` is the reference implementation
of it, so a different transport (an extension's offscreen document, a shared
worker, a remote renderer) only needs `open` / `renderPage` / `drainNewFonts` /
`close`.

---

## Layout

```
src/
  api.ts                    createViewer, renderDocument, public types
  core/
    engine.ts               MuPDF document + page rendering (DOM-free)
    debug.ts                opt-in pipeline tracing
    links.ts                link annotations → data, and → SVG hit areas
    svg/
      glyphs.ts             scanner for MuPDF's SVG (outlines + <use>)
      text-upgrade.ts       <use> runs → <text> runs
      package.ts            id namespacing, root rewriting, font embedding
    font/
      svg-path.ts           SVG path data parser (M/L/H/V/C/Z + implicit repeats)
      quadratic.ts          cubic → quadratic conversion
      build.ts              outlines + cmap → TrueType
      woff.ts               TrueType → WOFF (zlib via CompressionStream)
      registry.ts           per-page planning, caching, @font-face rules
  worker/
    pdf.worker.ts           engine host; installs onmessage before awaiting wasm
    client.ts               WorkerEngine: a PdfEngineLike that proxies to it
  viewer/
    layout.ts               page geometry + visible-range maths
    viewer.ts               virtualised scrolling viewer (browser-owned pinch)
demo/                       the demo application
  papers.mjs                the corpus: public URLs, and where they are cached
  papers-client.ts          which of them this page has a local copy of
  examples.ts               the picker's entries, cached copies first
tests/
  *.test.ts                 Node tests (real PDFs through the real wasm)
  pdf-cache.mjs             fetches the corpus, lists it, clears it
  browser/                  headless-Chromium verification over CDP
scripts/
  no-jekyll.mjs             marks the Pages artifact as pre-built
```

Rendering never touches the DOM, which is why the same `PdfEngine` runs inline,
inside the worker, and under Node in the tests.

## Development

```sh
npm install
npm run dev          # demo on http://127.0.0.1:5173
npm run pdfs         # fetch the test corpus into the cache (also happens on demand)
npm test             # Node tests: font pipeline over the real papers
npm run test:browser # builds the demo, serves it, verifies in headless Chromium
npm run verify       # typecheck + both test suites
npm run build:pages  # the published site, in dist/demo
```

### The test corpus

No PDF is stored in this repository, and none is generated: `demo/papers.mjs`
lists the corpus - four papers, at the time of writing - by public URL, and
everything refers to that one list: the Node tests, the browser tests, and the
demo's picker on a local origin. Nothing needs a document to be checked in,
reviewed as a binary, or replaced when it goes stale; `git ls-files '*.pdf'` is
empty, and the tests cannot drift from what a reader would actually download.

The URLs are versioned arXiv papers (plus ISO 32000-1 from Adobe), chosen because
they are immutable and served with `access-control-allow-origin: *`. Both matter
here: the browser tests fetch them the way the published demo does, with no proxy.

Downloads land in a cache, `.scratch/pdfs` by default, which is gitignored. Point
it somewhere else - a shared or pre-warmed directory, a CI volume - with
`$WEBPDF_PDF_CACHE`; a relative path is read from the repository root. The tests
fetch whatever is missing on their own, so a cold cache costs one download and
every run after that is offline. `npm run pdfs -- --list` shows what is cached,
`-- --clear` empties it, and the cache directory is never written to by a build.

The browser suite is the interesting one. It renders each page twice — once as
MuPDF outlines, once through the text upgrade — rasterises both, and reports how
much of the reference ink the text render covers. It needs a Chromium binary;
set `$CHROMIUM` if it is not at `/usr/bin/chromium`. It also needs the network:
the last thing it does is open a paper at its public URL, because that is what a
reader of the published page does. The document-specific search checks run
against the cached copy of the paper, so their counts do not depend on what the
network returns today.

`tests/browser/diff.mjs` produces a red/green difference map for human eyes:
overlapping ink is yellow, so any systematic offset or missing glyph is obvious.

### Publishing

`.github/workflows/pages.yml` typechecks, builds `dist/demo` and deploys it with
`actions/deploy-pages` on every push to `main` (and on demand from the Actions
tab). It deliberately does **not** run the test suites: rendering a paper and
rasterising pages is a fine thing to do on a developer's machine and a poor gate
between a commit and the published site. It does not fetch the corpus either -
the published build has no use for it.

Pages has to be set to **Source: GitHub Actions** in the repository settings —
there is no `gh-pages` branch and nothing to commit back to the repository. The
site is served from the repository's own path (`…github.io/webPDF/`), which is
why the demo derives its base from its own module URL and every asset Vite emits
is referenced relatively.

---

## Limitations

* **Complex scripts stay as outlines.** Arabic, Hebrew, Indic and South-East
  Asian scripts are detected by code point range and left as glyph outlines. The
  text would otherwise be reordered by the bidi algorithm or reshaped, undoing
  MuPDF's already-resolved per-glyph positioning. Latin, Greek, Cyrillic, CJK
  and punctuation are all emitted as text.
* **Fonts are subset per page.** Each page builds its own subsets, roughly
  10–25 KB of WOFF per page. Correct and lazy (a page you never open costs
  nothing), but a document-wide pass would share tables between pages and cut
  that substantially — the obvious next optimisation.
* **Fonts are not hinted.** Outlines are re-emitted from MuPDF's, so the
  original bytecode hints are gone. This is mostly irrelevant for SVG at
  arbitrary zoom, but it is a real difference from embedding the original font.
* **Synthetic bold/italic is not reproduced.** When a PDF has no bold face and
  the producer relies on stroke-based faux bold, outline mode and text mode
  differ slightly.
* **WOFF, not WOFF2.** WOFF2 would be roughly a third smaller, but every
  JS/wasm encoder tried either did not work in the browser or added a
  multi-megabyte dependency for a few hundred bytes per page.
* **Per-page text is emitted by span, not by paragraph.** Line breaking is
  whatever the PDF says; the SVG carries positioned runs, not flowing text. A
  space glyph has no outline to rebuild a font from, so runs break at word
  boundaries and the space between them is dropped: copy-paste (and naive search)
  sees `AttentionIsAllYouNeed`. Emitting U+0020 from the PDF's advance widths
  would fix it; the demo's search strips whitespace from both sides instead.
* **The worker path is verified in Chromium only.** It relies on module workers
  and `CompressionStream`, both of which are widely available, but the fallback
  exists precisely because worker startup can be blocked by a host's CSP.
* **Links follow only what a browser can follow.** `https`, `http`, `mailto` and
  `tel` become `href`s; everything else is reported and left inert (see
  [Links](#links)). A relative link has no base URL to resolve against - a PDF
  does not have one - so it is treated the same way. An internal destination
  carries the point the PDF names, and the viewer uses its `y`: the `x` is
  reported for hosts that care about columns, and ignored by a viewer that
  scrolls in one column. Ink annotations, form fields and other annotation types
  are not interactive; only link annotations are.

## Licence

MuPDF.js is AGPL-3.0-or-later, and this project links it, so the same licence
applies. See [LICENSE](LICENSE).
