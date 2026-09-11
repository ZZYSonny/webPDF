/**
 * Namespacing and packaging helpers for the SVG that MuPDF produces.
 *
 * MuPDF numbers its internal ids (`font_1_53`, `ma3`, `im0`, ...) from a fresh
 * counter for every page. Inlining several pages into one document would make
 * those ids collide - and in HTML, `url(#id)` resolves against the whole
 * document, not against the enclosing `<svg>` - so every page gets a prefix.
 */

const RE_ID = /\sid="([^"]*)"/g;
const RE_REF = /url\(#([^)]*)\)|href="#([^"]*)"/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prefix every id (and every reference to one) in a MuPDF page SVG.
 *
 * Returns the input unchanged when there is nothing to rewrite.
 */
export function namespaceSvgIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  RE_ID.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ID.exec(svg))) ids.add(m[1]);
  if (ids.size === 0) return svg;

  const map = new Map<string, string>();
  for (const id of ids) map.set(id, prefix + id);

  // Longest first so `font_1_5` is never matched inside `font_1_53`.
  const ordered = [...ids].sort((a, b) => b.length - a.length);
  const alternation = ordered.map(escapeRe).join('|');

  let out = svg.replace(new RegExp(`\\sid="(${alternation})"`, 'g'), (_all, id: string) => ` id="${map.get(id)}"`);
  out = out.replace(new RegExp(`url\\(#(${alternation})\\)|href="#(${alternation})"`, 'g'), (all, u: string, h: string) => {
    if (u !== undefined) return `url(#${map.get(u)})`;
    if (h !== undefined) return `href="#${map.get(h)}"`;
    return all;
  });
  return out;
}

export interface SvgDimensions {
  width: number;
  height: number;
  viewBox: string;
}

/**
 * Read the page geometry MuPDF wrote onto the root `<svg>` element.
 *
 * The `viewBox` is the page's own size and is what this prefers: the
 * width/height attributes may since have been rewritten to fill a container
 * (`rewriteSvgRoot`), at which point they say nothing about the page.
 */
export function readSvgDimensions(svg: string): SvgDimensions | null {
  const root = /<svg\b[^>]*>/.exec(svg);
  if (!root) return null;
  const vb = /\bviewBox="([^"]*)"/.exec(root[0]);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3], viewBox: vb[1] };
    }
  }
  const px = (attr: RegExpExecArray | null): number =>
    attr && /^[\d.]+$/.test(attr[1].trim()) ? Number.parseFloat(attr[1]) : NaN;
  const width = px(/\bwidth="([^"]*)"/.exec(root[0]));
  const height = px(/\bheight="([^"]*)"/.exec(root[0]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, viewBox: `0 0 ${width} ${height}` };
}

export interface SvgRootOptions {
  /** Value written to the root `class` attribute. */
  className?: string;
  /** Make the root fill its container instead of using MuPDF's pixel size. */
  responsive?: boolean;
}

/** Rewrite the root `<svg>` tag so it can be dropped into a DOM container. */
export function rewriteSvgRoot(svg: string, opts: SvgRootOptions = {}): string {
  const root = /<svg\b[^>]*>/.exec(svg);
  if (!root) return svg;
  let tag = root[0];
  if (opts.responsive !== false) {
    tag = tag.replace(/\swidth="[^"]*"/, ' width="100%"').replace(/\sheight="[^"]*"/, ' height="100%"');
    if (!/\bpreserveAspectRatio=/.test(tag)) tag = tag.replace(/<svg\b/, '<svg preserveAspectRatio="xMidYMid meet"');
  }
  if (opts.className) {
    if (/\bclass="/.test(tag)) tag = tag.replace(/\bclass="([^"]*)"/, `class="$1 ${opts.className}"`);
    else tag = tag.replace(/<svg\b/, `<svg class="${opts.className}"`);
  }
  return tag + svg.slice(root[0].length);
}

/** Strip the XML prolog if a writer ever adds one; `innerHTML` rejects it. */
export function stripXmlProlog(svg: string): string {
  return svg.replace(/^\s*<\?xml[^>]*\?>\s*/, '').replace(/^\s*<!DOCTYPE[^>]*>\s*/i, '');
}

/**
 * Embed `@font-face` rules inside the SVG itself.
 *
 * Required whenever the SVG is used as a standalone document - as an `<img>`
 * source, a file on disk, or a CSS background - because such documents cannot
 * see the host page's stylesheets. `]]>` is escaped so the CSS cannot terminate
 * an enclosing CDATA section.
 */
export function inlineFontCss(svg: string, css: string): string {
  if (!css) return svg;
  const safe = css.replace(/]]>/g, ']]]]><![CDATA[>');
  const style = `<style type="text/css"><![CDATA[\n${safe}\n]]></style>`;
  const root = /<svg\b[^>]*>/.exec(svg);
  if (!root) return svg;
  return svg.slice(0, root.index + root[0].length) + style + svg.slice(root.index + root[0].length);
}
