/**
 * The host's half of cropping.
 *
 * The patterns and the box they leave are the core's (`core/src/crop.rs`), and a
 * crop reaches the page as a `viewBox` the core writes. What is left here is the
 * two things a *viewer* needs and the core has no opinion about:
 *
 *  - turning the core's JSON answer into a rectangle, checked rather than
 *    trusted, because it has crossed a wasm boundary; and
 *  - the padding, which is a reader's setting and not a document's, and which
 *    therefore has to be changeable without measuring anything again.
 */

import type { CropPattern, CropRect } from './types.ts';

/** The core's crop answer, as JSON: `{x,y,width,height}` or null. */
export function cropBox(raw: unknown): CropRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const box = raw as Record<string, unknown>;
  const values = [box.x, box.y, box.width, box.height];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  return { x: box.x as number, y: box.y as number, width: box.width as number, height: box.height as number };
}

/**
 * Grow a box by `padding` on every side, stopped by the page.
 *
 * The reference crops to the content exactly, which on a page whose text reaches
 * the trim is a box with no room to breathe - and a crop box cannot be larger
 * than the page it is cutting, so the page is the outer limit.
 */
export function padBox(box: CropRect, padding: number, page?: CropRect): CropRect {
  if (!Number.isFinite(padding) || padding <= 0) return box;
  const x = Math.max(page ? page.x : -Infinity, box.x - padding);
  const y = Math.max(page ? page.y : -Infinity, box.y - padding);
  const right = Math.min(page ? page.x + page.width : Infinity, box.x + box.width + padding);
  const bottom = Math.min(page ? page.y + page.height : Infinity, box.y + box.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The selection a caller asked for: blanks dropped, duplicates collapsed, order
 * kept.
 *
 * `null` and `[]` both mean "crop nothing", which is the state a page opens in.
 * A pattern the core cannot compile is the core's to refuse; this only keeps one
 * selection's cache key the same however it was spelled.
 */
export function normalisePatterns(patterns: readonly CropPattern[] | null | undefined): CropPattern[] {
  if (!patterns || patterns.length === 0) return [];
  const kept: CropPattern[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed !== '' && !kept.includes(trimmed)) kept.push(trimmed);
  }
  return kept;
}
