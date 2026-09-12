/**
 * Page geometry for a continuously scrolling viewer.
 *
 * The entire scroll height is derived up front from the page sizes, so the
 * scrollbar is correct from the first frame and page slots can be positioned
 * absolutely - no reflow, no measuring, no layout thrash while scrolling.
 */

export interface PageGeometry {
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Gap between pages, in CSS pixels at scale 1. */
  gap?: number;
  /** Padding around the page column, in CSS pixels at scale 1. */
  padding?: number;
  /** Zoom factor. */
  scale?: number;
  /** 1 = single column, 2 = facing pages. */
  columns?: 1 | 2;
  /** Show the first page on its own (book-like). */
  firstPageAlone?: boolean;
}

export interface PageBox {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  start: number;
  end: number;
}

export class PageLayout {
  readonly boxes: PageBox[] = [];
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  private readonly opt: Required<LayoutOptions>;
  private readonly rowTops: number[] = [];
  private readonly rowBottoms: number[] = [];

  constructor(pages: readonly PageGeometry[], opts: LayoutOptions = {}) {
    this.opt = {
      gap: opts.gap ?? 14,
      padding: opts.padding ?? 16,
      scale: opts.scale ?? 1,
      columns: opts.columns ?? 1,
      firstPageAlone: opts.firstPageAlone ?? false,
    };
    const { gap, padding, scale, columns, firstPageAlone } = this.opt;
    this.scale = scale;

    const maxWidth = pages.reduce((m, p) => Math.max(m, p.width), 0) * scale;
    this.width = maxWidth + padding * 2;

    let y = padding;
    let i = 0;
    while (i < pages.length) {
      const rowStart = i;
      const taken = firstPageAlone && i === 0 ? 1 : columns;
      const row = pages.slice(i, i + taken);
      const rowHeight = row.reduce((m, p) => Math.max(m, p.height), 0) * scale;

      // Centre the pages of this row in the column.
      const naturalWidths = row.reduce((a, p) => a + p.width * scale, 0) + gap * (row.length - 1);
      let x = padding + Math.max(0, (maxWidth - naturalWidths) / 2);

      for (let c = 0; c < row.length; c++) {
        const p = row[c];
        const w = p.width * scale;
        const h = p.height * scale;
        this.boxes.push({
          index: i,
          left: x,
          top: y + (rowHeight - h) / 2, // vertically centre shorter pages in a spread
          width: w,
          height: h,
        });
        x += w + gap;
        i++;
      }
      this.rowTops[rowStart] = y;
      this.rowBottoms[rowStart] = y + rowHeight;
      y += rowHeight + gap;
    }
    this.height = Math.max(y - gap + padding, padding * 2);
  }

  /**
   * Pages intersecting the viewport, widened by `overscan` pixels.
   *
   * Purely a scan over the precomputed boxes, so it stays cheap for very large
   * documents.
   */
  visibleRange(scrollTop: number, viewportHeight: number, overscan = 0): Viewport {
    const top = scrollTop - overscan;
    const bottom = scrollTop + viewportHeight + overscan;
    let start = -1;
    let end = -1;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.top + b.height >= top && b.top <= bottom) {
        if (start < 0) start = i;
        end = i;
      } else if (start >= 0 && b.top > bottom) {
        break;
      }
    }
    if (start < 0) {
      // Between pages, or beyond the end: fall back to the nearest page.
      const nearest = this.nearestPage(scrollTop + viewportHeight / 2);
      return { start: nearest, end: nearest };
    }
    return { start, end };
  }

  /** Index of the page whose box contains (or is closest to) a vertical offset. */
  nearestPage(y: number): number {
    if (this.boxes.length === 0) return 0;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const d = y < b.top ? b.top - y : y > b.top + b.height ? y - (b.top + b.height) : 0;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
      if (b.top > y && bestDistance > 0) break;
    }
    return best;
  }

  /** The page that should be considered "current" for a given scroll offset. */
  currentPage(scrollTop: number, viewportHeight: number): number {
    return this.nearestPage(scrollTop + Math.min(viewportHeight * 0.3, 200));
  }

  /** Scroll offset that brings a page to the top of the viewport. */
  offsetOf(index: number): number {
    const b = this.boxes[Math.max(0, Math.min(index, this.boxes.length - 1))];
    return b ? Math.max(0, b.top - this.opt.padding) : 0;
  }

  /**
   * Scroll offset that brings a point *inside* a page to the top of the viewport
   * - what an internal link's destination asks for. `y` is in page units, and is
   * clamped to the page: a destination outside it is a broken annotation, not an
   * invitation to scroll somewhere else.
   */
  offsetOfPoint(index: number, y: number, scale: number): number {
    const b = this.boxes[Math.max(0, Math.min(index, this.boxes.length - 1))];
    if (!b) return 0;
    if (!Number.isFinite(y) || y <= 0) return b.top;
    return b.top + Math.min(y, b.height / (scale || 1)) * scale;
  }

  /**
   * The other direction: which page, and which point inside it, a scroll offset
   * puts at the top of the viewport. Exactly the inverse of `offsetOfPoint` and
   * `offsetOf` (a y of null is a page top), which is what lets a position be
   * remembered and come back to at a different zoom.
   */
  pointAt(offset: number, scale: number): { index: number; y: number | null } {
    if (this.boxes.length === 0) return { index: 0, y: null };
    let index = 0;
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i].top <= offset + this.opt.padding) index = i;
      else break;
    }
    const b = this.boxes[index];
    const y = (offset - b.top) / (scale || 1);
    return { index, y: y <= 0 ? null : Math.min(y, b.height / (scale || 1)) };
  }
}

export type ZoomMode = 'custom' | 'fit-width' | 'fit-page';

export function computeFitScale(
  pages: readonly PageGeometry[],
  containerWidth: number,
  containerHeight: number,
  opts: LayoutOptions,
  mode: 'fit-width' | 'fit-page',
): number {
  const padding = (opts.padding ?? 16) * 2;
  const gap = opts.gap ?? 14;
  const columns = opts.columns ?? 1;
  const maxWidth = pages.reduce((m, p) => Math.max(m, p.width), 0);
  if (maxWidth <= 0) return 1;
  const usableW = Math.max(50, containerWidth - padding - gap * (columns - 1));
  if (mode === 'fit-width') {
    const perPage = columns > 1 ? usableW / columns : usableW;
    return clamp(perPage / maxWidth, 0.05, 12);
  }
  // fit-page: also make the tallest page fit the viewport height
  const maxHeight = pages.reduce((m, p) => Math.max(m, p.height), 0);
  const usableH = Math.max(50, containerHeight - padding);
  return clamp(Math.min(usableW / (maxWidth * columns), usableH / maxHeight), 0.05, 12);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
