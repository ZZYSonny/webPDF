/**
 * Link annotations: what a PDF's links point at, and the SVG hit areas that make
 * them clickable.
 *
 * A PDF link is an invisible rectangle over the page content, so a viewer has to
 * supply both the target and the affordance. MuPDF gives the target
 * (`page.getLinks()`, one entry per link annotation); this module turns it into
 *
 *  - `PageLink` values, which are plain data and cross the worker boundary
 *    unchanged, and
 *  - one `<a>` per link, holding a transparent `<rect>`, appended to the page's
 *    SVG by `injectSvgLinks`.
 *
 * The hit areas live *inside the SVG* rather than in an overlay element, so they
 * scale with the page at any zoom without anyone re-measuring anything, they
 * survive `exportSvg`, and a downloaded SVG carries its links.
 *
 * A PDF is untrusted input, so an `href` - which is an instruction to the
 * browser to navigate - is written only for the schemes in `isOpenableUri`.
 * Everything else is still reported, still gets a hit area, and is left for the
 * host to deal with.
 *
 * Geometry is in MuPDF's page space: points, origin at the page's top-left. That
 * is also the SVG's user space, because `page.getBounds()` is normalised to the
 * origin and the SVG writer puts it in the `viewBox` verbatim - so no rect is
 * ever transformed here.
 */

/** A rectangle in page coordinates: `[x0, y0, x1, y1]`, points, top-left origin. */
export type LinkRect = [number, number, number, number];

interface PageLinkBase {
  /** The link annotation's rectangle, in the page's own coordinates. */
  rect: LinkRect;
}

/** A link to somewhere else in the same document. */
export interface InternalLink extends PageLinkBase {
  kind: 'internal';
  /** 1-based destination page, or -1 when the destination cannot be resolved. */
  page: number;
  /** Destination point in points from the target page's top-left, when the PDF gives one. */
  x: number | null;
  y: number | null;
}

/** A link out of the document. */
export interface ExternalLink extends PageLinkBase {
  kind: 'external';
  /** The URI exactly as the PDF stores it. Not necessarily safe to navigate to. */
  uri: string;
}

export type PageLink = InternalLink | ExternalLink;

/**
 * Schemes a browser will actually follow.
 *
 * `javascript:`, `data:`, `vbscript:` and `file:` are not on the list, and
 * neither is a relative path - a PDF has no base URL, so there is nothing to
 * resolve one against.
 */
const OPENABLE_URI = /^(?:https?|mailto|tel):\S/i;

/** Whether `uri` may be handed to the browser as an `href`. */
export function isOpenableUri(uri: string): boolean {
  return OPENABLE_URI.test(uri);
}

/** The target of a hit area, as read back out of the DOM. */
export type LinkTarget =
  | { kind: 'internal'; page: number; y: number | null }
  | { kind: 'external'; uri: string; openable: boolean };

/**
 * Read a link target out of one of the anchors `svgLinks` wrote. Returns null
 * for any other element, including the `<rect>` inside the anchor - pass the
 * element the click landed on and let this walk up.
 */
export function linkTargetOf(el: Element | null): LinkTarget | null {
  const anchor = el?.closest?.('a[data-wpdf-link]');
  if (!anchor) return null;
  const kind = anchor.getAttribute('data-wpdf-link');
  if (kind === 'internal') {
    const page = Number.parseInt(anchor.getAttribute('data-wpdf-page') ?? '', 10);
    if (!Number.isFinite(page)) return null;
    const raw = anchor.getAttribute('data-wpdf-y');
    const y = raw === null ? null : Number.parseFloat(raw);
    return { kind: 'internal', page, y: y !== null && Number.isFinite(y) ? y : null };
  }
  if (kind === 'external') {
    return {
      kind: 'external',
      uri: anchor.getAttribute('data-wpdf-uri') ?? '',
      // The `href` is written only for a scheme the browser will follow, so its
      // presence *is* the answer - no second copy of the policy to drift.
      openable: anchor.hasAttribute('href'),
    };
  }
  return null;
}

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Make a string safe to put inside a double-quoted XML attribute.
 *
 * Escaping the five entities is not enough: XML 1.0 has no representation at all
 * - not even as a numeric reference - for C0 control characters and lone
 * surrogates, and one of those in a link URI would make the whole SVG
 * unparseable. They are dropped instead.
 */
function xmlAttr(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20) {
      if (cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) continue;
    } else if (cp === 0x7f || cp === 0xfffe || cp === 0xffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      continue;
    }
    out += XML_ESCAPE[ch] ?? ch;
  }
  return out;
}

/** Two decimals is well under a device pixel even at 400%, and half the bytes. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export interface SvgLinkOptions {
  /**
   * `target` for links that navigate. The default keeps an embedded viewer from
   * being replaced by whatever the document links to.
   */
  target?: string;
}

/**
 * The `<a>` + transparent `<rect>` markup for a page's links, or `''` when none
 * of them can be clicked.
 *
 * A link with a degenerate rectangle has nothing to click and a link whose
 * destination could not be resolved has nowhere to go; both were reported in
 * `PageLink[]` and both are skipped here.
 *
 * The rectangles are transparent rather than `fill="none"`: an unpainted shape
 * is not a hit-test target at all, and the whole point is to be clicked.
 */
export function svgLinks(links: readonly PageLink[], opts: SvgLinkOptions = {}): string {
  const target = opts.target ?? '_blank';
  const parts: string[] = [];
  for (const link of links) {
    const [x0, y0, x1, y1] = link.rect;
    if (!(x1 > x0) || !(y1 > y0)) continue;
    if (link.kind === 'internal' && link.page < 1) continue;

    const attrs = ['class="wpdf-link"', `data-wpdf-link="${link.kind}"`];
    if (link.kind === 'internal') {
      attrs.push(`data-wpdf-page="${link.page}"`, `title="Page ${link.page}"`);
      if (link.y !== null) attrs.push(`data-wpdf-y="${num(link.y)}"`);
    } else {
      const uri = xmlAttr(link.uri);
      attrs.push(`data-wpdf-uri="${uri}"`, `title="${uri}"`);
      if (isOpenableUri(link.uri)) {
        attrs.push(`href="${uri}"`, `target="${xmlAttr(target)}"`, 'rel="noopener noreferrer"');
      }
    }
    // Focusable so the hit areas are reachable without a mouse; the viewer wires
    // Enter and Space to the same jump a click makes.
    attrs.push('tabindex="0"');

    const rect = `<rect x="${num(x0)}" y="${num(y0)}" width="${num(x1 - x0)}" height="${num(y1 - y0)}"/>`;
    parts.push(`<a ${attrs.join(' ')}>${rect}</a>`);
  }
  return parts.length ? `<g class="wpdf-links" fill="transparent">${parts.join('')}</g>` : '';
}

/** Append link hit areas to a rendered page, just before its closing tag. */
export function injectSvgLinks(svg: string, links: readonly PageLink[], opts: SvgLinkOptions = {}): string {
  const markup = svgLinks(links, opts);
  if (!markup) return svg;
  const close = svg.lastIndexOf('</svg>');
  return close < 0 ? svg : svg.slice(0, close) + markup + svg.slice(close);
}
