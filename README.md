# webpdf

Render PDF pages to SVG where **the text is real text** — selectable, searchable,
hintable, and tiny — instead of thousands of glyph outlines.

```ts
import { createViewer } from 'webpdf';

const viewer = await createViewer({ container: '#viewer', source: file });
viewer.setZoom('fit-width');
```

![the demo: a paper downloaded from arXiv, rendered as SVG with its real fonts, one line of chrome above it, and every match of a search boxed](docs/demo.png)

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
(`data-text`), so copy, search and screen readers work. A ligature is the case
that needs help: the outline device names a glyph by the *first* of the letters
it was shown with, so the one glyph a typesetter drew for `fi` arrives as `f` and
looks like a second glyph claiming a code point that is already taken. The text
device knows the whole word — it takes the ligature apart and reports one
character per letter — so the letters are read from there
(`core/svg/ligatures.ts`) and the glyph is given the Unicode character that *is*
that ligature (`U+FB01` for `fi`, and the six others Unicode names). Copying
`efficient` then gives a ligature character - not a box - which normalising
spells back into `ffi`, and which a search that normalises (ICU-based find in
the browsers, a normalising index) matches against the decomposed spelling.

Only what is left over falls back to a code point from the BMP Private Use Area
(`U+E000…U+F8FF`): a ligature Unicode never named, a glyph drawn two different
ways on one page, or one the text device did not describe. Every case produces a
`cmap` entry pointing at the right outline, so nothing renders blank.

### Falling back

Anything not provably safe stays an outline, glyph by glyph:

| situation | behaviour |
| --- | --- |
| Type 3 font, bitmap-only glyph | `<use>` outline kept (MuPDF emits a `<g>`) |
| glyph with no outline in `<defs>` | `<use>` outline kept |
| stroked text (`stroke` attribute) | `<use>` outline kept |
| right-to-left or complex-shaping scripts | `<use>` outline kept (see limitations) |
| ligature whose letters cannot be established | private-use code point (see limitations) |
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
| *Attention Is All You Need*, 1 page (6 Type 1/PFB fonts) | 373 KB | 74 KB (**20%**) | 2464 / 2464 | 6 (21 KB) |
| *Deep Residual Learning*, 1 page (9 fonts, bitmap figures) | 579 KB | 117 KB (**20%**) | 3630 / 3630 | 9 (33 KB) |
| *GPT-4 Technical Report*, 1 page (6 fonts) | 398 KB | 89 KB (**22%**) | 2917 / 2917 | 6 (19 KB) |

The same paper over 3 pages: 1260 KB of outlines become 458 KB (36%) across 18
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

Only the pages near the viewport are ever in the DOM. Everyone else is an
absolutely positioned box whose geometry was computed up front, so zooming
restyles boxes and never re-renders a page.

The window is deliberately wider than the viewport, and *rendering* a page is
deliberately separated from *putting it in the document*:

```ts
createViewer({
  container,
  keepPages: 1,           // pages either side of the viewport that stay in the DOM
  overscanViewports: 1,   // how far past the viewport the rendered window reaches
  prepareAhead: 3,        // pages past the window rendered while nothing else is happening
});
```

* A page is rendered about a viewport before it can be read, so arriving at it is
  not the moment its render starts.
* A finished page goes into the document at a **quiet moment** - 150 ms after the
  view has stopped moving - unless the reader is looking at it or is one page
  away from it, in which case it goes in straight away.
* While the pipeline is idle, the pages just past the window are rendered too.
  Their SVG is kept (`viewer.preparedPages`) and their fonts are registered, so
  reaching one costs a DOM insert and nothing else. None of this is extra work:
  those pages would have been rendered on the way to them.

That ordering is not a micro-optimisation: it is the difference between a smooth
scroll and a hitch at every page boundary. Two costs land on a page insertion:

| what | why it costs | measured |
|---|---|---|
| parsing 100-300 kB of SVG | the page is text-heavy and every element is a positioned `<tspan>` | 4-7 ms |
| `@font-face` registration | adding *any* face makes the browser lay out every text run in the document again - all pages currently rendered, not just the new one | **60-110 ms** |

The second one is the expensive one, and it used to be paid at every boundary,
because a page carries the faces it needs every time it is rendered and each
family was handed to the document again each time. Now a family is registered
once for the life of the document - the demo test asserts that a full re-render
of every rendered page registers zero faces - and what is left of the cost is
paid while the reader is stationary.

Measured three times on each build, same gesture (40 wheel notches at 60 px,
crossing one page boundary in a 15-page paper, 1280x900):

| | slow frames while scrolling | worst frame while scrolling | faces registered |
|---|---|---|---|
| pages rendered as they arrive, faces re-registered per page | 1, at the boundary | 70-89 ms | 18 |
| this design | **0** | **≤19 ms** | 7 |

The work did not disappear: it moved to the first frames after the scroll stops
(67-127 ms in the same runs, in software rendering, with the reader looking at a
page that is not moving). A page the reader *is* looking at never waits for that
moment - it goes in as soon as it is ready.

Preparing *every* font when the document loads is not possible: a glyph's outline
only exists once that page has been through MuPDF's SVG device, so preparing the
whole document means rendering the whole document - the SVG pass alone measures
52 ms a page, about 5 s for a 100-page report and 39 s for the 756-page
specification, before any font is built. Preparing the pages just ahead of the
reader does the same job for the pages that matter, and the work stays bounded
however long the document is.

#### Cropping pages to their content

```ts
import { CROP_RULES, type CropRuleId } from 'webpdf';

viewer.setCrop(['arxiv', 'page-number']);       // trim to content, minus those marks
viewer.setCrop(['arxiv', 'page-number'], 8);    // ...keeping 8pt of margin around it
viewer.setCrop(null);                           // show the pages whole again
viewer.cropBox(1);                              // { x, y, width, height } | null
```

The rules are [PaperCutter](https://github.com/zzysonny/PaperCutter)'s: a page is
reduced to the bounding box of its text and its larger drawings, with the spans
that match an enabled rule left out of that box. A rule is a test on one text run
- `s.startsWith("arXiv:")`, `s.lstrip().rstrip().isdigit()`, `re.match("CHAPTER
[0-9]\.", s)` - and `CROP_RULES` publishes them with the source line each came
from, so a host can render its own control from the same table the engine uses.
`renderDocument(source, { crop, cropPadding })` does the same thing headlessly,
which is the batch case the original script exists for.

The margin is in page units - 1/72 inch - and is stopped by the page's own edges.
It costs nothing to change: the rules decide where the content is, the margin is
added to that box at render time, so the field in the demo re-lays-out the pages
without reading a single one of them again. Zero is the library's default, which
is exactly what the reference script crops to; the demo's own field starts at 6pt
- a twelfth of an inch, which is enough that a trimmed page does not look cut
off.

Two properties are worth stating plainly, because they are the difference between
this and "delete what is outside the box":

* **The crop is a `viewBox`.** Every element the page had is still in the SVG -
  the text is still there to be selected and searched, and the link hit areas are
  still where they were. The reader sees a smaller window onto the same drawing,
  which is exactly what a PDF crop box is. (The page's *layout* size follows the
  crop, so the scroll height is right.)
* **A rule may not slice a line of text.** The box is the union of whole text
  runs, measured from all four corners of each glyph's quad, so a mark is either
  inside the window or outside it - never half in. A run measured from a single
  corner collapses to a line and takes the bottom line of the page with it; that
  is a bug this code had, and `tests/crop.test.ts` and the demo test both pin it.

Measuring a page costs a few milliseconds, and the scroll layout cannot be built
until the boxes are known, so `setCrop` reads the document in the background and
lets the layout follow: the reader's own page is measured first, one re-layout per
frame at most, and `crop-change` reports the progress. The reader keeps their page
and their place on it throughout. An engine keeps what it measured, so toggling a
rule off and on again is free. Internal link destinations are points on the
*uncropped* page and are translated to the crop before the jump, so a link still
lands where it says.

#### Bionic reading

```ts
viewer.setBionic(true);        // every word's first letters at full strength
viewer.setBionic(true, 0.3);   // ...with the rest of each word fainter still
viewer.bionicDim;              // 0.5: `BIONIC_DIM`, until a host says otherwise
viewer.setBionic(false);       // the document's own page again
```

Bionic reading gives every word a *fixation point* - its first letters, so the eye
has somewhere to land and the brain finishes the word on its own. Which letters is
not a guess of ours: [`text-vide`](https://github.com/Gumball12/text-vide) decides
it from the word's length, and the engine holds exactly those glyphs at the
document's own strength while everything else in the word is drawn back at a
reduced opacity (`core/svg/bionic.ts`). How far back is a setting - the
`bionicDim` render option, `0..1`, with `BIONIC_DIM` (a half) as the default and
`BIONIC_MIN_DIM` as the floor - because how much of a word to hold is a matter of
taste and of eyesight; the demo offers 30% to 70% and stars the value in force.
`renderDocument(source, { bionic: true, bionicDim: 0.4 })` does the same thing
headlessly, and an exported SVG carries it.

**Faded, not bold** - and that is the part worth reading. The fonts here are
rebuilt from the page's own outlines and have one weight, so `font-weight: bold`
is the browser's synthetic emboldening: it smears the letterforms of a text face
badly, and because every character keeps the position the PDF gave it, the
emboldened letter is drawn wider *into* the letter after it, so a fixation point
looks both blobby and cramped. An opacity costs nothing, works on text of any
colour (it is not a grey - it is the page's own ink, thinned), and leaves the
glyphs exactly as they were.

It is a text-level effect rather than a word-level one: anything `text-vide` finds
no word in - a bare number, a formula, a run of symbols - is faded like a word's
tail, so a page of prose reads as intended and a table reads as uniformly light.
Whitespace between two words is never faded: the attribute would draw no pixel.

A word is counted in *letters*, not in glyphs. `fi` is one glyph in most text
faces and two letters to a reader, and the letters are what the fixation point is
made of, so a ligature is spelled out before the words are looked for and the
marks are read back onto the glyphs afterwards. A glyph the fixation point
reaches into is marked whole - it is a single outline and cannot be drawn half
dark - which is why `find` marks `fin` and not the `n` alone.

It changes how the text is **drawn** and nothing else. Every character carries its
own x and y, and the fade is an attribute of the character's own `<tspan>`: the
words do not reflow, the pages do not change size, and nothing has to be measured
again. Toggling it re-renders what is on screen; the text, the selection and the
position of every character are identical either way. The demo test checks that
down to the ink: the same page, the same edges, less of it dark.

#### Spaces, and why a copy works

An outline SVG has no spaces in it. MuPDF draws a glyph by referencing its
outline, and a space has no outline to reference, so it draws nothing at all -
and what comes out is `Providedproperattributionisprovided`. That is what a
reader copies, and bionic reading can find no word boundary in it either.

So the spaces are written back (`src/core/svg/spaces.ts`). The text device
reports every character it read, spaces included, with the origin it starts at;
a space has no ink, so putting the character back cannot change what the page
looks like. Two details are what make it exact rather than approximate:

* **A space is anchored to the character after it**, which starts where the space
  ended. The space is then written at that character's origin, so it stays inside
  the line of the glyph it belongs to - which matters, because a cropped page
  measures its lines and a box that hangs below one looks like a sliced line.
  Anchoring to a *point* rather than to a bounding box is also what keeps it
  right for rotated text.
* **A line break is a space too.** The device ends a line instead of writing a
  character, so two lines of the same run would otherwise read as one word
  (`permission toreproduce`). It is written back only where the break is what
  separates the two words: a line that already ends, or whose successor already
  starts, with a space is separated once.

A space the page *does* draw - some fonts give one an outline - is left to the
glyph that already carries it, and trailing whitespace has nothing to sit in
front of, so neither is written twice. The exception is a drawn space whose glyph
cannot become text: figures set in Type 3 fonts draw their spaces with a glyph
that has no outline to rebuild, and the character is then nowhere in the SVG, so
its space is written back like any other. This is on in every render, and costs
about 4 ms a page.

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
  toggle (no layout involved) and **closes whatever was open** - the outline and
  the zoom dropdown. Closing matters as much as hiding: a panel left open still
  scrolls its own items into view when the page changes, and a magnified browser
  answers that by scrolling the *visual viewport* to reveal it, which drags the
  reader's view sideways - the pinch test measures 657 px the moment the current
  page changes, with `visualViewport.offsetLeft` snapping from 657 to 0. A host
  that keeps its panels open must scroll them by hand, as the demo's
  `scrollIntoPanel` does, and never let `scrollIntoView` walk out of the panel it
  was aimed at.

The same event carries `layoutScale`, `mode` and `pageScale`, so a zoom control
can show the level the *layout* is at without re-deriving it from the effective
zoom - the browser's page scale is not a layout zoom and is not settable from
script.

Measured in this repository's Chromium (1440x900, three real LaTeX pages, a
viewport's worth of pages rendered either side of the viewport):

| gesture | layout | layout ms | frames p50/p95 |
|---|---|---|---|
| touch pinch, page scale 1 -> 10 | 8 trivial | **0.0** | 16.7 / 16.7 |
| pinch + chained pan + virtualisation | 29 | 10 | 16.7 / 16.7 |
| browser zoom (device pixel ratio 1 -> 1.5) | 0 | **0.0** | - |
| Ctrl+= (one ladder step, re-layout) | 3 | 30-90 | - |
| scrolling across a page boundary | 0 | **0.0** | 16.7 / 17.4 |
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

* **Opening a document happens on the card, not on the bar.** With no document
  open there is nothing for the bar to hold, so it is not there: the empty card
  offers the file picker and a dropdown of the example papers. Every example is a
  public URL - the first is *Attention Is All You Need* on arXiv, a pdfTeX paper
  whose Type 1 fonts are exactly the case this library exists for - so a published
  page carries no PDFs at all: the browser downloads one from whoever hosts it
  (arXiv serves it with `access-control-allow-origin: *`, so no proxy of ours sits
  in the middle) and opens it like any other file. On a local dev or preview
  server the papers the tests have cached are *also* offered, from
  `/pdf/<name>`; a build has no cache behind it, so the published site lists the
  public URLs and nothing else. Once a document is open the card is gone, and
  another file arrives by drag and drop over the pages or by Ctrl+O - the bar
  itself never carries a way to open one.
* **One bar, one line, no status bar.** The bar is the document's chrome and it
  arrives with the first page; it stays a single row at every window width, and
  what gives way to keep it there is the find box: below 560px the page count and
  the match count go, and below 460px the magnifier and the two match arrows go
  with them - a query nobody can see is worse than a control without an icon, and
  Enter still steps the matches. The rest of the controls are marks rather than
  words, and keep the size they were drawn at. Messages float in a toast instead
  of a status bar, and the last render's cost is not shown at all, so the pages
  own every pixel below the bar and there is no chrome pretending to stay put
  while the browser magnifies the document.
* **The tab names the document**: its own title if it declares one, else the
  file's name, else the URL it came from with the scheme taken off
  (`arxiv.org/pdf/1706.03762v7`). The page carries an icon - a page whose lines
  are held at the front and faded behind, which is the effect this reader is
  built around - as an SVG with a PNG beside it for the crawlers that will not
  take one.
* **The zoom box holds a bare number.** `%` is the control's unit and nobody types
  it; the levels - including the fit modes, listed as the percentage they resolve
  to (`229% (fit width)`) - live in the dropdown, which is the only zoom control
  on the bar, and Ctrl +/- steps that same ladder with the box left free for
  typing `150` or `1.5`. A document opens one rung *below* fit-width (200% at the
  sizes above): fit-width is the widest level that still shows the page in full,
  and starting there leaves the paper touching both edges of the window. Ctrl+0
  still means fit width.
* **The outline floats** over the pages rather than taking a column. A column
  would change the viewer's width every time it opened, and a fit-width layout
  would re-fit - visibly re-zooming the document - for a navigation panel. It
  starts closed - the pages are what the page is for - marks the entry for the
  page a document opens on, follows the current page by scrolling its own list
  and nothing else, and is put away the moment the reader scrolls the pages or
  the browser magnifies them, when there is nothing on screen to read.
* **Search behaves like the browser's find bar.** Typing boxes every match on the
  pages in front of you and jumps straight to the first one - no Enter needed -
  while the background index fills in from page one, so the count and the boxes
  settle as the rest of the document is read. `Enter` / `Shift+Enter` (and the
  arrows) walk the matches from there, `Esc` clears them. The viewer only keeps
  the pages near the viewport, so any page that is not on screen is rendered once
  and kept as text. A hit is painted as a `<rect>` measured from a `Range` over
  the matched characters and mapped back through the page's own matrix, so it
  lands on the word - and the page's markup is never restyled.
* **Search ignores whitespace on both sides.** The pages do carry real spaces
  (`Attention Is All You Need`), but a match has to survive a line break, which is
  where the browser's own find bar gives up: both the page and the query are
  lower-cased with the whitespace removed, so `encoder and decoder` finds the two
  words across a line and `AttentionIsAllYouNeed` finds them without the spaces.
  The offsets are mapped back for the boxes, so the highlight still lands on the
  characters that matched.
* **Cropping is opt-in, and never edits the page.** The *Crop* dropdown, after the
  search box, lists the marks PaperCutter removes from a page before it measures
  what is left: the arXiv stamp, a publisher's header, a bare page number, a
  numbered heading, `PRIME AI paper`, and the document's own running title. The
  **Page number** row is starred - it is the mark nearly every paper needs - but
  a star is a recommendation and not a state: the pages are shown whole until a
  rule is switched on, and nothing is ever cropped on the document's behalf. One
  bulk button is offered at a time, and it says what is left to do: *Enable all*
  (what the reference script does) until every rule that applies is checked, and
  *Disable all* from there, which puts the pages back. Each row carries the test
  it runs, so what a rule removes is never a guess. A **Padding** field above the
  list keeps a margin around what is left, in points, from 0 (the reference
  script's own crop) to two inches; it starts at 6pt, which is a hair of white
  between the ink and the edge rather than a box drawn on it.
* **Bionic reading is a dropdown, after the crop control, and it is one choice.**
  `B` opens a menu of values: *Off*, or a fade at 30% to 70% of the document's own
  strength. Choosing one turns the mode on with the faded part of every word at
  that opacity, and the value in force carries a star, so the menu opens on the
  setting the reader settled on. Nothing is emboldened: each word's remainder is
  drawn at that one opacity, which the demo test checks along with every character
  in every run keeping the exact position it had. The two modes on the bar light
  up the same way - an accent background while they are changing how a page is
  drawn - and neither counts anything on its face.
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

`crop: ['arxiv', 'page-number']` trims each page to its content as it is
exported, changing only the root `viewBox` - the file still contains the whole
page, the way a PDF with a crop box does. `bionic: true` fades the words' tails on
the way out, and the spaces are written back either way.

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
`close` - plus `measureCrop`, without which a viewer simply does not crop.

---

## Layout

```
src/
  api.ts                    createViewer, renderDocument, public types
  core/
    engine.ts               MuPDF document + page rendering (DOM-free)
    crop.ts                 PaperCutter's rules, and the box they leave
    debug.ts                opt-in pipeline tracing
    links.ts                link annotations → data, and → SVG hit areas
    svg/
      glyphs.ts             scanner for MuPDF's SVG (outlines + <use>)
      text-upgrade.ts       <use> runs → <text> runs, with spaces and fading
      spaces.ts             where the spaces the outline device cannot draw go
      ligatures.ts          the letters behind the one glyph a font draws for two
      bionic.ts             text-vide's fixation points, and how they are drawn
      package.ts            id namespacing, root rewriting, font embedding
    font/
      svg-path.ts           SVG path data parser (M/L/H/V/C/Z + implicit repeats)
      quadratic.ts          cubic → quadratic conversion
      build.ts              outlines + cmap → TrueType
      woff.ts               TrueType → WOFF (zlib via CompressionStream)
      registry.ts           per-page planning, caching, @font-face rules
  worker/
    pdf.worker.ts           engine host; installs onmessage before awaiting wasm
    client.ts               WorkerEngine: a PdfEngineLike that proxies to it,
                            handing out each face once
  viewer/
    layout.ts               page geometry + visible-range maths
    viewer.ts               virtualised scrolling viewer (browser-owned pinch):
                            a window wider than the viewport, pages inserted at
                            a quiet moment, pages prepared ahead
demo/                       the demo application
  main.ts                   the bar, the card, and everything wired to them
  papers.mjs                the corpus: public URLs, and where they are cached
  papers-client.ts          which of them this page has a local copy of
  examples.ts               the picker's entries, cached copies first
  menu.ts                   a dropdown in the bar: open, close, arrows, Escape
  search.ts                 indexing the document, and boxing what matches
  crop.ts                   the crop dropdown: one toggle per rule
  zoom.ts                   the ladder, and what the box will accept
  panels.ts                 scrolling a panel without moving the document
  styles.css                the chrome's own stylesheet
  icon.svg, icon.png        the site icon: a page, held at the front and faded
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
demo's example list on a local origin. Nothing needs a document to be checked in,
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
  nothing), and what a face costs is not how many of them there are: registering
  *any* face makes the browser lay out every text run in the document again, so
  one rule costs what twenty cost, and re-registering a face the document
  already has costs just as much as a new one. Sharing a face between the pages
  that use the same font is possible - glyph outlines are in em units, so the
  same glyph is byte-identical on every page, and a page's font can be matched
  to a document-level face by the glyphs they have in common (measured on a
  figure-heavy paper: 70 per-page subsets become 28 shared faces over eight
  pages). It does not remove the cost, though, because a face cannot grow: every
  page that brings a glyph the face does not have yet needs another rule. So the
  count is not what hurts - *when* the rule arrives is, and that is what the
  viewer's quiet-moment registration and preparation ahead are for. Sharing
  remains worth doing for memory, not for smoothness.
* **A page can be blank for a moment when scrolling fast into unread
  territory.** A page that has not been rendered yet cannot be shown, and a
  reader who outruns the renderer sees the empty white box until it lands. The
  window and the preparation ahead are sized so that this needs a flick of a
  whole screen or more, and the page being looked at is always rendered first.
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
  whatever the PDF says; the SVG carries positioned runs, not flowing text. The
  spaces are written back (see [Spaces](#spaces-and-why-a-copy-works)), but a
  run still ends where the document's own line does, so a word hyphenated across
  a line break arrives as `trans-` and `formation` on either side of the space
  the break stands for - which is what a PDF's own copy gives you too.
* **A ligature is one glyph, so it is one character.** Where a document draws
  `fi` as a single glyph, the text carries the ligature's own Unicode character
  (`U+FB01`) rather than the two letters, because one glyph can only be one
  character. Everything that normalises text spells it back into `fi`, but a
  plain substring search for `efficient` - in a program that neither normalises
  nor compares the way the browsers' find-in-page does - will not match the
  copied text. A ligature Unicode has no character for (`fj`, say) gets a
  private-use code point instead, which renders correctly and reads as nothing.
* **Bionic reading fades rather than emboldens.** A fixation point is the
  document's own ink at full strength and the rest of the word is half faded; a
  reader who expects the fixation points to be *bolder* (as the original Bionic
  Reading does it) will find the contrast comes from the other side. Bolding is
  not available as an option because these fonts have one weight, and synthetic
  bold on a text face looks worse than no bold at all.
* **Cropping reads every page to lay the document out.** A crop changes each
  page's height, so the scroll height is only correct once every box is known:
  switching a rule on measures the whole document in the background (about 5 ms
  a page - a second or two for a 756-page specification, a few hundred
  milliseconds for a paper, and free the second time). Applying it page by page
  as the reader scrolls would be faster and would make the scrollbar jump.
* **A crop hides text without removing it.** A search match inside a cropped-away
  margin - a page number, say - is still found and still boxed, but the box is
  outside the window the page is showing, so jumping to it shows nothing. Removing
  the marks instead would break every coordinate the SVG shares with the page.
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
