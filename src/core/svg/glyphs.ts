/**
 * Fast, targeted scanning of the SVG that MuPDF's SVG device produces.
 *
 * We deliberately do not pull in a full XML parser: MuPDF's writer emits a very
 * regular subset (double-quoted attributes, no namespaces beyond xlink, no CDATA
 * in the parts we care about), and scanning it linearly keeps a 60-page scroll
 * cheap. Everything here is defensive - if a document does not match the shape
 * we expect we simply keep MuPDF's outlines, which always render correctly.
 */

export interface Matrix6 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Attribute {
  name: string;
  value: string;
}

/** A glyph's name across the modules: its font on the page, and its id in it. */
export function glyphKey(fontId: number, gid: number): string {
  return `${fontId}:${gid}`;
}

/** A `<path id="font_N_gid" d="...">` or `<g id="font_N_gid">` inside `<defs>`. */
export interface GlyphOutline {
  fontId: number;
  gid: number;
  /** SVG path data in em units (y up), or null for Type3 groups. */
  d: string | null;
  /** Raw text of the whole definition element, for pruning. */
  raw: string;
  start: number;
  end: number;
}

/** A single `<use>` referencing a glyph outline. */
export interface GlyphPlacement {
  fontId: number;
  gid: number;
  /** Decoded `data-text` code point, or -1 when MuPDF did not emit one. */
  code: number;
  matrix: Matrix6;
  /** Attributes to copy onto a replacement `<text>`, in source order. */
  attrs: Attribute[];
  start: number;
  end: number;
}

const RE_DEF_PATH = /<path id="font_(\d+)_(\d+)" d="([^"]*)"\s*\/>/g;
const RE_DEF_GROUP = /<g id="font_(\d+)_(\d+)">/g;
const RE_USE = /<use\b([^>]*?)\/>/g;
const RE_ATTR = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;

export function parseAttributes(s: string): Attribute[] {
  const out: Attribute[] = [];
  RE_ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ATTR.exec(s))) out.push({ name: m[1], value: m[2] });
  return out;
}

/** Decode the numeric character references MuPDF writes into `data-text`. */
export function decodeNumericRefs(s: string): number {
  if (!s) return -1;
  let value = s;
  const ent = /^&#x([0-9a-fA-F]+);$/.exec(s) ?? /^&#(\d+);$/.exec(s);
  if (ent) {
    const n = ent[1];
    const cp = s.startsWith('&#x') ? parseInt(n, 16) : parseInt(n, 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return -1;
    // MuPDF substitutes U+FFFD for lone surrogates, which carries no meaning.
    if (cp === 0xfffd) return -1;
    return cp;
  }
  if (value === '&amp;') return 0x26;
  if (value === '&quot;') return 0x22;
  if (value === '&apos;') return 0x27;
  if (value === '&lt;') return 0x3c;
  if (value === '&gt;') return 0x3e;
  const cp = value.codePointAt(0);
  return cp === undefined ? -1 : cp;
}

export function parseMatrix(value: string): Matrix6 | null {
  // MuPDF always writes matrix(a,b,c,d,e,f); accept scale/translate forms too.
  let m = /^matrix\(([^)]*)\)$/.exec(value.trim());
  if (m) {
    const parts = m[1].split(/[\s,]+/).filter(Boolean).map(Number);
    if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null;
    return { a: parts[0], b: parts[1], c: parts[2], d: parts[3], e: parts[4], f: parts[5] };
  }
  m = /^translate\(([^)]*)\)$/.exec(value.trim());
  if (m) {
    const parts = m[1].split(/[\s,]+/).filter(Boolean).map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return { a: 1, b: 0, c: 0, d: 1, e: parts[0] ?? 0, f: parts[1] ?? 0 };
  }
  return null;
}

function unescapeAttr(v: string): string {
  return v.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => {
    switch (e) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      default:
        return "'";
    }
  });
}

/** Collect every glyph outline definition inside the SVG. */
export function scanGlyphOutlines(svg: string): Map<string, GlyphOutline> {
  const out = new Map<string, GlyphOutline>();

  RE_DEF_PATH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_DEF_PATH.exec(svg))) {
    const fontId = Number(m[1]);
    const gid = Number(m[2]);
    out.set(glyphKey(fontId, gid), {
      fontId,
      gid,
      d: unescapeAttr(m[3]),
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Type3 glyphs become `<g id="font_N_gid"> ... </g>`; we record them so the
  // caller knows the glyph exists but keep them as outlines.
  RE_DEF_GROUP.lastIndex = 0;
  while ((m = RE_DEF_GROUP.exec(svg))) {
    const fontId = Number(m[1]);
    const gid = Number(m[2]);
    const key = glyphKey(fontId, gid);
    if (!out.has(key)) {
      out.set(key, { fontId, gid, d: null, raw: m[0], start: m.index, end: m.index + m[0].length });
    }
  }

  return out;
}

/** Collect every `<use>` that references a glyph. */
export function scanGlyphPlacements(svg: string): GlyphPlacement[] {
  const out: GlyphPlacement[] = [];
  RE_USE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_USE.exec(svg))) {
    const attrs = parseAttributes(m[1]);
    let href: string | null = null;
    let dataText = '';
    let transform: string | null = null;
    for (const a of attrs) {
      if (a.name === 'xlink:href' || a.name === 'href') href = a.value;
      else if (a.name === 'data-text') dataText = a.value;
      else if (a.name === 'transform') transform = a.value;
    }
    if (!href) continue;
    const target = /^#font_(\d+)_(\d+)$/.exec(href);
    if (!target) continue;
    const matrix = transform ? parseMatrix(transform) : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    if (!matrix) continue;

    out.push({
      fontId: Number(target[1]),
      gid: Number(target[2]),
      code: decodeNumericRefs(dataText),
      matrix,
      attrs: attrs.filter((a) => a.name !== 'xlink:href' && a.name !== 'href' && a.name !== 'data-text' && a.name !== 'transform'),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}
