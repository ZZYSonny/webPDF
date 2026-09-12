/**
 * Link hit areas: reading a click back out of the DOM.
 *
 * The hit areas themselves are written by the core (`core/src/links.rs`), inside
 * the page's SVG, so they scale with the page at any zoom and a downloaded SVG
 * carries its links. What the *host* has to answer is the other half of the
 * question: which link did a click land on, and is its target something a
 * browser may be sent to.
 *
 * Nothing here trusts the document. A PDF is untrusted input, and the document
 * writes both the target and the text on the hit area; the only thing that
 * decides whether an `href` is followed is the scheme, and the presence of an
 * `href` in the markup *is* that answer - no second copy of the policy to drift.
 */

import type { LinkTarget } from './types.ts';

export type { LinkTarget };

/** Whether `uri` may be handed to the browser as an `href`. */
export function isOpenableUri(uri: string): boolean {
  return /^(?:https?|mailto|tel):\S/i.test(uri);
}

/**
 * Read a link target out of one of the anchors the core wrote. Returns null for
 * any other element, including the `<rect>` inside the anchor - pass the element
 * the click landed on and let this walk up.
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
      // The `href` is written only for a scheme the browser will follow.
      openable: anchor.hasAttribute('href'),
    };
  }
  return null;
}
