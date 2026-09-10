/**
 * Minimal, fast parser for the SVG path subset that MuPDF's SVG device emits.
 *
 * MuPDF serialises outlines through `svg_path_walker`, which only ever produces
 * the absolute commands `M`, `L`, `H`, `V`, `C` and `Z`, and *suppresses a
 * command letter when it repeats* (see `svg_path_emit_command`). Implicit
 * repeats therefore have to be handled: `M 0 0 1 1` is a moveto plus a lineto.
 *
 * We deliberately support the full grammar anyway (relative commands included)
 * so that the module stays useful if a different SVG producer is plugged in.
 */

export type PathCommand =
  | { readonly c: 'M'; readonly x: number; readonly y: number }
  | { readonly c: 'L'; readonly x: number; readonly y: number }
  | { readonly c: 'Q'; readonly x1: number; readonly y1: number; readonly x: number; readonly y: number }
  | { readonly c: 'C'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number }
  | { readonly c: 'Z' };

const CH_SPACE = 32;
const CH_COMMA = 44;
const CH_MINUS = 45;
const CH_PLUS = 43;
const CH_DOT = 46;
const CH_ZERO = 48;
const CH_NINE = 57;
const CH_E = 69; // 'E'
const CH_LOWER_E = 101; // 'e'

class Scanner {
  private i = 0;
  private readonly s: string;

  constructor(s: string) {
    this.s = s;
  }

  get offset(): number {
    return this.i;
  }

  atEnd(): boolean {
    return this.i >= this.s.length;
  }

  /** Skip whitespace and commas. Returns false at end of input. */
  skipSeparators(): boolean {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === CH_SPACE || c === 10 || c === 13 || c === 9 || c === 12 || c === CH_COMMA) this.i++;
      else return true;
    }
    return false;
  }

  peek(): number {
    return this.s.charCodeAt(this.i);
  }

  advance(): void {
    this.i++;
  }

  /** Read a number; returns NaN if none is present at the cursor. */
  number(): number {
    // Numbers are separated by whitespace and/or commas; SVG also allows a
    // sign or a leading dot as the start of a number.
    this.skipSeparators();
    const start = this.i;
    const s = this.s;
    if (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === CH_MINUS || c === CH_PLUS) this.i++;
    }
    let seenDigit = false;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c >= CH_ZERO && c <= CH_NINE) {
        this.i++;
        seenDigit = true;
      } else break;
    }
    if (this.i < s.length && s.charCodeAt(this.i) === CH_DOT) {
      this.i++;
      while (this.i < s.length) {
        const c = s.charCodeAt(this.i);
        if (c >= CH_ZERO && c <= CH_NINE) {
          this.i++;
          seenDigit = true;
        } else break;
      }
    }
    if (!seenDigit) {
      this.i = start;
      return NaN;
    }
    if (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === CH_E || c === CH_LOWER_E) {
        // Only consume the exponent when it is well formed.
        const save = this.i;
        this.i++;
        const c2 = this.i < s.length ? s.charCodeAt(this.i) : 0;
        if (c2 === CH_MINUS || c2 === CH_PLUS) this.i++;
        let expDigit = false;
        while (this.i < s.length) {
          const c3 = s.charCodeAt(this.i);
          if (c3 >= CH_ZERO && c3 <= CH_NINE) {
            this.i++;
            expDigit = true;
          } else break;
        }
        if (!expDigit) this.i = save;
      }
    }
    return Number(s.slice(start, this.i));
  }
}

/**
 * Parse SVG path data into absolute commands.
 *
 * Throws on malformed input; callers that must never fail should catch and fall
 * back to leaving the glyph as an outline.
 */
export function parseSvgPath(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  const sc = new Scanner(d);
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let cmd = '';

  while (sc.skipSeparators()) {
    const code = sc.peek();
    // 0x20..0x7a: SVG command letters occupy the alpha range.
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      cmd = String.fromCharCode(code);
      sc.advance();
      if (cmd === 'Z' || cmd === 'z') {
        out.push({ c: 'Z' });
        cx = startX;
        cy = startY;
      }
      continue;
    }
    if (cmd === '') throw new Error('SVG path data does not start with a command');

    const rel = cmd >= 'a' && cmd <= 'z';
    const upper = rel ? cmd.toUpperCase() : cmd;

    switch (upper) {
      case 'M': {
        const x = sc.number();
        const y = sc.number();
        if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('malformed M');
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        startX = cx;
        startY = cy;
        out.push({ c: 'M', x: cx, y: cy });
        // Subsequent coordinate pairs are implicit linetos.
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': {
        const x = sc.number();
        const y = sc.number();
        if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('malformed L');
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        out.push({ c: 'L', x: cx, y: cy });
        break;
      }
      case 'H': {
        const x = sc.number();
        if (Number.isNaN(x)) throw new Error('malformed H');
        cx = rel ? cx + x : x;
        out.push({ c: 'L', x: cx, y: cy });
        break;
      }
      case 'V': {
        const y = sc.number();
        if (Number.isNaN(y)) throw new Error('malformed V');
        cy = rel ? cy + y : y;
        out.push({ c: 'L', x: cx, y: cy });
        break;
      }
      case 'C': {
        const x1 = sc.number();
        const y1 = sc.number();
        const x2 = sc.number();
        const y2 = sc.number();
        const x = sc.number();
        const y = sc.number();
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(x1) || Number.isNaN(y1) || Number.isNaN(x2) || Number.isNaN(y2))
          throw new Error('malformed C');
        const ax1 = rel ? cx + x1 : x1;
        const ay1 = rel ? cy + y1 : y1;
        const ax2 = rel ? cx + x2 : x2;
        const ay2 = rel ? cy + y2 : y2;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        out.push({ c: 'C', x1: ax1, y1: ay1, x2: ax2, y2: ay2, x: cx, y: cy });
        break;
      }
      case 'S': {
        // Reflected cubic: reconstruct the missing first control point.
        const x2 = sc.number();
        const y2 = sc.number();
        const x = sc.number();
        const y = sc.number();
        if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('malformed S');
        const prev = out[out.length - 1];
        const rx = prev && prev.c === 'C' ? 2 * cx - prev.x2 : cx;
        const ry = prev && prev.c === 'C' ? 2 * cy - prev.y2 : cy;
        const ax2 = rel ? cx + x2 : x2;
        const ay2 = rel ? cy + y2 : y2;
        const nx = rel ? cx + x : x;
        const ny = rel ? cy + y : y;
        out.push({ c: 'C', x1: rx, y1: ry, x2: ax2, y2: ay2, x: nx, y: ny });
        cx = nx;
        cy = ny;
        break;
      }
      case 'Q': {
        const x1 = sc.number();
        const y1 = sc.number();
        const x = sc.number();
        const y = sc.number();
        if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('malformed Q');
        const ax1 = rel ? cx + x1 : x1;
        const ay1 = rel ? cy + y1 : y1;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        out.push({ c: 'Q', x1: ax1, y1: ay1, x: cx, y: cy });
        break;
      }
      case 'T': {
        const x = sc.number();
        const y = sc.number();
        if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('malformed T');
        const prev = out[out.length - 1];
        const qx = prev && prev.c === 'Q' ? 2 * cx - prev.x1 : cx;
        const qy = prev && prev.c === 'Q' ? 2 * cy - prev.y1 : cy;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        out.push({ c: 'Q', x1: qx, y1: qy, x: cx, y: cy });
        break;
      }
      default:
        throw new Error(`unsupported SVG path command "${cmd}"`);
    }
  }
  return out;
}

/** Axis-aligned bounding box of a command list. */
export function pathBounds(cmds: readonly PathCommand[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const k of cmds) {
    switch (k.c) {
      case 'M':
      case 'L':
        add(k.x, k.y);
        break;
      case 'Q':
        add(k.x1, k.y1);
        add(k.x, k.y);
        break;
      case 'C':
        add(k.x1, k.y1);
        add(k.x2, k.y2);
        add(k.x, k.y);
        break;
      case 'Z':
        break;
    }
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}
