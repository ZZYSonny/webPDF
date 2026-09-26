import assert from 'node:assert/strict';
import { create } from 'fontkit';
import type { Core } from '../../demo/core/bridge.ts';

/** Flatten span cuts: bionic may split spans, but must preserve text and positions. */
export function checkBionic(plain: string, faded: string, requireFade = false): void {
  const runs = (svg: string) => [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((run) => {
    const spans = [...run[2].matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)];
    const positions = (attr: string) => spans.flatMap((s) => (new RegExp(`\\b${attr}="([^"]*)"`).exec(s[1])?.[1] ?? '').trim().split(/\s+/).filter(Boolean));
    return { attributes: run[1], text: spans.map((s) => s[2]).join(''), x: positions('x'), y: positions('y') };
  });
  assert.deepEqual(runs(faded), runs(plain), 'bionic preserves text, run attributes and every position');
  if (requireFade) assert.match(faded, /<tspan[^>]*fill-opacity=/);
}

/** The stylesheet and payload must describe the same loadable, complete fonts. */
export function checkFonts(core: Core, id: number): number {
  const css = core.stylesheet(id);
  const { faces, bytes } = core.fonts(id);
  assert.equal((css.match(/@font-face/g) ?? []).length, faces.length);
  assert.equal(new Set(faces.map((f) => f.family)).size, faces.length);
  let offset = 0;
  for (const face of faces) {
    assert.equal(face.offset, offset);
    assert.ok(face.bytes > 0);
    assert.ok(face.offset + face.bytes <= bytes.length);
    assert.ok(css.includes(`url("${face.uri}")`));
    const font = create(bytes.subarray(face.offset, face.offset + face.bytes));
    assert.ok(font.numGlyphs > 0);
    for (const code of font.characterSet) {
      // cmap format 4 terminates with U+FFFF -> .notdef; it is not a character.
      if (code === 0xffff) continue;
      const glyph = font.glyphForCodePoint(code);
      assert.ok(glyph.id > 0 && glyph.id < font.numGlyphs, `U+${code.toString(16)} resolves inside ${face.family}`);
      assert.ok(Number.isFinite(glyph.advanceWidth));
    }
    offset += face.bytes;
  }
  assert.equal(offset, bytes.length);
  return faces.length;
}

/** From raster-sweep: reject unbalanced groups before asking a browser to paint. */
export function checkGroups(svg: string): void {
  let depth = 0;
  for (const [tag] of svg.matchAll(/<g\b[^>]*>|<\/g>/g)) {
    if (tag.endsWith('/>')) continue;
    depth += tag === '</g>' ? -1 : 1;
    assert.ok(depth >= 0, 'SVG closes a group before opening it');
  }
  assert.equal(depth, 0, 'SVG groups are balanced');
}
