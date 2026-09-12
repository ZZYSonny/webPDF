/**
 * The glyph that comes out of a generated font is the curve that went in.
 *
 * This is the regression test for a real bug. The font builder used to run every
 * cubic through a cubic-to-quadratic conversion - left over from when the writer
 * emitted a `glyf` table - and opentype.js 2.x writes a `CFF ` table instead,
 * whose charstrings are cubic. The quadratic was therefore re-expanded into a
 * cubic on the way out, so the only thing the conversion did was move the
 * outline: up to 35/1000 of an em on a real page's glyphs, which is most of a
 * pixel at reading size and ten pixels in a zoomed page.
 *
 * Worse, the conversion's own error test could not have fired: it compared the
 * cubic and the quadratic at t = 1/2, which is the one point the quadratic is
 * constructed to get exactly right, so it returned zero for every curve. A
 * round-trip measurement like this one is the check that was missing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fontkit from 'fontkit';

import { buildFontFromOutlines, type OutlineGlyph } from '../src/core/font/build.ts';
import { encodeWoff } from '../src/core/font/woff.ts';
import { FontRegistry } from '../src/core/font/registry.ts';
import { parseSfnt } from '../src/core/font/woff.ts';
import { parseSvgPath, type PathCommand } from '../src/core/font/svg-path.ts';
import type { GlyphOutline, GlyphPlacement } from '../src/core/svg/glyphs.ts';

/** A quarter circle, in em units: the curve a single quadratic cannot hold. */
const QUARTER = 'M0 0C0 .5523 .4477 1 1 1';

/** How far a curve may move: the 1/1000 em grid it is rounded onto, and no more. */
const SLACK_EM = 2 / 1000;

function polyline(cmds: readonly PathCommand[], per: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  for (const k of cmds) {
    const push = (px: number, py: number) => pts.push([px, py]);
    if (k.c === 'M') {
      x = sx = k.x;
      y = sy = k.y;
      push(x, y);
    } else if (k.c === 'L') {
      for (let i = 1; i <= per; i++) push(x + ((k.x - x) * i) / per, y + ((k.y - y) * i) / per);
      x = k.x;
      y = k.y;
    } else if (k.c === 'Q') {
      for (let i = 1; i <= per; i++) {
        const t = i / per;
        const m = 1 - t;
        push(m * m * x + 2 * m * t * k.x1 + t * t * k.x, m * m * y + 2 * m * t * k.y1 + t * t * k.y);
      }
      x = k.x;
      y = k.y;
    } else if (k.c === 'C') {
      for (let i = 1; i <= per; i++) {
        const t = i / per;
        const m = 1 - t;
        push(
          m * m * m * x + 3 * m * m * t * k.x1 + 3 * m * t * t * k.x2 + t * t * t * k.x,
          m * m * m * y + 3 * m * m * t * k.y1 + 3 * m * t * t * k.y2 + t * t * t * k.y,
        );
      }
      x = k.x;
      y = k.y;
    } else if (k.c === 'Z') {
      x = sx;
      y = sy;
    }
  }
  return pts;
}

/** The furthest either curve gets from the other, in em. */
function separation(a: readonly PathCommand[], b: readonly PathCommand[]): number {
  const A = polyline(a, 32);
  const B = polyline(b, 32);
  const oneWay = (from: Array<[number, number]>, to: Array<[number, number]>) => {
    let worst = 0;
    for (const [x, y] of from) {
      let nearest = Infinity;
      for (const [u, v] of to) {
        const d = Math.hypot(x - u, y - v);
        if (d < nearest) nearest = d;
      }
      if (nearest > worst) worst = nearest;
    }
    return worst;
  };
  return Math.max(oneWay(A, B), oneWay(B, A));
}

/** The glyph's outline as it comes back out of a font, in em units. */
function roundTrip(font: fontkit.Font, code: number): PathCommand[] {
  const svg = font.glyphForCodePoint(code).path.toSVG();
  const commands = parseSvgPath(svg);
  return commands.map((k) => {
    switch (k.c) {
      case 'M':
      case 'L':
        return { ...k, x: k.x / 1000, y: k.y / 1000 };
      case 'Q':
        return { ...k, x1: k.x1 / 1000, y1: k.y1 / 1000, x: k.x / 1000, y: k.y / 1000 };
      case 'C':
        return {
          ...k,
          x1: k.x1 / 1000,
          y1: k.y1 / 1000,
          x2: k.x2 / 1000,
          y2: k.y2 / 1000,
          x: k.x / 1000,
          y: k.y / 1000,
        };
      default:
        return k;
    }
  });
}

test('a generated glyph holds the curve it was given', async () => {
  const built = buildFontFromOutlines([{ gid: 1, d: QUARTER, codes: [0x41], advanceEm: 1 }], {
    familyName: 'OutlineRoundTrip',
  });
  const original = parseSvgPath(QUARTER);

  const raw = fontkit.create(Buffer.from(built.data));
  const fromRaw = roundTrip(raw, 0x41);
  // A cubic in, a cubic out: one curve, not the eight a subdivision would leave.
  assert.equal(fromRaw.filter((k) => k.c === 'C').length, 1, 'the curve came back as one cubic');
  assert.ok(
    separation(original, fromRaw) <= SLACK_EM,
    `raw font moved the outline by ${(separation(original, fromRaw) * 1000).toFixed(3)}/1000 em`,
  );

  const woff = await encodeWoff(new Uint8Array(built.data));
  assert.ok(woff, 'WOFF encoding should be available in Node');
  const fromWoff = roundTrip(fontkit.create(Buffer.from(woff.data)), 0x41);
  assert.ok(
    separation(original, fromWoff) <= SLACK_EM,
    `WOFF moved the outline by ${(separation(original, fromWoff) * 1000).toFixed(3)}/1000 em`,
  );
});

test('the asset is an OpenType/CFF font, and says so', async () => {
  const outlines = new Map<string, GlyphOutline>([
    ['0:1', { fontId: 0, gid: 1, d: QUARTER, raw: '', start: 0, end: 0 }],
  ]);
  const placements: GlyphPlacement[] = [
    {
      fontId: 0,
      gid: 1,
      code: 0x41,
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      attrs: [],
      start: 0,
      end: 0,
    },
  ];

  const compressed = await new FontRegistry().planPage(outlines, placements);
  const woffAsset = compressed.assets[0];
  assert.equal(woffAsset.format, 'woff');
  assert.match(woffAsset.css, /format\('woff'\)/);
  assert.match(woffAsset.css, /data:font\/woff;base64,/);

  // With compression off the raw sfnt goes in, and it is `OTTO`: opentype.js
  // writes CFF charstrings, so calling it `truetype` was never true.
  const plain = await new FontRegistry({ disableCompression: true }).planPage(outlines, placements);
  const rawAsset = plain.assets[0];
  assert.equal(rawAsset.format, 'opentype');
  assert.match(rawAsset.css, /format\('opentype'\)/);
  assert.match(rawAsset.css, /data:font\/otf;base64,/);
  const base64 = /base64,([^)]*)\)/.exec(rawAsset.css)![1];
  const flavor = parseSfnt(new Uint8Array(Buffer.from(base64, 'base64'))).flavor;
  assert.equal(flavor, 0x4f54544f, 'the bytes are an OTTO sfnt, so the label must be opentype');
});

test('every glyph in a built font is reachable', () => {
  const glyphs: OutlineGlyph[] = [
    { gid: 1, d: QUARTER, codes: [0x41], advanceEm: 1 },
    { gid: 2, d: 'M0 0L1 0L1 1Z', codes: [0xe000], advanceEm: 1 },
  ];
  const built = buildFontFromOutlines(glyphs, { familyName: 'Reachability' });
  const font = fontkit.create(Buffer.from(built.data));
  for (const g of glyphs) {
    for (const code of g.codes) {
      assert.notEqual(font.glyphForCodePoint(code).id, 0, `U+${code.toString(16)} is missing`);
    }
  }
});
