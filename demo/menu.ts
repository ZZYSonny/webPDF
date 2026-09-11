/**
 * A dropdown in the bar.
 *
 * The bar has several of them - the zoom levels, the example papers, bionic
 * reading's fade - and they all behave the same way: one at a time, arrow keys
 * to walk the rows, Enter to take the highlighted one, Escape or a click
 * anywhere else to leave. That behaviour lives here rather than three times
 * over in `main.ts`.
 *
 * What is *in* a menu is the caller's business: the rows are rebuilt through
 * `prepare()` every time it opens, so a menu whose contents depend on the
 * document (or on the current value, which is starred) is never stale. The
 * highlight is a class of the menu's own, and focus stays where the reader left
 * it - on the control that opened the menu - which is what makes typing in the
 * zoom box and pressing ArrowDown work without a trip through the tab order.
 *
 * Rows are real `<button role="option">` elements, so a click, Enter and Space
 * all work without any help; `aria-selected` is what says which value is in
 * force, and the caller sets it while building the rows.
 */

import { scrollIntoPanel } from './panels.ts';

export interface MenuOptions {
  /** The controls that open it. Their `aria-expanded` follows the menu. */
  anchors: readonly HTMLElement[];
  /** The dropdown itself: the element holding the rows. */
  menu: HTMLElement;
  /** The rows, in the order the arrow keys walk them. */
  items: () => HTMLElement[];
  /** Rebuild or refresh the rows, before the menu is shown. */
  prepare?: () => void;
}

export interface Menu {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** Move the highlight by `delta`, opening the menu first if it is closed. */
  move(delta: number): void;
  /** The row the highlight is on, if the menu has any. */
  current(): HTMLElement | null;
}

export function createMenu(opts: MenuOptions): Menu {
  const { anchors, menu } = opts;
  let cursor = 0;

  const rows = (): HTMLElement[] => opts.items();

  function highlight(): void {
    const list = rows();
    cursor = Math.min(Math.max(0, cursor), Math.max(0, list.length - 1));
    list.forEach((row, index) => row.classList.toggle('active', index === cursor));
  }

  function open(): void {
    opts.prepare?.();
    menu.hidden = false;
    for (const anchor of anchors) anchor.setAttribute('aria-expanded', 'true');
    // Start on the value in force - the starred row - rather than at the top.
    const list = rows();
    const selected = list.findIndex((row) => row.getAttribute('aria-selected') === 'true');
    cursor = selected >= 0 ? selected : 0;
    highlight();
    const row = list[cursor];
    if (row) scrollIntoPanel(row, menu);
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    for (const anchor of anchors) anchor.setAttribute('aria-expanded', 'false');
  }

  function move(delta: number): void {
    if (menu.hidden) {
      open();
      if (delta < 0) cursor = Math.max(0, rows().length - 1);
      highlight();
      return;
    }
    cursor += delta;
    highlight();
    const row = rows()[cursor];
    if (row) scrollIntoPanel(row, menu);
  }

  function toggle(): void {
    if (menu.hidden) open();
    else close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && !menu.hidden) {
      // The highlighted row is a button; pressing it is what choosing means.
      const row = rows()[cursor];
      if (row) {
        event.preventDefault();
        row.click();
      }
    } else if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      close();
    }
  }

  // A click anywhere else closes it. Captured on the document, because the
  // click may land on a control that opens a different menu - that one opens
  // as this one closes, so only one dropdown is ever in the air.
  const onPointerDown = (event: Event): void => {
    if (menu.hidden) return;
    const target = event.target as Element | null;
    if (anchors.some((anchor) => anchor.contains(target))) return;
    if (menu.contains(target)) return;
    close();
  };

  for (const anchor of anchors) {
    anchor.addEventListener('click', () => toggle());
    anchor.addEventListener('keydown', onKeyDown);
  }
  document.addEventListener('pointerdown', onPointerDown);

  for (const anchor of anchors) anchor.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onPointerDown);

  return {
    open,
    close,
    toggle,
    get isOpen(): boolean {
      return !menu.hidden;
    },
    move,
    current(): HTMLElement | null {
      return rows()[cursor] ?? null;
    },
  };
}
