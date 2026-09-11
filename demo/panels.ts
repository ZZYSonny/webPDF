/**
 * Scrolling inside a panel, and nothing else.
 *
 * Chrome that floats over the pages - the outline, a dropdown in the sticky bar
 * - is not part of the document's scrollable area in any useful sense, but
 * `Element.scrollIntoView` does not know that: it walks the entire ancestor
 * chain and ends at the document viewport. As soon as the browser is magnified
 * and the visual viewport has been panned over the pages, a `position: fixed`
 * or sticky panel counts as off screen, and "bring this into view" makes the
 * browser drag the magnified view sideways - measured at 657 px, the moment a
 * page changed with the outline open.
 *
 * So a panel scrolls itself, here, and the document stays exactly where the
 * reader put it.
 */

/**
 * Bring an element into view *inside the panel that scrolls it*. The behaviour
 * is `block: 'nearest'`, the only mode any caller wants.
 */
export function scrollIntoPanel(el: HTMLElement, panel: HTMLElement): void {
  const item = el.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  // A scrollport is the padding box, which is what `block: 'nearest'` measures
  // against: `clientTop` is the border, `clientHeight` the padding box height.
  const top = box.top + panel.clientTop;
  const bottom = top + panel.clientHeight;
  if (item.top < top) panel.scrollTop -= top - item.top;
  else if (item.bottom > bottom) panel.scrollTop += item.bottom - bottom;
}
