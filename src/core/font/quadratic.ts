/**
 * Cubic -> quadratic Bezier conversion.
 *
 * MuPDF hands us glyph outlines as cubic Beziers (FreeType converts TrueType
 * conics to cubics), but the compact `glyf` table we emit only stores
 * quadratics. A quadratic approximates a cubic extremely well at font-unit
 * precision, so we subdivide adaptively until the error is below a fraction of
 * a font unit.
 */

import type { PathCommand } from './svg-path.ts';

export interface QuadSink {
  quad(x1: number, y1: number, x: number, y: number): void;
  line(x: number, y: number): void;
}

const MAX_DEPTH = 8;

/** Distance between the cubic and the best single-quadratic approximation. */
function quadError(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  qx: number, qy: number,
): number {
  // Cubic evaluated at t = 1/2 (exact) versus the quadratic at t = 1/2.
  const cx = (x0 + 3 * x1 + 3 * x2 + x3) / 8;
  const cy = (y0 + 3 * y1 + 3 * y2 + y3) / 8;
  const px = (x0 + 2 * qx + x3) / 4;
  const py = (y0 + 2 * qy + y3) / 4;
  return Math.hypot(cx - px, cy - py);
}

function emitCubic(
  sink: QuadSink,
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  tolerance: number,
  depth: number,
): void {
  // Degenerate control points: a straight line is both cheaper and exact.
  const cross = (x1 - x0) * (y3 - y0) - (y1 - y0) * (x3 - x0);
  if (Math.abs(cross) < 1e-9 && Math.abs((x2 - x0) * (y3 - y0) - (y2 - y0) * (x3 - x0)) < 1e-9) {
    sink.line(x3, y3);
    return;
  }

  // Least-squares-ish single quadratic control point.
  const qx = (3 * x1 - x0 + 3 * x2 - x3) / 4;
  const qy = (3 * y1 - y0 + 3 * y2 - y3) / 4;

  if (depth >= MAX_DEPTH || quadError(x0, y0, x1, y1, x2, y2, x3, y3, qx, qy) <= tolerance) {
    sink.quad(qx, qy, x3, y3);
    return;
  }

  // de Casteljau split at t = 1/2
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2;
  const x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2;
  const xm = (x012 + x123) / 2, ym = (y012 + y123) / 2;

  emitCubic(sink, x0, y0, x01, y01, x012, y012, xm, ym, tolerance, depth + 1);
  emitCubic(sink, xm, ym, x123, y123, x23, y23, x3, y3, tolerance, depth + 1);
}

/**
 * Re-emit a command list with cubics replaced by quadratics.
 *
 * `tolerance` is expressed in the same units as the input coordinates.
 */
export function cubicsToQuadratics(cmds: readonly PathCommand[], tolerance: number): PathCommand[] {
  const out: PathCommand[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  const sink: QuadSink = {
    quad(x1, y1, ex, ey) {
      out.push({ c: 'Q', x1, y1, x: ex, y: ey });
    },
    line(ex, ey) {
      out.push({ c: 'L', x: ex, y: ey });
    },
  };

  for (const k of cmds) {
    switch (k.c) {
      case 'M':
        out.push(k);
        x = startX = k.x;
        y = startY = k.y;
        break;
      case 'L':
        out.push(k);
        x = k.x;
        y = k.y;
        break;
      case 'Q':
        out.push(k);
        x = k.x;
        y = k.y;
        break;
      case 'C':
        emitCubic(sink, x, y, k.x1, k.y1, k.x2, k.y2, k.x, k.y, tolerance, 0);
        x = k.x;
        y = k.y;
        break;
      case 'Z':
        out.push(k);
        x = startX;
        y = startY;
        break;
    }
  }
  return out;
}
