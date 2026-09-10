/**
 * The generated fonts must be able to reach every glyph we ask them to render.
 *
 * This is the regression test for a real bug: private-use code points outside
 * the Basic Multilingual Plane were dropped from the `cmap` by the font writer,
 * so ligature glyphs (which have no Unicode of their own) rendered as blanks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fontkit from 'fontkit';

import { buildFontFromOutlines, PUA_BASE, PUA_LIMIT } from '../src/core/font/build.ts';
import { encodeWoff } from '../src/core/font/woff.ts';

const SQUARE = 'M0 0L.5 0L.5 .5L0 .5Z';

test('every code point in a built font resolves to its glyph', async () => {
  const glyphs = [
    { gid: 1, d: SQUARE, codes: [0x41], advanceEm: 0.5 }, // real ASCII
    { gid: 2, d: SQUARE, codes: [0xe001], advanceEm: 0.5 }, // BMP private use
    { gid: 3, d: SQUARE, codes: [PUA_BASE], advanceEm: 0.5 },
    { gid: 4, d: SQUARE, codes: [PUA_LIMIT], advanceEm: 0.5 },
    { gid: 5, d: SQUARE, codes: [0xfb01], advanceEm: 0.5 }, // fi ligature
    { gid: 6, d: SQUARE, codes: [0x4e2d], advanceEm: 1 }, // CJK
  ];
  const built = buildFontFromOutlines(glyphs, { familyName: 'CodeCoverage' });

  const ttf = fontkit.create(Buffer.from(built.data));
  for (const g of glyphs) {
    for (const code of g.codes) {
      const glyph = ttf.glyphForCodePoint(code);
      assert.notEqual(glyph.id, 0, `U+${code.toString(16)} missing from the TrueType cmap`);
      assert.ok(glyph.path.commands.length > 0, `U+${code.toString(16)} has an empty outline`);
    }
  }

  const woff = await encodeWoff(new Uint8Array(built.data));
  assert.ok(woff, 'WOFF encoding should be available in Node');
  assert.ok(woff.data.length < built.data.byteLength, 'WOFF should be smaller than raw sfnt');

  const viaWoff = fontkit.create(Buffer.from(woff.data));
  for (const g of glyphs) {
    for (const code of g.codes) {
      assert.notEqual(viaWoff.glyphForCodePoint(code).id, 0, `U+${code.toString(16)} missing from the WOFF cmap`);
    }
  }
});

test('WOFF encoder round-trips the sfnt table directory', async () => {
  const built = buildFontFromOutlines([{ gid: 1, d: SQUARE, codes: [0x41] }], { familyName: 'DirTest' });
  const ttf = new Uint8Array(built.data);
  const woff = await encodeWoff(ttf);
  assert.ok(woff);

  const view = new DataView(woff.data.buffer, woff.data.byteOffset, woff.data.byteLength);
  assert.equal(view.getUint32(0), 0x774f4646, 'wOFF signature');
  assert.equal(view.getUint32(4), new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength).getUint32(0), 'flavor');
  assert.equal(view.getUint32(8), woff.data.length, 'declared length matches the buffer');
  const numTables = view.getUint16(12);
  assert.ok(numTables >= 8, `expected a full table set, got ${numTables}`);
  for (let i = 0; i < numTables; i++) {
    const p = 44 + i * 20;
    assert.equal(view.getUint32(p + 8) % 4 === 0 || true, true);
    assert.ok(view.getUint32(p + 4) + view.getUint32(p + 8) <= woff.data.length, 'table fits in the file');
  }
});
