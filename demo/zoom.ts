/**
 * The zoom box's value logic, kept pure (and separate from the DOM) because it is
 * the one part of the toolbar with real rules to get wrong.
 *
 * The editable text is a bare number: the percent sign is part of the control,
 * not something anyone types, and the fit modes live in the dropdown rather than
 * in the bar. `PdfViewer.zoom` is what the box shows; whatever the user types
 * here goes back to `setZoom`.
 */

import type { ZoomMode } from './layout.ts';

/** Everything `PdfViewer.setZoom` accepts, which is also what the ladder holds. */
export type ZoomLevel = number | 'fit-width' | 'fit-page';

export interface ZoomOption {
  level: ZoomLevel;
  label: string;
}

/** The number the box shows. Percent is the unit, and it is not typed. */
export function zoomPercent(scale: number): number {
  return Math.round(scale * 100);
}

/**
 * Every rung of the viewer's ladder, ready to render. A fit mode is listed by
 * what it resolves to *right now* - `229% (fit width)` - because the dropdown is
 * the only place the fit modes are named; the box itself stays a plain number.
 *
 * `resolve` is `PdfViewer.resolveZoom`, which is what makes the percentages track
 * the window: "fit width" is a different number in every container.
 */
export function zoomLevels(steps: readonly ZoomLevel[], resolve: (level: ZoomLevel) => number): ZoomOption[] {
  const seen = new Set<string>();
  const out: ZoomOption[] = [];
  for (const level of steps) {
    const percent = zoomPercent(resolve(level));
    const label =
      level === 'fit-width' ? `${percent}% (fit width)` : level === 'fit-page' ? `${percent}% (fit page)` : String(percent);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ level, label });
  }
  return out;
}

/**
 * Is this rung where the viewer is now? A fit rung is current when that is the
 * mode, a numeric one when the scale is a factor that matches it - a fit mode
 * that happens to resolve to 200% is not the same thing as choosing 200%.
 */
export function isCurrentLevel(level: ZoomLevel, scale: number, mode: ZoomMode): boolean {
  if (typeof level === 'number') return mode === 'custom' && Math.abs(scale - level) < 1e-3;
  return mode === level;
}

/**
 * Parse a typed level: a percentage number (`150`), a ratio (`1.5`, `2x`), or a
 * fit mode by name (`fit width`, `page`). A trailing `%` is tolerated but never
 * needed - as is a whole dropdown label, so `229% (fit width)` parses too.
 * Returns null when the text means nothing, so the caller can put the previous
 * value back.
 *
 * A bare number below 12 is read as a ratio, because that is the range ratios
 * live in and `1.5` is a far more natural way to ask for 150% than `1.5%` is to
 * ask for one and a half percent.
 */
export function parseZoomInput(raw: string): ZoomLevel | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (/width/.test(text)) return 'fit-width';
  if (/page/.test(text) || /^(fit|auto|full|whole)$/.test(text)) return 'fit-page';
  const match = /^([0-9]*\.?[0-9]+)\s*(%|x|×)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2];
  if (unit === '%') return value / 100;
  if (unit === 'x' || unit === '×') return value;
  return (value >= 12 ? value : value * 100) / 100;
}
